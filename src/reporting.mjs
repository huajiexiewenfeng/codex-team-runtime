import { validate,validateCaller } from './runtime.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const text=x=>check(typeof x==='string'&&x.trim().length>0&&x.length<=4000,'Expected nonempty text');
const time=x=>check(typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x,'Expected canonical UTC timestamp');
const shape=(x,keys)=>check(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k)),'Unknown ledger field');
const same=(a,b)=>a.hostId===b.hostId&&a.threadId===b.threadId&&a.memberId===b.memberId;
const roleIdentity=m=>({memberId:m.id,hostId:m.binding.hostId,threadId:m.binding.threadId});
function owner(x){shape(x,['memberId','hostId','threadId']);text(x.memberId);validateCaller({hostId:x.hostId,threadId:x.threadId});}
function source(x){shape(x,['kind','evidenceRef']);check(['fixture','manual','host-observation'].includes(x.kind),'Invalid evidence source');text(x.evidenceRef);}
function authorization(state,caller,ledger=null){
 validate(state);validateCaller(caller);const m=state.members.find(x=>x.role==='Manager'),l=state.members.find(x=>x.role==='Liaison');
 check(m.lifecycle==='active'&&m.binding.status==='bound'&&m.binding.hostId===caller.hostId&&m.binding.threadId===caller.threadId,'Active bound Manager caller required');
 check(l.binding.status==='bound'&&state.session?.invitation?.confirmedAt,'Confirmed Liaison pairing required');
 if(ledger)check(ledger.teamId===state.team.id&&ledger.teamSourceKind===state.team.source.kind&&same(ledger.manager,roleIdentity(m))&&same(ledger.owner,roleIdentity(l)),'Ledger team or owner mismatch');
 return {m,l};
}
function eventShape(e){
 const extra={prepare:['expiresAt'],dispatch:['operationId'],record:['operationId','owner','automationId','outcome','observedAt']};
 check(extra[e?.type],'Unknown reporting event');shape(e,['id','type','at','source',...extra[e.type]]);text(e.id);time(e.at);source(e.source);
 if(e.type==='prepare'){time(e.expiresAt);check(e.expiresAt>e.at,'Invalid preparation expiry');}
 else{text(e.operationId);if(e.type==='record'){owner(e.owner);if(e.automationId!==null)text(e.automationId);check(['running','stopped','unknown','failed'].includes(e.outcome),'Invalid observation outcome');if(['running','stopped'].includes(e.outcome))check(e.automationId!==null,'Observed automation identity required');time(e.observedAt);check(e.observedAt<=e.at,'Observation is in future');}}
}
export function validateReportingLedger(b){
 shape(b,['schemaVersion','version','updatedAt','teamId','teamSourceKind','manager','owner','bindingEpoch','automationId','observation','operations','events']);
 check(b.schemaVersion===1,'Unsupported reporting schema');check(Number.isSafeInteger(b.version)&&b.version>=0,'Invalid ledger version');time(b.updatedAt);text(b.teamId);owner(b.manager);owner(b.owner);check(!same(b.manager,b.owner),'Owner cannot be Manager');
 check(['fixture','manual','host-observation'].includes(b.teamSourceKind)&&b.bindingEpoch===1,'Invalid ledger binding');if(b.automationId!==null)text(b.automationId);
 check(Array.isArray(b.operations)&&Array.isArray(b.events)&&b.events.length===b.version,'Invalid ledger history');
 const ids=new Set();let previous=null;
 for(const e of b.events){eventShape(e);check(!ids.has(e.id),'Duplicate ledger event');ids.add(e.id);check(e.at<=b.updatedAt&&(!previous||e.at>=previous),'Ledger event time mismatch');previous=e.at;}
 check(previous===null||previous===b.updatedAt,'Ledger update mismatch');
 const ops=new Set();let pending=0;
 for(const op of b.operations){
  shape(op,['id','kind','phase','preparedAt','expiresAt','intentVersion','stateVersion','desired','bindingEpoch','automationId','dispatchedAt','records']);text(op.id);check(!ops.has(op.id),'Duplicate operation');ops.add(op.id);
  check(['CREATE','RESUME','PAUSE'].includes(op.kind)&&['PREPARED','DISPATCHED','UNKNOWN','CONFIRMED','FAILED','SUPERSEDED'].includes(op.phase),'Invalid operation state');
  time(op.preparedAt);time(op.expiresAt);check(op.expiresAt>op.preparedAt&&op.preparedAt<=b.updatedAt,'Invalid operation time');check(op.bindingEpoch===b.bindingEpoch,'Binding epoch mismatch');
  check(Number.isSafeInteger(op.intentVersion)&&op.intentVersion>=0&&Number.isSafeInteger(op.stateVersion)&&op.stateVersion>=op.intentVersion,'Invalid intent version');check(['running','stopped'].includes(op.desired),'Invalid operation intent');
  if(op.automationId!==null)text(op.automationId);check(op.kind==='CREATE'?op.automationId===null:op.automationId!==null,'Operation automation identity missing');
  const prep=b.events.find(e=>e.id===op.id);check(prep?.type==='prepare'&&prep.at===op.preparedAt&&prep.expiresAt===op.expiresAt,'Preparation history mismatch');
  check(Array.isArray(op.records),'Invalid operation records');
  const dispatches=b.events.filter(e=>e.type==='dispatch'&&e.operationId===op.id);
  check(op.dispatchedAt===null?dispatches.length===0:dispatches.length===1&&dispatches[0].at===op.dispatchedAt,'Dispatch history mismatch');
  check(JSON.stringify(op.records)===JSON.stringify(b.events.filter(e=>e.type==='record'&&e.operationId===op.id)),'Record history mismatch');
  if(op.dispatchedAt!==null){time(op.dispatchedAt);check(op.dispatchedAt>=op.preparedAt&&op.dispatchedAt<op.expiresAt&&op.dispatchedAt<=b.updatedAt,'Invalid dispatch time');check(b.events.some(e=>e.type==='dispatch'&&e.operationId===op.id&&e.at===op.dispatchedAt),'Dispatch history mismatch');}
  else check(['PREPARED','SUPERSEDED'].includes(op.phase)&&op.records.length===0,'Undispatched operation has outcome');
  for(const r of op.records){eventShape(r);check(r.type==='record'&&r.operationId===op.id&&same(r.owner,b.owner)&&r.at>=op.dispatchedAt&&r.at<=b.updatedAt,'Record identity/time mismatch');check(b.events.some(e=>e.id===r.id&&JSON.stringify(e)===JSON.stringify(r)),'Record history mismatch');}
  if(op.dispatchedAt!==null){
   if(op.records.length===0)check(op.phase==='DISPATCHED','Dispatched operation phase has no observation');
   else {
    const last=op.records.at(-1),host=last.source.kind==='host-observation'&&b.teamSourceKind!=='fixture';
    const phase=!host||last.outcome==='unknown'?'UNKNOWN':last.outcome==='failed'?'FAILED':'CONFIRMED';
    check(op.phase===phase,'Operation phase disagrees with observation');
   }
  }
  if(['PREPARED','DISPATCHED','UNKNOWN'].includes(op.phase))pending++;
 }
 check(pending<=1,'Multiple unresolved operations');
 for(const e of b.events.filter(e=>e.type!=='prepare'))check(ops.has(e.operationId),'Unknown operation in history');
 let knownAutomation=null,expectedObservation=null;
 for(const e of b.events.filter(e=>e.type==='record'&&e.source.kind==='host-observation'&&b.teamSourceKind!=='fixture')){
  if(knownAutomation!==null)check(e.automationId===knownAutomation,'Observed automation tracking changed');
  if(e.automationId!==null)knownAutomation=e.automationId;
  if(['running','stopped'].includes(e.outcome)&&(!expectedObservation||e.observedAt>=expectedObservation.observedAt))expectedObservation=e;
 }
 check(b.automationId===knownAutomation,'Automation tracking has no observation');
 check(JSON.stringify(b.observation)===JSON.stringify(expectedObservation),'Projection is not latest eligible observation');
 if(b.observation!==null){eventShape(b.observation);const e=b.observation;check(e.type==='record'&&e.source.kind==='host-observation'&&b.teamSourceKind!=='fixture'&&['running','stopped'].includes(e.outcome)&&e.automationId===b.automationId&&same(e.owner,b.owner),'Invalid host projection');check(b.events.some(x=>x.id===e.id&&JSON.stringify(x)===JSON.stringify(e)),'Projection history mismatch');}
 return b;
}
export function createReportingLedger(state,caller,at){
 const {m,l}=authorization(state,caller);time(at);check(at>=state.updatedAt,'Ledger predates state');check(l.lifecycle==='active','Active Liaison required at initialization');
 return validateReportingLedger({schemaVersion:1,version:0,updatedAt:at,teamId:state.team.id,teamSourceKind:state.team.source.kind,manager:roleIdentity(m),owner:roleIdentity(l),bindingEpoch:1,automationId:null,observation:null,operations:[],events:[]});
}
function desired(state,l){return state.reporting.desired==='running'&&l.lifecycle==='active'?'running':'stopped';}
function nextKind(b,wanted){if(b.automationId===null)return wanted==='running'?'CREATE':'NONE';if(b.observation?.outcome===wanted)return 'NONE';return wanted==='running'?'RESUME':'PAUSE';}
function stale(op,b,state,wanted,at){return at>=op.expiresAt||op.intentVersion!==state.reporting.intentVersion||op.desired!==wanted||op.bindingEpoch!==b.bindingEpoch||op.automationId!==(op.kind==='CREATE'?null:b.automationId);}
export function planReporting(state,b,caller,asOf=new Date().toISOString()){
 validateReportingLedger(b);const {l}=authorization(state,caller,b);time(asOf);check(asOf>=b.updatedAt&&asOf>=state.updatedAt,'Plan predates recorded data');
 const wanted=desired(state,l),op=b.operations.at(-1);let kind=nextKind(b,wanted),operationId=null;
 if(op&&['DISPATCHED','UNKNOWN'].includes(op.phase)){kind='RECONCILE';operationId=op.id;}
 else if(op?.phase==='FAILED'){kind='FAILED';operationId=op.id;}
 else if(op?.phase==='PREPARED'){kind=stale(op,b,state,wanted,asOf)?'SUPERSEDE':'DISPATCH';operationId=op.id;}
 return {kind,operationId,desired:wanted,intentVersion:state.reporting.intentVersion,stateVersion:state.version,ledgerVersion:b.version,automationId:b.automationId,owner:structuredClone(b.owner),bindingEpoch:b.bindingEpoch,assurance:'caller-declared; host observations are not authenticated',sourceKinds:[...new Set([state.team.source.kind,...b.events.map(e=>e.source.kind)])],readOnly:true,hostActionExecuted:false,observedOutcome:b.observation?.outcome??'unknown',crossFileAtomic:false};
}
export function evolveReporting(ledger,state,caller,event,expectedVersion){
 validateReportingLedger(ledger);const {l}=authorization(state,caller,ledger);check(expectedVersion===ledger.version,'Ledger version conflict');eventShape(event);check(event.at>=ledger.updatedAt&&event.at>=state.updatedAt,'Ledger event time moved backwards');check(!ledger.events.some(e=>e.id===event.id),'Duplicate ledger event');
 const b=structuredClone(ledger),wanted=desired(state,l);let op=b.operations.at(-1);
 if(event.type==='prepare'){
  check(!op||!['DISPATCHED','UNKNOWN','FAILED'].includes(op.phase),'Unresolved or failed operation requires reconciliation');
  if(op?.phase==='PREPARED'){check(stale(op,b,state,wanted,event.at),'Prepared operation already exists');op.phase='SUPERSEDED';}
  const kind=nextKind(b,wanted);
  if(kind!=='NONE')b.operations.push({id:event.id,kind,phase:'PREPARED',preparedAt:event.at,expiresAt:event.expiresAt,intentVersion:state.reporting.intentVersion,stateVersion:state.version,desired:wanted,bindingEpoch:b.bindingEpoch,automationId:kind==='CREATE'?null:b.automationId,dispatchedAt:null,records:[]});
 }else{
  check(op&&op.id===event.operationId,'Operation identity mismatch');
  if(event.type==='dispatch'){
   check(op.phase==='PREPARED'&&!stale(op,b,state,wanted,event.at),'Prepared operation expired or stale');op.phase='DISPATCHED';op.dispatchedAt=event.at;
  }else{
   check(['DISPATCHED','UNKNOWN'].includes(op.phase),'Operation is not unresolved');check(same(event.owner,b.owner),'Observation owner mismatch');
   check(event.observedAt>=op.dispatchedAt,'Observation predates dispatch');
   if(b.automationId!==null)check(event.automationId===b.automationId,'Automation identity mismatch');
   if(op.kind!=='CREATE')check(event.automationId===op.automationId,'Automation identity mismatch');
   const host=event.source.kind==='host-observation'&&b.teamSourceKind!=='fixture'&&state.team.source.kind!=='fixture';
   op.records.push(structuredClone(event));
   if(host){
    if(event.automationId!==null)b.automationId=event.automationId;
    op.phase=event.outcome==='unknown'?'UNKNOWN':event.outcome==='failed'?'FAILED':'CONFIRMED';
    if(['running','stopped'].includes(event.outcome)&&(!b.observation||event.observedAt>=b.observation.observedAt))b.observation=structuredClone(event);
   }else op.phase='UNKNOWN';
  }
 }
 b.events.push(structuredClone(event));b.version++;b.updatedAt=event.at;return validateReportingLedger(b);
}
