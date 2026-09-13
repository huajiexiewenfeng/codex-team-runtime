import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, evolve } from '../src/runtime.mjs';
import { buildMetrics } from '../src/metrics.mjs';
import { buildDailyMetrics } from '../src/metrics-daily.mjs';

const source = { kind: 'fixture', ref: 'metrics-daily-test' };
const utc = value => new Date(value).toISOString();
const member = (id, role, threadId = id) => ({ id, role, name: id, lifecycle: 'active', binding: { status: 'bound', hostId: 'host', threadId } });
function setup() {
  return createState({ teamId: 'team', name: 'Team', source, members: [member('m', 'Manager'), member('l', 'Liaison'), member('w', 'Worker')] }, utc('2026-09-10T00:00:00Z'));
}
function step(state, type, data, at, actor = 'm') {
  return evolve(state, { id: `e-${state.version}-${type}`, type, actor, at: utc(at), source, ...data }, state.version);
}
function assigned() {
  let state = step(setup(), 'openRound', { roundId: 'r', title: 'Round' }, '2026-09-10T00:01:00Z');
  return step(state, 'assign', { roundId: 'r', taskId: 't', title: 'Task', workerId: 'w', required: true, assignedAt: utc('2026-09-10T00:02:00Z') }, '2026-09-10T00:02:00Z');
}
const rec = (id, threadId, at, values = {}, model = null) => ({
  id, hostId: 'host', threadId, at: utc(at), turnId: null, model,
  usage: { input: null, cachedInput: null, output: null, reasoningOutput: null, total: null, ...values },
  source: { kind: 'fixture', ref: id }
});
const ledger = (records = [], links = []) => ({ schemaVersion: 1, teamId: 'team', records, links, diagnostics: [] });
const options = (from = '2026-09-11', to = from, asOf = '2026-09-12T15:00:00.000Z', timeZone) => ({ from, to, asOf, ...(timeZone ? { timeZone } : {}) });
const metric = (known, knownRecords, missingRecords) => ({ known, knownRecords, missingRecords });

test('uses Asia/Shanghai natural days across the UTC 16:00 boundary and excludes records after asOf', () => {
  const records = [
    rec('before', 'w', '2026-09-10T15:59:59Z', { total: 1 }),
    rec('start', 'w', '2026-09-10T16:00:00Z', { total: 2 }),
    rec('end', 'w', '2026-09-11T15:59:59Z', { total: 4 }),
    rec('next', 'w', '2026-09-11T16:00:00Z', { total: 8 }),
    rec('future', 'w', '2026-09-12T15:00:01Z', { total: 16 })
  ];
  const report = buildDailyMetrics(assigned(), ledger(records), options('2026-09-11', '2026-09-12'));
  assert.equal(report.timeZone, 'Asia/Shanghai');
  assert.deepEqual(report.days.map(day => [day.date, day.records, day.totals.total.known]), [
    ['2026-09-11', 2, 6], ['2026-09-12', 1, 8]
  ]);
});

test('uses IANA Asia/Shanghai history instead of assuming a fixed UTC offset', () => {
  const state = createState({ teamId: 'team', name: 'Team', source, members: [member('m', 'Manager'), member('l', 'Liaison'), member('w', 'Worker')] }, utc('1991-09-14T00:00:00Z'));
  const input = ledger([rec('historical-dst', 'm', '1991-09-14T15:30:00Z', { total: 1 })]);
  const report = buildDailyMetrics(state, input, options('1991-09-15', '1991-09-15', '1991-09-15T01:00:00.000Z'));
  assert.equal(report.days[0].records, 1);
});

test('accepts real four-digit dates whose years are between 0000 and 0099', () => {
  const state = createState({ teamId: 'team', name: 'Team', source, members: [member('m', 'Manager'), member('l', 'Liaison'), member('w', 'Worker')] }, utc('0099-01-01T00:00:00Z'));
  const report = buildDailyMetrics(state, ledger(), options('0099-01-01', '0099-01-01', '0099-01-01T12:00:00.000Z'));
  assert.equal(report.days[0].date, '0099-01-01');
});

