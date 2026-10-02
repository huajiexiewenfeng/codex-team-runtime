import {lstat,mkdir,open,link,unlink,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseNoticeJson} from './notice-json.mjs';
import {MAX_BYTES,canonical,hash,demand,shape,isDispatch,operationEventId,validateDispatchRequest,validateBrief} from './dispatch-contract.mjs';

// No runtime/store imports: the store validates every reachable object on reads.
async function directory(statePath,create=false){
 const parent=await realpath(dirname(statePath)),dir=join(parent,resolve(statePath).split(/[\\/]/).at(-1)+'.e04-objects');
 if(create)await mkdir(dir,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const stat=await lstat(dir);demand(stat.isDirectory()&&!stat.isSymbolicLink()&&resolve(await realpath(dir))===resolve(dir),'OBJECT_CORRUPT','Unsafe dispatch object directory');return dir;
}
function parts(ref){const m=/^e04-(brief|op):sha256:([a-f0-9]{64})$/.exec(ref);demand(m,'OBJECT_CORRUPT','Invalid dispatch object reference');return m;}
export async function loadObject(statePath,ref){
 const [,kind,digest]=parts(ref);let file;
 try{file=join(await directory(statePath),`${kind}-${digest}.json`);const stat=await lstat(file);demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_BYTES,'OBJECT_CORRUPT','Unsafe or oversized dispatch object');
  const handle=await open(file,'r');try{const bytes=Buffer.alloc(MAX_BYTES+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);demand(bytesRead<=MAX_BYTES,'OBJECT_CORRUPT','Oversized dispatch object');const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead));demand(hash(raw)===digest,'OBJECT_CORRUPT','Dispatch object hash mismatch');const obj=parseNoticeJson(raw);demand(canonical(obj)===raw,'OBJECT_CORRUPT','Noncanonical dispatch object');return obj;}finally{await handle.close();}
 }catch(e){if(e.code==='ENOENT')throw Object.assign(new Error('Committed dispatch object is missing'),{code:'OBJECT_MISSING'});throw e;}
}
export async function saveObject(statePath,kind,obj){
 demand(['brief','op'].includes(kind),'INVALID_REQUEST','Invalid object kind');const raw=canonical(obj);demand(Buffer.byteLength(raw)<=MAX_BYTES,'PAYLOAD_TOO_LARGE','Dispatch object exceeds 1 MiB');
 const digest=hash(raw),ref=`e04-${kind}:sha256:${digest}`,dir=await directory(statePath,true),file=join(dir,`${kind}-${digest}.json`),temp=join(dir,`${randomUUID()}.tmp`);let handle;
 try{handle=await open(temp,'wx');await handle.writeFile(raw,'utf8');await handle.sync();await handle.close();handle=null;try{await link(temp,file);}catch(e){if(e.code!=='EEXIST')throw e;demand(isDeepStrictEqual(await loadObject(statePath,ref),obj),'OBJECT_CORRUPT','Object collision');}}finally{if(handle)await handle.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 return ref;
}
export async function validateDispatchObjects(statePath,s){
 const operations=new Map(),briefs=new Map();
 let totalBytes=0,objectCount=0;
 const load=async ref=>{demand(++objectCount<=8192,'OBJECT_LIMIT','Dispatch graph exceeds 8192 objects');const value=await loadObject(statePath,ref);totalBytes+=Buffer.byteLength(canonical(value));demand(totalBytes<=64*MAX_BYTES,'OBJECT_LIMIT','Dispatch graph exceeds 64 MiB');return value;};
 for(const [index,e] of s.events.entries()){
  if(!isDispatch(e)){demand(!e.source.ref.startsWith('e04-op:'),'OBJECT_CORRUPT','Malformed E04 event reference');continue;}
  const op=await load(e.source.ref);shape(op,['schemaVersion','wrapperVersion','request','fingerprint','event','briefRef','attemptId','sourceVersion','runtimeRevision']);
  demand(op.schemaVersion===1&&op.wrapperVersion===1,'OBJECT_CORRUPT','Unsupported operation protocol');const r=validateDispatchRequest(op.request);
  demand(r.action!=='status'&&hash(canonical(r))===op.fingerprint&&operationEventId(s,r.operation_id)===e.id,'OBJECT_CORRUPT','Operation identity/fingerprint mismatch');
  const {source,...audit}=e;demand(isDeepStrictEqual(audit,op.event)&&op.sourceVersion===index+1&&typeof op.runtimeRevision==='string','OBJECT_CORRUPT','Operation audit mismatch');
  demand(source.kind==='manual','OBJECT_CORRUPT','Dispatch object source kind mismatch');
  const task=s.tasks.find(t=>t.id===e.taskId),round=s.rounds.find(x=>x.id===e.roundId),actor=s.members.find(m=>m.id===e.actor);
  demand(task&&r.team_id===s.team.id&&r.round_id===task.roundId&&r.task_id===task.id&&r.worker_id===task.workerId&&actor?.role==='Manager'&&actor.binding.hostId===r.actor_host_id&&actor.binding.threadId===r.actor_thread_id,'OBJECT_CORRUPT','Operation scope mismatch');
  let brief=briefs.get(op.briefRef);if(!brief){brief=validateBrief(await load(op.briefRef));briefs.set(op.briefRef,brief);}
  demand(brief.teamId===s.team.id&&brief.roundId===task.roundId&&brief.taskId===task.id,'OBJECT_CORRUPT','Brief scope mismatch');
  if(r.action==='prepare'){
   demand(['startTask','deliveryClaim'].includes(e.type)&&op.attemptId===e.id&&r.brief_ref===op.briefRef,'OBJECT_CORRUPT','Prepare mapping mismatch');
   const enqueue=s.events.find(x=>x.id===r.enqueue_event_id&&x.type==='enqueue'&&x.taskId===task.id&&x.roundId===task.roundId);
   demand(enqueue&&(enqueue.source.ref===op.briefRef||(brief.enqueueEventId===enqueue.id&&brief.originalSourceRef===enqueue.source.ref)),'OBJECT_CORRUPT','Brief/enqueue mismatch');
   const binding=round.members.find(m=>m.id===task.workerId)?.binding,n=r.admission?.native;
   demand(n&&n.host_id===binding?.hostId&&n.thread_id===binding?.threadId&&((brief.authorizationRef&&brief.dependencyRef)||r.admission.scope_evidence_ref),'OBJECT_CORRUPT','Prepare admission mismatch');
   demand(e.type==='startTask'?!!r.baseline&&!r.retry_of_attempt_id:e.attemptId===r.retry_of_attempt_id&&!r.baseline,'OBJECT_CORRUPT','Prepare lineage mismatch');
   if(e.type==='deliveryClaim')demand([...operations.values()].some(o=>o.request.action==='prepare'&&o.attemptId===e.attemptId&&o.briefRef===op.briefRef),'OBJECT_CORRUPT','Retry material changed');
  }else{
   const initial=[...operations.values()].find(x=>x.attemptId===r.attempt_id&&x.request.action==='prepare');
   demand(initial&&op.attemptId===r.attempt_id&&op.briefRef===initial.briefRef,'OBJECT_CORRUPT','Attempt mapping mismatch');
   demand(e.attemptId===r.attempt_id&&(r.action==='cancel'?e.type==='cancelUndelivered'&&isDeepStrictEqual(e.cancellation,r.cancellation):['deliveryCheck','dispatchConflict'].includes(e.type)),'OBJECT_CORRUPT','Action/event mismatch');
   if(r.action==='result'&&e.type==='deliveryCheck')demand(e.outcome===({accepted:'delivered',unknown:'unknown','terminal-not-delivered':'not-delivered',denied:'policy-denied'})[r.result.outcome]&&e.summary===r.result.summary,'OBJECT_CORRUPT','Outcome mismatch');
  }
  operations.set(r.operation_id,op);
 }
 return {operations,briefs};
}
