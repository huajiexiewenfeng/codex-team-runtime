import {open,stat,realpath,mkdir,readFile} from 'node:fs/promises';
import {resolve,dirname,basename,isAbsolute,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {atomicWrite} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {timestamp} from './watchdog-checker.mjs';
import {classifyWatchdogNativeUser} from './watchdog-native-user.mjs';
export const watchdogReceiptLimits=Object.freeze({logBytes:8*1024*1024,lineBytes:1024*1024,lines:50000,ledgerBytes:32*1024*1024,entries:1000,payloadBytes:12000});
const sha=value=>createHash('sha256').update(value).digest('hex');
const demand=(ok,reason)=>{if(!ok)throw Object.assign(new Error(reason),{receiptReason:reason});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const fields=(v,keys,required=keys)=>demand(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'invalid-receipt-fields');
const defaultBody='Isolated Watchdog reminder receipt test. Reply briefly. No business work is authorized; do not read files or register anything.';
function validateContext(c){fields(c,['teamId','taskId','executionId','sourceVersion','sourceUpdatedAt','hostId','threadId']);for(const k of ['teamId','taskId','executionId','hostId','threadId'])demand(id(c[k]),'invalid-context-id');demand(integer(c.sourceVersion),'invalid-source-version');timestamp(c.sourceUpdatedAt);return c;}
function validateCurrent(c){fields(c,['teamId','taskId','executionId','sourceVersion','hostId','threadId']);for(const k of ['teamId','taskId','executionId','hostId','threadId'])demand(id(c[k]),'invalid-current-id');demand(integer(c.sourceVersion),'invalid-current-version');return c;}
function validateLog(log){fields(log,['path','hostId','threadId','hostLogVersion','queueClientVersion']);demand(isAbsolute(log.path)&&id(log.hostId)&&id(log.threadId),'invalid-exact-log-registration');for(const k of ['hostLogVersion','queueClientVersion'])demand(typeof log[k]==='string'&&log[k].length>0&&log[k].length<=128,'invalid-version-pair');return log;}
const payload=e=>JSON.stringify({kind:'reminder',attemptId:e.attemptId,nonce:e.nonce,teamId:e.context.teamId,taskId:e.context.taskId,executionId:e.context.executionId,sourceVersion:e.context.sourceVersion,body:e.body});
const publicResult=e=>({attemptId:e.attemptId,operationId:e.operationId,nonce:e.nonce,kind:e.kind,phase:e.transport?'transport-recorded':'intent',payloadSha256:e.payloadSha256,transportAccepted:e.transport?.outcome==='queued',transportAssurance:'caller-declared',receiptStatus:e.receipt?.receiptStatus??'unknown',businessHandled:'unknown',businessAccepted:'unknown'});
function validateEntry(e){
 fields(e,['kind','operationId','attemptId','nonce','context','log','preparedAt','body','payloadText','payloadSha256','fingerprint','baseline','transport','receipt','priorReceiptEvidence'],['kind','operationId','attemptId','nonce','context','log','preparedAt','body','payloadText','payloadSha256','fingerprint','baseline','transport','receipt']);
 demand(e.kind==='reminder'&&id(e.operationId)&&id(e.attemptId)&&id(e.nonce),'invalid-reminder-identity');validateContext(e.context);validateLog(e.log);timestamp(e.preparedAt);demand(e.context.sourceUpdatedAt<=e.preparedAt,'future-source-version');
 demand(typeof e.body==='string'&&e.body.length>0&&e.body.length<=1000&&e.body.isWellFormed(),'invalid-controlled-body');
 demand(e.payloadText===payload(e)&&Buffer.byteLength(e.payloadText)<=watchdogReceiptLimits.payloadBytes&&sha(e.payloadText)===e.payloadSha256&&hex(e.fingerprint),'invalid-persisted-payload');
 fields(e.baseline,['bytes','sha256','fileIdentity','sessionThreadId','hostLogVersion','hostLogSource','statSignature'],['bytes','sha256','fileIdentity','sessionThreadId','hostLogVersion','hostLogSource']);demand(integer(e.baseline.bytes)&&hex(e.baseline.sha256)&&typeof e.baseline.fileIdentity==='string'&&e.baseline.sessionThreadId===e.context.threadId&&e.baseline.hostLogVersion===e.log.hostLogVersion,'invalid-log-baseline');
 if(e.transport){fields(e.transport,['outcome','at','queueId'],['outcome','at']);timestamp(e.transport.at);demand(e.transport.at>e.preparedAt&&['queued','unknown'].includes(e.transport.outcome),'invalid-transport-record');if(e.transport.queueId!==undefined)demand(id(e.transport.queueId),'invalid-queue-id');}
 if(e.receipt){demand(['unknown','consumed','turn-completed','turn-interrupted'].includes(e.receipt.receiptStatus)&&e.receipt.attemptId===e.attemptId&&e.receipt.businessHandled==='unknown'&&e.receipt.businessAccepted==='unknown','invalid-receipt-result');timestamp(e.receipt.checkedAt);}
 if(e.priorReceiptEvidence!==undefined){demand(Array.isArray(e.priorReceiptEvidence)&&e.priorReceiptEvidence.length<=8,'invalid-prior-receipt-evidence');for(const r of e.priorReceiptEvidence){fields(r,['receiptStatus','checkedAt','nativeReminderTurnId','evidence']);timestamp(r.checkedAt);demand(['consumed','turn-completed','turn-interrupted'].includes(r.receiptStatus)&&id(r.nativeReminderTurnId)&&hex(r.evidence?.logSha256),'invalid-prior-receipt-evidence');}}
 return e;
}
async function ledgerFile(path){
 demand(typeof path==='string'&&isAbsolute(path),'absolute-receipt-ledger-required');const p=resolve(path);await mkdir(dirname(p),{recursive:true});
 const canonical=join(await realpath(dirname(p)),basename(p));demand(canonical===p,'redirected-receipt-ledger');
 try{demand(await realpath(p)===p,'redirected-receipt-ledger');}catch(e){if(e.code!=='ENOENT')throw e;}
 return p;
}
async function load(path){
 let s;try{demand((await stat(path)).size<=watchdogReceiptLimits.ledgerBytes,'receipt-ledger-limit');s=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return {schemaVersion:1,kind:'watchdog-reminder-receipts',ledgerPath:path,entries:[]};throw e;}
 fields(s,['schemaVersion','kind','ledgerPath','entries']);demand(s.schemaVersion===1&&s.kind==='watchdog-reminder-receipts'&&s.ledgerPath===path&&Array.isArray(s.entries)&&s.entries.length<=watchdogReceiptLimits.entries,'invalid-receipt-ledger');
 const operations=new Set(),attempts=new Set(),nonces=new Set();for(const e of s.entries){validateEntry(e);demand(!operations.has(e.operationId)&&!attempts.has(e.attemptId)&&!nonces.has(e.nonce),'duplicate-receipt-ledger-identity');operations.add(e.operationId);attempts.add(e.attemptId);nonces.add(e.nonce);}
 return s;
}
async function save(path,s){const text=JSON.stringify(s,null,2)+'\n';demand(Buffer.byteLength(text)<=watchdogReceiptLimits.ledgerBytes,'receipt-ledger-limit');await atomicWrite(path,text);}
const identity=s=>[s.dev,s.ino].join(':');
const sameStat=(a,b)=>identity(a)===identity(b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
// Exact registered path only. Entire opened bound must be valid and stable. No
// transcript scan, ACK, reasoning, latest-turn selection or partial-line success.
async function snapshot(log,at,wantedText=null,registered=null,signal=null,evidenceBoundary=null){
 signal?.throwIfAborted();
 const now=timestamp(at),path=await realpath(log.path);demand(path===log.path,'registered-log-redirected');const handle=await open(path,'r');
 try{
  const start=await handle.stat({bigint:true});demand(start.isFile(),'registered-log-not-file');
  const actualSize=Number(start.size),size=evidenceBoundary??actualSize,baseBytes=registered?.bytes??size;
  demand(Number.isSafeInteger(size)&&size>=0&&size<=actualSize,'invalid-fixed-evidence-boundary');
  demand(Number.isSafeInteger(size)&&baseBytes<=size,'prepared-log-truncated');
  demand(size-baseBytes<=watchdogReceiptLimits.logBytes,'log-append-boundary-exceeded');
  const whole=createHash('sha256'),prefix=createHash('sha256'),tail=[];let first=[],firstBytes=0,gotFirst=false,lastByte=null,pos=0,baseLines=0,totalLines=0;
  while(pos<size){
   signal?.throwIfAborted();
   const buf=Buffer.allocUnsafe(Math.min(64*1024,size-pos)),r=await handle.read(buf,0,buf.length,pos);demand(r.bytesRead>0,'log-truncated-during-read');const chunk=buf.subarray(0,r.bytesRead);whole.update(chunk);
   const prefixCount=Math.max(0,Math.min(chunk.length,baseBytes-pos));if(prefixCount)prefix.update(chunk.subarray(0,prefixCount));
   if(pos+chunk.length>baseBytes)tail.push(Buffer.from(chunk.subarray(Math.max(0,baseBytes-pos))));
   for(let i=0;i<chunk.length;i++)if(chunk[i]===10){totalLines++;if(pos+i<baseBytes)baseLines++;}
   if(!gotFirst){const end=chunk.indexOf(10),part=end<0?chunk:chunk.subarray(0,end);firstBytes+=part.length;demand(firstBytes<=watchdogReceiptLimits.lineBytes,'session-meta-line-limit');first.push(Buffer.from(part));if(end>=0)gotFirst=true;}
   lastByte=chunk.at(-1);pos+=chunk.length;
  }
  const after=await handle.stat({bigint:true}),named=await stat(path,{bigint:true});
  if(evidenceBoundary===null)demand(sameStat(start,after)&&sameStat(start,named),'log-changed-during-read');
  else demand(identity(start)===identity(after)&&identity(start)===identity(named)&&after.size>=BigInt(size)&&named.size>=BigInt(size),'fixed-proof-file-replaced-or-truncated');
  demand(gotFirst&&lastByte===10,'incomplete-jsonl-boundary');
  let firstRecord;try{firstRecord=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(first)));}catch{throw Object.assign(new Error('invalid-session-meta'),{receiptReason:'invalid-session-meta'});}
  demand(firstRecord.type==='session_meta'&&firstRecord.payload?.id===log.threadId,'session-thread-mismatch-or-ambiguous');
  demand(firstRecord.payload.cli_version===log.hostLogVersion,'host-log-version-mismatch');timestamp(firstRecord.timestamp);demand(timestamp(firstRecord.timestamp)<=now,'future-log-record');
  const session={id:firstRecord.payload.id,version:firstRecord.payload.cli_version,source:typeof firstRecord.payload.source==='string'?firstRecord.payload.source.slice(0,128):'unknown',line:1};
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(tail));}catch{throw Object.assign(new Error('invalid-log-utf8'),{receiptReason:'invalid-log-utf8'});}
  const raw=text.split('\n');if(raw.at(-1)==='')raw.pop();demand(raw.length<=watchdogReceiptLimits.lines,'log-line-boundary-exceeded');
  const sessions=[],matches=[],events=[],usersByTurn=new Map(),unknownUsersByTurn=new Set(),environmentsByTurn=new Map();let byteOffset=baseBytes,unattributedUserRecords=0;
  for(let i=0;i<raw.length;i++){
   const value=raw[i].endsWith('\r')?raw[i].slice(0,-1):raw[i];demand(value.length>0&&Buffer.byteLength(value)<=watchdogReceiptLimits.lineBytes,'invalid-log-line-boundary');
   let r;try{r=JSON.parse(value);}catch{throw Object.assign(new Error('invalid-log-json'),{receiptReason:'invalid-log-json'});}
   demand(r&&typeof r==='object'&&!Array.isArray(r),'invalid-log-record');const ts=timestamp(r.timestamp);demand(ts<=now,'future-log-record');
   if(r.type==='session_meta')sessions.push({id:r.payload?.id,version:r.payload?.cli_version,source:r.payload?.source,line:baseLines+i+1});
   const p=r.payload;
   if(r.type==='response_item'&&p?.type==='message'&&p.role==='user'){
    const m=p.internal_chat_message_metadata_passthrough;
    const classification=classifyWatchdogNativeUser(p);
    if(!classification.turnId)unattributedUserRecords++;
    else if(classification.kind==='unknown'||classification.createTime*1000>now||Math.abs(classification.createTime*1000-ts)>1000)unknownUsersByTurn.add(classification.turnId);
    else if(classification.kind==='user-text')usersByTurn.set(classification.turnId,(usersByTurn.get(classification.turnId)??0)+1);
    else environmentsByTurn.set(classification.turnId,(environmentsByTurn.get(classification.turnId)??0)+1);
    const content=Array.isArray(p.content)?p.content:[];
    const allText=content.filter(c=>c&&typeof c.text==='string').map(c=>c.text).join('');
    if(wantedText!==null&&(allText===wantedText||content.some(c=>c?.text===wantedText)))matches.push({line:baseLines+i+1,byteOffset,timestamp:r.timestamp,turnId:m?.turn_id,createTime:m?.create_time,messageKind:classification.kind,layoutValid:content.length===1&&content[0].type==='input_text'&&content[0].text===wantedText});
   }
   if(r.type==='event_msg'&&['task_started','task_complete','turn_aborted','task_interrupted','task_aborted'].includes(p?.type))events.push({type:p.type,turnId:p.turn_id,at:r.timestamp,line:baseLines+i+1,byteOffset,startedAt:p.started_at,completedAt:p.completed_at,turnTrigger:p.turn_attribution?.turn_trigger,attributionTurnId:p.turn_attribution?.turn_id});
   byteOffset+=Buffer.byteLength(raw[i])+1;
  }

  demand(sessions.length===0,'appended-session-meta-ambiguous');
  return {byteBoundary:size,prefixSha256:prefix.digest('hex'),sha256:whole.digest('hex'),fileIdentity:identity(start),statSignature:[start.dev,start.ino,start.size,start.mtimeNs,start.ctimeNs].join(':'),session,matches,events,usersByTurn,unknownUsersByTurn,environmentsByTurn,unattributedUserRecords,lineCount:totalLines};
 }finally{await handle.close();}
}

