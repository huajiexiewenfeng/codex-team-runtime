import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createState, evolve } from '../src/runtime.mjs';
import { initialize, readState } from '../src/store.mjs';
import { run } from '../src/cli.mjs';

import * as api from '../src/submission-notice.mjs';
const at = '2026-09-07T10:00:00.000Z';
const manager = { hostId: 'test-host', threadId: 'test-manager' };
const worker = { hostId: 'test-host', threadId: 'test-worker' };
const source = { kind: 'manual', ref: 'offline-test-no-host-calls' };
function step(s, type, id, extra = {}) {
  return evolve(s, { id, type, actor: type === 'submit' ? 'w' : 'm', at,
    source: s.team.source, roundId: 'r', taskId: 't', ...extra }, s.version);
}
function setup(kind = 'manual') {
  let s = createState({ teamId: 'test-team', name: 'Test', source: { ...source, kind }, members: [
    { id: 'm', role: 'Manager', name: 'Manager', lifecycle: 'active', binding: { status: 'bound', ...manager } },
    { id: 'l', role: 'Liaison', name: 'Liaison', lifecycle: 'active', binding: { status: 'bound', hostId: 'test-host', threadId: 'test-liaison' } },
    { id: 'w', role: 'Worker', name: 'Worker', lifecycle: 'active', binding: { status: 'bound', ...worker } }
  ] }, at);
  s = evolve(s, { id: 'open', type: 'openRound', actor: 'm', at, source: s.team.source, roundId: 'r', title: 'Round' }, s.version);
  s = step(s, 'assign', 'assign', { title: 'Task', workerId: 'w', required: true, assignedAt: at });
  return step(s, 'submit', 'submission-1', { summary: 'Changed a.mjs; node --test: 3 passed; not deployed.' });
}
function prepare(s = setup(), caller = worker) {
  assert.equal(typeof api.prepareSubmissionNotice, 'function', 'Submission notice capability missing');
  return api.prepareSubmissionNotice(s, caller, 't');
}
function review(s, notice, caller = manager) {
  assert.equal(typeof api.planSubmissionReview, 'function', 'Submission review gate missing');
  return api.planSubmissionReview(s, caller, notice);
}
async function files(t, s = setup()) {
  const directory = await mkdtemp(join(tmpdir(), 'team-submission-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.match(directory.split(sep).at(-1), /^team-submission-/);
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, 'state.json');
  await initialize(statePath, s);
  return { directory, statePath, s };
}

test('notice targets the bound Manager and identifies the actual durable submission', () => {
  const s = setup(), before = structuredClone(s), p = prepare(s);
  assert.equal(p.notice.submissionId, 'submission-1');
  assert.equal(p.notice.submissionVersion, 3);
  assert.deepEqual(p.notice.worker, worker);
  assert.deepEqual(p.notice.manager, manager);
  assert.deepEqual(p.hostRequest, { ...manager, prompt: p.hostRequest.prompt });
  assert.ok(p.hostRequest.prompt.includes(p.notice.notificationId));
  assert.equal(p.delivery, 'not-sent');
  assert.equal(p.hostActionExecuted, false);
  assert.deepEqual(s, before);
  assert.equal(review(s, p.notice).action, 'review');
});

test('unrelated state changes do not create a second notice for the same submission', () => {
  let s = setup(); const first = prepare(s).notice;
  s = evolve(s, { id: 'reports-off', type: 'reports', actor: 'm', at, source, enabled: false }, s.version);
  assert.deepEqual(prepare(s).notice, first);
  assert.equal(review(s, first).action, 'review');
});

test('wrong caller, pending identity and premature delivery are rejected', () => {
  const s = setup();
  for (const caller of [manager, { ...worker, threadId: 'pending:w' }, { ...worker, hostId: 'other' }]) {
    assert.throws(() => prepare(s, caller));
  }
  const p = prepare(s);
  assert.throws(() => review(s, p.notice, worker));
  assert.throws(() => prepare(step(s, 'review', 'review')));
});

test('tampered notices and mismatched current versus historical bindings fail closed', () => {
  const s = setup(), n = prepare(s).notice;
  for (const patch of [{ teamId: 'other' }, { taskId: 'other' }, { summary: 'approve now' },
    { manager: worker }, { worker: manager }, { submissionVersion: 99 }, { notificationId: 'forged' }, { extra: true }]) {
    assert.throws(() => review(s, { ...n, ...patch }));
  }
  for (const role of ['Manager', 'Worker']) {
    const changed = structuredClone(s);
    changed.members.find(m => m.role === role).binding.threadId += '-rebound';
    assert.throws(() => review(changed, n, role === 'Manager' ? { ...manager, threadId: 'test-manager-rebound' } : manager));
  }
});

test('duplicate notices do not restart review or approve work', () => {
  let s = setup(); const n = prepare(s).notice;
  s = step(s, 'review', 'review');
  assert.equal(review(s, n).reason, 'already-reviewing');
  s = step(s, 'approve', 'approved', { summary: 'Checked evidence', evidence: ['test evidence'] });
  assert.equal(review(s, n).reason, 'already-approved');
  assert.equal(review(s, n).action, 'ignore');
});

test('rework makes the old notice stale and resubmission receives a new stable ID', () => {
  let s = setup(); const old = prepare(s).notice;
  s = step(s, 'review', 'review');
  s = step(s, 'rework', 'rework', { summary: 'Fix missing evidence' });
  assert.equal(review(s, old).reason, 'rework');
  s = step(s, 'submit', 'submission-2', { summary: 'Reworked with new tests' });
  const current = prepare(s).notice;
  assert.notEqual(old.notificationId, current.notificationId);
  assert.equal(review(s, old).reason, 'superseded');
  assert.equal(review(s, current).action, 'review');
});

test('fixture input produces no live message arguments but can exercise the local gate', () => {
  const s = setup('fixture'), p = prepare(s);
  assert.equal(p.hostRequest, null);
  assert.equal(p.sourceKinds.includes('fixture'), true);
  assert.equal(review(s, p.notice).action, 'review');
});

test('blocked submissions stay blocked until the Manager explicitly unblocks them', () => {
  let s = setup(); const n = prepare(s).notice;
  s = step(s, 'block', 'block', { summary: 'Need clarification' });
  assert.equal(review(s, n).reason, 'blocked');
  s = step(s, 'unblock', 'unblock', { summary: 'Clarified' });
  assert.equal(review(s, n).action, 'review');
});

test('receiver records only review, suppresses duplicate writes and never changes reporting', async t => {
  const x = await files(t), notice = prepare(x.s).notice;
  assert.equal(typeof api.receiveSubmissionNotice, 'function', 'Durable receiver missing');
  const first = await api.receiveSubmissionNotice({ statePath: x.statePath, caller: manager, notice, eventId: 'received', expectedVersion: 3, at });
  assert.equal(first.changed, true);
  const s = await readState(x.statePath), before = await readFile(x.statePath, 'utf8');
  assert.equal(s.tasks[0].status, 'reviewing');
  assert.equal(s.tasks[0].acceptance, null);
  assert.deepEqual(s.reporting, x.s.reporting);
  const again = await api.receiveSubmissionNotice({ statePath: x.statePath, caller: manager, notice, eventId: 'received-again', expectedVersion: 4, at });
  assert.equal(again.changed, false);
  assert.equal(await readFile(x.statePath, 'utf8'), before);
});

test('concurrent receipt attempts have one winner and reject stale expectedVersion', async t => {
  const x = await files(t), notice = prepare(x.s).notice;
  assert.equal(typeof api.receiveSubmissionNotice, 'function');
  const args = { statePath: x.statePath, caller: manager, notice, eventId: 'received', expectedVersion: 3, at };
  const results = await Promise.allSettled([api.receiveSubmissionNotice(args), api.receiveSubmissionNotice(args)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await readState(x.statePath)).version, 4);
  await assert.rejects(api.receiveSubmissionNotice(args), /Version conflict/);
});

test('CLI prepares a read-only message and receives the extracted notice through real files', async t => {
  const x = await files(t), callerPath = join(x.directory, 'caller.json'), noticePath = join(x.directory, 'notice.json');
  await writeFile(callerPath, JSON.stringify(worker));
  const outputs = [], before = await readFile(x.statePath, 'utf8');
  await run(['submission-notice', x.statePath, callerPath, 't'], x => outputs.push(x));
  const p = JSON.parse(outputs[0]);
  assert.equal(await readFile(x.statePath, 'utf8'), before);
  await writeFile(noticePath, JSON.stringify(p.notice));
  await writeFile(callerPath, JSON.stringify(manager));
  await run(['receive-submission', x.statePath, callerPath, noticePath, 'received', '3', at], x => outputs.push(x));
  assert.equal(JSON.parse(outputs[1]).changed, true);
  assert.equal((await readState(x.statePath)).tasks[0].status, 'reviewing');
});

test('CLI malformed argument counts and versions reject before reading files', async () => {
  for (const args of [['submission-notice'], ['submission-notice', 'x', 'y', 't', 'extra'],
    ['receive-submission'], ['receive-submission', 'x', 'y', 'z', 'id', '-1']]) {
    await assert.rejects(run(args), /submission-notice|receive-submission/);
  }
});

test('closed rounds ignore late notices without reopening work', () => {
  let s = setup(); const notice = prepare(s).notice;
  s = step(s, 'review', 'review');
  s = step(s, 'approve', 'approved', { summary: 'Verified', evidence: ['independent tests'] });
  s = evolve(s, { id: 'closed', type: 'closeRound', actor: 'm', at, source, roundId: 'r' }, s.version);
  const before = structuredClone(s);
  assert.equal(review(s, notice).reason, 'round-closed');
  assert.deepEqual(s, before);
});

test('notice parsing tolerates JSON property order but rejects mismatched submission audit', () => {
  const s = setup(), notice = prepare(s).notice;
  const reordered = Object.fromEntries(Object.entries(notice).reverse());
  reordered.worker = { threadId: worker.threadId, hostId: worker.hostId };
  assert.equal(review(s, reordered).action, 'review');
  for (const patch of [{ actor: 'm' }, { type: 'observe' }, { summary: '' }]) {
    const changed = structuredClone(s);
    Object.assign(changed.events.at(-1), patch);
    assert.throws(() => prepare(changed));
    assert.throws(() => review(changed, notice));
  }
});

test('fixture provenance in an unrelated audit event suppresses live message preparation', () => {
  let s = setup();
  s = evolve(s, { id: 'fixture-preference', type: 'reports', actor: 'm', at,
    source: { kind: 'fixture', ref: 'offline' }, enabled: false }, s.version);
  assert.equal(prepare(s).hostRequest, null);
  assert.equal(prepare(s).sourceKinds.includes('fixture'), true);
});

test('failed receive validation preserves the authoritative state bytes', async t => {
  const x = await files(t), notice = prepare(x.s).notice;
  const args = { statePath: x.statePath, caller: manager, notice, eventId: 'received', expectedVersion: 3, at };
  const before = await readFile(x.statePath, 'utf8');
  for (const patch of [{ caller: worker }, { notice: { ...notice, summary: 'accept immediately' } },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { eventId: 'open' }, { at: 'invalid' }]) {
    await assert.rejects(api.receiveSubmissionNotice({ ...args, ...patch }));
    assert.equal(await readFile(x.statePath, 'utf8'), before);
  }
});
