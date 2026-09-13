import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServerMcpReport, validateServerMcpReport } from '../src/metrics-mcp-events.mjs';

const daily = () => ({
  schemaVersion: 1, rulesVersion: 1, teamId: 'demo-team', asOf: '2026-09-13T12:00:00.000Z',
  timeZone: 'Asia/Shanghai', from: '2026-09-12', to: '2026-09-13', sourceVersion: 1,
  runtimeVersion: 'unknown', days: [{ date: '2026-09-12' }, { date: '2026-09-13' }], limitations: []
});
const event = (overrides = {}) => ({
  schemaVersion: 1, eventId: '00000000-0000-4000-8000-000000000001',
  startedAt: '2026-09-12T15:59:58.000Z', completedAt: '2026-09-12T16:00:00.000Z', durationMs: 7,
  tool: 'team_context.read', registryId: 'registry-demo', teamId: 'demo-team', memberId: 'worker-1',
  role: 'Worker', hostId: 'host-1', threadId: 'thread-1', memberStatus: 'active',
  identitySource: 'registry-at-call-start', reason: 'resume', reasonSource: 'agent-declared',
  outcome: 'matched', errorCode: null, policyRevision: 2, runtimeRevision: 'runtime-1',
  runtimeRevisionSource: 'operator-declared', ...overrides
});
const input = records => ({ registryId: 'registry-demo', teamId: 'demo-team', sourceKind: 'fixture', records });

test('deduplicates identical key-order variants, keeps retries, sorts, filters cutoff and groups every day', () => {
  const first = event(), duplicate = Object.fromEntries(Object.entries(first).reverse());
  const retry = event({ eventId: '00000000-0000-4000-8000-000000000002', role: 'Manager', reason: 'manual', outcome: 'inactive' });
  const future = event({ eventId: '00000000-0000-4000-8000-000000000003', completedAt: '2026-09-13T12:00:00.001Z' });
  const report = buildServerMcpReport(input([
    { event: retry, sourceRefs: ['z.json'] }, { event: duplicate, sourceRefs: ['b.json'] },
    { event: first, sourceRefs: ['a.json', 'b.json'] }, { event: future, sourceRefs: ['future.json'] }
  ]), daily());
  assert.deepEqual(report.events.map(row => row.event.eventId), [first.eventId, retry.eventId]);
  assert.deepEqual(report.events[0].sourceRefs, ['a.json', 'b.json']);
  assert.deepEqual(report.days, [
    { date: '2026-09-12', observedCalls: 0, byRole: { Manager: 0, Liaison: 0, Worker: 0 }, byReason: { onboarding: 0, resume: 0, post_compaction: 0, before_dispatch: 0, before_delivery: 0, before_review: 0, identity_conflict: 0, manual: 0, unknown: 0 }, byOutcome: { matched: 0, inactive: 0, unmatched: 0, success: 0, error: 0, unexpected_error: 0 } },
    { date: '2026-09-13', observedCalls: 2, byRole: { Manager: 1, Liaison: 0, Worker: 1 }, byReason: { onboarding: 0, resume: 1, post_compaction: 0, before_dispatch: 0, before_delivery: 0, before_review: 0, identity_conflict: 0, manual: 1, unknown: 0 }, byOutcome: { matched: 1, inactive: 1, unmatched: 0, success: 0, error: 0, unexpected_error: 0 } }
  ]);
  assert.equal(report.coverage, 'unverified');
});

test('validates all records before filtering and rejects duplicate conflicts and scope mismatch', () => {
  const outside = event({ completedAt: '2026-09-10T00:00:00.000Z' });
  assert.throws(() => buildServerMcpReport(input([
    { event: outside, sourceRefs: ['a'] }, { event: { ...outside, durationMs: 8 }, sourceRefs: ['b'] }
  ]), daily()), /conflict/i);
  assert.throws(() => buildServerMcpReport({ ...input([]), registryId: 'other', records: [{ event: event(), sourceRefs: ['a'] }] }, daily()), /registry/i);
  assert.throws(() => buildServerMcpReport({ ...input([]), teamId: 'other' }, daily()), /team/i);
});