function baseline(s){return {bytes:s.byteBoundary,sha256:s.sha256,fileIdentity:s.fileIdentity,sessionThreadId:s.session.id,hostLogVersion:s.session.version,hostLogSource:s.session.source??'unknown',statSignature:s.statSignature};}
export async function prepareWatchdogReminder({ledgerPath,context,log,at=new Date().toISOString(),operationId,body=defaultBody,signal=null}){
 timestamp(at);validateContext(context);validateLog(log);demand(context.sourceUpdatedAt<=at,'future-source-version');demand(context.hostId===log.hostId&&context.threadId===log.threadId,'context-log-identity-mismatch');
 demand(typeof body==='string'&&body.length>0&&body.length<=1000&&body.isWellFormed(),'invalid-controlled-body');
 const path=await ledgerFile(ledgerPath),exactLog={...log,path:await realpath(log.path)};demand(path!==exactLog.path,'receipt-ledger-must-be-separate');
 const key=operationId??sha(JSON.stringify([context.teamId,context.taskId,context.executionId,context.sourceVersion,context.hostId,context.threadId]));demand(id(key),'invalid-operation-id');
 const fingerprint=sha(JSON.stringify({context,log:exactLog,body}));
 return withFileLocks([path+'.lock'],async()=>{
  const s=await load(path),existing=s.entries.find(e=>e.operationId===key);
  if(existing){demand(existing.fingerprint===fingerprint,'receipt-operation-conflict');demand(at>=existing.preparedAt,'prepare-time-moved-backwards');return {...publicResult(existing),replayed:true};}
  demand(s.entries.length<watchdogReceiptLimits.entries,'receipt-ledger-capacity');
  const before=await snapshot(exactLog,at,null,null,signal),e={kind:'reminder',operationId:key,attemptId:randomUUID(),nonce:randomUUID(),context:structuredClone(context),log:exactLog,preparedAt:at,body,fingerprint,baseline:baseline(before),transport:null,receipt:null};
  e.payloadText=payload(e);e.payloadSha256=sha(e.payloadText);validateEntry(e);s.entries.push(e);await save(path,s);return {...publicResult(e),replayed:false};
 });
}
export async function readPreparedWatchdogReminder(ledgerPath,attemptId){
 const path=await ledgerFile(ledgerPath),s=await load(path),e=s.entries.find(e=>e.attemptId===attemptId);demand(e,'unknown-reminder-attempt');
 return {attemptId:e.attemptId,hostId:e.context.hostId,threadId:e.context.threadId,text:e.payloadText,payloadSha256:e.payloadSha256,kind:'reminder'};
}
export async function recordWatchdogQueueResult({ledgerPath,attemptId,at=new Date().toISOString(),result}){
 timestamp(at);fields(result,['outcome','queueId'],['outcome']);demand(['queued','unknown'].includes(result.outcome),'invalid-queue-outcome');if(result.queueId!==undefined)demand(id(result.queueId),'invalid-queue-id');
 const path=await ledgerFile(ledgerPath);return withFileLocks([path+'.lock'],async()=>{
  const s=await load(path),e=s.entries.find(e=>e.attemptId===attemptId);demand(e,'unknown-reminder-attempt');demand(at>e.preparedAt,'queue-result-not-after-intent');
  if(e.transport){demand(e.transport.outcome===result.outcome&&e.transport.queueId===result.queueId,'queue-result-conflict');return {...publicResult(e),replayed:true};}
  e.transport={...result,at};validateEntry(e);await save(path,s);return {...publicResult(e),replayed:false};
 });
}
function correlate(e,s,at,current){
 const base={attemptId:e.attemptId,kind:'reminder',checkedAt:at,receiptStatus:'unknown',assurance:'controlled-local-log-correlation',currentAssurance:'caller-declared',businessHandled:'unknown',businessAccepted:'unknown',queueClientVersion:e.log.queueClientVersion,hostLogVersion:e.log.hostLogVersion};
 const unknown=reason=>({...base,reason});
 if(at<=e.preparedAt)return unknown('reconcile-not-after-intent');
 if(current.teamId!==e.context.teamId||current.taskId!==e.context.taskId||current.executionId!==e.context.executionId||current.hostId!==e.context.hostId||current.threadId!==e.context.threadId)return unknown('current-execution-or-target-mismatch');
 if(current.sourceVersion<e.context.sourceVersion)return unknown('current-source-version-older-than-intent');
 if(s.fileIdentity!==e.baseline.fileIdentity||s.byteBoundary<e.baseline.bytes||s.prefixSha256!==e.baseline.sha256)return unknown('prepared-log-prefix-mismatch');
 if(s.matches.length!==1)return unknown(s.matches.length?'full-payload-match-ambiguous':'full-payload-match-missing');
 const m=s.matches[0];if(!m.layoutValid||!id(m.turnId)||!Number.isFinite(m.createTime)||m.createTime<0)return unknown('native-user-metadata-missing-or-unsupported');
 if(m.byteOffset<e.baseline.bytes)return unknown('native-user-predates-send-intent');
 if(m.messageKind!=='user-text'||s.unattributedUserRecords||s.unknownUsersByTurn.has(m.turnId)||(s.environmentsByTurn.get(m.turnId)??0)>1)return unknown('native-user-kind-or-provenance-unknown');
 if(s.usersByTurn.get(m.turnId)!==1)return unknown('native-turn-has-multiple-user-messages');
 if(m.line<=0||timestamp(m.timestamp)<timestamp(e.preparedAt)||m.createTime*1000<timestamp(e.preparedAt)||m.createTime*1000>timestamp(at)||Math.abs(m.createTime*1000-timestamp(m.timestamp))>1000)return unknown('native-user-time-mismatch');
 const starts=s.events.filter(x=>x.turnId===m.turnId&&x.type==='task_started'),ends=s.events.filter(x=>x.turnId===m.turnId&&x.type!=='task_started');
 if(starts.length!==1||ends.length>1)return unknown('native-lifecycle-missing-or-ambiguous');
 const start=starts[0];if(start.byteOffset<e.baseline.bytes||!Number.isFinite(start.startedAt)||start.startedAt<0||start.startedAt*1000>timestamp(at)||timestamp(start.at)<timestamp(e.preparedAt)||timestamp(start.at)>timestamp(m.timestamp)||start.line>=m.line||Math.abs(start.startedAt*1000-timestamp(start.at))>1000)return unknown('native-start-time-mismatch');
 if(start.turnTrigger!=='queue'||start.attributionTurnId!==m.turnId)return unknown('native-turn-trigger-not-queue');
 const evidence={logSha256:s.sha256,byteBoundary:s.byteBoundary,lineBoundary:s.lineCount,userLine:m.line,startLine:start.line};
 if(!ends.length)return {...base,receiptStatus:'consumed',nativeReminderTurnId:m.turnId,nativeStartedAt:start.at,evidence};
 const end=ends[0];if(end.line<=m.line||timestamp(end.at)<timestamp(m.timestamp))return unknown('native-terminal-time-mismatch');
 if(end.type==='task_complete'&&(!Number.isFinite(end.completedAt)||end.completedAt*1000>timestamp(at)||end.completedAt<start.startedAt||end.startedAt!==start.startedAt||Math.abs(end.completedAt*1000-timestamp(end.at))>1000))return unknown('native-terminal-metadata-mismatch');
 return {...base,receiptStatus:end.type==='task_complete'?'turn-completed':'turn-interrupted',nativeReminderTurnId:m.turnId,nativeStartedAt:start.at,nativeCompletedAt:end.at,nativeDurationMs:timestamp(end.at)-timestamp(start.at),evidence:{...evidence,terminalLine:end.line,terminalType:end.type}};
}
export async function reconcileWatchdogReminder({ledgerPath,attemptId,at=new Date().toISOString(),current,signal=null}){
 timestamp(at);validateCurrent(current);const path=await ledgerFile(ledgerPath);
 return withFileLocks([path+'.lock'],async()=>{
  const s=await load(path),e=s.entries.find(e=>e.attemptId===attemptId);demand(e,'unknown-reminder-attempt');
  if(e.receipt)demand(at>=e.receipt.checkedAt,'receipt-time-moved-backwards');
  let result;
  try{const snap=await snapshot(e.log,at,e.payloadText,e.baseline,signal);result=correlate(e,snap,at,current);}
  catch(error){result={attemptId:e.attemptId,kind:'reminder',checkedAt:at,receiptStatus:'unknown',reason:signal?.aborted?'bounded-read-cancelled':error.receiptReason??'registered-log-unavailable-or-invalid',assurance:'controlled-local-log-correlation',currentAssurance:'caller-declared',businessHandled:'unknown',businessAccepted:'unknown',queueClientVersion:e.log.queueClientVersion,hostLogVersion:e.log.hostLogVersion};}
  if(e.receipt?.evidence&&result.receiptStatus==='unknown'){
   const old=e.receipt;
   e.priorReceiptEvidence=[...(e.priorReceiptEvidence??[]),{receiptStatus:old.receiptStatus,checkedAt:old.checkedAt,nativeReminderTurnId:old.nativeReminderTurnId,evidence:old.evidence}].slice(-8);
  }
  e.receipt=result;validateEntry(e);await save(path,s);return {...result,priorEvidenceCount:e.priorReceiptEvidence?.length??0};
 });
}

