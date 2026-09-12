import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, evolve } from '../src/runtime.mjs';
import { buildMetrics } from '../src/metrics.mjs';
import { parseCodexUsage } from '../src/metrics-usage.mjs';

const at = n => new Date(Date.UTC(2026, 8, 12, 0, n)).toISOString();
const source = { kind: 'fixture', ref: 'metrics-test' };
const member = (id, role, threadId = id) => ({ id, role, name: id, lifecycle: 'active', binding: { status: 'bound', hostId: 'host', threadId } });
function setup(extra = []) { return createState({ teamId: 'team', name: 'Team', source, members: [member('m', 'Manager'), member('l', 'Liaison'), member('w', 'Worker'), ...extra] }, at(0)); }
function step(state, type, data = {}, n = 1, actor = 'm') { return evolve(state, { id: `e-${state.version}-${type}`, type, actor, at: at(n), source, ...data }, state.version); }
function assigned() { let s = step(setup(), 'openRound', { roundId: 'r', title: 'Round' }); return step(s, 'assign', { roundId: 'r', taskId: 't', title: 'Task', workerId: 'w', required: true, assignedAt: at(2) }, 2); }
function approved(rework = false) { let s = assigned(); s = step(s, 'submit', { roundId: 'r', taskId: 't', summary: 'done' }, 3, 'w'); s = step(s, 'review', { roundId: 'r', taskId: 't' }, 4); if (rework) { s = step(s, 'rework', { roundId: 'r', taskId: 't', summary: 'fix' }, 5); s = step(s, 'submit', { roundId: 'r', taskId: 't', summary: 'fixed' }, 6, 'w'); s = step(s, 'review', { roundId: 'r', taskId: 't' }, 7); } return step(s, 'approve', { roundId: 'r', taskId: 't', summary: 'ok', evidence: ['fixture'] }, rework ? 8 : 5); }
const rec = (id, threadId, minute, values = {}) => ({ id, hostId: 'host', threadId, at: at(minute), turnId: null, model: null, usage: { input: null, cachedInput: null, output: null, reasoningOutput: null, total: null, ...values }, source: { kind: 'fixture', ref: id } });
const ledger = (records = [], links = [], diagnostics = []) => ({ schemaVersion: 1, teamId: 'team', records, links, diagnostics });

test('v2 usage adds a validated explanation while mixed historical records remain explicit unknown evidence', () => {
  const records = [rec('observed', 'w', 3, { input: 10, cachedInput: 5, output: 2, reasoningOutput: 1, total: 12 }), rec('historical', 'm', 4, { total: 3 })];
  const observations = [{ recordId: 'observed', sourceRef: 'observed', firstLine: 1, usageLine: 2, nativeResponse: null, events: [] }];
  const report = buildMetrics(assigned(), { ...ledger(records), schemaVersion: 2, observations }, at(10));
  assert.equal(report.schemaVersion, 2); assert.equal(report.rulesVersion, 1);
  assert.equal(report.explanation.cards.length, 2);
  assert.equal(report.explanation.cards.find(card => card.recordId === 'historical').activity.availability, 'unavailable');
  assert.equal(report.attribution.window.records, 1); assert.equal(report.attribution.shared.records, 1);
});

test('empty metrics remain unknown and include every unobserved task', () => {
  const state = assigned(), beforeState = JSON.stringify(state), input = ledger(), beforeLedger = JSON.stringify(input);
  const report = buildMetrics(state, input, at(10));
  assert.equal(report.schemaVersion, 1); assert.equal(report.rulesVersion, 1); assert.equal(report.teamId, 'team');
  assert.equal(report.sourceVersion, state.version); assert.equal(report.asOf, at(10)); assert.equal(report.readOnly, true);
  assert.deepEqual(report.totals.input, { known: null, knownRecords: 0, missingRecords: 0 });
  assert.equal(report.byTask.length, 1); assert.equal(report.byTask[0].taskId, 't'); assert.equal(report.byTask[0].metrics.total.known, null);
  assert.equal(JSON.stringify(state), beforeState); assert.equal(JSON.stringify(input), beforeLedger);
});

