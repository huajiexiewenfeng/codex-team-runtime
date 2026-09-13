import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExplanation, validateExplanation } from '../src/metrics-explain.mjs';

const hash = digit => digit.repeat(64);
const usage = (input, cachedInput, output, reasoningOutput = 0, total = input + output) => ({
  input, cachedInput, nonCachedInput: input === null || cachedInput === null ? null : input - cachedInput,
  output, reasoningOutput, net: input === null || cachedInput === null || output === null ? null : input - cachedInput + output, total
});
const record = (id, line, values, sourceRef = 'fixture-log') => ({
  id, hostId: 'host', threadId: 'thread', at: `2026-09-12T00:0${line}:00.000Z`, turnId: `turn-${id}`, model: 'gpt-test',
  metrics: values, source: { kind: 'codex-log', ref: sourceRef }
});
const assignment = (recordId, kind = 'window') => ({ recordId, kind, roundId: kind === 'window' ? 'round' : null, taskId: kind === 'window' ? 'task' : null, memberId: 'worker', role: 'Worker', operation: kind === 'window' ? 'implementation' : 'unknown', evidenceRef: null });
const event = (kind, line, extra = {}) => ({ kind, line, at: null, callId: null, tool: null, argumentsHash: null, contentHash: null, bytes: null, ...extra });
const observation = (recordId, firstLine, usageLine, events = [], nativeResponse = null, sourceRef = 'fixture-log') => ({ recordId, sourceRef, firstLine, usageLine, nativeResponse, events });

test('projects complete deterministic driver rankings and distinguishes cached input from noncached input', () => {
  const records = [
    record('cached-heavy', 1, usage(1000, 990, 4)),
    record('noncached-heavy', 2, usage(600, 0, 8)),
    record('output-heavy', 3, usage(50, 0, 700, 300)),
    record('missing', 4, { input: null, cachedInput: null, nonCachedInput: null, output: null, reasoningOutput: null, net: null, total: null })
  ];
  const result = buildExplanation(records, records.map(item => assignment(item.id)), []);
  assert.deepEqual(result.rankings.input.rows.map(row => row.recordId), ['cached-heavy', 'noncached-heavy', 'output-heavy']);
  assert.deepEqual(result.rankings.nonCachedInput.rows.map(row => row.recordId), ['noncached-heavy', 'output-heavy', 'cached-heavy']);
  assert.deepEqual(result.rankings.output.rows.map(row => row.recordId), ['output-heavy', 'noncached-heavy', 'cached-heavy']);
  assert.equal(result.rankings.net.rows.length, 3);
  assert.equal(result.rankings.input.missingRecords, 1);
  assert.deepEqual(result.cards.find(card => card.recordId === 'cached-heavy').metrics, {
    input: 1000, cachedInput: 990, nonCachedInput: 10, output: 4, reasoningOutput: 0, net: 14, total: 1004
  });
  assert.doesNotThrow(() => validateExplanation(result));
});

test('projects observed activity, UTF-8 result bytes and temporal compaction without claiming token causality', () => {
  const records = [record('one', 1, usage(20, 10, 5))];
  const observations = [observation('one', 7, 15, [
    event('tool_call', 8, { callId: 'call-1', tool: 'exec', argumentsHash: hash('a') }),
    event('tool_result', 9, { callId: 'call-1', tool: 'exec', contentHash: hash('b'), bytes: 37 }),
    event('context_compaction', 10)
  ], { responseId: 'response-1', turnId: 'turn-one', line: 12, association: 'counter-match' })];
  const card = buildExplanation(records, [assignment('one')], observations).cards[0];
  assert.deepEqual(card.source, { kind: 'codex-log', ref: 'fixture-log', firstLine: 7, lastLine: 15, usageLine: 15, activityLastLine: 12 });
  assert.deepEqual(card.nativeResponse, { responseId: 'response-1', turnId: 'turn-one', line: 12, association: 'counter-match' });
  assert.deepEqual(card.activity, {
    availability: 'observed',
    toolCalls: { count: 1, items: [{ line: 8, tool: 'exec' }] },
    toolResults: { count: 1, utf8BytesKnown: 37, bytesMissing: 0, items: [{ line: 9, bytes: 37, callLine: 8, tool: 'exec' }] },
    compactions: { count: 1, lines: [10] },
    userMessages: { count: 0, lines: [] }
  });
  assert.ok(card.evidence.some(item => item.level === 'temporal' && item.code === 'nearby_compaction'));
  assert.ok(card.limitations.includes('bytes_are_log_volume_not_input_tokens'));
});

