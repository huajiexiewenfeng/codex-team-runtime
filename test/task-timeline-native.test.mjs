import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNativeTimeline} from '../src/task-timeline-native.mjs';
const descriptor={sourceRef:'native-worker',hostId:'local',threadId:'worker',role:'Worker',turnId:'turn',itemIds:['build']};
const page=()=>({schemaVersion:1,thread:{id:'worker',hostId:'local'},turns:[{id:'turn',items:[{id:'build',type:'commandExecution',status:'completed',exitCode:0,durationMs:484805,command:'SECRET',cwd:'SECRET',aggregatedOutput:'SECRET'},{id:'other',type:'commandExecution',durationMs:999}]}]});
test('explicit native item selection retains reported duration without invented endpoints or content',()=>{
 const r=projectNativeTimeline(page(),descriptor);
 assert.equal(r.items.length,1);assert.equal(r.items[0].durationMs,484805);
 assert.equal(r.items[0].startAt,null);assert.equal(r.items[0].endAt,null);
 assert.equal(r.items[0].timeBasis,'host-reported-duration');assert.equal(JSON.stringify(r).includes('SECRET'),false);
});
test('native identity, turn and item mismatches reject rather than guessing',()=>{
 for(const override of [{hostId:'other'},{threadId:'other'},{turnId:'other'},{itemIds:['missing']},{itemIds:['build','build']}])assert.throws(()=>projectNativeTimeline(page(),{...descriptor,...override}));
 const p=page();p.turns[0].items.push({...p.turns[0].items[0]});assert.throws(()=>projectNativeTimeline(p,descriptor),/ambiguous/);
});
test('unknown duration is null, zero stays zero; reasoning is never a supported item',()=>{
 for(const value of [undefined,-1,Infinity,'123']){const p=page();p.turns[0].items[0].durationMs=value;assert.equal(projectNativeTimeline(p,descriptor).items[0].durationMs,null);}
 const p=page();p.turns[0].items[0].durationMs=0;assert.equal(projectNativeTimeline(p,descriptor).items[0].durationMs,0);
 p.turns[0].items[0].type='reasoning';assert.throws(()=>projectNativeTimeline(p,descriptor),/Unsupported/);
});
