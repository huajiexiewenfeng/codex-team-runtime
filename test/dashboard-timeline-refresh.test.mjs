import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startDashboardServer} from '../src/dashboard-live.mjs';
import {demoState} from '../src/demo.mjs';
import {buildTaskTimeline} from '../src/task-timeline.mjs';
import {buildStateTimeline} from '../src/task-timeline-state.mjs';
import {evolve} from '../src/runtime.mjs';
import {run} from '../src/cli.mjs';

async function fixture(t,{count=1}={}){
 const dir=await mkdtemp(join(tmpdir(),'timeline-refresh-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state=demoState();
 const tasks=Array.from({length:count},(_,i)=>({...structuredClone(state.tasks[0]),id:'indexed-'+i}));
 state.tasks.push(...tasks);
 const indexPath=join(dir,'index.json');
 const index={schemaVersion:1,teamId:state.team.id,reports:tasks.map(task=>({taskId:task.id,path:task.id+'.json'}))};
 await writeFile(indexPath,JSON.stringify(index));
 const report=buildTaskTimeline({teamId:state.team.id,taskId:tasks.at(-1).id},[]);
 report.businessTimeline=buildStateTimeline(state,{teamId:state.team.id,taskId:report.taskId,roundId:tasks.at(-1).roundId});
 const reportPath=join(dir,report.taskId+'.json');await writeFile(reportPath,JSON.stringify(report));
 let reads=0;
 const service=await startDashboardServer({statePath:'unused.json',timelineIndexPath:indexPath,port:0,read:async()=>{reads++;return structuredClone(state);}});t.after(()=>service.close());
 const token=new URLSearchParams(new URL(service.url).hash.slice(1)).get('token');
 const get=(query='')=>fetch(service.origin+'/api/timeline'+query,{headers:{Authorization:`Bearer ${token}`}});
 return {state,index,indexPath,report,reportPath,get,service,reads:()=>reads};
}

test('index supports more than 32 bindings and opens only the selected report',async t=>{
 const f=await fixture(t,{count:40});
 const response=await f.get('?task=indexed-39'),r=await response.json();
 assert.equal(response.status,200);assert.equal(r.status,'ready');assert.equal(r.taskId,'indexed-39');
 assert.equal(r.unavailableReports,0);assert.equal(r.checkedReports,1);
 assert.equal(r.tasks.filter(task=>task.reportConfigured).length,40);
 assert.equal(JSON.stringify(r).includes(f.reportPath),false);
});

test('refresh rebuilds latest declared stages without replacing historical evidence or writing state/report',async t=>{
 const f=await fixture(t),before=await readFile(f.reportPath,'utf8');
 const old=await (await f.get('?task=indexed-0')).json();assert.equal(old.status,'ready');
 const reads=f.reads();Object.assign(f.state,evolve(f.state,{id:'refresh-fixture-event',type:'observe',actor:'worker-04',at:'2026-09-05T02:00:00.000Z',source:{kind:'fixture',ref:'timeline-refresh-test'},roundId:'round-demo',taskId:'T-4',observedAt:null,summary:'fixture observation',progress:false},f.state.version));
 const response=await f.get('?task=indexed-0&refresh=state'),r=await response.json();
 assert.equal(response.status,200);assert.equal(r.status,'ready');assert.equal(f.reads(),reads+1);
 assert.equal(r.stageData.mode,'refreshed-state');assert.equal(r.stageData.sourceVersion,f.state.version);
 assert.equal(r.stageData.sourceUpdatedAt,f.state.updatedAt);assert.equal(r.observations.status,'not_collected');
 assert.equal(r.observations.latestObservedAt,null);assert.match(r.html,/未采集/);assert.match(r.html,/不采集日志/);
 assert.equal(await readFile(f.reportPath,'utf8'),before);
 const reloaded=await (await f.get('?task=indexed-0')).json();
 assert.equal(reloaded.stageData.mode,'report-snapshot');assert.equal(reloaded.stale,true);
 assert.equal(reloaded.stageData.sourceVersion,f.report.businessTimeline.sourceVersion);
});

test('unbound tasks can refresh state, while plain reread stays explicitly unbound',async t=>{
 const f=await fixture(t);
 assert.equal((await (await f.get('?task=T-2')).json()).status,'task_not_configured');
 const response=await f.get('?task=T-2&refresh=state'),r=await response.json();
 assert.equal(response.status,200);assert.equal(r.taskId,'T-2');assert.equal(r.stageData.mode,'refreshed-state');
 assert.equal(r.observations.status,'not_collected');assert.match(r.html,/未知/);
});

test('index identity and duplicate bindings fail closed without leaking filesystem paths',async t=>{
 const f=await fixture(t);
 for(const index of [{...f.index,teamId:'wrong'},{...f.index,reports:[...f.index.reports,...f.index.reports]}]){
  await writeFile(f.indexPath,JSON.stringify(index));const response=await f.get('?task=indexed-0&refresh=state');
  assert.equal(response.status,503);assert.equal((await response.text()).includes(f.indexPath),false);
 }
});

test('refresh endpoint remains authenticated and read-only, rejects ambiguous requests',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.service.origin+'/api/timeline?task=T-1&refresh=state')).status,401);
 for(const query of ['?task=T-1&refresh=all','?task=T-1&refresh=state&refresh=state','?task=unknown&refresh=state','?path=private&refresh=state'])assert.equal((await f.get(query)).status,400);
});

