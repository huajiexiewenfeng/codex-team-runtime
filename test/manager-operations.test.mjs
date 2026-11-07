import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,caller} from './manager-operations-helper.mjs';
import {fingerprint,managerOperationsSchema,validateManagerRequest} from '../src/manager-operations-contract.mjs';
import {dispatchManagerOperation,recordManagerDecision} from '../src/manager-operations-host.mjs';
import {run} from '../src/cli.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ok=r=>{assert.notEqual(r.status,'error',JSON.stringify(r));return r;};
const begin=async(f,title='code')=>{const q=await f.enqueue({title});ok(q.result);ok((await f.dispatch(q)).result);return q;};

for(const mode of ['legacy','observe','queue_first']) {
  for(const kind of ['code','artifact','document'])test(`G01 ${mode} ${kind} exact enqueue/E04/receive/approve`,async t=>{
    const f=await fixture(t,mode),q=await begin(f,kind);
    const summary='中文\r\n'+kind+' 原始证据'.repeat(220);
    const sub=await f.event('submit',{summary},'w'),recv=await f.receive();ok(recv.result);
    assert.equal((await f.raw()).tasks[0].status,'reviewing');
    const dec=await f.decision(recv),d=ok(await f.call(dec));assert.equal(d.effects,'committed');
    assert.equal((await f.call(dec)).replayed,true);
    const s=await f.raw();assert.equal(s.events.find(e=>e.id===sub.id).summary,summary);assert.equal(s.tasks[0].status,'approved');
    assert.equal(s.events.at(-1).summary,dec.summary);assert.equal(q.result.eventId,f.operationEventId(q.request));
    if(mode==='queue_first')ok(await f.settle(recv,d.eventId));
    assert.ok(Buffer.byteLength(JSON.stringify(d))<2048);
  });
  test(`G02 ${mode} rework and two independent submissions`,async t=>{
    const f=await fixture(t,mode);await begin(f);const first=await f.event('submit',{summary:'first'},'w'),r1=await f.receive();ok(r1.result);
    const d1=ok(await f.call(await f.decision(r1,'rework')));if(mode==='queue_first')ok(await f.settle(r1,d1.eventId));
    const second=await f.event('submit',{summary:'second'},'w'),r2=await f.receive();ok(r2.result);assert.notEqual(first.id,second.id);
    const bad=await f.decision(r2,'approve',{submissionId:first.id});assert.equal((await f.call(bad)).reasonCode,'SUBMISSION_CHANGED');
    const badReview=await f.decision(r2,'approve',{reviewEventId:r1.result.eventId});assert.equal((await f.call(badReview)).reasonCode,'REVIEW_REQUIRED');
    ok(await f.call(await f.decision(r2)));assert.equal((await f.raw()).tasks[0].submissions,2);
  });
  test(`G04 ${mode} busy and queued task do not start or send`,async t=>{
    const f=await fixture(t,mode);await begin(f);const q=await f.enqueue({taskId:'next'});ok(q.result);
    const p=await f.dispatch(q);assert.equal(p.result.status,'error');assert.equal(p.result.sendNow,false);
    assert.equal((await f.raw()).tasks.find(t=>t.id==='next').status,'queued');
    const {planDispatch}=await import('../src/scheduling.mjs');assert.equal(planDispatch(await f.raw(),caller,'w').decision,'held');
  });
  test(`G06/G07 ${mode} exact complete replay and input conflict/CAS`,async t=>{
    const f=await fixture(t,mode),q=await f.enqueue();ok(q.result);const before=(await f.raw()).version;
    assert.equal((await f.call(q.request)).replayed,true);
    for(const changed of [{expectedVersion:before},{title:'changed'},{reason:'before_dispatch'}])assert.equal((await f.call({...q.request,...changed})).reasonCode,'OPERATION_CONFLICT');
    assert.equal((await f.raw()).version,before);
    const wrong=await f.base('enqueue',{title:'stale',required:true,briefRef:q.frozen.briefRef,expectedVersion:0});assert.equal((await f.call(wrong)).reasonCode,'VERSION_CONFLICT');
    ok((await f.dispatch(q)).result);await f.event('submit',{summary:'submit'},'w');const recv=await f.receive();ok(recv.result);
    assert.equal((await f.call(recv.request)).replayed,true);
    assert.equal((await f.call({...recv.request,reason:'before_review'})).reasonCode,'OPERATION_CONFLICT');
    assert.equal((await f.raw()).events.filter(e=>e.type==='review').length,1);
    const d=await f.decision(recv);const race=await Promise.all([f.call(d),f.call({...d,operationId:'another-decision'})]);
    assert.equal(race.filter(r=>r.status==='recorded').length,1);assert.equal((await f.raw()).events.filter(e=>e.type==='approve').length,1);
  });
  test(`G08 ${mode} before-write failure / after-write lost response / status`,async t=>{
    const f=await fixture(t,mode);await begin(f);await f.event('submit',{summary:'submit'},'w');const recv=await f.receive();ok(recv.result);const d=await f.decision(recv);
    const fail=phase=>{throw Error(phase);};
    const before=await f.call(d,{fault:phase=>{if(phase==='before-business')fail(phase);}});assert.equal(before.effects,'none');
    const lost=await f.call(d,{fault:phase=>{if(phase==='after-business')fail(phase);}});assert.equal(lost.effects,'unknown');
    const status=await f.base('status',{operationId:d.operationId,requestFingerprint:fingerprint(d),submissionId:d.submissionId});assert.equal((await f.call(status)).effects,'committed');
    assert.equal((await f.call(d)).replayed,true);assert.equal((await f.raw()).events.filter(e=>e.type==='approve').length,1);
    const missing=await f.base('status',{operationId:'not-found',requestFingerprint:'a'.repeat(64)});assert.equal((await f.call(missing)).effects,'unknown');
  });
  test(`G09/G10 ${mode} Manager identity/review/fields/mode rejection before effects`,async t=>{
    const f=await fixture(t,mode);await begin(f);const sub=await f.event('submit',{summary:'submit'},'w');
    const d=await f.base('record_decision',{submissionId:sub.id,reviewEventId:'invented',decision:'approve',summary:'fake',evidence:['reference alone is not proof'],...(mode==='queue_first'?{claim:{runId:'fake',generation:0,claimId:'fake',itemId:'fake'}}:{})});
    const snapshot=await readFile(f.statePath,'utf8');
    assert.equal((await f.call(d)).reasonCode,'REVIEW_REQUIRED');
    for(const [change,field] of [[{caller:{hostId:'fake-host',threadId:'fake-w'}},'$.caller'],[{teamId:'wrong'},'$.teamId'],[{reason:'guess'},'$.reason'],[{at:'2026'},'$.at'],[{expectedVersion:'4'},'$.expectedVersion'],[{mode:'unknown'},'$.mode']]) {
      const out=await f.call({...d,...change});assert.equal(out.status,'error');assert.equal(out.field,field);assert.equal(out.effects,'none');assert.ok(JSON.stringify(out).length<2048);
    }
    assert.equal(await readFile(f.statePath,'utf8'),snapshot);
  });
  test(`G11/G14 ${mode} long evidence rejected; old CLI events interoperate`,async t=>{
    const f=await fixture(t,mode);await begin(f);await f.event('submit',{summary:'原文'.repeat(1900)},'w');const recv=await f.receive();ok(recv.result);
    const d=await f.decision(recv,'approve',{summary:'x'.repeat(4001)});assert.equal((await f.call(d)).field,'$.summary');
    await f.event('approve',{summary:'old independent inspection',evidence:['old fixture check']});
    assert.equal((await f.call(recv.request)).replayed,true);assert.equal((await f.raw()).tasks[0].status,'approved');
  });
}

