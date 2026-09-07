import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createState, evolve } from '../src/runtime.mjs';
import { initialize } from '../src/store.mjs';
import { initReporting, readReporting, transactReporting } from '../src/reporting-store.mjs';
import { planReporting } from '../src/reporting.mjs';

const api = await import('../src/reporting-executor.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const at = n => new Date(Date.UTC(2026, 8, 7, 0, n)).toISOString();
const manager = { hostId: 'test-host', threadId: 'test-manager' };
const liaison = { hostId: 'test-host', threadId: 'test-liaison' };
const owner = { memberId: 'l', ...liaison };
const source = { kind: 'manual', evidenceRef: 'isolated-executor-test' };

async function setup(t, kind = 'manual') {
  const dir = await mkdtemp(join(tmpdir(), 'team-executor-'));
  t.after(async () => {
    const path = await realpath(dir);
    assert.equal(dirname(path), await realpath(tmpdir()));
    assert.ok(basename(path).startsWith('team-executor-'));
    await rm(path, { recursive: true, force: true });
  });
  const statePath = join(dir, 'state.json'), ledgerPath = join(dir, 'ledger.json');
  const businessSource = { kind, ref: 'isolated-executor-test' };
  let state = createState({ teamId: 'test-team', name: 'Test', source: businessSource, members: [
    { id: 'm', name: 'M', role: 'Manager', lifecycle: 'active', binding: { status: 'bound', ...manager } },
    { id: 'l', name: 'L', role: 'Liaison', lifecycle: 'active', binding: { status: 'unbound' } },
    { id: 'w', name: 'W', role: 'Worker', lifecycle: 'active', binding: { status: 'bound', hostId: 'test-host', threadId: 'test-worker' } }
  ] }, at(0));
  for (const event of [
    { id: 'invite', type: 'attachInvite', caller: manager, target: liaison, expiresAt: at(20) },
    { id: 'confirm', type: 'attachConfirm', actor: 'l', caller: liaison, invitationId: 'invite', invitationVersion: 1 },
    { id: 'open', type: 'openRound', roundId: 'r', title: 'Round' }
  ]) state = evolve(state, { actor: 'm', at: at(1), source: businessSource, ...event }, state.version);
  await initialize(statePath, state);
  await initReporting(ledgerPath, statePath, manager, at(2));
  await transactReporting(ledgerPath, statePath, manager, { id: 'prepare', type: 'prepare', at: at(3), expiresAt: at(20), source }, 0);
  return { statePath, ledgerPath, state, options: { statePath, ledgerPath, caller: manager, operationId: 'prepare', expectedVersion: 1, dispatchEventId: 'dispatch', recordEventId: 'record', source, now: () => at(5) } };
}
const receipt = (patch = {}) => ({ owner, automationId: 'test-automation', outcome: 'running', observedAt: at(5), source: { kind: 'host-observation', evidenceRef: 'test-only-normalized-host-receipt' }, ...patch });
function execute(options, host) {
  assert.equal(typeof api.executeReportingOperation, 'function', 'reporting executor capability missing');
  return api.executeReportingOperation({ ...options, host });
}
const adapter = execute => ({ kind: 'native', execute }); // Contract substitute only; never a real host tool.

test('executor persists DISPATCHED before one host call and records the exact receipt without business writes', async t => {
  const x = await setup(t), before = await readFile(x.statePath, 'utf8');
  let calls = 0;
  const result = await execute(x.options, adapter(async request => {
    calls++;
    assert.equal((await readReporting(x.ledgerPath)).operations[0].phase, 'DISPATCHED');
    await assert.rejects(readFile(`${x.ledgerPath}.lock`), { code: 'ENOENT' });
    assert.equal(request.kind, 'CREATE');
    assert.equal(request.automationId, null);
    assert.deepEqual(request.owner, owner);
    assert.equal(request.operationId, 'prepare');
    return receipt();
  }));
  assert.equal(calls, 1);
  assert.equal(result.hostActionInvoked, true);
  assert.equal(result.ledgerRecorded, true);
  assert.equal(result.phase, 'CONFIRMED');
  assert.equal(result.requiresReconciliation, false);
  assert.equal((await readReporting(x.ledgerPath)).automationId, 'test-automation');
  assert.equal(await readFile(x.statePath, 'utf8'), before);
});

test('concurrent executors and a restarted caller cannot invoke the same operation twice', async t => {
  const x = await setup(t);
  let calls = 0;
  const host = adapter(async () => { calls++; return receipt(); });
  const results = await Promise.allSettled([execute(x.options, host), execute(x.options, host)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(calls, 1);
  await assert.rejects(execute({ ...x.options, expectedVersion: 3 }, host));
  assert.equal(calls, 1);
});

test('host exception is recorded UNKNOWN and never automatically retried', async t => {
  const x = await setup(t);
  let calls = 0;
  const host = adapter(async () => { calls++; throw new Error('response lost after possible creation'); });
  const result = await execute(x.options, host);
  assert.equal(result.phase, 'UNKNOWN');
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.ledgerRecorded, true);
  assert.equal((await readReporting(x.ledgerPath)).automationId, null);
  await assert.rejects(execute({ ...x.options, expectedVersion: 3 }, host));
  assert.equal(calls, 1);
});

test('empty, wrong-owner, manual-source and future receipts never become confirmed observations', async t => {
  for (const response of [null, receipt({ owner: { ...owner, threadId: 'wrong' } }), receipt({ source }), receipt({ observedAt: at(6) })]) {
    await t.test(String(response?.observedAt ?? 'empty') + String(response?.owner?.threadId ?? ''), async child => {
      const x = await setup(child);
      const result = await execute(x.options, adapter(async () => response));
      assert.equal(result.phase, 'UNKNOWN');
      assert.equal(result.requiresReconciliation, true);
      assert.equal((await readReporting(x.ledgerPath)).observation, null);
    });
  }
});

test('recording failure preserves DISPATCHED and the returned evidence without replaying the host call', async t => {
  const x = await setup(t);
  let calls = 0;
  const result = await execute(x.options, adapter(async () => {
    calls++;
    await writeFile(`${x.ledgerPath}.lock`, 'another-writer', { flag: 'wx' });
    return receipt();
  }));
  assert.equal(result.ledgerRecorded, false);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.receipt.automationId, 'test-automation');
  assert.equal((await readReporting(x.ledgerPath)).operations[0].phase, 'DISPATCHED');
  await unlink(`${x.ledgerPath}.lock`);
  await assert.rejects(execute({ ...x.options, expectedVersion: 2 }, adapter(async () => { calls++; return receipt(); })));
  assert.equal(calls, 1);
});

test('stale intent, expired preparation, wrong caller and absent adapter stop before dispatch', async t => {
  const x = await setup(t), before = await readFile(x.ledgerPath, 'utf8');
  let calls = 0;
  const host = adapter(async () => { calls++; return receipt(); });
  await assert.rejects(execute({ ...x.options, caller: liaison }, host));
  await assert.rejects(execute({ ...x.options, now: () => at(20) }, host));
  await assert.rejects(execute(x.options, undefined));
  await assert.rejects(execute({ ...x.options, recordEventId: '' }, host));
  for (const timeoutMs of [0, -1, 60001, NaN, '10']) await assert.rejects(execute({ ...x.options, timeoutMs }, host));
  const off = evolve(x.state, { id: 'off', type: 'reports', actor: 'm', at: at(4), source: { kind: 'manual', ref: 'test' }, enabled: false }, x.state.version);
  await writeFile(x.statePath, JSON.stringify(off));
  await assert.rejects(execute(x.options, host));
  assert.equal(calls, 0);
  assert.equal(await readFile(x.ledgerPath, 'utf8'), before);
});

test('fixture data cannot call a native adapter or manufacture a confirmed host receipt', async t => {
  const x = await setup(t, 'fixture');
  let calls = 0;
  await assert.rejects(execute(x.options, adapter(async () => { calls++; return receipt(); })), /fixture/i);
  assert.equal(calls, 0);
  const result = await execute(x.options, { kind: 'fixture', execute: async () => { calls++; return receipt(); } });
  assert.equal(result.phase, 'UNKNOWN');
  assert.equal((await readReporting(x.ledgerPath)).observation, null);
  assert.equal(calls, 1);
});

test('fixture adapter classification remains fixed during an asynchronous call', async t => {
  const x = await setup(t);
  const host = { kind: 'fixture', execute: async () => { host.kind = 'native'; return receipt(); } };
  const result = await execute(x.options, host);
  assert.equal(result.phase, 'UNKNOWN');
  assert.equal((await readReporting(x.ledgerPath)).observation, null);
});

test('a hanging host call times out UNKNOWN; its late completion cannot silently confirm or trigger a retry', { timeout: 1000 }, async t => {
  const x = await setup(t);
  let finish, calls = 0;
  const host = adapter(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const result = await execute({ ...x.options, timeoutMs: 10 }, host);
  assert.equal(result.hostError.name, 'ReportingHostTimeout');
  assert.equal(result.phase, 'UNKNOWN');
  assert.equal(result.requiresReconciliation, true);
  const before = await readFile(x.ledgerPath, 'utf8');
  finish(receipt());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(x.ledgerPath, 'utf8'), before);
  await assert.rejects(execute({ ...x.options, expectedVersion: 3, timeoutMs: 10 }, host));
  assert.equal(calls, 1);
});

test('a pause receipt for another automation cannot replace the known identity', async t => {
  const x = await setup(t);
  await execute(x.options, adapter(async () => receipt()));
  const off = evolve(x.state, { id: 'off', type: 'reports', actor: 'm', at: at(6), source: { kind: 'manual', ref: 'test' }, enabled: false }, x.state.version);
  await writeFile(x.statePath, JSON.stringify(off));
  await transactReporting(x.ledgerPath, x.statePath, manager, { id: 'pause', type: 'prepare', at: at(6), expiresAt: at(20), source }, 3);
  const result = await execute({ ...x.options, operationId: 'pause', expectedVersion: 4, dispatchEventId: 'dispatch-pause', recordEventId: 'record-pause', now: () => at(7) }, adapter(async () => receipt({ automationId: 'wrong-automation', outcome: 'stopped', observedAt: at(7) })));
  const ledger = await readReporting(x.ledgerPath);
  assert.equal(result.phase, 'UNKNOWN');
  assert.equal(result.receipt.automationId, 'wrong-automation');
  assert.equal(ledger.automationId, 'test-automation');
  assert.equal(ledger.observation.outcome, 'running');
});

test('late pause result preserves a new running intent and requests subsequent coordination, not another host call', async t => {
  const x = await setup(t);
  await execute(x.options, adapter(async () => receipt()));
  let state = evolve(x.state, { id: 'off', type: 'reports', actor: 'm', at: at(6), source: { kind: 'manual', ref: 'test' }, enabled: false }, x.state.version);
  await writeFile(x.statePath, JSON.stringify(state));
  await transactReporting(x.ledgerPath, x.statePath, manager, { id: 'pause', type: 'prepare', at: at(6), expiresAt: at(20), source }, 3);
  let now = at(7), calls = 0;
  const result = await execute({ ...x.options, operationId: 'pause', expectedVersion: 4, dispatchEventId: 'dispatch-pause', recordEventId: 'record-pause', now: () => now }, adapter(async request => {
    calls++;
    assert.equal(request.kind, 'PAUSE');
    assert.equal(request.automationId, 'test-automation');
    state = evolve(state, { id: 'on', type: 'reports', actor: 'm', at: at(8), source: { kind: 'manual', ref: 'test' }, enabled: true }, state.version);
    await writeFile(x.statePath, JSON.stringify(state));
    now = at(9);
    return receipt({ outcome: 'stopped', observedAt: now });
  }));
  assert.equal(result.phase, 'CONFIRMED');
  assert.equal(calls, 1);
  const ledger = await readReporting(x.ledgerPath);
  assert.equal(planReporting(state, ledger, manager, at(10)).kind, 'RESUME');
  assert.equal(JSON.parse(await readFile(x.statePath, 'utf8')).reporting.desired, 'running');
});
