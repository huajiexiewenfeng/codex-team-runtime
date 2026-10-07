import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {demoState} from '../src/demo.mjs';
import {evolve} from '../src/runtime.mjs';
import {runActivityStep} from '../src/activity-workflow.mjs';
import {beginActivity,endActivity} from '../src/stats-activity.mjs';
import {refreshStats,releaseStatsSession} from '../src/stats-collector.mjs';
import {queryStats} from '../src/stats-query.mjs';
import {run} from '../src/cli.mjs';

const at=n=>new Date(Date.UTC(2026,9,6,0,0,n)).toISOString(),ok={exitCode:0,signal:null,errorCode:null};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'runtime-step-workflow-')),cache=join(root,'cache'),statePath=join(root,'state.json'),manifestPath=join(root,'manifest.json'),path=join(root,'activity.jsonl'),receipt=join(root,'workflow.json'),state=demoState(),task=state.tasks.find(t=>t.status==='executing'),worker=state.members.find(m=>m.id===task.workerId);
  const request={...worker.binding,taskId:task.id,roundId:task.roundId,stepId:'verify',evidenceRef:'fixture:explicit-command-attempt'};delete request.status;
  const bindings=[worker,state.members.find(m=>m.id==='worker-03')].map(m=>({memberId:m.id,hostId:m.binding.hostId,threadId:m.binding.threadId,bindingRevision:1,role:m.role,roleEpoch:'fixture-epoch',from:'2000-01-01T00:00:00.000Z',to:'2100-01-01T00:00:00.000Z',evidenceRef:'fixture:binding'}));
  const source={sourceId:'activity',kind:'activity-jsonl',path,adapterVersion:'v1',mutationPolicy:'append-only',authorizedFrom:bindings[0].from,authorizedTo:bindings[0].to,coverageAssertions:{status:'partial',evidenceRef:'fixture:partial'},evidenceRef:'fixture:authorized',bindings,selection:{taskId:task.id,roundId:task.roundId,turnIds:[],itemIds:[]}};
  const stateSource={...source,sourceId:'state',kind:'recorded-state',path:statePath,mutationPolicy:'mutable',bindings:[],selection:{taskId:null,roundId:null,turnIds:[],itemIds:[]}};
  await writeFile(statePath,JSON.stringify(state));await writeFile(manifestPath,JSON.stringify({schemaVersion:'dashboard-sources/v1',teamId:state.team.id,registryId:'fixture-registry',revision:1,authorizationRef:'fixture:workflow-tests',sources:[stateSource,source]}));
  t.after(async()=>{releaseStatsSession(cache);const target=await realpath(root),parent=await realpath(tmpdir());assert.ok(target.startsWith(parent+sep)&&/^runtime-step-workflow-/.test(basename(target)));
    if(process.env.ACTIVITY_WORKFLOW_TEST_EVIDENCE){const evidence=join(process.env.ACTIVITY_WORKFLOW_TEST_EVIDENCE,createHash('sha256').update(t.name).digest('hex').slice(0,12));await mkdir(process.env.ACTIVITY_WORKFLOW_TEST_EVIDENCE,{recursive:true});await cp(target,evidence,{recursive:true,errorOnExist:true,force:false});await writeFile(join(evidence,'case.json'),JSON.stringify({kind:'synthetic fixture; not production',name:t.name,originalTemporaryRoot:root,rerun:'node --test test/activity-workflow.test.mjs',receiptAndManifestPathsAreOriginalEvidence:true},null,2));}
    await rm(target,{recursive:true,force:true,maxRetries:3});});
  const execute=(receiptPath=receipt,command=[process.execPath,'-e',''],options={})=>runActivityStep(statePath,manifestPath,'activity',request,receiptPath,command,{cwd:root,...options});
  return {root,cache,statePath,manifestPath,path,receipt,state,request,execute,bindings};
}
const lines=async f=>(await readFile(f.path,'utf8')).trim().split('\n').map(JSON.parse);
test('actual CLI normal/failed command attempts close once; replay does not execute side effects',async t=>{
  const f=await fixture(t),requestPath=join(f.root,'request.json'),marker=join(f.root,'marker.txt'),command=[process.execPath,'-e',`require('fs').appendFileSync(${JSON.stringify(marker)},'x')`];await writeFile(requestPath,JSON.stringify(f.request));const output=[];
  const args=['stats-step-run',f.statePath,f.manifestPath,'activity',requestPath,f.receipt,'--',...command];await run(args,x=>output.push(JSON.parse(x)));await run(args,x=>output.push(JSON.parse(x)));
  assert.equal(await readFile(marker,'utf8'),'x');assert.deepEqual(output.map(x=>x.replayed),[false,true]);assert.equal((await lines(f)).length,2);
  const failed=await f.execute(join(f.root,'failed.json'),[process.execPath,'-e','process.exit(7)']);assert.equal(failed.outcome.exitCode,7);assert.equal(failed.businessSuccess,false);assert.equal((await lines(f)).length,4);
  const missing=await f.execute(join(f.root,'missing.json'),[join(f.root,'missing-executable')]);assert.equal(missing.outcome.errorCode,'ENOENT');assert.equal(missing.businessSuccess,false);
});
test('one exclusive claim wins; replay while operation is running cannot run it again',async t=>{
  const f=await fixture(t);let entered,release,calls=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const first=f.execute(undefined,undefined,{operation:async()=>{calls++;entered();await gate;return ok;}});await started;
  await assert.rejects(f.execute(),/incomplete_use_new_receipt/);release();await first;assert.equal(calls,1);assert.equal((await lines(f)).length,2);
  // Compete on a genuinely fresh receipt; an already_claimed error proves two
  // contenders passed the absent-journal read and reached exclusive creation.
  const fresh=join(f.root,'simultaneous-first-claim.json');let effects=0;
  const results=await Promise.allSettled(Array.from({length:8},()=>f.execute(fresh,undefined,{operation:async()=>{effects++;await delay(30);return ok;}})));
  assert.equal(effects,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(results.some(r=>r.status==='rejected'&&r.reason.code==='activity_step_already_claimed'));
  for(const r of results.filter(r=>r.status==='rejected'))assert.match(r.reason.message,/already_claimed|incomplete_use_new_receipt/);
  assert.equal(JSON.parse(await readFile(fresh)).phase,'finished');assert.equal((await lines(f)).length,4);
});
test('hard killed wrapper leaves unknown; new attempt excludes downtime and keeps original pending',async t=>{
  const f=await fixture(t),requestPath=join(f.root,'request.json'),marker=join(f.root,'started.txt');await writeFile(requestPath,JSON.stringify(f.request));
  const command=[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`];
  const child=spawn(process.execPath,['src/cli.mjs','stats-step-run',f.statePath,f.manifestPath,'activity',requestPath,f.receipt,'--',...command],{cwd:join(import.meta.dirname,'..'),stdio:'ignore',windowsHide:true});
  const stopped=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});let childPid;
  try{for(let i=0;i<100;i++){try{childPid=Number(await readFile(marker,'utf8'));break;}catch(e){if(e.code!=='ENOENT')throw e;await delay(20);}}assert.ok(Number.isSafeInteger(childPid)&&childPid>0&&childPid!==process.pid);child.kill('SIGKILL');await stopped;}
  finally{child.kill('SIGKILL');if(childPid)try{process.kill(childPid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
  assert.equal(JSON.parse(await readFile(f.receipt)).phase,'running');assert.equal((await lines(f)).length,1);await assert.rejects(f.execute(f.receipt,command,{cwd:join(import.meta.dirname,'..')}),/incomplete_use_new_receipt/);
  // Reconstruct only a synthetic missing-end attempt with the real producer.
  const pendingReceipt=join(f.root,'pending.json');let crashed=false;
  await assert.rejects(f.execute(pendingReceipt,undefined,{now:()=>{if(crashed)throw Error('synthetic_crash_before_finishing');return at(1);},operation:async()=>{crashed=true;return ok;}}),/synthetic_crash_before_finishing/);
  await assert.rejects(f.execute(pendingReceipt),/incomplete_use_new_receipt/);
  let clock=at(100);await f.execute(join(f.root,'resumed.json'),undefined,{now:()=>clock,operation:async()=>{clock=at(102);return ok;}});
  await refreshStats(f.manifestPath,f.cache,{asOf:at(110)});const q=await queryStats(f.cache,{view:'steps',taskId:f.request.taskId,stepId:f.request.stepId,preset:'all'});
  assert.equal(q.data.rows.find(r=>r.startAt===at(1)).durationMs,null);assert.equal(q.data.rows.find(r=>r.startAt===at(100)).durationMs,2000);
});
test('finishing recovery uses saved exit time, rejects scope/state changes, and never re-executes',async t=>{
  const f=await fixture(t);let clock=at(1),calls=0;await f.execute(undefined,undefined,{now:()=>clock,operation:async()=>{calls++;clock=at(3);return ok;}});
  const complete=JSON.parse(await readFile(f.receipt)),producerPath=f.receipt+'.activity.json',producer=JSON.parse(await readFile(producerPath));complete.phase='finishing';producer.endEvent=null;producer.endRecorded=false;delete producer.endOffset;delete producer.endBytes;await writeFile(f.path,JSON.stringify((await lines(f))[0])+'\n');await writeFile(producerPath,JSON.stringify(producer));await writeFile(f.receipt,JSON.stringify(complete));
  const originalState=await readFile(f.statePath);f.state.members.find(m=>m.id==='worker-04').binding.threadId='changed';await writeFile(f.statePath,JSON.stringify(f.state));await assert.rejects(f.execute(),/active team member/);await writeFile(f.statePath,originalState);
  // Non-executing task can replay a fully finished receipt, but not close finishing.
  const blocked=evolve(JSON.parse(originalState),{id:'synthetic-block',type:'block',actor:'manager',at:at(4),source:{kind:'fixture',ref:'synthetic-scope-change'},taskId:f.request.taskId,roundId:f.request.roundId,summary:'Synthetic blocked step'},f.state.version);await writeFile(f.statePath,JSON.stringify(blocked));await assert.rejects(f.execute(),/task_not_executing/);await writeFile(f.statePath,originalState);
  const replay=await f.execute(undefined,undefined,{now:()=>at(100),operation:async()=>{calls++;return ok;}});assert.equal(replay.endAt,at(3));assert.equal(replay.replayed,true);assert.equal(calls,1);assert.equal((await lines(f))[1].at,at(3));
});
test('foreign task/caller, mismatched binding, changed command, and receipt collisions refuse execution',async t=>{
  const f=await fixture(t);let calls=0;for(const change of [{taskId:'T-2'},{threadId:'unknown'},{roundId:'unknown'}])await assert.rejects(runActivityStep(f.statePath,f.manifestPath,'activity',{...f.request,...change},f.receipt,[process.execPath],{operation:async()=>{calls++;return ok;}}));
  for(const target of [f.statePath,f.manifestPath,f.path])await assert.rejects(f.execute(target),/path_collision/);assert.equal(calls,0);
  await f.execute();await assert.rejects(f.execute(undefined,[process.execPath,'-e','changed']),/scope_changed/);
  const manifest=JSON.parse(await readFile(f.manifestPath));manifest.sources[1].bindings[0].threadId='different';await writeFile(f.manifestPath,JSON.stringify(manifest));await assert.rejects(f.execute(join(f.root,'other.json')),/binding_mismatch/);
});
test('parallel same-member attempts union overlaps; another member retains its own interval',async t=>{
  const f=await fixture(t);let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let clockA=at(1),clockB=at(2);
  const first=f.execute(join(f.root,'a.json'),undefined,{now:()=>clockA,operation:async()=>{entered();await gate;clockA=at(5);return ok;}});await started;
  await f.execute(join(f.root,'b.json'),undefined,{now:()=>clockB,operation:async()=>{clockB=at(4);return ok;}});release();await first;
  const b=f.bindings[1],context={teamId:f.state.team.id,memberId:b.memberId,hostId:b.hostId,threadId:b.threadId,bindingRevision:b.bindingRevision,role:b.role,roleEpoch:b.roleEpoch,taskId:f.request.taskId,roundId:f.request.roundId,stepId:'synthetic-second-member',assurance:'worker-declared',evidenceRef:'fixture:second-member-explicit-producer'};
  await beginActivity(f.manifestPath,'activity',context,join(f.root,'second-member.json'),{now:()=>at(2)});await endActivity(f.manifestPath,join(f.root,'second-member.json'),{now:()=>at(3)});
  await refreshStats(f.manifestPath,f.cache,{asOf:at(10)});const q=await queryStats(f.cache,{view:'members',taskId:f.request.taskId,preset:'all'});assert.equal(q.data.rows.find(r=>r.memberId==='worker-04').time.intervals[0].observedUnionMs,4000);assert.equal(q.data.rows.find(r=>r.memberId==='worker-03').time.intervals[0].observedUnionMs,1000);
});
