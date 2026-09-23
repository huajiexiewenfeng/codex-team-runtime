import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createState, evolve } from '../src/runtime.mjs';
import { initialize, readState } from '../src/store.mjs';
import { prepareSubmissionNotice, receiveSubmissionNotice } from '../src/submission-notice.mjs';
import { run } from '../src/cli.mjs';
import * as supervision from '../src/supervision.mjs';

const api = await import('../src/submission-recovery.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const at = '2026-09-11T00:00:00.000Z';
const time = seconds => new Date(Date.parse(at) + seconds * 1000).toISOString();
const manager = { hostId: 'test-host', threadId: 'test-manager' };
const worker = { hostId: 'test-host', threadId: 'test-worker' };
const source = { kind: 'manual', ref: 'synthetic-test-no-native-tools' };
const evidence = { kind: 'host-result', ref: 'synthetic:receipt', detail: 'Synthetic host result, not a real receipt' };
const transient = { outcome: 'transient-not-delivered', evidence: { ...evidence,
  kind: 'terminal-nonreceipt', notReceived: true, cannotArrive: true, temporary: true } };
function step(s, type, id, extra = {}) {
  return evolve(s, { id, type, actor: type === 'submit' ? 'w' : 'm', at, source,
    roundId: 'r', taskId: 't', ...extra }, s.version);
}
function setup() {
  let s = createState({ teamId: 'test-team', name: 'Test', source, members: [
    { id: 'm', role: 'Manager', name: 'Manager', lifecycle: 'active', binding: { status: 'bound', ...manager } },
    { id: 'l', role: 'Liaison', name: 'Liaison', lifecycle: 'active', binding: { status: 'bound', hostId: 'test-host', threadId: 'test-liaison' } },
    { id: 'w', role: 'Worker', name: 'Worker', lifecycle: 'active', binding: { status: 'bound', ...worker } }
  ] }, at);
  s = evolve(s, { id: 'open', type: 'openRound', actor: 'm', at, source, roundId: 'r', title: 'Round' }, s.version);
  s = step(s, 'assign', 'assign', { title: 'Task', workerId: 'w', required: true, assignedAt: at });
  return step(s, 'submit', 'submission-1', { summary: 'Synthetic local implementation and tests' });
}
async function files(t) {
  assert.equal(typeof api.trackSubmissionNotice, 'function', 'Durable notification recovery is missing');
  const directory = await mkdtemp(join(tmpdir(), 'team-notice-recovery-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.match(directory.split(sep).at(-1), /^team-notice-recovery-/);
    await rm(directory, { recursive: true, force: true });
  });
  const statePath = join(directory, 'state.json'), state = setup();
  await initialize(statePath, state);
  const notice = prepareSubmissionNotice(state, worker, 't').notice;
  return { directory, state, statePath, caller: worker, notice, expectedVersion: state.version, at };
}
const track = (x, baseline = 'not-attempted') => api.trackSubmissionNotice({ ...x, expectedLedgerVersion: 0,
  baseline: { outcome: baseline, evidence } });
const plan = (x, seconds = 0) => api.planNoticeDelivery({ ...x, at: time(seconds) });
const claim = (x, version, seconds = 0) => api.claimNoticeDelivery({ ...x, expectedLedgerVersion: version, at: time(seconds) });
const record = (x, c, result, seconds = 0) => api.recordNoticeResult({ ...x, expectedLedgerVersion: c.ledgerVersion,
  attemptId: c.attemptId, result, at: time(seconds) });

test('foreground supervision optionally joins existing notification evidence without sending or writing', async t => {
 const x=await files(t);
 assert.equal(typeof supervision.readSupervisionPlan,'function','Missing integrated foreground reader');
 const before=await readFile(x.statePath,'utf8');
 let p=await supervision.readSupervisionPlan(x.statePath,manager);
 assert.equal(p.taskChecks[0].notificationSource,'not-read');
 p=await supervision.readSupervisionPlan(x.statePath,manager,[],{notifications:true});
 assert.equal(p.taskChecks[0].notificationStatus,'unknown');assert.equal(p.taskChecks[0].notificationSource,'not-recorded');
 await assert.rejects(readFile(x.statePath+'.submission-notices.json'),{code:'ENOENT'});
 await track(x,'accepted');const ledgerBefore=await readFile(x.statePath+'.submission-notices.json','utf8');
 let out;await run(['supervision-plan',x.statePath,await callerFile(x),'--notifications'],v=>{out=JSON.parse(v);});
 assert.equal(out.taskChecks[0].notificationStatus,'accepted');assert.equal(out.taskChecks[0].nextAction,'inspect-submission');
 assert.equal(out.notificationRead.evidenceAssurance,'caller-assessed');
 assert.equal(await readFile(x.statePath,'utf8'),before);assert.equal(await readFile(x.statePath+'.submission-notices.json','utf8'),ledgerBefore);
});
async function callerFile(x) {const p=join(x.directory,'manager.json');await writeFile(p,JSON.stringify(manager));return p;}

test('invalid notification ledger is explicit unknown and never hides durable review work',async t=>{
 const x=await files(t);assert.equal(typeof supervision.readSupervisionPlan,'function');
 await writeFile(x.statePath+'.submission-notices.json','{"schemaVersion":1,"teamId":"other"}');
 const p=await supervision.readSupervisionPlan(x.statePath,manager,[],{notifications:true});
 assert.equal(p.notificationRead.status,'error');assert.equal(p.taskChecks[0].notificationStatus,'unknown');
 assert.equal(p.taskChecks[0].notificationSource,'read-error');assert.equal(p.recoverySummary.pendingReview,1);
 await assert.rejects(supervision.readSupervisionPlan(x.statePath,worker,[],{notifications:true}),/Manager/);
});

test('superseded send receipts do not label a new submission as delivered',async t=>{
 const x=await files(t);assert.equal(typeof supervision.readSupervisionPlan,'function');await track(x,'accepted');
 let s=step(x.state,'review','review');s=step(s,'rework','rework',{summary:'Changes needed'});s=step(s,'submit','submission-2',{summary:'New evidence'});
 await writeFile(x.statePath,JSON.stringify(s));
 const p=await supervision.readSupervisionPlan(x.statePath,manager,[],{notifications:true});
 assert.equal(p.taskChecks[0].notificationStatus,'unknown');assert.equal(p.taskChecks[0].notificationSource,'not-recorded');
 assert.equal(p.pendingSubmissions.notices[0].submissionId,'submission-2');
});

test('untracked or legacy-unknown notice cannot silently start a fresh retry budget', async t => {
  const x = await files(t), before = await readFile(x.statePath, 'utf8');
  assert.equal((await plan(x)).reason, 'untracked');
  await assert.rejects(claim(x, 0), /untracked/);
  await track(x, 'unknown');
  assert.equal((await plan(x, 500)).action, 'reconcile');
  await assert.rejects(api.trackSubmissionNotice({ ...x, expectedLedgerVersion: 1,
    baseline: { outcome: 'not-attempted', evidence } }), /already tracked/);
  assert.equal(await readFile(x.statePath, 'utf8'), before);
});

test('durable three-send limit, 5/15 second cooldowns and unchanged transport payload', async t => {
  const x = await files(t), before = await readFile(x.statePath, 'utf8');
  await track(x);
  const sent = [];
  // Simulate only the external transport; all admission/storage below is real.
  async function send(version, seconds) {
    const c = await claim(x, version, seconds);
    sent.push(structuredClone(c.hostRequest));
    assert.equal(c.hostActionExecuted, false);
    assert.equal((await plan(x, seconds)).action, 'reconcile');
    return record(x, c, transient, seconds);
  }
  let r = await send(1, 0);
  assert.equal((await plan(x, 4)).action, 'wait');
  await assert.rejects(claim(x, r.ledgerVersion, 4), /cooldown/);
  r = await send(r.ledgerVersion, 5);
  assert.equal((await plan(x, 19)).action, 'wait');
  r = await send(r.ledgerVersion, 20);
  assert.equal((await plan(x, 100)).reason, 'attempt-limit');
  await assert.rejects(claim(x, r.ledgerVersion, 100), /attempt-limit/);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], sent[1]); assert.deepEqual(sent[1], sent[2]);
  const ledger = JSON.parse(await readFile(x.statePath + '.submission-notices.json', 'utf8'));
  assert.equal(ledger.entries[0].notice.submissionId, x.notice.submissionId);
  assert.deepEqual(ledger.entries[0].notice.manager, manager);
  assert.equal(ledger.entries[0].attempts.length, 3);
  assert.equal(await readFile(x.statePath, 'utf8'), before);
});

