import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsage, mergeUsage, validateUsage } from '../src/metrics-usage.mjs';

const empty = () => ({ schemaVersion: 1, teamId: 'team', records: [], links: [], diagnostics: [] });
const usage = (overrides = {}) => ({ input: 100, cachedInput: 60, output: 20, reasoningOutput: 5, total: 120, ...overrides });
const record = (id = 'u1', overrides = {}) => ({
  id, hostId: 'host', threadId: 'thread', at: '2026-09-12T01:00:00.000Z', turnId: null, model: null,
  usage: usage(), source: { kind: 'fixture', ref: id }, ...overrides
});
const meta = { timestamp: '2026-09-12T00:00:00.000Z', type: 'session_meta', payload: { id: 'thread', instructions: 'must be discarded' } };
const turn = { timestamp: '2026-09-12T00:01:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-test', user_instructions: 'discard me' } };
const token = (minute, last, total) => ({
  timestamp: new Date(Date.UTC(2026, 8, 12, 0, minute)).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total }, message: 'discard me' }
});
const wire = value => ({
  input_tokens: value.input, cached_input_tokens: value.cachedInput, output_tokens: value.output,
  reasoning_output_tokens: value.reasoningOutput, total_tokens: value.total
});
const parse = lines => parseCodexUsage(lines.map(x => JSON.stringify(x)).join('\n') + '\n', { hostId: 'host', threadId: 'thread', sourceRef: 'fixture-log' });

test('parseCodexUsage extracts only safe usage fields and keeps distinct equal last values', () => {
  const a = wire(usage()), cumulative1 = wire(usage());
  const cumulative2 = wire({ input: 200, cachedInput: 120, output: 40, reasoningOutput: 10, total: 240 });
  const result = parse([meta, turn, token(2, a, cumulative1), token(3, a, cumulative2)]);
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].id, result.records[1].id);
  assert.deepEqual(result.records[0].usage, usage());
  assert.deepEqual({ turnId: result.records[0].turnId, model: result.records[0].model }, { turnId: 'turn-1', model: 'gpt-test' });
  assert.deepEqual(Object.keys(result.records[0].source).sort(), ['kind', 'ref']);
  assert.doesNotMatch(JSON.stringify(result), /discard me|instructions|message/);
});

test('repeated cumulative notices are deduplicated while reset and coverage gap are diagnosed', () => {
  const first = wire(usage()), advanced = wire({ input: 250, cachedInput: 120, output: 50, reasoningOutput: 10, total: 300 });
  const reset = wire({ input: 10, cachedInput: 0, output: 2, reasoningOutput: 0, total: 12 });
  const result = parse([meta, token(1, first, first), token(2, first, first), token(3, first, advanced), token(4, wire({ input: 10, cachedInput: 0, output: 2, reasoningOutput: 0, total: 12 }), reset)]);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.diagnostics.map(x => x.code).sort(), ['counter_reset', 'coverage_gap', 'duplicate_cumulative']);
});

test('missing cumulative basis and missing last usage are safe diagnostics, not invented usage', () => {
  const result = parse([meta,
    { timestamp: '2026-09-12T00:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: wire(usage()) } } },
    { timestamp: '2026-09-12T00:02:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: wire(usage()) } } }
  ]);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.diagnostics.map(x => x.code).sort(), ['missing_cumulative', 'missing_last_usage']);
});

test('partial wire usage maps only absent usage fields to null', () => {
  const partial = { input_tokens: 7, output_tokens: 2 };
  const result = parse([meta, token(1, partial, partial)]);
  assert.deepEqual(result.records[0].usage, { input: 7, cachedInput: null, output: 2, reasoningOutput: null, total: null });
  assert.deepEqual(result.diagnostics.map(item => item.code).sort(), ['counter_profile_gap', 'usage_profile_gap']);
});

test('empty or partial cumulative profiles never deduplicate distinct observed last events', () => {
  const first = wire({ input: 1, cachedInput: 0, output: 0, reasoningOutput: 0, total: 1 });
  const second = wire({ input: 2, cachedInput: 0, output: 0, reasoningOutput: 0, total: 2 });
  for (const cumulative of [{}, { input_tokens: 9 }]) {
    const result = parse([meta, token(1, first, cumulative), token(2, second, cumulative)]);
    assert.deepEqual(result.records.map(item => item.usage.total), [1, 2]);
    assert.equal(result.diagnostics.filter(item => item.code === 'counter_profile_gap').length, 2);
    assert.equal(result.diagnostics.some(item => item.code === 'duplicate_cumulative'), false);
  }
});

test('malformed middle lines and incomplete final lines yield location-only diagnostics', () => {
  const text = `${JSON.stringify(meta)}\n{bad json}\n${JSON.stringify(token(2, wire(usage()), wire(usage())))}`;
  const result = parseCodexUsage(text, { hostId: 'host', threadId: 'thread', sourceRef: 'fixture-log' });
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.diagnostics.map(x => x.code), ['malformed_line', 'incomplete_line']);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /bad json|token_count/);
});

