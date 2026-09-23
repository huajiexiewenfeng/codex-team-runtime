import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildTaskTimeline,createTimelineParser} from '../src/task-timeline.mjs';
import {evaluateTaskTimeline,renderTaskEvaluation} from '../src/task-eval.mjs';
import {run} from '../src/cli.mjs';
const fixture=()=>{
 const p=createTimelineParser({sourceRef:'W',hostId:'local',threadId:'worker',role:'Worker',from:'2026-09-01T00:00:00Z',to:'2026-09-01T01:00:00Z'});
 p.push(JSON.stringify({type:'session_meta',payload:{id:'worker'}}));
 for(const timestamp of ['2026-09-01T00:00:00Z','2026-09-01T00:10:00Z'])p.push(JSON.stringify({timestamp,type:'response_item',payload:{type:'message',role:'assistant',content:'SECRET'}}));
 return buildTaskTimeline({teamId:'team',taskId:'task'},[p.finish()]);
};
test('evaluation gives evidence-backed review candidates, not causes or active experiments',()=>{
 const r=fixture(),before=JSON.stringify(r),e=evaluateTaskTimeline(r);
 assert.equal(e.candidates.length,1);assert.equal(e.candidates[0].fact.durationMs,600000);
 assert.deepEqual(e.candidates[0].fact.evidence,['W:2','W:3']);
 for(const field of ['hypothesis','goal','singleChange','verification','disposition'])assert.ok(e.candidates[0][field]);
 assert.equal(e.activeExperiment,null);assert.equal(e.comparison.status,'insufficient-evidence');assert.equal(e.comparison.estimatedSavingsMs,null);
 assert.equal(JSON.stringify(r),before);assert.equal(JSON.stringify(e).includes('SECRET'),false);
 assert.match(renderTaskEvaluation(e),/不能据此归因/);
 assert.deepEqual(evaluateTaskTimeline(r),e);
});
test('unknown stays null, no candidates is not evidence of efficiency',()=>{
 const r=buildTaskTimeline({teamId:'team',taskId:'task'},[]),e=evaluateTaskTimeline(r);
 assert.equal(e.metrics.endToEndMs,null);assert.deepEqual(e.candidates,[]);assert.equal(e.comparison.status,'insufficient-evidence');
});
test('stages use declared time, never combine with log gaps or native durations',()=>{
 const r=fixture();r.businessTimeline={teamId:'team',taskId:'task',stages:[{stageId:'state-stage:0',kind:'declared-stage',status:'submitted',declaredStartAt:'2026-09-01T00:00:00Z',declaredEndAt:'2026-09-01T00:05:00Z',durationMs:300000},{stageId:'state-stage:1',kind:'terminal-state',status:'approved',durationMs:null}]};
 const e=evaluateTaskTimeline(r);assert.equal(e.candidates.find(c=>c.fact.timeBasis==='declaredAt').fact.durationMs,300000);
 assert.equal(e.metrics.unattributedMs,undefined);assert.equal(e.metrics.savedMs,undefined);
 r.gaps[0].durationMs=0;assert.throws(()=>evaluateTaskTimeline(r),/duration/);
});
test('unsupported report, dangling event references and foreign business identity reject',()=>{
 assert.throws(()=>evaluateTaskTimeline({...fixture(),schemaVersion:9}));
 const r=fixture();r.gaps[0].endEventId='unknown';assert.throws(()=>evaluateTaskTimeline(r),/evidence/);
 const other=fixture();other.businessTimeline={teamId:'wrong',taskId:'task',stages:[]};assert.throws(()=>evaluateTaskTimeline(other),/identity/);
});
test('candidate limits do not hide coverage gaps and cannot invent an end-to-end duration',()=>{
 const r=fixture();r.coverage.missing=['nested-process-continuations'];r.endToEndMs=123;
 assert.throws(()=>evaluateTaskTimeline(r),/milestone/);
 r.endToEndMs=null;const e=evaluateTaskTimeline(r);assert.deepEqual(e.coverage.sourceMissing,['nested-process-continuations']);
});
test('CLI exports immutable eval artifacts with source digest and does not modify input',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'task-eval-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const input=join(dir,'report.json'),out=join(dir,'eval'),bytes=JSON.stringify(fixture());await writeFile(input,bytes);
 await run(['task-eval',input,out],()=>{});
 const e=JSON.parse(await readFile(join(out,'evaluation.json'),'utf8'));assert.match(e.sourceSha256,/^[a-f0-9]{64}$/);
 assert.equal(await readFile(input,'utf8'),bytes);assert.match(await readFile(join(out,'evaluation.md'),'utf8'),/待人工复核/);
 await assert.rejects(run(['task-eval',input,out],()=>{}),/EEXIST/);
});
