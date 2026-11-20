import {readFile,stat,realpath,open,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {prepareWatchdogReminder,readPreparedWatchdogReminder,recordWatchdogQueueResult,reconcileWatchdogReminder,verifyWatchdogReceiptLog} from './watchdog-receipts.mjs';
import {executionFor} from './watchdog-checker.mjs';
const execute=promisify(execFile),registered=new WeakSet();
export const testedLocalQueuePair=Object.freeze({scope:'tested-local-queue-reminders',hostId:'local',clientVersion:'0.167.0-alpha.4.1',binarySha256:'83f5c2dd2ac2902e0d96ba5d8ccdd27d513f57df4a9ab73e06a5a518028e9a2f',hostLogVersion:'0.169.0-alpha.11.1'});
const demand=(ok,message)=>{if(!ok)throw new Error(message);};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const closed=(v,keys)=>demand(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Invalid Watchdog deployment fields');
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function hashWatchdogBinary(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
function managerMatches(config,state){
 const manager=state.members.find(m=>m.role==='Manager');if(state.team.id!==config.teamId||manager?.lifecycle!=='active'||manager.binding.status!=='bound'||manager.binding.hostId!==config.manager.hostId||manager.binding.threadId!==config.manager.threadId)return false;
 return state.rounds.filter(r=>r.status==='open').every(r=>{const old=r.members.find(m=>m.id===manager.id);return old?.lifecycle==='active'&&old.binding.status==='bound'&&old.binding.hostId===manager.binding.hostId&&old.binding.threadId===manager.binding.threadId;});
}
export function watchdogRegisteredStateMatches(registration,state){return managerMatches(registration,state);}
export function watchdogDeploymentAllowed(adapter,statePath,state){return registered.has(adapter)&&adapter.statePath===statePath&&managerMatches(adapter.config,state)&&(!adapter.fixtureOnly||state.team.source.kind==='fixture'&&state.events.every(e=>e.source.kind==='fixture'));}
function buildAdapter(config,{verify,runner,fixtureOnly=false,bodyOverride=null,beforeSend=null,signal=null,capabilityReason='explicit-deployment-required'}){
 Object.freeze(config.manager);Object.freeze(config.binary);Object.freeze(config.log);Object.freeze(config);
 const receiptCache=new Map();let lastValidation=null;
 const ledgerPath=join(config.statePath+'.watchdog','reminder-receipts.json'),markerDirectory=join(config.statePath+'.watchdog','send-once');
 const adapter={statePath:config.statePath,config,fixtureOnly,capability:{status:fixtureOnly?'fixture-only':'tested-local-queue',scope:'reminders-only; loaded local idle/busy observed; not universal',reason:capabilityReason},
  validationStatus:()=>lastValidation??{status:'registered-unchecked'},
  async verify(state,at){try{demand(managerMatches(config,state),'Deployment Manager binding changed');const result=await verify(state,at);lastValidation={status:'verified',at};return result;}catch(e){lastValidation={status:'fault',at};throw e;}},
  async prepare({watchdogAttemptId,anomalies,state,at}){
   await adapter.verify(state,at);const first=anomalies[0];demand(first&&anomalies.every(a=>a.taskId===first.taskId&&a.executionId===first.executionId),'One receipt context required per reminder');
   const body=bodyOverride??JSON.stringify({taskId:first.taskId,executionId:first.executionId,anomalies:anomalies.map(a=>({type:a.type,ref:a.evidence.ref.length<=180?a.evidence.ref:'sha256:'+hash(a.evidence.ref)})),instruction:'Check current task and anomaly validity, then decide under existing authorization. No automatic dispatch or repair. Reply briefly.'});
   return prepareWatchdogReminder({ledgerPath,operationId:watchdogAttemptId,at,body,signal,context:{teamId:state.team.id,taskId:first.taskId,executionId:first.executionId,sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,...config.manager},log:config.log});
  },
  async send({receiptAttemptId,state,at,guard}){
   try{await adapter.verify(state,at);}catch{return {outcome:'not-sent',reason:'pre-marker-capability-unavailable'};}
   let finalGuard=null;try{signal?.throwIfAborted();if(beforeSend)finalGuard=await beforeSend({receiptAttemptId,ledgerPath,state,at});}catch{return {outcome:'not-sent',reason:'pre-marker-idle-observation-unavailable'};}
   const out=await readPreparedWatchdogReminder(ledgerPath,receiptAttemptId);demand(out.hostId===config.manager.hostId&&out.threadId===config.manager.threadId,'Receipt deployment target drift');
   let allowed=false;try{allowed=await guard();}catch{}
   if(!allowed)return {outcome:'not-sent',reason:'fresh-guard-denied-before-marker'};
   if(finalGuard&&!await finalGuard())return {outcome:'not-sent',reason:'fresh-native-idle-guard-denied-before-marker'};
   await mkdir(markerDirectory,{recursive:true});let marker;
   try{marker=await open(join(markerDirectory,receiptAttemptId+'.json'),'wx');}catch(e){if(e.code==='EEXIST')return {outcome:'unknown',reason:'send-once-marker-exists'};throw e;}
   await marker.writeFile(JSON.stringify({receiptAttemptId,payloadSha256:out.payloadSha256,hostId:out.hostId,threadId:out.threadId,at})+'\n');await marker.sync();await marker.close();
   if(signal?.aborted||finalGuard&&!await finalGuard())return {outcome:'unknown',reason:'post-marker-guard-denied-no-retry'};
   // Marker survives every exception. No retry, steer, resume or fallback send.
   let result={outcome:'unknown'};
   try{const raw=await runner(config.binary.path,['queue','--thread',out.threadId,'--message',out.text],{encoding:'utf8',windowsHide:true,shell:false,timeout:15000,maxBuffer:65536});const m=/^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.\r?\n?$/.exec(raw.stdout??'');if(m?.[2]===out.threadId&&!(raw.stderr??'').trim())result={outcome:'queued',queueId:m[1]};}catch{}
   // Differentiate send return time from the earlier intent even on a coarse
   // injected test clock. This records ordering, not host execution evidence.
   await recordWatchdogQueueResult({ledgerPath,attemptId:receiptAttemptId,at:new Date(Math.max(Date.now(),Date.parse(at)+1)).toISOString(),result});return result;
  },
  async reconcile({receiptAttemptId,state,at,taskId,executionId}){
   const task=state.tasks.find(t=>t.id===taskId),currentExecution=task?executionFor(state,task):'missing';
   const info=await stat(config.log.path,{bigint:true}),signature=[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs,currentExecution].join(':');
   const cached=receiptCache.get(receiptAttemptId);
   if(cached?.signature===signature&&cached.result.receiptStatus!=='unknown')return cached.result;
   await adapter.verify(state,at);
   const result=await reconcileWatchdogReminder({ledgerPath,attemptId:receiptAttemptId,at,signal,current:{teamId:state.team.id,taskId,executionId:currentExecution??'unknown',sourceVersion:state.version,...config.manager}});
   receiptCache.set(receiptAttemptId,{signature,result});return result;
  },
 };
 registered.add(adapter);return Object.freeze(adapter);
}
export async function loadWatchdogDeployment(manifestPath,{bodyOverride=null,signal=null}={}){
 if(bodyOverride!==null)demand(typeof bodyOverride==='string'&&bodyOverride.length>0&&bodyOverride.length<=1000,'Invalid controlled reminder override');
 demand(isAbsolute(manifestPath),'Explicit absolute deployment manifest required');const path=await realpath(manifestPath);demand((await stat(path)).size<=65536,'Deployment manifest too large');const bytes=await readFile(path),fingerprint=hash(bytes),manifest=JSON.parse(bytes.toString('utf8'));
 if(manifest?.kind==='watchdog-production-deployment')return loadProductionDeployment({manifest,path,fingerprint,bodyOverride,signal});
 closed(manifest,['schemaVersion','kind','teams']);demand(manifest.schemaVersion===1&&manifest.kind==='watchdog-local-queue-deployment'&&Array.isArray(manifest.teams)&&manifest.teams.length>0&&manifest.teams.length<=100,'Invalid deployment manifest');
 const adapters=new Map();
 for(const row of manifest.teams){
  closed(row,['statePath','teamId','manager','binary','log']);closed(row.manager,['hostId','threadId']);closed(row.binary,['path','sha256','version']);closed(row.log,['path','hostId','threadId','hostLogVersion','queueClientVersion']);
  demand(id(row.teamId)&&id(row.manager.threadId)&&row.manager.hostId==='local','Only explicit local Manager target supported');
  demand(row.binary.sha256===testedLocalQueuePair.binarySha256&&row.binary.version===testedLocalQueuePair.clientVersion&&row.log.hostLogVersion===testedLocalQueuePair.hostLogVersion&&row.log.queueClientVersion===testedLocalQueuePair.clientVersion,'Unvalidated deployment pair');
  demand(row.log.hostId===row.manager.hostId&&row.log.threadId===row.manager.threadId,'Log and Manager target mismatch');
  for(const p of [row.statePath,row.binary.path,row.log.path])demand(typeof p==='string'&&isAbsolute(p),'Exact absolute deployment paths required');
  const config=structuredClone(row);config.statePath=await realpath(row.statePath);config.binary.path=await realpath(row.binary.path);config.log.path=await realpath(row.log.path);
  demand(!adapters.has(config.statePath),'Duplicate registered state');
  const verify=async(_state,at)=>{
   demand(hash(await readFile(path))===fingerprint,'Deployment manifest changed');
   demand(await hashWatchdogBinary(config.binary.path)===config.binary.sha256,'Deployment binary hash drift');
   const v=await execute(config.binary.path,['--version'],{encoding:'utf8',windowsHide:true,shell:false,timeout:10000,maxBuffer:65536});demand(v.stdout.trim()===`codex-cli ${config.binary.version}`,'Deployment client version drift');
   return verifyWatchdogReceiptLog(config.log,at);
  };
  adapters.set(config.statePath,buildAdapter(config,{verify,runner:execute,bodyOverride}));
 }
 return {manifestPath:path,statePaths:[...adapters.keys()],adapterFor:statePath=>adapters.get(statePath)??null};
}
// Deterministic offline seam: never valid for manual/host team ledgers. It cannot
// authorize an arbitrary manifest or run the real executable.
export function fixtureWatchdogDeployment(config,{runner,verify=async()=>{},bodyOverride=null,beforeSend=null,signal=null}){return buildAdapter(config,{runner,verify,fixtureOnly:true,bodyOverride,beforeSend,signal});}

// Formal service registration: all teams get newtasks-only cutover. No profile
// means observe-only; arbitrary version/safe flags never authorize a sender.
async function loadProductionDeployment({manifest,path,fingerprint,bodyOverride,signal}){
 const top=['schemaVersion','kind','teams',...(Object.hasOwn(manifest,'pythonExecutable')?['pythonExecutable']:[])];closed(manifest,top);
 demand(manifest.schemaVersion===1&&Array.isArray(manifest.teams)&&manifest.teams.length>0&&manifest.teams.length<=100,'Invalid production registration');
 if(manifest.pythonExecutable!==undefined)demand(typeof manifest.pythonExecutable==='string'&&isAbsolute(manifest.pythonExecutable),'Explicit Python executable required');
 const modes=new Map(),adapters=new Map(),registrations=[];
 for(const row of manifest.teams){
  const keys=['statePath','teamId','manager','binary','log','mode',...(row.mode==='queue-profile'?['profilePath']:[])];closed(row,keys);closed(row.manager,['hostId','threadId']);closed(row.binary,['path','sha256','version']);closed(row.log,['path','hostId','threadId','hostLogVersion','queueClientVersion']);
  demand(['observe-only','queue-profile'].includes(row.mode)&&id(row.teamId)&&id(row.manager.threadId)&&row.manager.hostId==='local','Invalid production mode/Manager');
  demand(row.log.hostId===row.manager.hostId&&row.log.threadId===row.manager.threadId,'Registered log identity mismatch');
  for(const p of [row.statePath,row.log.path,row.binary.path])demand(typeof p==='string'&&isAbsolute(p),'Explicit production paths required');
  const config=structuredClone(row);config.statePath=await realpath(row.statePath);config.log.path=await realpath(row.log.path);config.binary.path=await realpath(row.binary.path);
  demand(!modes.has(config.statePath),'Duplicate production state');modes.set(config.statePath,row.mode);registrations.push({statePath:config.statePath,teamId:config.teamId,mode:row.mode,manager:config.manager});
  if(row.mode==='observe-only')continue;
  demand(config.binary.sha256===testedLocalQueuePair.binarySha256&&config.binary.version===testedLocalQueuePair.clientVersion&&config.log.queueClientVersion===testedLocalQueuePair.clientVersion,'Production client pair unvalidated');
  demand(typeof row.profilePath==='string'&&isAbsolute(row.profilePath),'Computed exact-log profile required');config.profilePath=await realpath(row.profilePath);demand((await stat(config.profilePath)).size<=65536,'Profile too large');
  const bytes=await readFile(config.profilePath),profileHash=hash(bytes),profile=JSON.parse(bytes),{profileId,...body}=profile;
  demand(profile.kind==='watchdog-native-queue-profile'&&profile.schemaVersion===1&&profileId===hash(JSON.stringify(body)),'Computed profile invalid');
  for(const k of ['path','hostId','threadId','hostLogVersion','queueClientVersion'])demand(profile.log?.[k]===config.log[k],'Production profile exact log mismatch');
  demand(profile.client?.sha256===config.binary.sha256&&profile.client.version===config.binary.version,'Production profile client mismatch');
  const verify=async(_state,at)=>{
   signal?.throwIfAborted();demand(hash(await readFile(path))===fingerprint,'Production manifest changed');demand(hash(await readFile(config.profilePath))===profileHash,'Computed profile changed');
   demand(await hashWatchdogBinary(config.binary.path)===config.binary.sha256,'Production binary hash drift');const v=await execute(config.binary.path,['--version'],{encoding:'utf8',windowsHide:true,shell:false,timeout:10000,maxBuffer:65536});demand(v.stdout.trim()===`codex-cli ${config.binary.version}`,'Production client version drift');
   const {verifyWatchdogQueueProfile}=await import('./watchdog-compatibility.mjs');return verifyWatchdogQueueProfile({profilePath:config.profilePath,log:config.log,client:config.binary,at,signal});
  };
  adapters.set(config.statePath,buildAdapter(config,{verify,runner:execute,bodyOverride,signal,capabilityReason:'queue-profile-registered-revalidated-before-send'}));
 }
 return {manifestPath:path,manifestSha256:fingerprint,statePaths:[...modes.keys()],registrations,requireCutover:true,readOptions:manifest.pythonExecutable?{python:manifest.pythonExecutable}:{},registrationFor:p=>registrations.find(r=>r.statePath===p)??null,adapterFor:p=>adapters.get(p)??null,modeFor:p=>modes.get(p)??'observe-only'};
}
