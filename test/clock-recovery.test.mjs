import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createState,evolve,validate} from '../src/runtime.mjs';
import {recoverFinalSubmitClock} from '../src/clock-recovery.mjs';
const now='2026-09-28T09:40:00.000Z',future='2026-09-28T18:00:00.000Z';
const source={kind:'fixture',ref:'clock'},caller={hostId:'local',threadId:'m'};
function setup(){
 let s=createState({teamId:'team',name:'T',source,members:[['m','Manager'],['l','Liaison'],['w','Worker']].map(([id,role])=>({id,role,name:id,lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:id}}))},'2026-09-28T09:00:00.000Z');
 for(const [type,data,actor,at] of [['openRound',{roundId:'r',title:'R'},'m','2026-09-28T09:01:00.000Z'],['assign',{roundId:'r',taskId:'t',title:'T',workerId:'w',required:true,assignedAt:'2026-09-28T09:02:00.000Z'},'m','2026-09-28T09:02:00.000Z'],['submit',{roundId:'r',taskId:'t',summary:'evidence'},'w',future]])s=evolve(s,{id:type,type,actor,at,source,...data},s.version,{nowMs:Date.parse(future)});
 return s;
}
const request={caller,eventId:'submit',operationId:'clock-repair',correctedAt:now,evidenceRef:'saved-evidence'};
test('only final submit timing changes; append audit and preserve submission count, members and other tasks',()=>{
 const s=setup(),before=structuredClone(s),next=recoverFinalSubmitClock(s,request,Date.parse(now));
 assert.deepEqual(s,before);validate(next);
 assert.equal(next.version,4);assert.equal(next.tasks[0].status,'submitted');assert.equal(next.tasks[0].submissions,1);
 assert.equal(next.events[2].at,now);assert.equal(next.tasks[0].stages.at(-2).endedAt,now);
 assert.equal(next.tasks[0].stages.at(-1).startedAt,now);assert.equal(next.events.at(-1).type,'observe');
 assert.deepEqual(next.members,s.members);assert.deepEqual(next.rounds,s.rounds);
 assert.deepEqual(next.events.slice(0,2),s.events.slice(0,2));assert.equal(next.events[2].summary,s.events[2].summary);
});
test('reject wrong event, actor, future replacement, older replacement and missing evidence',()=>{
 for(const extra of [{eventId:'assign'},{caller:{hostId:'local',threadId:'w'}},{correctedAt:future},{correctedAt:'2026-09-28T08:00:00.000Z'},{evidenceRef:''}])assert.throws(()=>recoverFinalSubmitClock(setup(),{...request,...extra},Date.parse(now)));
});
test('refuse a submission with subsequent events; never silently drop them',()=>{
 const s=setup(),later=evolve(s,{id:'later',type:'review',actor:'m',at:future,source,roundId:'r',taskId:'t'},s.version,{nowMs:Date.parse(future)});
 assert.throws(()=>recoverFinalSubmitClock(later,request,Date.parse(now)),/final submit/);
});
