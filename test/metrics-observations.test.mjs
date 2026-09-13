import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeUsage, parseCodexUsage, validateUsage } from '../src/metrics-usage.mjs';
import { createCodexUsageParser, parseCodexUsageWithObservations } from '../src/metrics-observations.mjs';

const options = { hostId: 'host', threadId: 'thread', sourceRef: 'fixture-log' };
const meta = { timestamp: '2026-09-12T00:00:00.000Z', type: 'session_meta', payload: { id: 'thread' } };
const wire = total => ({ input_tokens: total - 2, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: total });
const token = (minute, total) => ({
  timestamp: new Date(Date.UTC(2026, 8, 12, 0, minute)).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: wire(total), total_token_usage: wire(total) } }
});
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ schemaVersion: 1, teamId: 'team', records: [], links: [], diagnostics: [] });
const native = (lineTotal, responseId, turnId = 'turn-native') => ({
  timestamp: '2026-09-12T00:00:20.000Z', ordinal: 97, type: 'token_usage_record',
  payload: {
    thread_id: 'thread', turn_id: turnId, session_id: 'ignored', root_turn_id: 'ignored', response_id: responseId,
    usage: { ...wire(lineTotal), cache_write_input_tokens: 0 },
    turn_token_usage: { ignored: true }, thread_token_usage: { ignored: true }
  }
});

test('detailed parse preserves record IDs and emits linked, redacted source observations', () => {
  const argumentsText = '{"path":"RAW_ARGUMENT_SENTINEL"}';
  const outputText = 'RAW_OUTPUT_SENTINEL';
  const message = 'RAW_USER_SENTINEL';
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:30.000Z', type: 'event_msg', payload: { type: 'user_message', message } },
    { timestamp: '2026-09-12T00:00:40.000Z', type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: argumentsText, call_id: 'call-1' } },
    { timestamp: '2026-09-12T00:00:50.000Z', type: 'response_item', payload: { type: 'function_call_output', output: outputText, call_id: 'call-1' } },
    { timestamp: 'not-canonical', type: 'compacted' },
    token(1, 12)
  ];
  const text = jsonl(entries);
  const detailed = parseCodexUsageWithObservations(text, options);
  assert.deepEqual(detailed.records, parseCodexUsage(text, options).records);
  assert.equal(detailed.observations.length, 1);
  assert.deepEqual(detailed.observations[0], {
    recordId: detailed.records[0].id, sourceRef: 'fixture-log', firstLine: 1, usageLine: 6, nativeResponse: null,
    events: [
      { kind: 'user_message', line: 2, at: '2026-09-12T00:00:30.000Z', callId: null, tool: null, argumentsHash: null, contentHash: sha256(message), bytes: Buffer.byteLength(message) },
      { kind: 'tool_call', line: 3, at: '2026-09-12T00:00:40.000Z', callId: 'call-1', tool: 'read_file', argumentsHash: sha256(argumentsText), contentHash: null, bytes: Buffer.byteLength(argumentsText) },
      { kind: 'tool_result', line: 4, at: '2026-09-12T00:00:50.000Z', callId: 'call-1', tool: 'read_file', argumentsHash: null, contentHash: sha256(outputText), bytes: Buffer.byteLength(outputText) },
      { kind: 'context_compaction', line: 5, at: null, callId: null, tool: null, argumentsHash: null, contentHash: null, bytes: null }
    ]
  });
  assert.doesNotMatch(JSON.stringify(detailed), /RAW_(?:ARGUMENT|OUTPUT|USER)_SENTINEL/);
});

test('tool result arrays use serialized bytes and a type-domain hash without retaining bodies', () => {
  const textOnly = [{ type: 'input_text', text: 'ARRAY_TEXT_ONLY_SENTINEL' }];
  const mixed = [{ type: 'input_text', text: 'ARRAY_MIXED_TEXT_SENTINEL' }, { type: 'input_image', image_url: 'ARRAY_IMAGE_SENTINEL' }];
  const literal = JSON.stringify(mixed);
  const entries = [
    meta,
    { type: 'response_item', payload: { type: 'function_call_output', output: textOnly, call_id: 'array-text' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: mixed, call_id: 'array-mixed' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: literal, call_id: 'literal-string' } },
    token(1, 12)
  ];
  const results = parseCodexUsageWithObservations(jsonl(entries), options).observations[0].events;
  const serializedText = JSON.stringify(textOnly), serializedMixed = JSON.stringify(mixed);
  assert.deepEqual(results.map(item => item.bytes), [Buffer.byteLength(serializedText), Buffer.byteLength(serializedMixed), Buffer.byteLength(literal)]);
  assert.deepEqual(results.map(item => item.contentHash), [sha256(`array-json-v1\0${serializedText}`), sha256(`array-json-v1\0${serializedMixed}`), sha256(literal)]);
  assert.notEqual(results[1].contentHash, results[2].contentHash);
  assert.doesNotMatch(JSON.stringify(results), /ARRAY_(?:TEXT|MIXED|IMAGE)/);
});