test('groups every role, member and model while preserving Unknown attribution', () => {
  const state = assigned();
  const records = [
    rec('manager', 'm', '2026-09-11T01:00:00Z', { total: 2 }, 'gpt-a'),
    rec('liaison', 'l', '2026-09-11T01:01:00Z', { total: 3 }, null),
    rec('worker', 'w', '2026-09-11T01:02:00Z', { total: 5 }, 'gpt-a'),
    rec('unknown', 'stranger', '2026-09-11T01:03:00Z', { total: 7 }, 'gpt-b'),
    rec('literal-unknown-model', 'w', '2026-09-11T01:04:00Z', { total: 11 }, 'unknown')
  ];
  const links = [{ recordId: 'liaison', roundId: 'r', taskId: 't', memberId: 'l', operation: 'coordination', evidenceRef: 'proof:l' }];
  const day = buildDailyMetrics(state, ledger(records, links), options()).days[0];
  assert.deepEqual(day.byRole.map(row => row.role), ['Manager', 'Liaison', 'Worker', 'Unknown']);
  assert.deepEqual(day.byRole.map(row => row.metrics.total.known), [2, 3, 16, 7]);
  assert.deepEqual(day.byMember.map(row => [row.memberId, row.role, row.metrics.total.known]), [['m', 'Manager', 2], ['l', 'Liaison', 3], ['w', 'Worker', 16]]);
  assert.deepEqual(day.byModel.map(row => [row.model, row.metrics.total.known]), [['gpt-a', 7], [null, 3], ['gpt-b', 7], ['unknown', 11]]);
  assert.deepEqual(day.coverage, { status: 'unverified', expectedMembers: null, observedMembers: 3, ratio: null });
});

test('keeps missing values distinct from observed zero and never double-counts cache or reasoning', () => {
  const records = [
    rec('zero', 'w', '2026-09-11T01:00:00Z', { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 }),
    rec('partial', 'w', '2026-09-11T01:01:00Z', { output: 3 })
  ];
  const totals = buildDailyMetrics(assigned(), ledger(records), options()).days[0].totals;
  assert.deepEqual(totals.input, metric(0, 1, 1));
  assert.deepEqual(totals.output, metric(3, 2, 0));
  assert.deepEqual(totals.nonCachedInput, metric(0, 1, 1));
  assert.deepEqual(totals.net, metric(0, 1, 1));
  assert.deepEqual(totals.reasoningOutput, metric(0, 1, 1));
});

test('emits every date including blank days with unknown rather than confirmed zero', () => {
  const report = buildDailyMetrics(assigned(), ledger(), options('2026-09-10', '2026-09-12'));
  assert.deepEqual(report.days.map(day => day.date), ['2026-09-10', '2026-09-11', '2026-09-12']);
  for (const day of report.days) {
    assert.equal(day.records, 0);
    assert.deepEqual(day.totals.total, metric(null, 0, 0));
    assert.equal(day.coverage.status, 'unverified');
    assert.deepEqual(day.byRole.map(row => row.metrics.total.known), [null, null, null, null]);
    assert.deepEqual(day.byMember.map(row => row.metrics.total.known), [null, null, null]);
  }
});

test('validates canonical asOf, real dates, ordering, supported zone, maximum range and future days', () => {
  const state = assigned(), input = ledger();
  assert.throws(() => buildDailyMetrics(state, input, options('2026-02-29')), /date/i);
  assert.throws(() => buildDailyMetrics(state, input, options('2026-09-12', '2026-09-11')), /from.*to|range/i);
  assert.throws(() => buildDailyMetrics(state, input, options('2025-01-01', '2026-09-12')), /366|range/i);
  assert.throws(() => buildDailyMetrics(state, input, options('2026-09-11', '2026-09-11', '2026-09-12T15:00:00Z')), /canonical/i);
  assert.throws(() => buildDailyMetrics(state, input, options('2026-09-11', '2026-09-11', '2026-09-12T15:00:00.000Z', 'UTC')), /timeZone|Asia\/Shanghai/i);
  assert.throws(() => buildDailyMetrics(state, input, options('2026-09-13', '2026-09-13')), /future|asOf/i);
  assert.throws(() => buildDailyMetrics(state, input, { ...options(), runtimeVersion: 'current' }), /unknown.*option|runtimeVersion/i);
});