test('G03 dual Workers and cross-project/PDC optional original materials stay independent',async t=>{
  const f=await fixture(t),a=await f.enqueue({},'project A; no PDC'),b=await f.enqueue({taskId:'b',workerId:'w2'},'project B; PDC reference only');
  ok(a.result);ok(b.result);ok((await f.dispatch(a)).result);ok((await f.dispatch(b)).result);
  await f.event('submit',{summary:'A without PDC'},'w');await f.event('submit',{taskId:'b',summary:'B with PDC'},'w2');
  const ra=await f.receive(),rb=await f.receive({taskId:'b',workerId:'w2'});ok(ra.result);ok(rb.result);
  ok(await f.call(await f.decision(ra)));ok(await f.call(await f.decision(rb,'approve',{taskId:'b',workerId:'w2'})));
  assert.ok((await f.raw()).tasks.every(t=>t.status==='approved'));
});

for(const mode of ['legacy','queue_first'])test(`Manager review regression: ${mode} status refuses another task/Worker/submission`,async t=>{
  const f=await fixture(t,mode),a=await f.enqueue(),b=await f.enqueue({taskId:'b',workerId:'w2'});ok(a.result);ok(b.result);
  const before=await readFile(f.statePath,'utf8');
  const wrong=await f.base('status',{operationId:a.request.operationId,requestFingerprint:fingerprint(a.request),taskId:'b',workerId:'w2'});
  assert.equal((await f.call(wrong)).reasonCode,'OPERATION_SCOPE_CONFLICT');assert.equal(await readFile(f.statePath,'utf8'),before);
  ok((await f.dispatch(a)).result);await f.event('submit',{summary:'exact a'},'w');const recv=await f.receive();ok(recv.result);
  const original=await f.base('status',{operationId:recv.request.operationId,requestFingerprint:fingerprint(recv.request),submissionId:recv.request.submissionId});
  assert.equal((await f.call(original)).taskId,'t');
  assert.equal((await f.call({...original,taskId:'b',workerId:'w2'})).reasonCode,'OPERATION_SCOPE_CONFLICT');
  assert.equal((await f.call({...original,submissionId:'another-submit'})).reasonCode,'OPERATION_SCOPE_CONFLICT');
  assert.equal((await f.call({...original,submissionId:undefined})).status,'error');
  assert.equal((await f.call(recv.request)).replayed,true);
});