export async function verifyWatchdogReceiptLog(log,at=new Date().toISOString(),{signal=null}={}){validateLog(log);const result=await snapshot({...log,path:await realpath(log.path)},at,null,null,signal);return baseline(result);}

// Bounded association descriptor: never returns the controlled send text.
export async function readWatchdogReceiptEvidence(ledgerPath,attemptId){
 const path=await ledgerFile(ledgerPath),s=await load(path),e=s.entries.find(e=>e.attemptId===attemptId);demand(e,'unknown-reminder-attempt');
 return {kind:e.kind,attemptId:e.attemptId,nonce:e.nonce,operationId:e.operationId,preparedAt:e.preparedAt,transport:structuredClone(e.transport),context:structuredClone(e.context),log:structuredClone(e.log),baseline:structuredClone(e.baseline),payloadSha256:e.payloadSha256};
}

export async function findPreparedWatchdogReminder(ledgerPath,operationId){
 const path=await ledgerFile(ledgerPath),s=await load(path),e=s.entries.find(e=>e.operationId===operationId);demand(e,'unknown-reminder-operation');return readWatchdogReceiptEvidence(path,e.attemptId);
}

// Explicit recovery only for an intent known not to have reached any sender.
// A full unchanged baseline hash is calculated BEFORE a new native idle read.
export async function sealPreparedWatchdogReminder({ledgerPath,attemptId,at=new Date().toISOString(),signal=null}){
 timestamp(at);const path=await ledgerFile(ledgerPath),s=await load(path),e=s.entries.find(e=>e.attemptId===attemptId);demand(e,'unknown-reminder-attempt');demand(e.transport===null,'prepared-transport-already-recorded');
 demand(!e.receipt||e.receipt.receiptStatus==='unknown','prepared-receipt-already-consumed');
 const snap=await snapshot(e.log,at,null,e.baseline,signal);
 demand(snap.fileIdentity===e.baseline.fileIdentity&&snap.byteBoundary===e.baseline.bytes&&snap.prefixSha256===e.baseline.sha256&&snap.sha256===e.baseline.sha256,'prepared-baseline-changed');
 const seal={schemaVersion:1,kind:'watchdog-prepared-baseline-seal',verifiedAt:at,attemptId:e.attemptId,nonce:e.nonce,payloadSha256:e.payloadSha256,logPath:e.log.path,fileIdentity:snap.fileIdentity,byteBoundary:snap.byteBoundary,baselineSha256:snap.sha256,statSignature:snap.statSignature};
 return {...seal,sealSha256:sha(JSON.stringify(seal))};
}