test('unknown, timeout and empty reads do not prove non-delivery; precise reconciliation retains audit', async t => {
  const x = await files(t); await track(x); const c = await claim(x, 1);
  const unknown = { outcome: 'unknown', evidence: { kind: 'observation', ref: 'synthetic:empty-items', detail: 'timeout; items=[]; idle' } };
  let r = await record(x, c, unknown);
  assert.equal((await plan(x, 600)).action, 'reconcile');
  await assert.rejects(record(x, { ...c, ledgerVersion: r.ledgerVersion }, { ...unknown, outcome: 'transient-not-delivered' }), /terminal nonreceipt/);
  await assert.rejects(record(x, { ...c, ledgerVersion: r.ledgerVersion }, { ...transient, evidence: { ...transient.evidence, cannotArrive: false } }), /terminal nonreceipt/);
  r = await record(x, { ...c, ledgerVersion: r.ledgerVersion }, transient, 10);
  assert.equal((await plan(x, 14)).action, 'wait');
  assert.equal((await plan(x, 15)).action, 'send');
  const ledger = JSON.parse(await readFile(x.statePath + '.submission-notices.json', 'utf8'));
  assert.deepEqual(ledger.entries[0].attempts[0].observations.map(o => o.result.outcome), ['unknown', 'transient-not-delivered']);
});