test('Manager review regression: missing CLI request yields bounded structured failure',async t=>{
  const f=await fixture(t);let output;
  const result=await run(['manager-request',f.statePath,f.root+'/missing.json'],x=>output=x);
  assert.equal(result.status,'error');assert.equal(result.effects,'none');assert.equal(JSON.parse(output).reasonCode,'INPUT_UNAVAILABLE');
});

test('G10 generated UTC record time leaves original submission time untouched',async t=>{
  const f=await fixture(t);await begin(f);const sub=await f.event('submit',{summary:'original evidence time'},'w');
  const recv=await f.receive({},{at:undefined});ok(recv.result);const state=await f.raw(),review=state.events.find(e=>e.id===recv.result.eventId);
  assert.equal(new Date(review.at).toISOString(),review.at);assert.equal(state.events.find(e=>e.id===sub.id).at,sub.at);
});

test('G05 missing candidate module yields CAPABILITY_UNKNOWN before any state write',async t=>{
  const f=await fixture(t),dir=join(f.root,'partial-companion');await cp(new URL('../src',import.meta.url),dir,{recursive:true});
  await unlink(join(dir,'manager-inbox-contract.mjs'));const before=await readFile(f.statePath,'utf8');
  const output=execFileSync(process.execPath,[join(dir,'cli.mjs'),'manager-request',f.statePath,join(f.root,'request.json')],{encoding:'utf8',windowsHide:true});
  assert.equal(JSON.parse(output).reasonCode,'CAPABILITY_UNKNOWN');assert.equal(JSON.parse(output).effects,'none');assert.equal(await readFile(f.statePath,'utf8'),before);
});

test('Manager review regression: queue_first leader binding revision drift refuses approve unchanged',async t=>{
  const f=await fixture(t,'queue_first');await begin(f);await f.event('submit',{summary:'s'},'w');const recv=await f.receive();ok(recv.result);
  const request=await f.decision(recv),native=JSON.parse(await readFile(f.registryPath,'utf8'));
  native.teams[0].members.find(m=>m.id==='m').binding.revision=2;
  await writeFile(f.registryPath,JSON.stringify(native));
  const before=await readFile(f.statePath,'utf8'),beforeInbox=await readFile(f.statePath+'.manager-inbox.json','utf8');
  assert.equal((await f.inbox('status')).reasonCode,'LEADER_CONFLICT');
  assert.equal((await f.call(request)).reasonCode,'LEADER_CONFLICT');
  assert.equal(await readFile(f.statePath,'utf8'),before);assert.equal(await readFile(f.statePath+'.manager-inbox.json','utf8'),beforeInbox);
});

test('G09 queue_first native team revision drift and stale claim/work owner refuse decision',async t=>{
  const f=await fixture(t,'queue_first');await begin(f);await f.event('submit',{summary:'s'},'w');const recv=await f.receive();ok(recv.result);
  const request=await f.decision(recv),before=await readFile(f.statePath,'utf8');
  assert.equal((await f.call({...request,claim:{...request.claim,generation:request.claim.generation+1}})).reasonCode,'CLAIM_CONFLICT');
  const native=JSON.parse(await readFile(f.registryPath,'utf8'));native.teams[0].revision++;
  await writeFile(f.registryPath,JSON.stringify(native));assert.equal((await f.call(request)).reasonCode,'IDENTITY_CONFLICT');
  assert.equal(await readFile(f.statePath,'utf8'),before);
});