// No prefix rehash here: the previously computed seal is accepted only while
// exact identity/size/mtime/ctime and session metadata are still unchanged.
// The external send-once marker and fresh native idle proof remain mandatory.
export async function checkPreparedWatchdogSeal({ledgerPath,attemptId,seal,at=new Date().toISOString()}){
 timestamp(at);fields(seal,['schemaVersion','kind','verifiedAt','attemptId','nonce','payloadSha256','logPath','fileIdentity','byteBoundary','baselineSha256','statSignature','sealSha256']);const {sealSha256,...body}=seal;
 demand(seal.schemaVersion===1&&seal.kind==='watchdog-prepared-baseline-seal'&&sha(JSON.stringify(body))===sealSha256&&timestamp(seal.verifiedAt)<=timestamp(at),'invalid-prepared-seal');
 const d=await readWatchdogReceiptEvidence(ledgerPath,attemptId);demand(d.transport===null,'prepared-transport-already-recorded');
 demand(d.attemptId===seal.attemptId&&d.nonce===seal.nonce&&d.payloadSha256===seal.payloadSha256&&d.log.path===seal.logPath&&d.baseline.sha256===seal.baselineSha256&&d.baseline.bytes===seal.byteBoundary&&d.baseline.fileIdentity===seal.fileIdentity,'prepared-seal-association-mismatch');
 const canonical=await realpath(d.log.path);demand(canonical===d.log.path,'prepared-log-redirected');const h=await open(canonical,'r');
 try{
  const info=await h.stat({bigint:true}),signature=[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');demand(signature===seal.statSignature,'prepared-seal-stat-changed');
  const bytes=Buffer.alloc(Math.min(Number(info.size),watchdogReceiptLimits.lineBytes)),r=await h.read(bytes,0,bytes.length,0),end=bytes.subarray(0,r.bytesRead).indexOf(10);demand(end>=0,'prepared-session-meta-incomplete');
  const meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end)));demand(meta.type==='session_meta'&&meta.payload?.id===d.log.threadId&&meta.payload?.cli_version===d.log.hostLogVersion,'prepared-session-meta-changed');
  demand(sameStat(info,await h.stat({bigint:true}))&&sameStat(info,await stat(canonical,{bigint:true})),'prepared-log-changed-during-fast-guard');
  return {valid:true,attemptId:d.attemptId,nonce:d.nonce,payloadSha256:d.payloadSha256,byteBoundary:seal.byteBoundary,statSignature:signature,prefixRehashed:false};
 }finally{await h.close();}
}