test('policy denial keeps exact text and cannot be reclassified or unlocked with approval flags', async t => {
  const x = await files(t); await track(x); const c = await claim(x, 1);
  const denied = { outcome: 'policy-denied', evidence: { ...evidence, detail: 'DENIED: no trusted authorization for exact target' } };
  const r = await record(x, c, denied);
  assert.equal((await plan(x, 500)).reason, 'policy-denied');
  await assert.rejects(claim({ ...x, approved: true }, r.ledgerVersion, 500), /policy-denied/);
  await assert.rejects(record(x, { ...c, ledgerVersion: r.ledgerVersion }, transient, 500), /Terminal/);
  const ledger = JSON.parse(await readFile(x.statePath + '.submission-notices.json', 'utf8'));
  assert.equal(ledger.entries[0].attempts[0].observations[0].result.evidence.detail, denied.evidence.detail);
});

test('accepted delivery never approves or reviews, and cannot be retried', async t => {
  const x = await files(t); await track(x); const c = await claim(x, 1);
  const r = await record(x, c, { outcome: 'accepted', evidence });
  assert.equal((await plan(x, 500)).reason, 'accepted');
  await assert.rejects(claim(x, r.ledgerVersion, 500), /accepted/);
  assert.equal((await readState(x.statePath)).tasks[0].status, 'submitted');
});

test('pending query is Manager-only, read-only and feeds the existing deduplicated receiver', async t => {
  const x = await files(t), before = await readFile(x.statePath, 'utf8');
  const p = api.pendingSubmissions(x.state, manager);
  assert.equal(p.readOnly, true); assert.deepEqual(p.notices, [x.notice]);
  assert.throws(() => api.pendingSubmissions(x.state, worker), /Manager/);
  assert.equal(await readFile(x.statePath, 'utf8'), before);
  const first = await receiveSubmissionNotice({ ...x, caller: manager, eventId: 'receipt', notice: p.notices[0] });
  assert.equal(first.changed, true);
  const second = await receiveSubmissionNotice({ ...x, caller: manager, eventId: 'receipt-again', expectedVersion: first.sourceVersion });
  assert.equal(second.changed, false);
  assert.deepEqual(api.pendingSubmissions(await readState(x.statePath), manager).notices, []);
});

test('Manager may start review before Worker records accepted; receipt is retained without another claim', async t => {
  const x = await files(t); await track(x); const c = await claim(x, 1);
  const received = await receiveSubmissionNotice({ ...x, caller: manager, eventId: 'early-review' });
  const current = { ...x, expectedVersion: received.sourceVersion };
  const r = await record(current, c, { outcome: 'accepted', evidence }, 1);
  assert.equal((await plan(current, 100)).reason, 'already-reviewing');
  await assert.rejects(claim(current, r.ledgerVersion, 100), /already-reviewing/);
  const ledger = JSON.parse(await readFile(x.statePath + '.submission-notices.json', 'utf8'));
  assert.equal(ledger.entries[0].attempts[0].observations[0].result.outcome, 'accepted');
  assert.equal((await readState(x.statePath)).tasks[0].status, 'reviewing');
});

test('fixture provenance cannot produce send claims', async t => {
  const x = await files(t);
  const s = structuredClone(x.state);
  s.team.source.kind = 'fixture';
  await writeFile(x.statePath, JSON.stringify(s));
  await track(x);
  assert.equal((await plan(x)).reason, 'fixture');
  await assert.rejects(claim(x, 1), /fixture/);
});