test('source identity mismatch and unsafe or malformed usage fail closed', () => {
  assert.throws(() => parseCodexUsage(`${JSON.stringify({ ...meta, payload: { id: 'other' } })}\n`, { hostId: 'host', threadId: 'thread', sourceRef: 'ref' }), /identity mismatch/i);
  assert.throws(() => parse([meta, token(1, wire(usage({ input: Number.MAX_SAFE_INTEGER + 1 })), wire(usage()))]), /safe integer/i);
  assert.throws(() => parse([meta, token(1, { ...wire(usage()), surprise: 1 }, wire(usage()))]), /unknown field/i);
});

test('parse records are stable for the same explicit source and event position', () => {
  const lines = [meta, token(1, wire(usage()), wire(usage()))];
  assert.deepEqual(parse(lines), parse(lines));
});

test('pre-v2 fixture keeps its independently recorded legacy record ID', () => {
  const legacyText = [
    { type: 'session_meta', payload: { id: 'fixture-worker-01' } },
    { type: 'response_item', payload: { message: 'PRIVATE PROMPT MUST NEVER BE RETAINED' } },
    { type: 'turn_context', payload: { turn_id: 'fixture-turn', model: 'fixture-model' } },
    {
      timestamp: '2026-09-05T00:06:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: wire(usage()), total_token_usage: wire(usage())
      } }
    }
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  const parsed = parseCodexUsage(legacyText, {
    hostId: 'fixture-host', threadId: 'fixture-worker-01', sourceRef: 'synthetic-codex-log'
  });
  assert.equal(parsed.records[0].id, 'usage-31e99c5787c51b18b063ee3be3c4d4f677a385e4511c7e3579892aa13629d779');
});

test('known cache-write wire counters are validated but not counted in normalized usage', () => {
  const last = { ...wire(usage()), cache_write_input_tokens: 7 };
  const cumulative = { ...wire(usage()), cache_write_input_tokens: 9 };
  assert.deepEqual(parse([meta, token(1, last, cumulative)]).records[0].usage, usage());
  assert.throws(() => parse([meta, token(1, { ...last, cache_write_input_tokens: -1 }, cumulative)]), /cache_write_input_tokens/i);
  assert.throws(() => parse([meta, token(1, { ...last, cache_write_input_tokens: 1.5 }, cumulative)]), /cache_write_input_tokens/i);
});

test('validateUsage accepts null usage fields but rejects missing identity, unknown fields and invalid subsets', () => {
  const ledger = empty();
  ledger.records.push(record('partial', { usage: usage({ input: null, cachedInput: null, total: null }) }));
  assert.equal(validateUsage(ledger), ledger);
  for (const mutate of [
    x => { delete x.records[0].hostId; },
    x => { x.records[0].extra = true; },
    x => { x.records[0].usage.input = 100; x.records[0].usage.cachedInput = 101; },
    x => { x.records[0].usage.input = -1; },
    x => { x.records[0].usage = usage({ input: Number.MAX_SAFE_INTEGER, cachedInput: 0, output: 1, reasoningOutput: 0, total: Number.MAX_SAFE_INTEGER }); },
    x => { x.records[0].at = 'not-a-time'; }
  ]) {
    const bad = structuredClone(ledger); mutate(bad); assert.throws(() => validateUsage(bad));
  }
});

test('mergeUsage is immutable, idempotent across key order and rejects conflicting IDs', () => {
  const ledger = empty(), incoming = record();
  const once = mergeUsage(ledger, [incoming]);
  const reordered = { source: { ref: 'u1', kind: 'fixture' }, usage: { total: 120, reasoningOutput: 5, output: 20, cachedInput: 60, input: 100 }, model: null, turnId: null, at: incoming.at, threadId: 'thread', hostId: 'host', id: 'u1' };
  const twice = mergeUsage(once, [reordered]);
  assert.deepEqual(twice, once);
  assert.deepEqual(ledger, empty());
  assert.deepEqual(incoming, record());
  assert.throws(() => mergeUsage(once, [record('u1', { usage: usage({ total: 121 }) })]), /conflicting record/i);
});

test('mergeUsage preserves normalized links and diagnostics and rejects conflicting mappings', () => {
  const linked = empty();
  linked.records = [record()];
  linked.links = [{ recordId: 'u1', roundId: 'r', taskId: 't', memberId: 'w', operation: 'implementation', evidenceRef: 'evidence:1' }];
  linked.diagnostics = [{ code: 'coverage_gap', severity: 'warning', sourceRef: 'ref', line: 3, recordId: 'u1', message: 'Cumulative counter advance differs from observed last usage' }];
  const merged = mergeUsage(linked, [], structuredClone(linked.diagnostics));
  assert.deepEqual(merged, linked);
  const conflict = structuredClone(linked); conflict.links.push({ ...linked.links[0], taskId: 'other' });
  assert.throws(() => validateUsage(conflict), /conflicting mapping/i);
  const noEvidence = structuredClone(linked); noEvidence.links[0].evidenceRef = null;
  assert.throws(() => validateUsage(noEvidence), /evidenceRef/i);
});
