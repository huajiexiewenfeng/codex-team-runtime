import {isDeepStrictEqual} from 'node:util';
const check=(ok,message)=>{if(!ok)throw Error(message);};
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4000;
const exact=(v,keys)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Revocation fields mismatch');
export const revocationFor=(s,id)=>s.events.find(e=>e.type==='revokeWorker'&&e.revocation.memberId===id);
export const handoffHold=(s,id)=>s.events.find(e=>e.type==='revokeWorker'&&e.revocation.handoffTaskIds.includes(id)&&!s.events.some(r=>r.type==='resolveRevocation'&&r.revocationId===e.id));
export function checkRevocation(s,e){
 const c=e.revocation;
 exact(c,['teamId','memberId','worker','taskIds','handoffTaskIds','authorizationRef','intent','execution','wipRef']);
 check(c.teamId===s.team.id,'Revocation team mismatch');
 const m=s.members.find(m=>m.id===e.actor),w=s.members.find(m=>m.id===c.memberId);
 check(m?.role==='Manager'&&m.binding.status==='bound'&&isDeepStrictEqual(e.caller,{hostId:m.binding.hostId,threadId:m.binding.threadId}),'Revocation Manager mismatch');
 check(w?.role==='Worker'&&w.binding.status==='bound'&&isDeepStrictEqual(c.worker,{hostId:w.binding.hostId,threadId:w.binding.threadId}),'Revocation Worker mismatch');
 check(text(c.authorizationRef)&&c.authorizationRef===e.source.ref&&c.intent==='revoke-and-exit','Explicit scoped revocation authorization required');
 check(c.execution==='unknown'&&text(c.wipRef)&&text(e.summary),'Unknown execution risk and WIP evidence required');
 for(const key of ['taskIds','handoffTaskIds'])check(Array.isArray(c[key])&&c[key].length>0&&c[key].every(text)&&new Set(c[key]).size===c[key].length,'Exact nonempty task scope required');
 for(const id of c.taskIds){const t=s.tasks.find(t=>t.id===id);check(t&&t.workerId===w.id&&t.submissions===0&&t.stages.every(p=>['queued','executing','cancelled'].includes(p.status)),'Revocation supports only selected initial unsubmitted work');}
 for(const id of c.handoffTaskIds){const t=s.tasks.find(t=>t.id===id);check(t&&t.workerId!==w.id&&t.stages[0].status==='queued'&&t.stages[0].startedAt<=e.at&&c.taskIds.some(old=>s.tasks.find(t=>t.id===old).roundId===t.roundId),'Handoff task scope mismatch');}
}
export function checkResolution(s,e){
 const r=s.events.find(r=>r.id===e.revocationId&&r.type==='revokeWorker');
 check(r&&e.at>=r.at&&['isolated','stopped'].includes(e.disposition)&&text(e.evidenceRef)&&text(e.summary),'Handoff requires isolation or stop evidence');
 const m=s.members.find(m=>m.id===e.actor);
 check(m?.role==='Manager'&&isDeepStrictEqual(e.caller,{hostId:m.binding.hostId,threadId:m.binding.threadId}),'Resolution Manager mismatch');
}