test('collector supports custom calls, preserves ambiguous binding uncertainty, and ignores wrappers', () => {
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:10.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', input: 'one', call_id: 'same' } },
    { timestamp: '2026-09-12T00:00:20.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'other', input: 'two', call_id: 'same' } },
    { timestamp: '2026-09-12T00:00:30.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'three', call_id: 'same' } },
    { timestamp: '2026-09-12T00:00:35.000Z', type: 'event_msg', payload: { type: 'context_compacted' } },
    { timestamp: '2026-09-12T00:00:40.000Z', type: 'wrapper', payload: { type: 'function_call', name: 'fake', arguments: 'secret', call_id: 'fake' } },
    token(1, 12)
  ];
  const result = parseCodexUsageWithObservations(jsonl(entries), options);
  assert.deepEqual(result.observations[0].events.map(event => [event.kind, event.callId, event.tool]), [
    ['tool_call', 'same', 'shell'], ['tool_call', 'same', 'other'], ['tool_result', 'same', null],
    ['context_compaction', null, null]
  ]);
});

test('only accepted usage creates observation windows and repeated imports are idempotent', () => {
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
    token(1, 12),
    { timestamp: '2026-09-12T00:01:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'duplicate-window' } },
    token(2, 12),
    { timestamp: '2026-09-12T00:02:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
    token(3, 22),
    { timestamp: '2026-09-12T00:03:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'tail-unmatched' } }
  ];
  const parsed = parseCodexUsageWithObservations(jsonl(entries), options);
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.observations.map(item => [item.firstLine, item.usageLine, item.events.map(event => event.line)]), [
    [1, 3, [2]], [4, 7, [4, 6]]
  ]);
  assert.equal(JSON.stringify(parsed).includes(sha256('tail-unmatched')), false);
  const once = mergeUsage(empty(), parsed.records, parsed.diagnostics, parsed.observations);
  const twice = mergeUsage(once, parsed.records, parsed.diagnostics, parsed.observations);
  assert.deepEqual(twice, once);
  assert.equal(once.schemaVersion, 2);
});

test('v1 and v2 ledgers are strict while old merges preserve v2 observations', () => {
  assert.equal(validateUsage(empty()).schemaVersion, 1);
  const parsed = parseCodexUsageWithObservations(jsonl([meta, token(1, 12)]), options);
  const v2 = mergeUsage(empty(), parsed.records, parsed.diagnostics, parsed.observations);
  assert.equal(validateUsage(v2).schemaVersion, 2);
  assert.deepEqual(mergeUsage(v2, [], []), v2);

  const mutations = [
    ledger => { ledger.extra = true; },
    ledger => { ledger.observations[0].extra = true; },
    ledger => { ledger.observations[0].recordId = 'missing'; },
    ledger => { ledger.observations[0].sourceRef = 'other-source'; },
    ledger => { ledger.observations[0].firstLine = 0; },
    ledger => { ledger.observations[0].events[0] = { kind: 'unknown' }; }
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(v2);
    if (bad.observations[0].events.length === 0) bad.observations[0].events.push({
      kind: 'context_compaction', line: 1, at: null, callId: null, tool: null,
      argumentsHash: null, contentHash: null, bytes: null
    });
    mutate(bad);
    assert.throws(() => validateUsage(bad));
  }

  const duplicate = structuredClone(v2);
  duplicate.observations.push(structuredClone(duplicate.observations[0]));
  assert.throws(() => validateUsage(duplicate), /duplicate observation/i);

  const conflicting = structuredClone(v2.observations);
  conflicting[0].usageLine += 1;
  assert.throws(() => mergeUsage(v2, [], [], conflicting), /conflicting observation/i);
});

test('streaming parser matches text APIs and locates an omitted incomplete final line', () => {
  const content = [{ type: 'input_text', text: 'STREAM_USER_SENTINEL' }];
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:30.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content } },
    token(1, 12)
  ];
  const lines = entries.map(entry => JSON.stringify(entry));

  const detailedParser = createCodexUsageParser(options, { observations: true });
  lines.forEach(line => detailedParser.push(line));
  const detailed = detailedParser.finish();
  assert.deepEqual(detailed, parseCodexUsageWithObservations(`${lines.join('\n')}\n`, options));
  assert.equal(detailed.observations[0].events[0].contentHash, sha256(JSON.stringify(content)));
  assert.equal(detailed.observations[0].events[0].bytes, Buffer.byteLength(JSON.stringify(content)));
  assert.doesNotMatch(JSON.stringify(detailed), /STREAM_USER_SENTINEL/);

  const basicParser = createCodexUsageParser(options);
  lines.forEach(line => basicParser.push(line));
  assert.deepEqual(basicParser.finish(), parseCodexUsage(`${lines.join('\n')}\n`, options));

  const incompleteParser = createCodexUsageParser(options);
  incompleteParser.push(lines[0]);
  const incomplete = incompleteParser.finish({ incompleteFinalLine: true });
  assert.deepEqual(incomplete.diagnostics.map(item => [item.code, item.line]), [['incomplete_line', 2]]);
  assert.throws(() => incompleteParser.push('later'), /finished/i);
  assert.throws(() => incompleteParser.finish(), /finished/i);
});

