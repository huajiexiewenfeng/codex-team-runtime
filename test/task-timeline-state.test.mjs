import test from 'node:test';
import assert from 'node:assert/strict';
import {demoState} from '../src/demo.mjs';
import {buildStateTimeline} from '../src/task-timeline-state.mjs';
const options={teamId:'demo-team',roundId:'round-demo',taskId:'T-1'};
test('state stages are declared elapsed, not observed execution',()=>{
 const state=demoState(),before=JSON.stringify(state),r=buildStateTimeline(state,options);
 assert.equal(r.stages[0].status,'executing');
 assert.equal(r.stages[0].timeBasis,'declaredAt');
 assert.equal(r.stages[0].durationMs,300000);
 assert.equal(r.events.find(e=>e.kind==='submit').observedAt,null);
 assert.equal(r.events.find(e=>e.kind==='submit').role,'Worker');
 assert.equal(r.stages.at(-1).durationMs,null);
 assert.equal(r.stages.at(-1).kind,'terminal-state');
 assert.equal(JSON.stringify(state),before);
 assert.equal(JSON.stringify(r).includes('示例交付'),false);
 assert.equal(JSON.stringify(r).includes('fixture:test-result'),false);
});
test('wrong team, round, task and malformed timestamp fail closed',()=>{
 for(const patch of [{teamId:'wrong'},{roundId:'wrong'},{taskId:'wrong'}])assert.throws(()=>buildStateTimeline(demoState(),{...options,...patch}),/mismatch|missing/);
 const state=demoState();state.tasks[0].stages[0].startedAt='invalid';
 assert.throws(()=>buildStateTimeline(state,options));
});
test('rework remains a separate stage; unknown stage endpoint is null',()=>{
 const r=buildStateTimeline(demoState(),{...options,taskId:'T-2'});
 assert.equal(r.stages.filter(s=>s.status==='submitted').length,2);
 assert.equal(r.stages.filter(s=>s.status==='rework').length,1);
 assert.equal(r.stages.at(-1).durationMs,null);
 const unstarted=buildStateTimeline(demoState(),{...options,taskId:'T-4'});
 assert.equal(unstarted.stages[0].durationMs,null);
});
