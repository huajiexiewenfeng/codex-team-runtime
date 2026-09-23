import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demoState} from '../src/demo.mjs';
import {buildTaskTimeline} from '../src/task-timeline.mjs';
import {readDashboardTimeline,renderDashboardTimeline,readDashboardTimelines} from '../src/dashboard-timeline.mjs';
import {startDashboardServer} from '../src/dashboard-live.mjs';
import {buildStateTimeline} from '../src/task-timeline-state.mjs';
const report=()=>buildTaskTimeline({teamId:'demo-team',taskId:'T-1'},[]);
test('host-reported internal duration is displayed separately with provenance',()=>{
 const r=report();r.nativeObservations=[{sourceRef:'native',role:'Worker',items:[{itemId:'build',kind:'commandExecution',durationMs:484805,exitCode:0}]}];
 assert.match(renderDashboardTimeline(r),/宿主内部调用报告/);assert.match(renderDashboardTimeline(r),/8 分 4\.805 秒/);
});
test('process observations display independently with unknown exit and duration preserved',()=>{
 const r=report();r.processSpans=[{startEventId:'worker:2',endEventId:null,durationMs:null,exitCode:null}];
 const html=renderDashboardTimeline(r);assert.match(html,/原生进程观测/);assert.match(html,/未知/);
 r.processSpans={};assert.throws(()=>renderDashboardTimeline(r),/collections/);
});
test('multiple bindings select exact task and never substitute another report',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'timeline-multi-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const a=join(dir,'a.json'),b=join(dir,'b.json');await writeFile(a,JSON.stringify(report()));await writeFile(b,JSON.stringify({...report(),taskId:'T-2'}));
 const result=await readDashboardTimelines([a,b],demoState(),'T-2');
 assert.equal(result.taskId,'T-2');assert.equal(result.tasks.filter(t=>t.available).length,2);
 const missing=await readDashboardTimelines([a,b],demoState(),'T-3');
 assert.equal(missing.status,'task_not_configured');assert.equal(missing.html,undefined);
 await assert.rejects(readDashboardTimelines([a,a],demoState(),'T-1'),/Duplicate/);
 await assert.rejects(readDashboardTimelines([a],demoState(),'unknown'),/Unknown task/);
 const partial=await readDashboardTimelines([a,join(dir,'missing.json')],demoState(),'T-1');
 assert.equal(partial.status,'ready');assert.equal(partial.unavailableReports,1);
});
test('readable duration and Chinese stages preserve unknown, zero and source values',()=>{
 const r=report();r.endToEndMs=3352758;r.observedToolUnionMs=0;
 r.businessTimeline=buildStateTimeline(demoState(),{teamId:'demo-team',roundId:'round-demo',taskId:'T-1'});
 const before=JSON.stringify(r),html=renderDashboardTimeline(r);
 assert.match(html,/55 分 52\.758 秒/);assert.match(html,/0\.000 秒/);
 assert.match(html,/执行中/);assert.match(html,/待审查/);assert.match(html,/已验收/);
 assert.equal(JSON.stringify(r),before);
 r.endToEndMs=3661000;assert.match(renderDashboardTimeline(r),/1 小时 1 分 1\.000 秒/);
 r.endToEndMs=null;assert.match(renderDashboardTimeline(r),/端到端历时：<strong>未知/);
});
test('timeline is escaped, partial, unknown is not zero and details are expandable',()=>{
 const r=report();r.taskId='<script>alert(1)</script>';
 const html=renderDashboardTimeline(r);
 assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
 assert.match(html,/未知/);assert.match(html,/部分覆盖/);assert.match(html,/<details/);
 assert.match(html,/overflow/);
});
test('binding checks current team and task; missing binding is not empty usage',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-timeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'report.json');
 assert.equal((await readDashboardTimeline(null,demoState())).status,'not_configured');
 await writeFile(path,JSON.stringify(report()));
 assert.equal((await readDashboardTimeline(path,demoState())).status,'ready');
 await writeFile(path,JSON.stringify({...report(),teamId:'wrong'}));
 await assert.rejects(readDashboardTimeline(path,demoState()),/team/);
 await writeFile(path,JSON.stringify({...report(),taskId:'wrong'}));
 await assert.rejects(readDashboardTimeline(path,demoState()),/task/);
 await writeFile(path,JSON.stringify({...report(),schemaVersion:999}));
 await assert.rejects(readDashboardTimeline(path,demoState()),/schema/);
});
test('authenticated bound report works independently of daily metrics and marks stale state',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-timeline-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'report.json'),r=report();r.businessTimeline=buildStateTimeline(demoState(),{teamId:'demo-team',roundId:'round-demo',taskId:'T-1'});r.businessTimeline.sourceVersion--;
 await writeFile(path,JSON.stringify(r));
 const service=await startDashboardServer({statePath:join(dir,'unused.json'),timelineReportPath:path,port:0,read:async()=>demoState()});t.after(()=>service.close());
 const token=new URLSearchParams(new URL(service.url).hash.slice(1)).get('token');
 const response=await fetch(service.origin+'/api/timeline',{headers:{Authorization:`Bearer ${token}`}});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.stale,true);assert.match(body.html,/旧快照/);
 assert.equal(JSON.stringify(body).includes(path),false);
 const headers={Authorization:`Bearer ${token}`};
 const missing=await fetch(service.origin+'/api/timeline?task=T-3',{headers});
 assert.equal(missing.status,200);const absent=await missing.json();assert.equal(absent.status,'task_not_configured');assert.equal(absent.html,undefined);
 for(const query of ['?task=unknown','?task=T-1&task=T-2','?path=secret'])assert.equal((await fetch(service.origin+'/api/timeline'+query,{headers})).status,400);
});