test('Registry projection errors and non-ready members fail closed, ready projection permits a claim', async t => {
  const x = await files(t);
  const state = { ...x.state, schemaVersion: 2, registry: {
    registryId: 'registry', registryPath: join(x.directory, 'registry.json'), teamId: x.state.team.id,
    migrationId: 'migration', sourceSha256: 'a'.repeat(64), sourceVersion: x.state.version,
    phase: 'active', teamRevision: 1, readyMemberIds: ['m', 'l', 'w']
  } };
  await writeFile(x.statePath, JSON.stringify(state));
  const projection = readyMemberIds => ({ registryId: 'registry', teamId: state.team.id, teamRevision: 2,
    migrationId: 'migration', statePath: x.statePath, members: state.members, readyMemberIds });
  const ready = { ...x, options: { exporter: async () => projection(['m', 'l', 'w']) } };
  await assert.rejects(supervision.readSupervisionPlan(x.statePath,manager,[],{
    notifications:true,exporter:async()=>{throw new Error('registry offline');}
  }), /registry offline/);
  const linkedPlan=await supervision.readSupervisionPlan(x.statePath,manager,[],{...ready.options,notifications:true});
  assert.equal(linkedPlan.recoverySummary.pendingReview,1);
  assert.equal(linkedPlan.taskChecks[0].notificationStatus,'unknown');
  await track(ready);
  for (const members of [['m', 'l'], ['l', 'w']]) {
    await assert.rejects(claim({ ...x, options: { exporter: async () => projection(members) } }, 1), /not Registry ready/);
  }
  await assert.rejects(claim({ ...x, options: { exporter: async () => { throw new Error('registry offline'); } } }, 1), /registry offline/);
  assert.equal((await claim(ready, 1)).attemptCount, 1);
});

test('legacy accepted/denied observations never open a new budget', async t => {
  for (const outcome of ['accepted', 'policy-denied']) {
    const x = await files(t); await track(x, outcome);
    assert.equal((await plan(x, 600)).reason, outcome);
    await assert.rejects(claim(x, 1, 600), new RegExp(outcome));
  }
});

test('durable records survive path aliases; malformed audit is not treated as an empty ledger', async t => {
  const x = await files(t); await track(x); await claim(x, 1);
  assert.equal((await plan({ ...x, statePath: x.directory + '/./state.json' }, 600)).action, 'reconcile');
  const ledgerPath = x.statePath + '.submission-notices.json';
  const original = await readFile(ledgerPath, 'utf8');
  for (const contents of ['{broken', JSON.stringify({ ...JSON.parse(original), version: 0 })]) {
    await writeFile(ledgerPath, contents);
    await assert.rejects(plan(x));
    assert.equal(await readFile(ledgerPath, 'utf8'), contents);
  }
});

test('ledger cannot be transplanted to another state or used with a tampered payload', async t => {
  const x = await files(t); await track(x);
  const ledgerPath = x.statePath + '.submission-notices.json';
  const original = await readFile(ledgerPath, 'utf8');
  const y = await files(t);
  await writeFile(y.statePath + '.submission-notices.json', original);
  await assert.rejects(plan(y), /ledger binding/);
  const changed = JSON.parse(original); changed.entries[0].hostRequest.threadId = 'other-manager';
  await writeFile(ledgerPath, JSON.stringify(changed));
  await assert.rejects(claim(x, 1), /Stored host request changed/);
  assert.equal((await readState(x.statePath)).version, 3);
});

test('review, approval, closure, supersession and changed historical identities fence further claims', async t => {
  for (const kind of ['review', 'approved', 'closed', 'superseded', 'manager', 'worker', 'both-identities']) {
    const x = await files(t); await track(x); const c = await claim(x, 1); const r = await record(x, c, transient);
    let state = structuredClone(x.state);
    if (['review', 'approved', 'closed', 'superseded'].includes(kind)) state = step(state, 'review', 'review');
    if (['approved', 'closed'].includes(kind)) state = step(state, 'approve', 'approve', { summary: 'Checked', evidence: ['synthetic evidence'] });
    if (kind === 'closed') state = evolve(state, { id: 'close', type: 'closeRound', actor: 'm', at, source, roundId: 'r' }, state.version);
    if (kind === 'superseded') {
      state = step(state, 'rework', 'rework', { summary: 'Fix' });
      state = step(state, 'submit', 'submission-2', { summary: 'Fixed' });
    }
    if (['manager', 'worker', 'both-identities'].includes(kind)) {
      state.members.find(m => m.id === (kind === 'worker' ? 'w' : 'm')).binding.threadId += '-changed';
      if (kind === 'both-identities') state.rounds[0].members.find(m => m.id === 'm').binding.threadId += '-changed';
    }
    await writeFile(x.statePath, JSON.stringify(state));
    await assert.rejects(claim({ ...x, expectedVersion: state.version }, r.ledgerVersion, 100));
  }
});