test('all rollups use subset arithmetic without double-counting cache or reasoning', () => {
  const report = buildMetrics(assigned(), ledger([rec('u', 'w', 3, { input: 100, cachedInput: 60, output: 20, reasoningOutput: 5, total: 120 })]), at(10));
  assert.equal(report.totals.input.known, 100); assert.equal(report.totals.cachedInput.known, 60);
  assert.equal(report.totals.nonCachedInput.known, 40); assert.equal(report.totals.output.known, 20);
  assert.equal(report.totals.reasoningOutput.known, 5); assert.equal(report.totals.net.known, 60); assert.equal(report.totals.total.known, 120);
  assert.deepEqual(report.byTask[0].metrics, report.totals);
});

test('explicit mapping wins and exposes only a sanitized evidence assignment', () => {
  const state = assigned();
  const input = ledger([rec('u', 'w', 3, { total: 9 })], [{ recordId: 'u', roundId: 'r', taskId: 't', memberId: 'w', operation: 'review', evidenceRef: 'proof:1' }]);
  const report = buildMetrics(state, input, at(10));
  assert.equal(report.attribution.direct.records, 1); assert.equal(report.byOperation.find(x => x.operation === 'review').metrics.total.known, 9);
  assert.deepEqual(report.attribution.assignments[0], { recordId: 'u', kind: 'explicit', roundId: 'r', taskId: 't', memberId: 'w', role: 'Worker', operation: 'review', evidenceRef: 'proof:1' });
  assert.doesNotMatch(JSON.stringify(report.attribution.assignments), /source|hostId|threadId|fixture/);
});

test('task rows cross Manager explicit usage with Worker window usage by role', () => {
  const state = assigned();
  const records = [rec('manager-task', 'm', 3, { total: 10 }), rec('worker-task', 'w', 3, { total: 3 })];
  const links = [{ recordId: 'manager-task', roundId: 'r', taskId: 't', memberId: 'm', operation: 'coordination', evidenceRef: 'proof:manager' }];
  const task = buildMetrics(state, ledger(records, links), at(10)).byTask[0];
  assert.equal(task.metrics.total.known, 13);
  assert.equal(task.byRole.find(row => row.role === 'Manager').metrics.total.known, 10);
  assert.equal(task.byRole.find(row => row.role === 'Worker').metrics.total.known, 3);
  assert.equal(task.byRole.find(row => row.role === 'Liaison').metrics.total.known, null);
});

test('unique Worker execution interval is inferred with left-closed right-open boundaries and queues are not attributed', () => {
  const state = approved();
  const records = [rec('start', 'w', 2, { total: 1 }), rec('inside', 'w', 4, { total: 2 }), rec('end', 'w', 5, { total: 4 })];
  const report = buildMetrics(state, ledger(records), at(10));
  assert.equal(report.attribution.window.records, 2); assert.equal(report.attribution.unknown.records, 1);
  assert.equal(report.byTask[0].metrics.total.known, 3);
  let queued = step(setup(), 'openRound', { roundId: 'q', title: 'Queue' });
  queued = step(queued, 'enqueue', { caller: { hostId: 'host', threadId: 'm' }, roundId: 'q', taskId: 'queued', title: 'Queued', workerId: 'w', required: true, assignedAt: null }, 2);
  const queuedReport = buildMetrics(queued, ledger([rec('queue-use', 'w', 3, { total: 7 })]), at(10));
  assert.equal(queuedReport.byTask[0].metrics.total.known, null); assert.equal(queuedReport.attribution.unknown.records, 1);
});

test('unlinked Manager use stays shared while unknown identity is never assigned to a member', () => {
  const report = buildMetrics(assigned(), ledger([rec('manager', 'm', 3, { total: 10 }), rec('stranger', 'missing', 3, { total: 20 })]), at(10));
  assert.equal(report.attribution.shared.records, 1); assert.equal(report.attribution.unknown.records, 1);
  assert.equal(report.byMember.find(x => x.memberId === 'm').metrics.total.known, 10);
  assert.equal(report.byRole.find(x => x.role === 'Manager').metrics.total.known, 10);
  assert.equal(report.byRole.find(x => x.role === 'Unknown').metrics.total.known, 20);
});

