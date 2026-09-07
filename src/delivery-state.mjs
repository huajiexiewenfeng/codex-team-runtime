// Pure audit projection, shared by validation and planning. No host operations.
const check=(ok,message)=>{if(!ok)throw new Error(message);};
export const deliveryEventTypes=['deliveryCheck','deliveryClaim'];
export function deliveryState(state,task) {
 const events=state.events.filter(e=>e.taskId===task.id&&e.roundId===task.roundId);
 const assignments=events.filter(e=>['assign','startTask'].includes(e.type)),records=events.filter(e=>deliveryEventTypes.includes(e.type));
 const initial=assignments.length===1?assignments[0]:null;
 const result={status:['queued','cancelled'].includes(task.status)?'unstarted':'unknown',attemptId:initial?.id??null,evidenceEventId:null,attempts:0};
 if(!records.length)return result;
 check(initial,'Delivery recovery requires one original assignment audit');
 const round=state.rounds.find(r=>r.id===task.roundId),worker=round.members.find(m=>m.id===task.workerId);
 let started=false,advanced=false,observed=false;
 for(const [index,e] of events.entries()) {
  if(e===initial)started=true;
  if(['submit','review','rework','approve','block','unblock','cancelQueued'].includes(e.type))advanced=true;
  if(e.type==='observe')observed=true;
  if(!deliveryEventTypes.includes(e.type))continue;
  // Prefer audit order when timestamps tie; legacy observations without an audit
  // cannot prove that they followed the delivery operation at the same instant.
  const priorObservation=observed||task.observations.some(o=>{
   const position=events.findIndex(x=>x.type==='observe'&&x.id===o.id&&x.at===o.at);
   return position<0?o.at<=e.at:position<=index;
  });
  check(started&&!advanced,'Delivery event outside initial executing work');
  check(round.members.some(m=>m.id===e.actor&&m.role==='Manager'&&m.lifecycle==='active'),'Delivery audit requires Manager');
  check(e.attemptId===result.attemptId,'Delivery attempt mismatch');
  check(typeof e.summary==='string'&&e.summary.trim().length>0&&e.summary.length<=4000,'Delivery evidence summary required');
  if(e.source.kind==='host-observation')check(e.source.hostId===worker.binding.hostId&&e.source.threadId===worker.binding.threadId,'Delivery evidence Worker identity mismatch');
  if(e.type==='deliveryClaim') {
   check(result.status==='not-delivered','Claim requires checked non-delivery (not-delivered)');
   check(!priorObservation,'Observed work forbids delivery retry');
   result.attemptId=e.id;result.status='unknown';result.attempts++;
  } else {
   check(result.status==='unknown','Delivery attempt already resolved');
   check(['unknown','not-delivered','delivered'].includes(e.outcome),'Invalid delivery outcome');
   check(e.outcome!=='not-delivered'||!priorObservation,'Observed work contradicts non-delivery');
   result.status=e.outcome;
  }
  result.evidenceEventId=e.id;
 }
 return result;
}
