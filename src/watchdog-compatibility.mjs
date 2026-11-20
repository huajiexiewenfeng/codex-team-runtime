// Bounded metadata preflight and computed, exact-log capability evidence.
// This is not identity authentication or a human authorization file.
import {open,stat,realpath,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {TextDecoder,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {timestamp} from './watchdog-checker.mjs';
import {readWatchdogReceiptEvidence,reconcileWatchdogReminder,inspectWatchdogReceiptProof} from './watchdog-receipts.mjs';
import {classifyWatchdogNativeUser} from './watchdog-native-user.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),execute=promisify(execFile);
const need=(v,s)=>{if(!v)throw new Error(s);};
const closed=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Invalid closed capability profile');
const identity=s=>[s.dev,s.ino].join(':');
const stable=(a,b)=>identity(a)===identity(b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export async function probeWatchdogLongSession({path,hostId,threadId,at=new Date().toISOString()}){
 const now=timestamp(at),canonical=await realpath(path),h=await open(canonical,'r');
 try{
  const s=await h.stat({bigint:true}),size=Number(s.size);need(s.isFile()&&Number.isSafeInteger(size),'Invalid exact log');
  const first=Buffer.alloc(Math.min(size,1024*1024));const f=await h.read(first,0,first.length,0),nl=first.subarray(0,f.bytesRead).indexOf(10);need(nl>=0,'Incomplete bounded first line');
  const firstBytes=first.subarray(0,nl),meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(firstBytes));need(meta.type==='session_meta'&&meta.payload?.id===threadId,'Exact thread mismatch');need(timestamp(meta.timestamp)<=now,'Future session metadata');
  const count=Math.min(size,2*1024*1024),tail=Buffer.alloc(count),offset=size-count;const got=await h.read(tail,0,count,offset);need(got.bytesRead===count&&tail.at(-1)===10,'Incomplete bounded tail');
  const boundary=tail.indexOf(10);need(offset===0||boundary>=0,'Tail boundary missing');const start=offset===0?0:boundary+1;
  const text=new TextDecoder('utf-8',{fatal:true}).decode(tail.subarray(start)),rows=text.trimEnd().split('\n');need(rows.length<=50000,'Tail line budget exceeded');
  const users=new Map(),starts=new Map(),ends=new Map(),unknownUsers=new Set();let lastLifecycle=null;
  for(let i=0;i<rows.length;i++){
   need(Buffer.byteLength(rows[i])<=1024*1024,'Tail line too large');const r=JSON.parse(rows[i]),p=r.payload;need(timestamp(r.timestamp)<=now,'Future tail metadata');
   if(r.type==='response_item'&&p?.type==='message'&&p.role==='user'){const c=classifyWatchdogNativeUser(p);if(c.kind==='user-text')users.set(c.turnId,(users.get(c.turnId)??0)+1);else if(c.kind==='unknown')unknownUsers.add(c.turnId);}
   if(r.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(p?.type)){
    const e={turnId:p.turn_id,type:p.type,at:r.timestamp,startedAt:p.started_at,completedAt:p.completed_at,trigger:p.turn_attribution?.turn_trigger,attributionTurnId:p.turn_attribution?.turn_id};lastLifecycle=e;
    const map=p.type==='task_started'?starts:ends;map.set(e.turnId,[...(map.get(e.turnId)??[]),e]);
   }
  }
  const witnesses=[];
  for(const [turn,ss] of starts){const ee=ends.get(turn)??[];if(ss.length!==1||ee.length!==1||users.get(turn)!==1||unknownUsers.has(turn)||unknownUsers.has(null))continue;const a=ss[0],b=ee[0];if(b.type==='task_complete'&&a.attributionTurnId===turn&&typeof a.trigger==='string'&&Number.isFinite(a.startedAt)&&b.startedAt===a.startedAt&&Number.isFinite(b.completedAt)&&b.completedAt>=a.startedAt&&b.at>=a.at)witnesses.push({turnId:turn,startedAt:a.at,completedAt:b.at,trigger:a.trigger});}
  need(stable(s,await h.stat({bigint:true}))&&stable(s,await stat(canonical,{bigint:true})),'Log changed during bounded preflight');
  return {schemaVersion:1,kind:'watchdog-long-session-readonly-probe',checkedAt:at,path:canonical,hostId,threadId,sessionCreatedVersion:meta.payload.cli_version,sessionSource:meta.payload.source,firstLineSha256:sha(firstBytes),fileIdentity:identity(s),bytes:size,tailBytes:count,tailSha256:sha(tail),structureStatus:witnesses.length?'compatible-native-metadata-observed':'unknown',witnesses:witnesses.slice(-8),lastLifecycle:lastLifecycle?{turnId:lastLifecycle.turnId,type:lastLifecycle.type,at:lastLifecycle.at}:null,hostIdle:'unknown-native-observation-required',queueCompatibility:'unverified-until-new-controlled-probe',fullPrefixHashed:false};
 }finally{await h.close();}
}
export async function createWatchdogQueueProfile({ledgerPath,attemptId,current,client,profilePath,at=new Date().toISOString(),signal=null},{runner=execute}={}){
 timestamp(at);const descriptor=await readWatchdogReceiptEvidence(ledgerPath,attemptId),receipt=await reconcileWatchdogReminder({ledgerPath,attemptId,current,at,signal});signal?.throwIfAborted();need(receipt.receiptStatus==='turn-completed','Controlled queue completion required');
 const bytes=await readFile(client.path);need(sha(bytes)===client.sha256,'Probe client binary hash drift');const version=(await runner(client.path,['--version'],{encoding:'utf8',windowsHide:true,shell:false,timeout:10000,maxBuffer:65536})).stdout.trim();need(version===`codex-cli ${client.version}`,'Probe client version drift');
 const profile={schemaVersion:1,kind:'watchdog-native-queue-profile',scope:'exact-log controlled queue reminder evidence, not authorization',createdAt:at,client:{sha256:client.sha256,version:client.version},log:descriptor.log,fileIdentity:descriptor.baseline.fileIdentity,sourceReceipt:{ledgerPath:await realpath(ledgerPath),attemptId,payloadSha256:descriptor.payloadSha256,current},nativeReminderTurnId:receipt.nativeReminderTurnId,evidence:receipt.evidence};
 const result={...profile,profileId:sha(JSON.stringify(profile))};await writeFile(profilePath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}

// Wrap an actual native wait/read tool result. Its local provenance remains
// caller-provided; this is an observation projection, never an approval token.
export async function captureWatchdogIdleObservation({toolResult,log,path,at=new Date().toISOString()}){
 let value=toolResult;if(value?.content){const texts=value.content.filter(x=>x.type==='text');need(texts.length===1,'Ambiguous native tool result');value=JSON.parse(texts[0].text);}
 need(value&&Array.isArray(value.polls),'Native poll result required');
 const matches=value.polls.filter(p=>p.thread?.id===log.threadId&&p.thread?.hostId===log.hostId);need(matches.length===1,'Exact single native target required');
 const p=matches[0];need(p.thread.status?.type==='idle'&&p.latestTurn?.status==='completed'&&typeof p.latestTurn.id==='string','Native idle completed turn required');
 const readonly=await probeWatchdogLongSession({...log,at});need(readonly.structureStatus==='compatible-native-metadata-observed'&&readonly.lastLifecycle?.type==='task_complete'&&readonly.lastLifecycle.turnId===p.latestTurn.id,'Native idle and exact log lifecycle disagree');
 const result={schemaVersion:1,kind:'watchdog-native-idle-observation',observedAt:at,hostId:log.hostId,threadId:log.threadId,latestTurnId:p.latestTurn.id,toolResultSha256:sha(JSON.stringify(toolResult)),assurance:'caller-provided-native-tool-result-projection',log:{path:readonly.path,fileIdentity:readonly.fileIdentity,bytes:readonly.bytes,tailSha256:readonly.tailSha256}};
 await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
export async function verifyWatchdogQueueProfile({profilePath,log,client,at=new Date().toISOString(),signal=null}){
 signal?.throwIfAborted();
 need((await stat(profilePath)).size<=65536,'Profile size exceeded');const p=JSON.parse(await readFile(profilePath,'utf8')),{profileId,...body}=p;
 closed(p,['schemaVersion','kind','scope','createdAt','client','log','fileIdentity','sourceReceipt','nativeReminderTurnId','evidence','profileId']);closed(p.client,['sha256','version']);closed(p.sourceReceipt,['ledgerPath','attemptId','payloadSha256','current']);
 closed(p.evidence,['logSha256','byteBoundary','lineBoundary','userLine','startLine','terminalLine','terminalType']);
 need(p.scope==='exact-log controlled queue reminder evidence, not authorization'&&p.evidence.terminalType==='task_complete','Unknown profile scope or terminal');
 for(const k of ['byteBoundary','lineBoundary','userLine','startLine','terminalLine'])need(Number.isSafeInteger(p.evidence[k])&&p.evidence[k]>0,'Invalid profile evidence boundary');
 need(p.schemaVersion===1&&p.kind==='watchdog-native-queue-profile'&&profileId===sha(JSON.stringify(body)),'Profile fingerprint invalid');need(timestamp(p.createdAt)<=timestamp(at),'Future capability profile');
 need(p.client?.sha256===client.sha256&&p.client.version===client.version,'Profile client mismatch');
 for(const k of ['path','hostId','threadId','hostLogVersion','queueClientVersion'])need(p.log?.[k]===log[k],'Profile exact log mismatch');
 const d=await readWatchdogReceiptEvidence(p.sourceReceipt.ledgerPath,p.sourceReceipt.attemptId);need(d.payloadSha256===p.sourceReceipt.payloadSha256&&d.baseline.fileIdentity===p.fileIdentity&&JSON.stringify(d.log)===JSON.stringify(p.log),'Profile receipt binding mismatch');
 const receipt=await inspectWatchdogReceiptProof({ledgerPath:p.sourceReceipt.ledgerPath,attemptId:p.sourceReceipt.attemptId,current:p.sourceReceipt.current,at:p.createdAt,byteBoundary:p.evidence.byteBoundary,logSha256:p.evidence.logSha256,signal});signal?.throwIfAborted();need(receipt.receiptStatus==='turn-completed'&&receipt.nativeReminderTurnId===p.nativeReminderTurnId,'Profile fixed native completion invalid');
 for(const k of ['userLine','startLine','terminalLine','terminalType','lineBoundary','byteBoundary'])need(receipt.evidence[k]===p.evidence[k],'Profile native evidence range mismatch');
 return {profileId,scope:p.scope,sessionCreatedVersion:p.log.hostLogVersion,actualNativeQueueEvidence:true,fileIdentity:p.fileIdentity,statSignature:receipt.proofStatSignature,evidenceBoundary:p.evidence.byteBoundary,historicalFixedProof:true};
}