test('historical identity snapshots are honored and reused identity remains unknown outside a unique task window', () => {
  let state = approved(); state = step(state, 'closeRound', { roundId: 'r' }, 6);
  state = step(state, 'bindMember', { memberId: 'w', binding: { status: 'bound', hostId: 'host', threadId: 'w-new' } }, 7);
  state = step(state, 'bindMember', { memberId: 'l', binding: { status: 'bound', hostId: 'host', threadId: 'w' } }, 8);
  state = step(state, 'openRound', { roundId: 'r2', title: 'Next' }, 9);
  const report = buildMetrics(state, ledger([rec('historical', 'w', 3, { total: 3 }), rec('between', 'w', 8, { total: 8 })]), at(12));
  assert.equal(report.byTask.find(x => x.taskId === 't').metrics.total.known, 3);
  assert.equal(report.attribution.unknown.records, 1);
});

test('identity and member role come only from the record-time round snapshot', () => {
  let state = approved(); state = step(state, 'closeRound', { roundId: 'r' }, 6);
  state = step(state, 'bindMember', { memberId: 'w', binding: { status: 'bound', hostId: 'host', threadId: 'w-new' } }, 7);
  state = step(state, 'bindMember', { memberId: 'l', binding: { status: 'bound', hostId: 'host', threadId: 'w' } }, 8);
  state = step(state, 'openRound', { roundId: 'r2', title: 'Next' }, 9);
  const shared = buildMetrics(state, ledger([rec('new-round-liaison', 'w', 10, { total: 4 })]), at(12));
  assert.equal(shared.attribution.shared.records, 1);
  assert.equal(shared.byMember.find(row => row.memberId === 'l' && row.role === 'Liaison').metrics.total.known, 4);

  const changed = assigned();
  changed.members.find(item => item.id === 'w').role = 'Liaison';
  changed.members.find(item => item.id === 'l').role = 'Worker';
  const historical = buildMetrics(changed, ledger([rec('historical-worker-role', 'w', 3, { total: 3 })]), at(10));
  assert.equal(historical.byMember.find(row => row.memberId === 'w' && row.role === 'Worker').metrics.total.known, 3);
  assert.equal(historical.byMember.find(row => row.memberId === 'w' && row.role === 'Liaison').metrics.total.known, null);
});

test('conflicting identities in overlapping record-time snapshots override a unique task window', () => {
  let state = assigned(); state = step(state, 'openRound', { roundId: 'r2', title: 'Concurrent round' }, 3);
  const concurrent = state.rounds.find(round => round.id === 'r2');
  concurrent.members.find(item => item.id === 'm').binding.threadId = 'w';
  concurrent.members.find(item => item.id === 'w').binding.threadId = 'm';
  const report = buildMetrics(state, ledger([rec('ambiguous-window', 'w', 3, { total: 5 })]), at(10));
  assert.equal(report.attribution.unknown.records, 1);
  assert.equal(report.attribution.assignments[0].kind, 'unknown');
  assert.equal(report.byTask.find(item => item.taskId === 't').metrics.total.known, null);
});

test('sourceKinds combine Team state provenance with observed usage provenance', () => {
  const usageRecord = rec('codex', 'w', 3, { total: 1 }); usageRecord.source = { kind: 'codex-log', ref: 'explicit-log' };
  assert.deepEqual(buildMetrics(assigned(), ledger([usageRecord]), at(10)).sourceKinds, ['codex-log', 'fixture']);
});

test('invalid explicit links, mismatched team and conflicting task mappings fail safely', () => {
  const state = assigned(), record = rec('u', 'w', 3, { total: 1 });
  assert.throws(() => buildMetrics(state, { ...ledger([record]), teamId: 'other' }, at(10)), /team mismatch/i);
  assert.throws(() => buildMetrics(state, ledger([record], [{ recordId: 'u', roundId: 'r', taskId: 't', memberId: 'm', operation: 'review', evidenceRef: 'proof:1' }]), at(10)), /mapping.*identity|worker/i);
  assert.throws(() => buildMetrics(state, ledger([record], [{ recordId: 'u', roundId: 'r', taskId: 'missing', memberId: 'w', operation: 'review', evidenceRef: 'proof:1' }]), at(10)), /mapping.*task/i);
});

