import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoState } from '../src/demo.mjs';
import { evolve, validate } from '../src/runtime.mjs';
import { readState, transact } from '../src/store.mjs';

function apply(s, type, data = {}, actor = 'manager') {
 return evolve(s, { id: `review-${s.version}`, type, actor,
  at: new Date(Date.parse(s.updatedAt) + 60000).toISOString(),
  source: { kind: 'fixture', ref: 'validation-review' }, ...data }, s.version);
}
function hostObserved() {
 const s = demoState();
 const task = s.tasks[0];
 const b = s.rounds.find(r => r.id === task.roundId).members.find(m => m.id === task.workerId).binding;
 task.observations[0].source = { kind: 'host-observation', ref: 'review-repro', hostId: b.hostId, threadId: b.threadId };
 return s;
}
function receiptState() {
 const s = demoState();
 return apply(s, 'reportReceipt', { intentVersion: s.reporting.intentVersion, actual: 'running' });
}

for (const field of ['hostId', 'threadId']) {
 test(`import rejects task observation with mismatched ${field}`, () => {
  const s = hostObserved(); s.tasks[0].observations[0].source[field] = `unrelated-${field}`;
  assert.throws(() => validate(s), /Observation identity mismatch/);
 });
}
test('import accepts correctly bound observation and preserves historical round identity after rebind', () => {
 let s = hostObserved(); assert.equal(validate(s), s);
 for (const original of s.tasks) {
  const data = { roundId: original.roundId, taskId: original.id };
  let task = s.tasks.find(t => t.id === original.id);
  if (task.status === 'blocked') s = apply(s, 'unblock', { ...data, summary: 'resolved' });
  task = s.tasks.find(t => t.id === original.id);
  if (['executing', 'rework'].includes(task.status)) s = apply(s, 'submit', { ...data, summary: 'delivered' }, task.workerId);
  task = s.tasks.find(t => t.id === original.id);
  if (task.status === 'submitted') s = apply(s, 'review', data);
  task = s.tasks.find(t => t.id === original.id);
  if (task.status === 'reviewing') s = apply(s, 'approve', { ...data, summary: 'verified', evidence: ['fixture:test-pass'] });
 }
 s = apply(s, 'closeRound', { roundId: 'round-demo' });
 s = apply(s, 'bindMember', { memberId: 'worker-01', binding: { status: 'bound', hostId: 'new-host', threadId: 'new-thread' } });
 assert.equal(validate(s), s);
 assert.notEqual(s.members.find(m => m.id === 'worker-01').binding.threadId, s.tasks[0].observations[0].source.threadId);
 const bad = structuredClone(s);
 Object.assign(bad.tasks[0].observations[0].source, { hostId: 'new-host', threadId: 'new-thread' });
 assert.throws(() => validate(bad), /Observation identity mismatch/);
});
test('import rejects receipt later than state update', () => {
 const s = receiptState(); s.reporting.offlineReceipt.at = '2099-01-01T00:00:00.000Z';
 assert.throws(() => validate(s), /Timestamp exceeds state update/);
});
test('import accepts legal receipt at or before state update without claiming host confirmation', () => {
 let s = receiptState(); assert.equal(validate(s), s);
 const receiptAt = s.reporting.offlineReceipt.at;
 s = apply(s, 'observe', { roundId: 'round-demo', taskId: 'T-4', observedAt: null, summary: 'later observation', progress: false });
 assert.equal(validate(s), s); assert.ok(receiptAt < s.updatedAt);
 assert.equal(s.reporting.actual, 'unknown');
});
for (const corruption of ['hostId', 'threadId', 'future-receipt']) {
 test(`readState and transact reject ${corruption} without changing stored bytes`, async () => {
  const s = corruption === 'future-receipt' ? receiptState() : hostObserved();
  if (corruption === 'future-receipt') s.reporting.offlineReceipt.at = '2099-01-01T00:00:00.000Z';
  else s.tasks[0].observations[0].source[corruption] = 'unrelated-identity';
  const dir = await mkdtemp(join(tmpdir(), 'team-validation-review-'));
  const file = join(dir, 'state.json'); const bytes = JSON.stringify(s, null, 2) + '\n';
  await writeFile(file, bytes);
  const expected = corruption === 'future-receipt' ? /Timestamp exceeds state update/ : /Observation identity mismatch/;
  await assert.rejects(readState(file), expected);
  assert.equal(await readFile(file, 'utf8'), bytes);
  await assert.rejects(transact(file, s.version, { id: 'would-write', type: 'reports', actor: 'manager', at: s.updatedAt, source: { kind: 'fixture', ref: 'review' }, enabled: false }), expected);
  assert.equal(await readFile(file, 'utf8'), bytes);
 });
}