// New preparations persist the stat identity of their completed full hash. It
// can be reused only unchanged; legacy preparations still require full sealing.
export async function getUnchangedPreparedWatchdogSeal({ledgerPath,attemptId,at=new Date().toISOString()}){
 const d=await readWatchdogReceiptEvidence(ledgerPath,attemptId);demand(d.transport===null&&typeof d.baseline.statSignature==='string','prepared-stat-proof-unavailable');
 const body={schemaVersion:1,kind:'watchdog-prepared-baseline-seal',verifiedAt:at,attemptId:d.attemptId,nonce:d.nonce,payloadSha256:d.payloadSha256,logPath:d.log.path,fileIdentity:d.baseline.fileIdentity,byteBoundary:d.baseline.bytes,baselineSha256:d.baseline.sha256,statSignature:d.baseline.statSignature};
 const seal={...body,sealSha256:sha(JSON.stringify(body))};await checkPreparedWatchdogSeal({ledgerPath,attemptId,seal,at});return seal;
}

// Capability evidence is a historical fixed native proof, not the evolving
// delivery state of the old probe. Future bytes are never parsed or truncated
// into a uniqueness claim; the exact certified prefix hash is mandatory.
export async function inspectWatchdogReceiptProof({ledgerPath,attemptId,current,byteBoundary,logSha256,at,signal=null}){
 timestamp(at);validateCurrent(current);demand(Number.isSafeInteger(byteBoundary)&&byteBoundary>0&&hex(logSha256),'invalid-fixed-proof-request');const path=await ledgerFile(ledgerPath),s=await load(path),e=s.entries.find(e=>e.attemptId===attemptId);demand(e,'unknown-reminder-attempt');
 const snap=await snapshot(e.log,at,e.payloadText,e.baseline,signal,byteBoundary);demand(snap.sha256===logSha256,'fixed-proof-prefix-hash-mismatch');return {...correlate(e,snap,at,current),proofStatSignature:snap.statSignature};
}