test('CLI accepts explicit index and UI separates reread from stage refresh',async t=>{
 const f=await fixture(t);
 const server=await run(['dashboard-serve','unused.json','--port','0','--timeline-index',f.indexPath],()=>{});t.after(()=>server.close());
 const html=await (await fetch(server.origin)).text();
 assert.match(html,/id="timeline-update"[^>]*>更新阶段数据<\/button>/);
 assert.match(html,/不采集日志/);
 for(const args of [['--timeline-index',f.indexPath,'--timeline-index',f.indexPath],['--timeline-index',f.indexPath,'--timeline-report',f.reportPath]])await assert.rejects(()=>run(['dashboard-serve','unused.json','--port','0',...args],()=>{}),/index|dashboard-serve/);
});

test('mismatched report never substitutes its data; state refresh exposes its failure independently',async t=>{
 const f=await fixture(t);
 await writeFile(f.reportPath,JSON.stringify({...f.report,taskId:'T-2'}));
 const r=await (await f.get('?task=indexed-0')).json();
 assert.equal(r.status,'report_unavailable');assert.equal(r.html,undefined);assert.equal(r.unavailableReports,1);
 const updated=await (await f.get('?task=indexed-0&refresh=state')).json();
 assert.equal(updated.status,'ready');assert.equal(updated.taskId,'indexed-0');assert.equal(updated.reportStatus,'unavailable');
 assert.ok(updated.observations.missing.includes('bound-report-unavailable'));
});

test('stage refresh preserves historical observation window and tool duration without claiming a new sample',async t=>{
 const f=await fixture(t),r=f.report;
 r.sources=[{sourceRef:'fixture',from:'2026-09-05T00:00:00.000Z',to:'2026-09-05T00:16:00.000Z'}];
 r.events=[{eventId:'fixture:1',role:'Worker',kind:'tool-call',tool:'fixture-tool',observedAt:'2026-09-05T00:01:00.000Z'}];r.observedToolUnionMs=8000;
 await writeFile(f.reportPath,JSON.stringify(r));const before=await readFile(f.reportPath,'utf8'),stateBefore=JSON.stringify(f.state);
 const updated=await (await f.get('?task=indexed-0&refresh=state')).json();
 assert.equal(updated.observations.status,'historical');assert.equal(updated.observations.latestObservedAt,r.events[0].observedAt);
 assert.deepEqual(updated.observations.windows,[{from:r.sources[0].from,to:r.sources[0].to}]);
 assert.match(updated.html,/8\.000 秒/);assert.match(updated.html,/沿用历史采样/);
 assert.equal(await readFile(f.reportPath,'utf8'),before);assert.equal(JSON.stringify(f.state),stateBefore);
});