test('G05/G08 queue_first decision commits before resolve; failed resolve never repeats decision',async t=>{
  const f=await fixture(t,'queue_first');await begin(f);await f.event('submit',{summary:'s'},'w');const recv=await f.receive();ok(recv.result);const request=await f.decision(recv),l=await f.ledger();
  const resolveRequest={action:'resolve',operation_id:'resolve-same',actor_host_id:caller.hostId,actor_thread_id:caller.threadId,team_id:'team',reason:'before_review',
    run_id:'run',generation:recv.request.claim.generation,expected_control_revision:0,expected_work_id:l.activeWorkId,item_id:recv.request.claim.itemId,claim_id:recv.request.claim.claimId,disposition:'settle',reason_ref:'actual independent decision'};
  const failed=await recordManagerDecision({statePath:f.statePath,request,resolveRequest,options:f.options});assert.equal(failed.status,'resolve-pending');assert.equal(failed.stages.decision.effects,'committed');
  const recovered=await recordManagerDecision({statePath:f.statePath,request,resolveRequest:{...resolveRequest,expected_control_revision:l.controlRevision},options:f.options});assert.equal(recovered.status,'recorded');
  assert.equal((await f.raw()).events.filter(e=>e.type==='approve').length,1);
});

test('G08 queue_first receive intent/business/projection loss recovers through existing E05',async t=>{
  for(const phase of ['before-review-intent','after-review-intent','before-business','after-business','before-review-projection','after-review-projection']) {
    const f=await fixture(t,'queue_first');await begin(f);await f.event('submit',{summary:'s'},'w');
    const recv=await f.receive({},{fault:p=>{if(p===phase)throw Error('injected');}});assert.equal(recv.result.status,'error');
    if(['after-business','before-review-projection','after-review-projection'].includes(phase))assert.equal(recv.result.effects,'committed',phase);
    if(['after-review-intent','before-business'].includes(phase))assert.equal(recv.result.effects,'partial',phase);
    if(phase==='before-review-intent')assert.equal(recv.result.effects,'none',phase);
    const replay=ok(await f.call(recv.request));assert.equal((await f.raw()).events.filter(e=>e.type==='review').length,1);
    assert.equal((await f.call(recv.request)).replayed,true);
  }
});

test('contract schema/reason authority and CLI bounded return',async t=>{
  const f=await fixture(t),q=await f.enqueue(),sourcePath=fileURLToPath(new URL('../python/src/codex_team_context/observations.py',import.meta.url));
  let text=await readFile(sourcePath,'utf8');
  // The Windows source directory uses transparent at-rest protection. Read
  // through its ordinary host reader when Node sees the encrypted header.
  if(text.startsWith('%TSD-Header-###%')&&process.platform==='win32')text=execFileSync('powershell.exe',['-NoProfile','-Command','Get-Content -LiteralPath $env:MO_REASONS_SOURCE -Raw'],{encoding:'utf8',windowsHide:true,env:{...process.env,MO_REASONS_SOURCE:sourcePath}});
  const reasons=[...text.match(/REASONS = \(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(managerOperationsSchema.oneOf[0].properties.reason.enum,reasons);
  assert.equal(validateManagerRequest(q.request),q.request);
  const path=f.root+'/request.json';await writeFile(path,JSON.stringify({...q.request,reason:'bad'}));
  let output;const result=await run(['manager-request',f.statePath,path],x=>output=x);assert.equal(result.field,'$.reason');assert.equal(JSON.parse(output).effects,'none');
});

test('G06 fixed host flow invokes fake sender at most once; denied/lost results never retry',async t=>{
  for(const outcome of ['accepted','throw','denied']) {
    const f=await fixture(t),q=await f.enqueue({taskId:'already-queued',workerId:'w2'}); // unrelated existing queued work is preserved
    const taskId='fresh',brief={...q.brief,taskId},enqueueInput=await f.base('enqueue',{taskId,title:'fixed flow',required:true});
    let sends=0;const host={authorize:async()=>outcome!=='denied',send:async()=>{sends++;if(outcome==='throw')throw Error('lost native output');return {accepted:true};},result:async()=>({outcome:'accepted',evidence_ref:'fake host receipt',summary:'offline only'})};
    const args={statePath:f.statePath,enqueueInput,brief,prepareInput:{operation_id:'host-prepare',reason:'before_dispatch',admission:{native:{host_id:'fake-host',thread_id:'fake-w',status:'idle',evidence_ref:'fixture idle'}},baseline:{outcome:'not-attempted',evidence_ref:'fixture baseline'}},host,options:f.options};
    const first=await dispatchManagerOperation(args);assert.equal(sends,outcome==='denied'?0:1,JSON.stringify(first));
    await dispatchManagerOperation(args);assert.equal(sends,outcome==='denied'?0:1);
    if(outcome==='accepted')assert.equal(first.stages.result.status,'recorded');
    if(outcome==='throw')assert.equal(first.stages.host.outcome,'unknown');
    if(outcome==='denied')assert.equal(first.reasonCode,'AUTHORIZATION_REQUIRED');
  }
});
