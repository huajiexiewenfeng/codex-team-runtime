import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineParser, buildTaskTimeline, renderTimelineMarkdown } from '../src/task-timeline.mjs';

const at = second => `2026-09-18T08:00:${String(second).padStart(2,'0')}.000Z`;
const descriptor = {sourceRef:'worker',hostId:'local',threadId:'thread-1',role:'Worker',from:at(0),to:at(59)};
const row = (second,payload,type='response_item') => JSON.stringify({timestamp:at(second),type,payload});
function parsed(rows, overrides={}) {
  const p=createTimelineParser({...descriptor,...overrides});
  p.push(row(0,{id:'thread-1'},'session_meta'));
  for(const r of rows)p.push(r);
  return p.finish();
}
const call=(s,id)=>row(s,{type:'function_call',name:'exec_command',call_id:id,arguments:'SECRET'});
const result=(s,id,output='SECRET')=>row(s,{type:'function_call_output',call_id:id,output});
const options={teamId:'team',taskId:'task',timeZone:'Asia/Shanghai'};
const native=(s,c,meta)=>result(s,c,JSON.stringify({chunk_id:'chunk-'+c,wall_time_seconds:1,output:'SECRET',...meta}));
const poll=(s,c,session)=>row(s,{type:'function_call',name:'write_stdin',call_id:c,arguments:JSON.stringify({session_id:session,chars:'SECRET'})});
test('native process chain ends only at an explicit exit and retains no arguments',()=>{
 const r=buildTaskTimeline(options,[parsed([call(1,'start'),native(2,'start',{session_id:42}),poll(4,'poll',42),native(5,'poll',{session_id:42}),poll(8,'end',42),native(10,'end',{exit_code:0})])]);
 assert.equal(r.processSpans?.length,1);const s=r.processSpans[0];
 assert.equal(s.durationMs,9000);assert.equal(s.exitCode,0);assert.equal(s.completionKnown,true);
 assert.equal(s.timeBasis,'observedAt');assert.equal(s.scope,'process-observation-not-cpu-time');
 assert.equal(JSON.stringify(r).includes('SECRET'),false);
 assert.match(renderTimelineMarkdown(r),/原生进程观测/);
});
test('missing, reused or cross-source process IDs never imply completion',()=>{
 const root=parsed([call(1,'start'),native(2,'start',{session_id:42})]);
 const other=parsed([poll(4,'end',42),native(5,'end',{exit_code:0})],{sourceRef:'other'});
 assert.equal(buildTaskTimeline(options,[root,other]).processSpans?.[0]?.durationMs,null);
 const reused=parsed([call(1,'a'),native(2,'a',{session_id:42}),call(3,'b'),native(4,'b',{session_id:42}),poll(6,'end',42),native(7,'end',{exit_code:0})]);
 assert.ok(buildTaskTimeline(options,[reused]).processSpans?.every(s=>!s.completionKnown));
});
test('non-native tools and conflicting session results cannot close a process',()=>{
 const r=buildTaskTimeline(options,[parsed([call(1,'a'),native(2,'a',{session_id:42}),poll(3,'p',42),native(4,'p',{session_id:99,exit_code:0})])]);
 assert.equal(r.processSpans?.[0]?.completionKnown,false);
 const fake=parsed([row(1,{type:'function_call',name:'other_tool',call_id:'a'}),native(2,'a',{session_id:42})]);
 assert.deepEqual(buildTaskTimeline(options,[fake]).processSpans,[]);
});
test('native failure is completion but not success; reversed clocks stay unknown',()=>{
 const failed=buildTaskTimeline(options,[parsed([call(1,'a'),native(2,'a',{exit_code:1})])]);
 assert.equal(failed.processSpans[0].completionKnown,true);assert.equal(failed.processSpans[0].exitCode,1);
 const reversed=buildTaskTimeline(options,[parsed([call(5,'a'),native(2,'a',{exit_code:0})])]);
 assert.equal(reversed.processSpans[0].durationMs,null);assert.equal(reversed.processSpans[0].completionKnown,false);
});