test('asOf is canonical, excludes future records, and task timing/rework findings are deterministic', () => {
  const state = approved(true), input = ledger([rec('past', 'w', 3, { total: 2 }), rec('future', 'w', 12, { total: 100 })]);
  assert.throws(() => buildMetrics(state, input, '2026-09-12T00:10:00Z'), /canonical/i);
  assert.throws(() => buildMetrics(state, input, at(7)), /precedes state/i);
  const report = buildMetrics(state, input, at(10));
  assert.equal(report.totals.total.known, 2); assert.equal(report.byTask[0].elapsedMs, 6 * 60000);
  assert.equal(report.byTask[0].submissions, 2); assert.equal(report.byTask[0].reworkCount, 1);
  assert.ok(report.findings.some(x => x.code === 'task_rework'));
  assert.ok(report.limitations.some(x => x.code === 'future_records_excluded' && x.records === 1));
});

test('partial metrics count known and missing records independently and emit data-quality findings', () => {
  const records = [rec('a', 'w', 3, { input: 10, cachedInput: 4, output: 2, reasoningOutput: 1, total: 15 }), rec('b', 'w', 4, { output: 3 })];
  const diagnostics = [{ code: 'coverage_gap', severity: 'warning', sourceRef: 'log', line: 4, recordId: 'b', message: 'Cumulative counter advance differs from observed last usage' }];
  const report = buildMetrics(assigned(), ledger(records, [], diagnostics), at(10));
  assert.deepEqual(report.totals.input, { known: 10, knownRecords: 1, missingRecords: 1 });
  assert.deepEqual(report.totals.output, { known: 5, knownRecords: 2, missingRecords: 0 });
  assert.deepEqual(report.totals.nonCachedInput, { known: 6, knownRecords: 1, missingRecords: 1 });
  assert.ok(report.findings.some(x => x.code === 'usage_missing'));
  assert.ok(report.findings.some(x => x.code === 'source_coverage_gap'));
});

test('known parser coverage warnings survive projection as safe evidence IDs', () => {
  const valid = { timestamp: at(3), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 3 }, total_token_usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 3 } } } };
  const invalid = { timestamp: at(4), type: 'event_msg', payload: { type: 'token_count', info: null, privateText: 'DO_NOT_LEAK' } };
  const parsed = parseCodexUsage(`${JSON.stringify({ type: 'session_meta', payload: { id: 'w' } })}\n${JSON.stringify(valid)}\n${JSON.stringify(invalid)}\n`, { hostId: 'host', threadId: 'w', sourceRef: 'safe-source' });
  const noSession = parseCodexUsage(`${JSON.stringify({ type: 'turn_context', payload: { privateText: 'ALSO_PRIVATE' } })}\n`, { hostId: 'host', threadId: 'unused', sourceRef: 'no-session' });
  assert.deepEqual(parsed.diagnostics.map(item => item.code), ['invalid_token_event']);
  assert.deepEqual(noSession.diagnostics.map(item => item.code), ['missing_session_meta']);
  const finding = buildMetrics(assigned(), ledger(parsed.records, [], [...parsed.diagnostics, ...noSession.diagnostics]), at(10)).findings.find(item => item.code === 'source_coverage_gap');
  assert.deepEqual(finding?.evidenceIds, ['safe-source:3', 'no-session:unknown']);
  assert.doesNotMatch(JSON.stringify(finding), /DO_NOT_LEAK|ALSO_PRIVATE|privateText/);
});

test('submitted and reviewing tasks produce workflow reminders without a waste score', () => {
  let state = assigned(); state = step(state, 'submit', { roundId: 'r', taskId: 't', summary: 'ready' }, 3, 'w');
  const submitted = buildMetrics(state, ledger(), at(10));
  assert.ok(submitted.findings.some(x => x.code === 'task_pending_review'));
  assert.equal(Object.hasOwn(submitted, 'score'), false);
  state = step(state, 'review', { roundId: 'r', taskId: 't' }, 4);
  assert.ok(buildMetrics(state, ledger(), at(10)).findings.some(x => x.code === 'task_review_open'));
});
