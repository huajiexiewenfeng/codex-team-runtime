import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createState,evolve,validate} from '../src/runtime.mjs';
const nowMs=Date.parse('2026-09-28T09:35:00.000Z');
const source={kind:'fixture',ref:'event-clock'};
function state(){return createState({teamId:'clock',name:'Clock',source,members:['Manager','Liaison','Worker'].map((role,i)=>({id:`m${i}`,role,name:role,lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:`thread-${i}`}}))},'2026-09-28T09:29:00.000Z');}
const event=at=>({id:'open',type:'openRound',actor:'m0',roundId:'r',title:'R',source,at});
test('reject future event without changing caller state',()=>{
 const s=state(),before=structuredClone(s);
 assert.throws(()=>evolve(s,event('2026-09-28T18:00:00.000Z'),0,{nowMs}),/Event time exceeds host clock/);
 assert.deepEqual(s,before);
});
test('clock tolerance is bounded to sixty seconds',()=>{
 assert.equal(evolve(state(),event('2026-09-28T09:36:00.000Z'),0,{nowMs}).version,1);
 assert.throws(()=>evolve(state(),event('2026-09-28T09:36:00.001Z'),0,{nowMs}),/Event time exceeds host clock/);
});
test('historical validation remains clock independent; backwards writes still rejected',()=>{
 const s=evolve(state(),event('2026-09-28T09:35:00.000Z'),0,{nowMs});
 assert.equal(validate(s),s);
 assert.throws(()=>evolve(s,{id:'reports',type:'reports',actor:'m0',source,at:'2026-09-28T09:34:00.000Z',enabled:false},1,{nowMs}),/Event time moved backwards/);
});