test('retains each tool result byte value and leaves unknown bytes explicit', () => {
  const records = [record('one', 1, usage(20, 0, 2))];
  const observations = [observation('one', 1, 6, [
    event('tool_call', 2, { callId: 'known', tool: 'read_file', argumentsHash: hash('a') }),
    event('tool_result', 3, { callId: 'known', tool: 'read_file', contentHash: hash('b'), bytes: 12 }),
    event('tool_result', 4, { callId: 'unknown', tool: null, contentHash: hash('c'), bytes: null })
  ])];
  const card = buildExplanation(records, [assignment('one')], observations).cards[0];
  assert.deepEqual(card.activity.toolResults, {
    count: 2, utf8BytesKnown: 12, bytesMissing: 1,
    items: [{ line: 3, bytes: 12, callLine: 2, tool: 'read_file' }, { line: 4, bytes: null, callLine: null, tool: null }]
  });
});

test('retains a unique call link when the observed tool name is unknown', () => {
  const records = [record('one', 1, usage(20, 0, 2))];
  const observations = [observation('one', 1, 4, [
    event('tool_call', 2, { callId: 'known-id', tool: null, argumentsHash: hash('a') }),
    event('tool_result', 3, { callId: 'known-id', tool: null, contentHash: hash('b'), bytes: 14 })
  ])];
  const result = buildExplanation(records, [assignment('one')], observations);
  assert.deepEqual(result.cards[0].activity.toolCalls.items, [{ line: 2, tool: null }]);
  assert.deepEqual(result.cards[0].activity.toolResults.items, [{ line: 3, bytes: 14, callLine: 2, tool: null }]);
  assert.doesNotThrow(() => validateExplanation(result));
});

test('unknown tool metadata does not allow a callLine without an actual observed call', () => {
  const records = [record('one', 1, usage(20, 0, 2))];
  const observations = [observation('one', 1, 4, [event('tool_result', 3, { callId: 'orphan', tool: null, contentHash: hash('b'), bytes: 14 })])];
  const invalid = buildExplanation(records, [assignment('one')], observations);
  invalid.cards[0].activity.toolResults.items[0].callLine = 2;
  assert.throws(() => validateExplanation(invalid), /does not reference one observed call/i);
});

test('correlates unique calls across windows and labels same versus changed result content', () => {
  const records = [record('a', 1, usage(20, 0, 2)), record('b', 2, usage(21, 0, 2)), record('c', 3, usage(22, 0, 2))];
  const observations = [
    observation('a', 1, 4, [event('tool_call', 3, { callId: 'x', tool: 'exec', argumentsHash: hash('a') })]),
    observation('b', 5, 8, [
      event('tool_result', 5, { callId: 'x', tool: 'exec', contentHash: hash('b'), bytes: 10 }),
      event('tool_call', 7, { callId: 'y', tool: 'exec', argumentsHash: hash('a') })
    ]),
    observation('c', 9, 12, [
      event('tool_result', 9, { callId: 'y', tool: 'exec', contentHash: hash('b'), bytes: 11 }),
      event('tool_call', 10, { callId: 'z', tool: 'exec', argumentsHash: hash('a') }),
      event('tool_result', 11, { callId: 'z', tool: 'exec', contentHash: hash('c'), bytes: 12 })
    ])
  ];
  const candidates = buildExplanation(records, records.map(item => assignment(item.id)), observations).repetitionCandidates;
  assert.deepEqual(candidates.map(item => item.kind), ['repeated_same_content', 'repeated_call']);
  assert.deepEqual(candidates[0].previous, { recordId: 'a', sourceRef: 'fixture-log', callLine: 3, resultLine: 5 });
  assert.deepEqual(candidates[0].current, { recordId: 'b', sourceRef: 'fixture-log', callLine: 7, resultLine: 9 });
  assert.deepEqual(candidates[1].current, { recordId: 'c', sourceRef: 'fixture-log', callLine: 10, resultLine: 11 });
  assert.ok(candidates.every(item => item.level === 'candidate' && item.limitations.includes('repetition_does_not_prove_waste')));
  const invalid = buildExplanation(records, records.map(item => assignment(item.id)), observations);
  invalid.repetitionCandidates[0].previous.resultLine = 6;
  assert.throws(() => validateExplanation(invalid), /result/i);
});