test('daily totals reconcile to the authoritative aggregate and inputs are not modified', () => {
  const state = assigned();
  const input = ledger([
    rec('a', 'w', '2026-09-10T17:00:00Z', { input: 5, cachedInput: 2, output: 3, reasoningOutput: 1, total: 8 }),
    rec('b', 'w', '2026-09-11T17:00:00Z', { input: 7, cachedInput: 3, output: 4, reasoningOutput: 2, total: 11 })
  ]);
  const beforeState = structuredClone(state), beforeLedger = structuredClone(input);
  const report = buildDailyMetrics(state, input, options('2026-09-11', '2026-09-12'));
  const aggregate = buildMetrics(state, input, options().asOf).totals;
  for (const name of Object.keys(aggregate)) {
    assert.equal(report.days.reduce((sum, day) => sum + (day.totals[name].known ?? 0), 0), aggregate[name].known);
    assert.equal(report.days.reduce((sum, day) => sum + day.totals[name].knownRecords, 0), aggregate[name].knownRecords);
    assert.equal(report.days.reduce((sum, day) => sum + day.totals[name].missingRecords, 0), aggregate[name].missingRecords);
  }
  assert.deepEqual(state, beforeState); assert.deepEqual(input, beforeLedger);
});

test('inherits explicit, time-window and shared attribution from buildMetrics', () => {
  const state = assigned();
  const records = [
    rec('explicit', 'l', '2026-09-11T01:00:00Z', { total: 2 }),
    rec('window', 'w', '2026-09-11T01:01:00Z', { total: 3 }),
    rec('shared', 'm', '2026-09-11T01:02:00Z', { total: 5 })
  ];
  const links = [{ recordId: 'explicit', roundId: 'r', taskId: 't', memberId: 'l', operation: 'review', evidenceRef: 'proof' }];
  const day = buildDailyMetrics(state, ledger(records, links), options()).days[0];
  assert.deepEqual(day.byRole.map(row => row.metrics.total.known), [5, 2, 3, null]);
  assert.equal(day.coverage.observedMembers, 3);
});

test('counts approve events on their actual Asia/Shanghai date', () => {
  let state = assigned();
  state = step(state, 'submit', { roundId: 'r', taskId: 't', summary: 'done' }, '2026-09-11T15:57:00Z', 'w');
  state = step(state, 'review', { roundId: 'r', taskId: 't' }, '2026-09-11T15:58:00Z');
  state = step(state, 'approve', { roundId: 'r', taskId: 't', summary: 'ok', evidence: ['fixture'] }, '2026-09-11T16:00:00Z');
  const report = buildDailyMetrics(state, ledger(), options('2026-09-11', '2026-09-12', '2026-09-12T15:00:00.000Z'));
  assert.deepEqual(report.days.map(day => day.approvedTasks), [0, 1]);
});

test('throws on safe-integer overflow within a daily rollup', () => {
  const records = [
    rec('large', 'w', '2026-09-11T01:00:00Z', { total: Number.MAX_SAFE_INTEGER }),
    rec('one', 'w', '2026-09-11T01:01:00Z', { total: 1 })
  ];
  assert.throws(() => buildDailyMetrics(assigned(), ledger(records), options()), /safe integer|exceeds/i);
});

test('returns the independent documented schema and no pricing claims', () => {
  const report = buildDailyMetrics(assigned(), ledger(), options());
  assert.equal(report.schemaVersion, 1); assert.equal(report.rulesVersion, 1);
  assert.equal(report.teamId, 'team'); assert.equal(report.asOf, options().asOf);
  assert.equal(report.from, '2026-09-11'); assert.equal(report.to, '2026-09-11');
  assert.equal(report.sourceVersion, assigned().version); assert.equal(report.runtimeVersion, 'unknown');
  assert.ok(Array.isArray(report.limitations));
  assert.doesNotMatch(JSON.stringify(report), /price|cost|currency/i);
});