test('tail events survive without token counts; only metadata is retained',()=>{
  const source=parsed([call(1,'c1'),result(3,'c1'),row(4,{type:'message',role:'assistant',content:'SECRET'}),row(5,{type:'reasoning',summary:'SECRET'})]);
  const r=buildTaskTimeline(options,[source]);
  assert.equal(r.events.length,3);
  assert.equal(r.spans[0].durationMs,2000);
  assert.equal(JSON.stringify(r).includes('SECRET'),false);
  assert.equal(renderTimelineMarkdown(r).includes('SECRET'),false);
  assert.equal(r.coverage.status,'partial');
});
test('yield is first return, not completion; missing and orphan endpoints stay unknown',()=>{
  const r=buildTaskTimeline(options,[parsed([call(1,'a'),result(2,'a','Script running with cell ID 117\nWall time 1.0 seconds\nOutput:\n'),call(3,'b'),result(4,'c')])]);
  assert.equal(r.spans[0].kind,'tool-first-return');
  assert.equal(r.spans[0].completionKnown,false);
  assert.equal(r.spans[1].durationMs,null);
  assert.ok(r.diagnostics.some(x=>x.code==='orphan-result'));
  assert.equal(r.endToEndMs,null);
});
test('duplicate imports are idempotent; repeated call IDs cannot be guessed',()=>{
  const source=parsed([call(1,'a'),call(2,'a'),result(3,'a')]);
  const one=buildTaskTimeline(options,[source]);
  assert.deepEqual(buildTaskTimeline(options,[source,source]),one);
  assert.equal(one.spans.length,0);
  assert.ok(one.diagnostics.some(x=>x.code==='ambiguous-call-id'));
  const altered=structuredClone(source);altered.events[0].observedAt=at(9);
  assert.throws(()=>buildTaskTimeline(options,[source,altered]),/conflict/);
});
test('parallel observed tool intervals use union, never summed total work',()=>{
  const r=buildTaskTimeline({...options,milestones:{request:{sourceRef:'worker',line:2},delivery:{sourceRef:'worker',line:5}}},[parsed([call(1,'a'),call(2,'b'),result(4,'a'),result(5,'b')])]);
  assert.equal(r.observedToolUnionMs,4000);
  assert.equal(r.endToEndMs,4000);
  assert.equal(r.gaps[0].kind,'unattributed-log-gap');
});
test('compaction is a point, clock regression is diagnosed, not negative duration',()=>{
  const r=buildTaskTimeline(options,[parsed([call(5,'a'),result(2,'a'),row(6,{type:'context_compacted'},'event_msg')])]);
  assert.equal(r.spans[0].durationMs,null);
  assert.ok(r.diagnostics.some(x=>x.code==='clock-regression'));
  assert.equal(r.events.at(-1).kind,'compaction');
});
test('identity and unknown timezone fail closed',()=>{
  assert.throws(()=>parsed([], {threadId:'wrong'}),/identity/);
  assert.throws(()=>buildTaskTimeline({...options,timeZone:'bad-zone'},[]),/time zone/i);
});
test('missing call ID is retained; cross-source call IDs never pair',()=>{
  const r=buildTaskTimeline(options,[parsed([call(1,'a')]),parsed([result(2,'a'),result(3,undefined)],{sourceRef:'other'})]);
  assert.equal(r.spans[0].durationMs,null);
  assert.ok(r.diagnostics.some(x=>x.code==='missing-call-id'));
});
test('native process session return is not process completion',()=>{
 const r=buildTaskTimeline(options,[parsed([call(1,'a'),result(2,'a',JSON.stringify({session_id:123,output:'SECRET',wall_time_seconds:1}))])]);
 assert.equal(r.spans[0].completionKnown,false);
 assert.equal(r.spans[0].kind,'tool-first-return');
});
test('exact cell ID links wait completion while nested duration stays separate',()=>{
 const wait=row(3,{type:'function_call',name:'wait',call_id:'w',arguments:JSON.stringify({cell_id:'117',secret:'SECRET'})});
 const output=[{type:'input_text',text:'Script completed\nWall time 2.0 seconds\nOutput:\n'},{type:'input_text',text:JSON.stringify({chunk_id:'c',wall_time_seconds:1.25,exit_code:0,output:'SECRET'})}];
 const r=buildTaskTimeline(options,[parsed([call(1,'a'),result(2,'a','Script running with cell ID 117\nWall time 1.0 seconds\nOutput:\n'),wait,result(5,'w',output)])]);
 assert.equal(r.asyncSpans.length,1);
 assert.equal(r.asyncSpans[0].durationMs,4000);
 assert.equal(r.asyncSpans[0].completionKnown,true);
 assert.equal(r.reportedDurations[0].durationMs,1250);
 assert.equal(r.reportedDurations[0].startAt,null);
 assert.equal(JSON.stringify(r).includes('SECRET'),false);
});
test('cell IDs never link across sources; unknown wait results cannot close a cell',()=>{
 const begin=parsed([call(1,'a'),result(2,'a','Script running with cell ID 117\nWall time 1.0 seconds\nOutput:\n')]);
 const wait=parsed([row(3,{type:'function_call',name:'wait',call_id:'w',arguments:'{"cell_id":"117"}'}),result(4,'w')],{sourceRef:'other'});
 const r=buildTaskTimeline(options,[begin,wait]);
 assert.equal(r.asyncSpans[0].completionKnown,false);
 assert.equal(r.asyncSpans[0].durationMs,null);
});
test('reused cell IDs remain ambiguous instead of selecting nearest completion',()=>{
 const yielded='Script running with cell ID 117\nWall time 1.0 seconds\nOutput:\n';
 const r=buildTaskTimeline(options,[parsed([call(1,'a'),result(2,'a',yielded),call(3,'b'),result(4,'b',yielded),row(5,{type:'function_call',name:'wait',call_id:'w',arguments:'{"cell_id":"117"}'}),result(6,'w','Script completed\nWall time 1.0 seconds\nOutput:\n')])]);
 assert.equal(r.asyncSpans.length,2);
 assert.ok(r.asyncSpans.every(s=>s.durationMs===null));
 assert.ok(r.diagnostics.some(d=>d.code==='ambiguous-cell-continuation'));
});
test('unknown same-source wait output and invalid native duration stay unknown',()=>{
 const r=buildTaskTimeline(options,[parsed([call(1,'a'),result(2,'a','Script running with cell ID 117\nWall time 1.0 seconds\nOutput:\n'),row(3,{type:'function_call',name:'wait',call_id:'w',arguments:'{"cell_id":"117"}'}),result(4,'w',JSON.stringify({chunk_id:'c',wall_time_seconds:-1,output:'Script completed SECRET'}))])]);
 assert.equal(r.asyncSpans[0].completionKnown,false);
 assert.deepEqual(r.reportedDurations,[]);
});
