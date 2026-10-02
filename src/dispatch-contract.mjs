import {createHash} from 'node:crypto';

export const MAX_BYTES=1024*1024;
export const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
export function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
export function demand(ok,code,message){if(!ok)throw Object.assign(new Error(message),{code});}
export function shape(v,keys,required=keys){demand(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'INVALID_REQUEST','Fields do not match dispatch schema');}
export function text(v,max=4000){demand(typeof v==='string'&&v.trim().length>0&&v.length<=max&&v.isWellFormed(),'INVALID_REQUEST','Expected bounded nonempty Unicode text');}
export function bounded(v){const raw=JSON.stringify(v);demand(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:raw}],isError:false}))+256<=MAX_BYTES,'PAYLOAD_TOO_LARGE','Dispatch payload exceeds 1 MiB');return v;}
export const isDispatch=e=>/^e04-op:sha256:[a-f0-9]{64}$/.test(e?.source?.ref??'');
export const dispatchHold=(s,workerId)=>s.events.find(e=>e.type==='dispatchConflict'&&s.tasks.find(t=>t.id===e.taskId)?.workerId===workerId);
export const operationEventId=(s,id)=>'e04-'+hash(canonical(['e04-v1',s.registry.registryId,s.team.id,id]));
export const common=['actor_host_id','actor_thread_id','team_id','round_id','task_id','worker_id','reason'];
const additions={prepare:['operation_id','enqueue_event_id','brief_ref','admission','baseline','retry_of_attempt_id'],result:['operation_id','attempt_id','result'],cancel:['operation_id','attempt_id','cancellation'],status:['operation_id','attempt_id','include_content']};
const required={prepare:['operation_id','enqueue_event_id','brief_ref'],result:['operation_id','attempt_id','result'],cancel:['operation_id','attempt_id'],status:[]};
export function validateDispatchRequest(r){
 demand(r&&Object.hasOwn(additions,r.action),'INVALID_REQUEST','Unknown dispatch action');
 shape(r,['action',...common,...additions[r.action]],['action',...common,...required[r.action]]);
 for(const k of [...common,...['operation_id','enqueue_event_id','brief_ref','attempt_id','retry_of_attempt_id'].filter(k=>k in r)])text(r[k],256);
 for(const k of common.filter(k=>k!=='reason'))demand(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(r[k]),'INVALID_REQUEST','Invalid identity');
 if('operation_id'in r)demand(/^[A-Za-z0-9_-]{1,128}$/.test(r.operation_id),'INVALID_REQUEST','Invalid operation_id');
 demand(['onboarding','resume','post_compaction','before_dispatch','before_delivery','before_review','identity_conflict','manual','unknown'].includes(r.reason),'INVALID_REQUEST','Invalid reason');
 if('include_content'in r)demand(typeof r.include_content==='boolean','INVALID_REQUEST','Invalid include_content');
 if('brief_ref'in r)demand(/^e04-brief:sha256:[a-f0-9]{64}$/.test(r.brief_ref),'INVALID_REQUEST','Invalid brief reference');
 if('baseline'in r){shape(r.baseline,['outcome','evidence_ref']);demand(r.baseline.outcome==='not-attempted','INVALID_REQUEST','Baseline must prove no prior send');text(r.baseline.evidence_ref);}
 demand(!('baseline'in r&&'retry_of_attempt_id'in r),'INVALID_REQUEST','Retry cannot supply initial baseline');
 if('admission'in r){shape(r.admission,['native','scope_evidence_ref'],['native']);const n=r.admission.native;shape(n,['host_id','thread_id','status','evidence_ref','observed_at'],['host_id','thread_id','status','evidence_ref']);for(const k of ['host_id','thread_id','evidence_ref'])text(n[k]);demand(n.status==='idle','INVALID_REQUEST','Native idle evidence required');if('observed_at'in n)demand(typeof n.observed_at==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(n.observed_at)&&Number.isFinite(Date.parse(n.observed_at)),'INVALID_REQUEST','Invalid source observation time');if('scope_evidence_ref'in r.admission)text(r.admission.scope_evidence_ref);}
 if('result'in r){shape(r.result,['outcome','evidence_ref','summary']);demand(['accepted','unknown','terminal-not-delivered','denied'].includes(r.result.outcome),'INVALID_REQUEST','Invalid outcome');text(r.result.evidence_ref);text(r.result.summary);}
 if('cancellation'in r){shape(r.cancellation,['authorization_ref','reason','nonreceipt_evidence_ref','execution_evidence_ref']);Object.values(r.cancellation).forEach(v=>text(v));}
 return bounded(r);
}
export function validateBrief(b){
 shape(b,['schemaVersion','teamId','roundId','taskId','text','scope','materialRefs','authorizationRef','dependencyRef','actor','enqueueEventId','originalSourceRef'],['schemaVersion','teamId','roundId','taskId','text','scope','materialRefs','actor']);
 demand(b.schemaVersion===1,'INVALID_REQUEST','Unsupported brief protocol');
 for(const k of ['teamId','roundId','taskId','scope'])text(b[k]);text(b.text,65536);demand(Buffer.byteLength(b.text)<=65536,'PAYLOAD_TOO_LARGE','Brief exceeds 64 KiB');
 shape(b.actor,['hostId','threadId']);Object.values(b.actor).forEach(v=>text(v));
 demand(Array.isArray(b.materialRefs)&&b.materialRefs.length>0&&b.materialRefs.length<=100,'INVALID_REQUEST','Material references required');b.materialRefs.forEach(v=>text(v));
 for(const k of ['authorizationRef','dependencyRef','enqueueEventId','originalSourceRef'])if(k in b)text(b[k]);
 demand(('enqueueEventId'in b)===('originalSourceRef'in b),'INVALID_REQUEST','Legacy brief requires both enqueue and original source');return bounded(b);
}