test('accepts exact producer categories and rejects private, malformed and inconsistent fields', () => {
  const valid = [
    event({ outcome: 'inactive', memberStatus: 'exited' }), event({ outcome: 'unmatched' }),
    event({ tool: 'team_context.manage', outcome: 'success' }),
    event({ tool: 'team_context.startup', outcome: 'error', errorCode: 'INVALID_REQUEST' }),
    event({ outcome: 'unexpected_error', errorCode: null, reason: 'unknown', reasonSource: 'unknown', runtimeRevision: null, runtimeRevisionSource: 'unknown' })
  ];
  valid.forEach((value, index) => assert.doesNotThrow(() => buildServerMcpReport(
    input([{ event: { ...value, eventId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}` }, sourceRefs: ['x'] }]),
    daily()
  )));
  const invalid = [
    event({ prompt: 'secret' }), event({ completedAt: '2026-09-12T16:00:00Z' }), event({ eventId: 'bad' }),
    event({ eventId: ['00000000-0000-4000-8000-000000000001'] }),
    event({ memberId: 'bad id' }), event({ durationMs: Number.MAX_SAFE_INTEGER + 1 }), event({ policyRevision: 0 }),
    event({ role: 'Unknown' }), event({ memberStatus: 'inactive' }), event({ tool: 'other' }), event({ reason: 'other' }),
    event({ reason: 'unknown', reasonSource: 'agent-declared' }), event({ outcome: 'success' }),
    event({ outcome: 'error', errorCode: null }), event({ outcome: 'matched', errorCode: 'SAFE_ERROR' }),
    event({ runtimeRevision: null, runtimeRevisionSource: 'operator-declared' }), event({ runtimeRevision: '', runtimeRevisionSource: 'operator-declared' }),
    event({ eventId: '00000000-0000-4000-8000-00000000000A' })
  ];
  invalid.forEach(value => assert.throws(() => buildServerMcpReport(input([{ event: value, sourceRefs: ['x'] }]), daily())));
});

test('runtimeRevision uses the producer Unicode code-point bound and rejects isolated surrogates', () => {
  assert.doesNotThrow(() => buildServerMcpReport(input([{ event: event({ runtimeRevision: '\ud83d\ude80'.repeat(512) }), sourceRefs: ['x'] }]), daily()));
  assert.throws(() => buildServerMcpReport(input([{ event: event({ runtimeRevision: String.fromCharCode(0xd800) }), sourceRefs: ['x'] }]), daily()));
});

test('report validation rejects out-of-window events and duplicate eventIds', () => {
  const report = buildServerMcpReport(input([{ event: event(), sourceRefs: ['x'] }]), daily());
  const outside = structuredClone(report); outside.events[0].event.completedAt = '2026-09-14T00:00:00.000Z';
  assert.throws(() => validateServerMcpReport(outside, daily()), /range|cutoff|date/i);
  const duplicate = structuredClone(report); duplicate.events.push(structuredClone(duplicate.events[0]));
  assert.throws(() => validateServerMcpReport(duplicate, daily()), /duplicate|order/i);
});

test('uses a locale-independent total order and retains canonically equivalent Unicode source paths', () => {
  const composed = 'C:/e/é.json', decomposed = 'C:/e/e\u0301.json';
  const report = buildServerMcpReport(input([{ event: event(), sourceRefs: [composed, decomposed] }]), daily());
  assert.deepEqual(report.events[0].sourceRefs, [decomposed, composed]);
  assert.equal(validateServerMcpReport(report, daily()), report);
});

test('does not mutate readonly input and rejects tampered derived counts', () => {
  const original = input([{ event: event(), sourceRefs: Object.freeze(['x']) }]);
  Object.freeze(original.records[0].event); Object.freeze(original.records[0]); Object.freeze(original.records); Object.freeze(original);
  const report = buildServerMcpReport(original, daily());
  assert.equal(validateServerMcpReport(report, daily()), report);
  const tampered = structuredClone(report); tampered.days[1].observedCalls = 99;
  assert.throws(() => validateServerMcpReport(tampered, daily()), /count|consistent|derived/i);
});
