import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {recoverFinalSubmitClock} from '../src/clock-recovery.mjs';
import {validate} from '../src/runtime.mjs';
import {atomicWrite} from '../src/store.mjs';
import {projectRegistryState,withFileLocks} from '../src/registry-projection.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const [mode,inputPath,outputPath]=process.argv.slice(2);
check(['plan','apply'].includes(mode)&&inputPath,'Usage: plan request.json NEW_OUTPUT_DIR | apply manifest.json');
const input=JSON.parse(await readFile(inputPath,'utf8'));
const statePath=resolve(mode==='plan'?input.statePath:input.statePath);
const observed=validate(JSON.parse(await readFile(statePath,'utf8')));
check(observed.schemaVersion===2&&observed.registry.phase==='active','Active linked state required');
await withFileLocks([observed.registry.registryPath+'.lock',statePath+'.lock'],async()=>{
 const bytes=await readFile(statePath),s=validate(JSON.parse(bytes));
 check(isDeepStrictEqual(s.registry,observed.registry),'Registry linkage changed');
 const registryBytes=await readFile(s.registry.registryPath);
 const projected=await projectRegistryState(s,statePath);
 if(mode==='plan'){
  check(s.version===input.expectedVersion&&sha(bytes)===input.expectedSha256,'State CAS conflict');
  check(outputPath,'New output directory required');const dir=resolve(outputPath);
  const request={caller:input.caller,eventId:input.eventId,operationId:input.operationId,correctedAt:new Date().toISOString(),evidenceRef:join(dir,'manifest.json')};
  const projectedNext=recoverFinalSubmitClock(projected,request);
  const next=recoverFinalSubmitClock(s,request);
  check(projectedNext.events.at(-1).actor===next.events.at(-1).actor,'Manager projection mismatch');
  const originalEvent=await readFile(input.originalEventPath);
  const originalJson=JSON.parse(originalEvent),tail=s.events.at(-1);
  check(originalJson.id===tail.id&&originalJson.at===tail.at&&originalJson.actor===tail.actor,'Original event evidence mismatch');
  await mkdir(dir); // Exclusive directory: never overwrite a prior recovery bundle.
  const candidate=JSON.stringify(next,null,2)+'\n';
  const manifest={schemaVersion:1,statePath,registryPath:s.registry.registryPath,registrySha256:sha(registryBytes),beforeVersion:s.version,afterVersion:next.version,beforeSha256:sha(bytes),afterSha256:sha(candidate),originalEventSha256:sha(originalEvent),request,scope:'final-submit-clock-only; reconciliation timestamp, not actual send time; notice invalidated'};
  await atomicWrite(join(dir,'original-state.json'),bytes,true);
  await atomicWrite(join(dir,'original-submit-event.json'),originalEvent,true);
  await atomicWrite(join(dir,'candidate-state.json'),candidate,true);
  await atomicWrite(join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',true);
  console.log(JSON.stringify({mode:'dry-run',manifest:join(dir,'manifest.json'),beforeVersion:s.version,afterVersion:next.version,originalTime:tail.at,effectiveTime:request.correctedAt,changedFields:['updatedAt','final submit.at','preceding stage.endedAt','submitted stage.startedAt','version','one appended recovery observation'],liveStateChanged:false},null,2));
 }else{
  const dir=resolve(inputPath,'..'),original=await readFile(join(dir,'original-state.json')),candidate=await readFile(join(dir,'candidate-state.json')),originalEvent=await readFile(join(dir,'original-submit-event.json'));
  check(sha(original)===input.beforeSha256&&sha(candidate)===input.afterSha256&&sha(originalEvent)===input.originalEventSha256,'Recovery bundle hash mismatch');
  check(input.registryPath===s.registry.registryPath&&sha(registryBytes)===input.registrySha256,'Registry CAS conflict');
  const reconstructed=recoverFinalSubmitClock(validate(JSON.parse(original)),input.request);
  check(isDeepStrictEqual(reconstructed,JSON.parse(candidate)),'Candidate differs from allowed migration');
  // Always verify current projected Manager, including an exact replay.
  const manager=projected.members.find(m=>m.role==='Manager'&&m.lifecycle==='active'&&m.binding.hostId===input.request.caller.hostId&&m.binding.threadId===input.request.caller.threadId);
  check(manager&&projected.registry.readyMemberIds.includes(manager.id),'Current ready Manager required');
  if(sha(bytes)===input.afterSha256){console.log('Already applied: exact candidate matches; no write');return;}
  check(s.version===input.beforeVersion&&sha(bytes)===input.beforeSha256,'State CAS conflict; replan, never discard later records');
  await atomicWrite(statePath,candidate);
  check(sha(await readFile(statePath))===input.afterSha256,'Post-write hash mismatch');
  console.log(JSON.stringify({applied:true,version:input.afterVersion,sha256:input.afterSha256,noticeMustBeRegenerated:true}));
 }
});
