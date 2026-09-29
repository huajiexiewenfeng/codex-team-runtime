import {validate,validateCaller,evolve} from './runtime.mjs';
const check=(ok,message)=>{if(!ok)throw Error(message);};
// A narrow, explicitly reviewed migration. Original bytes must be retained by
// the durable caller; correctedAt is reconciliation time, not asserted send time.
export function recoverFinalSubmitClock(state,request,nowMs=Date.now()){
 validate(state);validateCaller(request.caller);
 const manager=state.members.find(m=>m.role==='Manager'&&m.lifecycle==='active'&&m.binding.status==='bound'&&m.binding.hostId===request.caller.hostId&&m.binding.threadId===request.caller.threadId);
 check(manager,'Current Manager required');
 const e=state.events.at(-1),t=state.tasks.find(t=>t.id===e?.taskId);
 check(e?.id===request.eventId&&e.type==='submit'&&t?.status==='submitted','Only exact final submit with no later events supported');
 check(Date.parse(e.at)>Date.parse(request.correctedAt),'Original time must exceed correction time');
 check(typeof request.correctedAt==='string'&&Number.isFinite(Date.parse(request.correctedAt))&&new Date(request.correctedAt).toISOString()===request.correctedAt,'Canonical correction timestamp required');
 check(Number.isFinite(nowMs)&&Date.parse(request.correctedAt)<=nowMs,'Correction cannot be future');
 check(request.correctedAt>=(state.events.at(-2)?.at??t.assignedAt),'Correction precedes prior event');
 check(typeof request.evidenceRef==='string'&&request.evidenceRef.trim(),'Recovery evidence required');
 check(t.stages.at(-1).status==='submitted'&&t.stages.at(-1).startedAt===e.at&&t.stages.at(-2)?.endedAt===e.at,'Submission stage mismatch');
 const next=structuredClone(state),nt=next.tasks.find(x=>x.id===t.id);
 next.events.at(-1).at=request.correctedAt;
 nt.stages.at(-2).endedAt=request.correctedAt;nt.stages.at(-1).startedAt=request.correctedAt;
 next.updatedAt=request.correctedAt;validate(next);
 return evolve(next,{id:request.operationId,type:'observe',actor:manager.id,at:request.correctedAt,source:{kind:'manual',ref:request.evidenceRef},roundId:t.roundId,taskId:t.id,observedAt:null,progress:false,summary:`Clock recovery for ${e.id}: original ${e.at}; effective reconciliation timestamp ${request.correctedAt}, NOT verified original submission time. Original bytes retained in recovery evidence. Submission count, result and acceptance unchanged; prior notice must be regenerated.`},next.version,{nowMs});
}