test('concurrent claims reserve at most one send; stale state/ledger versions and wrong attempt fail', async t => {
  const x = await files(t); await track(x);
  await assert.rejects(claim({ ...x, expectedVersion: 2 }, 1), /Version conflict/);
  await assert.rejects(claim({ ...x, caller: manager }, 1), /Worker/);
  const results = await Promise.allSettled([claim(x, 1), claim(x, 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const c = results.find(r => r.status === 'fulfilled').value;
  await assert.rejects(record(x, { ...c, attemptId: 'wrong' }, transient), /attempt/);
  await assert.rejects(record(x, { ...c, ledgerVersion: 1 }, transient), /Ledger version conflict/);
  await assert.rejects(record(x, c, transient, -1), /time/);
});

test('CLI track/plan/claim/result and Manager pending use the real ledger without host calls', async t => {
  const x = await files(t), callerPath = join(x.directory, 'caller.json'), requestPath = join(x.directory, 'request.json');
  await writeFile(callerPath, JSON.stringify(worker));
  await writeFile(requestPath, JSON.stringify({ caller: worker, notice: x.notice, expectedVersion: 3, expectedLedgerVersion: 0,
    at, baseline: { outcome: 'not-attempted', evidence } }));
  async function cli(args) { const out = []; await run(args, value => out.push(value)); return JSON.parse(out[0]); }
  await cli(['notice-track', x.statePath, requestPath]);
  const noticePath = join(x.directory, 'notice.json'); await writeFile(noticePath, JSON.stringify(x.notice));
  assert.equal((await cli(['notice-plan', x.statePath, callerPath, noticePath, at])).action, 'send');
  await writeFile(requestPath, JSON.stringify({ caller: worker, notice: x.notice, expectedVersion: 3, expectedLedgerVersion: 1, at }));
  const c = await cli(['notice-claim', x.statePath, requestPath]);
  await writeFile(requestPath, JSON.stringify({ caller: worker, notice: x.notice, expectedVersion: 3, expectedLedgerVersion: c.ledgerVersion, attemptId: c.attemptId, result: { outcome: 'accepted', evidence }, at }));
  await cli(['notice-result', x.statePath, requestPath]);
  await writeFile(callerPath, JSON.stringify(manager));
  assert.equal((await cli(['pending-submissions', x.statePath, callerPath])).notices.length, 1);
  for (const name of ['notice-track', 'notice-plan', 'notice-claim', 'notice-result', 'pending-submissions']) await assert.rejects(run([name]), new RegExp(name));
});

test('lossless CLI handoff feeds track, claim and result without changing notice or state', async t => {
  const x = await files(t), callerPath = join(x.directory, 'worker.json'), noticePath = join(x.directory, 'notice.json');
  await writeFile(callerPath, JSON.stringify(worker));
  const before = await readFile(x.statePath, 'utf8');
  await run(['submission-notice', x.statePath, callerPath, 't', '--notice-out', noticePath], () => {});
  async function preparedOperation(command, fields) {
    const fieldPath = join(x.directory, `${command}-fields.json`), requestPath = join(x.directory, `${command}-request.json`);
    await writeFile(fieldPath, JSON.stringify({ caller: worker, expectedVersion: 3, at, ...fields }));
    await run(['notice-request', noticePath, fieldPath, requestPath], () => {});
    assert.deepEqual(JSON.parse(await readFile(requestPath, 'utf8')).notice, x.notice);
    const output = [];
    await run([command, x.statePath, requestPath], v => output.push(v));
    return JSON.parse(output[0]);
  }
  const tracked = await preparedOperation('notice-track', { expectedLedgerVersion: 0, baseline: { outcome: 'not-attempted', evidence } });
  const claimed = await preparedOperation('notice-claim', { expectedLedgerVersion: tracked.ledgerVersion });
  const result = await preparedOperation('notice-result', { expectedLedgerVersion: claimed.ledgerVersion,
    attemptId: claimed.attemptId, result: { outcome: 'unknown', evidence } });
  assert.equal(result.ledgerVersion, 3);
  const ledger = JSON.parse(await readFile(x.statePath + '.submission-notices.json', 'utf8'));
  assert.deepEqual(ledger.entries[0].notice, x.notice);
  assert.equal(ledger.entries[0].attempts.length, 1);
  assert.equal(ledger.entries[0].attempts[0].observations[0].result.outcome, 'unknown');
  assert.equal(await readFile(x.statePath, 'utf8'), before);
});