test('merge rejects a rewritten source line even when it produced a different record ID', () => {
  const original = parseCodexUsageWithObservations(jsonl([meta, token(1, 12)]), options);
  const ledger = mergeUsage(empty(), original.records, original.diagnostics, original.observations);
  const rewritten = parseCodexUsageWithObservations(jsonl([meta, token(1, 13)]), options);
  assert.notEqual(rewritten.records[0].id, original.records[0].id);
  assert.throws(
    () => mergeUsage(ledger, rewritten.records, rewritten.diagnostics, rewritten.observations),
    /conflicting observation source position/i
  );
});

test('a unique native counter match ends the response window before following tool activity', () => {
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:10.000Z', type: 'turn_context', payload: { turn_id: 'turn-native', model: 'gpt-test' } },
    { timestamp: '2026-09-12T00:00:15.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'prompt-one' } },
    native(12, 'resp-1'),
    { timestamp: '2026-09-12T00:00:30.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: 'after-response', call_id: 'call-next' } },
    { timestamp: '2026-09-12T00:00:40.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'after-result', call_id: 'call-next' } },
    token(1, 12),
    native(22, 'resp-2'),
    token(2, 22)
  ];
  const parsed = parseCodexUsageWithObservations(jsonl(entries), options);
  assert.deepEqual(parsed.observations.map(observation => ({
    firstLine: observation.firstLine, usageLine: observation.usageLine,
    nativeResponse: observation.nativeResponse, eventLines: observation.events.map(event => event.line)
  })), [
    { firstLine: 1, usageLine: 7, nativeResponse: { responseId: 'resp-1', turnId: 'turn-native', line: 4, association: 'counter-match' }, eventLines: [3] },
    { firstLine: 5, usageLine: 9, nativeResponse: { responseId: 'resp-2', turnId: 'turn-native', line: 8, association: 'counter-match' }, eventLines: [5, 6] }
  ]);
});

test('late token notification preserves a later native candidate for its own counter match', () => {
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:10.000Z', type: 'turn_context', payload: { turn_id: 'turn-native', model: 'gpt-test' } },
    native(12, 'resp-a'),
    native(22, 'resp-b'),
    token(1, 12),
    token(2, 22)
  ];
  const parsed = parseCodexUsageWithObservations(jsonl(entries), options);
  assert.deepEqual(parsed.observations.map(item => item.nativeResponse), [
    { responseId: 'resp-a', turnId: 'turn-native', line: 3, association: 'counter-match' },
    { responseId: 'resp-b', turnId: 'turn-native', line: 4, association: 'counter-match' }
  ]);
});

test('unique call metadata survives an accepted boundary until its later result', () => {
  const entries = [
    meta,
    { timestamp: '2026-09-12T00:00:10.000Z', type: 'turn_context', payload: { turn_id: 'turn-native', model: 'gpt-test' } },
    { timestamp: '2026-09-12T00:00:15.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: 'safe-hash-only', call_id: 'cross-boundary' } },
    native(12, 'resp-a'),
    token(1, 12),
    { timestamp: '2026-09-12T00:01:10.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'safe-hash-only', call_id: 'cross-boundary' } },
    native(22, 'resp-b'),
    token(2, 22)
  ];
  const parsed = parseCodexUsageWithObservations(jsonl(entries), options);
  assert.deepEqual(parsed.observations[1].events.map(event => [event.kind, event.callId, event.tool]), [
    ['tool_result', 'cross-boundary', 'exec']
  ]);
});

test('pending-call overflow never restores certainty for a reused call ID', () => {
  const entries = [
    meta,
    { type: 'response_item', payload: { type: 'function_call', name: 'old_tool', arguments: 'old', call_id: 'reused' } }
  ];
  for (let index = 0; index < 4096; index += 1) {
    entries.push({
      type: 'response_item',
      payload: { type: 'function_call', name: 'filler_tool', arguments: 'filler', call_id: `filler-${index}` }
    });
  }
  entries.push(
    { type: 'response_item', payload: { type: 'function_call', name: 'new_tool', arguments: 'new', call_id: 'reused' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'result', call_id: 'reused' } },
    token(1, 12)
  );
  const parsed = parseCodexUsageWithObservations(jsonl(entries), options);
  const result = parsed.observations[0].events.find(event => event.kind === 'tool_result');
  assert.deepEqual({ callId: result.callId, tool: result.tool }, { callId: 'reused', tool: null });
});
