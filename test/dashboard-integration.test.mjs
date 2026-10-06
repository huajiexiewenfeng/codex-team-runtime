import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep,basename} from 'node:path';
import {createDashboardFixture} from '../src/dashboard-fixture.mjs';
import {startDashboardServer} from '../src/dashboard-live.mjs';
import {validate} from '../src/runtime.mjs';
import {refreshStats,releaseStatsSession} from '../src/stats-collector.mjs';
import {createDashboardQueries,projectDashboardState} from '../src/dashboard-query.mjs';
const asOf='2026-10-05T06:00:00.000Z';let root,f,state;
test.before(async()=>{root=await mkdtemp(join(tmpdir(),'runtime-dashboard-u3-'));f=await createDashboardFixture(join(root,'fixture'),{taskCount:16,activityTaskCount:1,longNames:true,asOf});const seed=JSON.parse(await readFile(f.statePath,'utf8')),events=seed.events.filter(e=>!e.taskId),tasks=[];
  for(let i=0;i<1000;i++){const original=i<991?seed.tasks[0]:seed.tasks[i-991+7],id=`task-${String(i).padStart(3,'0')}`;tasks.push({...structuredClone(original),id,title:`任务 ${id} · ${original.title}`});for(const e of seed.events.filter(e=>e.taskId===original.id))events.push({...structuredClone(e),id:`capacity-event-${events.length}`,taskId:id});}
  state={...seed,tasks,events:events.toSorted((a,b)=>a.at.localeCompare(b.at)),version:events.length};validate(state);await writeFile(f.statePath,JSON.stringify(state));await refreshStats(f.manifestPath,f.cache,{asOf});
});
test.after(async()=>{releaseStatsSession(f.cache);const path=await realpath(root),parent=await realpath(tmpdir());assert.ok(path.startsWith(parent+sep)&&/^runtime-dashboard-u3-/.test(basename(path)));await rm(path,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
async function serve(t){let instant=Date.parse(asOf);const s=await startDashboardServer({statePath:f.statePath,teamId:f.teamId,sourceManifestPath:f.manifestPath,statsCachePath:f.cache,port:0,cacheMs:0,now:()=>instant});t.after(()=>s.close());const token=new URLSearchParams(new URL(s.url).hash.slice(1)).get('token');const get=async(path,expected=200)=>{const r=await fetch(s.origin+'/api/v2/'+path,{headers:{Authorization:`Bearer ${token}`}}),body=await r.text();assert.equal(r.status,expected,body);assert.ok(Buffer.byteLength(body)<=1048576);return JSON.parse(body);};return {...s,get,advance:n=>instant+=n};}
test('1000 long Chinese tasks exceed a response-sized internal projection but all remain pageable, filtered, sorted and locatable',async t=>{
  assert.ok(Buffer.byteLength(JSON.stringify(projectDashboardState(state)))>1048576);const s=await serve(t),first=await s.get('tasks?sort=id&direction=asc&pageSize=20');assert.equal(first.data.total,1000);assert.equal(first.data.rows.length,20);assert.equal(first.data.pageCount,50);const base=first.baseSnapshotId,snapshot=first.querySnapshotId;
  const last=await s.get(`locate?targetKind=task&targetId=task-999&sort=id&direction=asc&pageSize=20&baseSnapshotId=${base}&snapshotId=${snapshot}`);assert.equal(last.data.location.page,50);assert.equal(last.data.rows.at(-1).id,'task-999');
  const large=await s.get(`tasks?pageSize=50&sort=id&direction=desc&baseSnapshotId=${base}`);assert.equal(large.data.rows.length,50);assert.equal(large.data.pageCount,20);assert.equal(large.data.rows[0].id,'task-999');assert.ok(large.data.rows.every(r=>!Array.isArray(r.currentStage)&&r.currentStage.ownerId===null));
  const filtered=await s.get(`locate?targetKind=task&targetId=task-999&search=task-000&baseSnapshotId=${base}`);assert.equal(filtered.data.total,1);assert.equal(filtered.data.location.matchesCurrentFilters,false);const approved=await s.get(`tasks?status=approved&baseSnapshotId=${base}`);assert.equal(approved.data.total,991);assert.ok(approved.data.rows.every(r=>r.status==='approved'));
  const detail=await s.get(`task?taskId=task-000&baseSnapshotId=${base}`);assert.equal(detail.data.stages.total,4);assert.equal(detail.data.stages.rows[0].durationMs,5000);assert.equal(detail.data.stages.rows[0].assurance,'task-declared');
  const metrics=await s.get(`metrics?dimension=time&pageSize=50&baseSnapshotId=${base}`);assert.equal(metrics.data.total,1000);assert.equal(metrics.data.rows.length,50);assert.equal(metrics.baseSnapshotId,base);
  s.advance(120000);await s.get(`tasks?baseSnapshotId=${base}&snapshotId=${snapshot}&sort=id&direction=asc&pageSize=20`,409);
});
test('internal projection budget rejection happens before disk lease creation, without losing task history',async()=>{
  const oversized={...state,tasks:Array.from({length:1000},(_,i)=>({...state.tasks[i],title:'字'.repeat(512),stages:Array.from({length:600},()=>state.tasks[i].stages[0])}))};const before=await readdir(f.cache),q=createDashboardQueries({teamId:f.teamId,current:async()=>oversized,manifestPath:f.manifestPath,cache:f.cache,now:()=>Date.parse(asOf)});await assert.rejects(q.handle('tasks',{}),/bounded_budget_busy/);q.close();assert.deepEqual(await readdir(f.cache),before);
});
test('cached statistics still validate the original disk lease, query contract and rules version',async t=>{
  const s=await serve(t),first=await s.get('metrics?dimension=time&view=members');await s.get(`metrics?dimension=time&view=members&baseSnapshotId=${first.baseSnapshotId}&snapshotId=${first.querySnapshotId}`);
  const path=join(f.cache,`stats-lease-${first.querySnapshotId}.json`),original=await readFile(path,'utf8'),value=JSON.parse(original);value.index.rulesVersion='dashboard-stats-v1';await writeFile(path,JSON.stringify(value));try{await s.get(`metrics?dimension=time&view=members&baseSnapshotId=${first.baseSnapshotId}&snapshotId=${first.querySnapshotId}`,503);}finally{await writeFile(path,original);}
  await s.get(`metrics?dimension=time&view=members&search=other&baseSnapshotId=${first.baseSnapshotId}&snapshotId=${first.querySnapshotId}`,400);
});