test('ambiguous reused call IDs never support a precise result link', () => {
  const records = [record('a', 1, usage(5, 0, 1)), record('b', 2, usage(5, 0, 1))];
  const observations = [
    observation('a', 1, 5, [
      event('tool_call', 2, { callId: 'reused', tool: 'exec', argumentsHash: hash('a') }),
      event('tool_call', 3, { callId: 'reused', tool: 'exec', argumentsHash: hash('a') }),
      event('tool_result', 4, { callId: 'reused', tool: null, contentHash: hash('b'), bytes: 4 })
    ]),
    observation('b', 6, 8, [event('tool_call', 7, { callId: 'next', tool: 'exec', argumentsHash: hash('a') })])
  ];
  const candidates = buildExplanation(records, records.map(item => assignment(item.id)), observations).repetitionCandidates;
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(item => item.previous.resultLine === null || item.current.resultLine === null));
  assert.ok(candidates.every(item => item.kind === 'repeated_call'));
});

test('distinguishes an observed empty window from unavailable historical evidence', () => {
  const records = [record('observed-empty', 1, usage(1, 0, 1)), record('historical', 2, usage(1, 0, 1))];
  const result = buildExplanation(records, records.map(item => assignment(item.id)), [observation('observed-empty', 2, 4)]);
  assert.equal(result.coverage.observedWindows, 1);
  assert.equal(result.coverage.unavailableRecords, 1);
  assert.equal(result.cards[0].activity.availability, 'observed');
  assert.equal(result.cards[0].activity.toolCalls.count, 0);
  assert.equal(result.cards[1].activity.availability, 'unavailable');
  assert.deepEqual(result.cards[1].source, { kind: 'codex-log', ref: 'fixture-log', firstLine: null, lastLine: null, usageLine: null, activityLastLine: null });
  assert.ok(result.cards[1].limitations.includes('record_only_evidence'));
});

test('does not report zero result bytes when every observed result byte value is missing', () => {
  const records = [record('one', 1, usage(1, 0, 1))];
  const observations = [observation('one', 1, 3, [event('tool_result', 2, { callId: 'call', tool: null, contentHash: hash('a'), bytes: null })])];
  const result = buildExplanation(records, [assignment('one')], observations);
  assert.deepEqual(result.cards[0].activity.toolResults, { count: 1, utf8BytesKnown: null, bytesMissing: 1, items: [{ line: 2, bytes: null, callLine: null, tool: null }] });
  assert.ok(result.cards[0].evidence.some(item => item.code === 'tool_results_observed'));
  assert.ok(result.cards[0].evidence.every(item => item.code !== 'tool_result_bytes_observed'));
});

test('strict validation rejects unknown nested fields, invalid references and metric conflicts', () => {
  const records = [record('one', 1, usage(5, 2, 1))];
  const valid = buildExplanation(records, [assignment('one')], [observation('one', 1, 2)]);
  for (const mutate of [
    value => { value.cards[0].activity.toolCalls.extra = true; },
    value => { value.rankings.input.rows[0].recordId = 'missing'; },
    value => { value.cards[0].metrics.nonCachedInput = 99; },
    value => { value.cards[0].activity.toolCalls = { count: 1, items: [{ line: 99, tool: 'exec' }] }; },
    value => { value.repetitionCandidates.push({}); }
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => validateExplanation(invalid));
  }
});
