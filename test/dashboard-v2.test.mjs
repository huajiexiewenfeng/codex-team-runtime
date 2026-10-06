import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,appendFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep,basename} from 'node:path';
import {createDashboardFixture} from '../src/dashboard-fixture.mjs';
import {startDashboardServer} from '../src/dashboard-live.mjs';
import {createRequestLane,createDashboardPoller,buildDetailRequest,createDetailRecovery} from '../src/dashboard-v2-client.mjs';
import {releaseStatsSession} from '../src/stats-collector.mjs';
const asOf='2026-10-05T06:00:00.000Z';
let root,fixture;
test.before(async()=>{root=await mkdtemp(join(tmpdir(),'runtime-dashboard-u2-'));fixture=await createDashboardFixture(join(root,'fixture'),{asOf});});
test.after(async()=>{releaseStatsSession(fixture.cache);const path=await realpath(root),parent=await realpath(tmpdir());assert.ok(path.startsWith(parent+sep)&&/^runtime-dashboard-u2-/.test(basename(path)));await rm(path,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
async function serve(t){let instant=Date.parse(asOf);const service=await startDashboardServer({statePath:fixture.statePath,teamId:fixture.teamId,sourceManifestPath:fixture.manifestPath,statsCachePath:fixture.cache,port:0,now:()=>instant,cacheMs:0});t.after(()=>service.close());const token=new URLSearchParams(new URL(service.url).hash.slice(1)).get('token');const get=(path,options={})=>fetch(service.origin+path,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers}});return {...service,get,advance:ms=>{instant+=ms;},json:async path=>{const response=await get(path);assert.equal(response.status,200,await response.clone().text());return response.json();}};}

test('v2 authenticated fixed-source endpoints reject unrelated keys, paths, bad enums and preserve v1',async t=>{
  const s=await serve(t);assert.equal((await fetch(s.origin+'/api/v2/tasks')).status,401);assert.equal((await s.get('/api/v2/tasks',{method:'POST'})).status,405);
  for(const query of ['path=E:/secret','team=other','dimension=banana&preset=nonsense','preset=7','search=x&search=y','sort=unknown','pageSize=100','memberId=unknown&mode=current'])assert.equal((await s.get('/api/v2/tasks?'+query)).status,400,query);
  assert.equal((await s.get('/api/v2/metrics?dimension=banana')).status,400);assert.equal((await s.get('/api/v2/snapshot?refresh=all')).status,400);assert.equal((await s.get('/api/view')).status,200);
  const html=await (await fetch(s.origin)).text();assert.match(html,/overview-panel/);assert.match(html,/data-dimension="time"/);assert.match(html,/dashboard-v2-client/);
});
test('56 current tasks/11 roster members use real sorted 20/50 paging and third-page locate with stable filters',async t=>{
  const s=await serve(t),current=await s.json('/api/v2/overview?mode=current');assert.equal(current.data.counts.members,11);assert.equal(current.data.counts.tasks,56);assert.ok(current.data.rows.every(m=>m.nameProvenance.asOf===current.stateAsOf));
  const first=await s.json('/api/v2/tasks?sort=id&direction=asc&pageSize=20'),base=first.baseSnapshotId,snap=first.querySnapshotId;assert.equal(first.data.rows.length,20);assert.equal(first.data.pageCount,3);assert.equal(first.data.rows[0].id,'task-000');
  const locate=await s.json(`/api/v2/locate?targetKind=task&targetId=task-055&sort=id&direction=asc&pageSize=20&baseSnapshotId=${base}&snapshotId=${snap}`);assert.equal(locate.data.location.page,3);assert.equal(locate.data.rows.length,16);
  const filtered=await s.json('/api/v2/locate?targetKind=task&targetId=task-055&search=task-000&sort=id&direction=asc');assert.equal(filtered.data.location.matchesCurrentFilters,false);assert.equal(filtered.data.location.page,null);
  const task=await s.json(`/api/v2/task?taskId=task-055&baseSnapshotId=${base}`);assert.equal(task.data.stages.rows[0].ownerId,null);assert.equal(task.data.task.taskWallClockMs,null);
  s.advance(120000);assert.equal((await s.get(`/api/v2/tasks?sort=id&direction=asc&baseSnapshotId=${base}&snapshotId=${snap}`)).status,409);
});
test('daily table→members→calls uses same immutable source base; every child preset and inherited identity filter is checked',async t=>{
  const s=await serve(t),snapshot=await s.json('/api/v2/snapshot'),base=snapshot.baseSnapshotId;
  const daily=await s.json(`/api/v2/metrics?dimension=mcp&preset=custom&from=2026-10-04&to=2026-10-04&baseSnapshotId=${base}`);assert.equal(daily.data.rows.length,1);assert.equal(daily.data.rows[0].summary.mcp[1].calls,11);
  for(const preset of ['all','7','30','today'])assert.equal((await s.get(`/api/v2/metrics?dimension=mcp&view=members&preset=${preset}&baseSnapshotId=${base}&parentSnapshotId=${daily.querySnapshotId}`)).status,400,preset);
  assert.equal((await s.get(`/api/v2/metrics?dimension=mcp&view=members&baseSnapshotId=${base}&parentSnapshotId=${daily.querySnapshotId}`)).status,400,'default preset must not expand');
  const child=await s.json(`/api/v2/metrics?dimension=mcp&view=members&preset=custom&from=2026-10-04&to=2026-10-04&baseSnapshotId=${base}&parentSnapshotId=${daily.querySnapshotId}`);assert.equal(child.baseSnapshotId,base);assert.equal(child.data.rows.reduce((sum,r)=>sum+(r.time.mcp[1].calls??0),0),11);assert.equal(child.statsSourceSnapshotId,daily.statsSourceSnapshotId);
  const call=await s.json(`/api/v2/metrics?dimension=mcp&view=calls&memberId=worker-1&series=team-context&preset=custom&from=2026-10-04&to=2026-10-04&baseSnapshotId=${base}&parentSnapshotId=${daily.querySnapshotId}`);assert.equal(call.data.total,1);assert.equal(call.data.rows[0].durationMs,1000);
  const bkey=child.data.rows.find(r=>r.memberId==='worker-1').id;
  const identityParent=await s.json(`/api/v2/metrics?dimension=mcp&memberBindingKey=${bkey}&preset=custom&from=2026-10-04&to=2026-10-04&baseSnapshotId=${base}`);
  assert.equal((await s.get(`/api/v2/metrics?dimension=mcp&view=members&preset=custom&from=2026-10-04&to=2026-10-04&baseSnapshotId=${base}&parentSnapshotId=${identityParent.querySnapshotId}`)).status,400);
});
test('state current roster and names remain separate from window counts; display-name search uses verified provenance',async t=>{
  const s=await serve(t),base=await s.json('/api/v2/snapshot');
  const members=await s.json(`/api/v2/metrics?dimension=token&view=members&search=${encodeURIComponent('可观测性优化成员1')}&baseSnapshotId=${base.baseSnapshotId}`);assert.equal(members.data.total,1);assert.equal(members.data.rows[0].memberId,'worker-1');assert.ok(members.data.rows[0].nameProvenance.sourceId);assert.equal(members.data.rows[0].time.token.nativeTotal.output.known,700);assert.equal(members.data.rows[0].time.token.nativeTotal.cachedInput.known,2800);
  const empty=await s.json(`/api/v2/overview?preset=custom&from=2026-09-20&to=2026-09-20&baseSnapshotId=${base.baseSnapshotId}`);assert.equal(empty.data.counts.members,11);assert.equal(empty.data.summary.token.nativeTotal.total.known,null);
});

test('actual member detail request builder queries global/date steps with the same binding, parent and base; task-specific timeline remains valid',async t=>{
  const s=await serve(t),base=(await s.json('/api/v2/snapshot')).baseSnapshotId;
  const request=scope=>s.json('/api/v2/'+scope.path+'?'+new URLSearchParams(Object.entries(scope.query).filter(([,v])=>v!==undefined&&v!==null&&v!=='')));
  const root=await s.json(`/api/v2/metrics?dimension=time&view=members&memberId=worker-1&baseSnapshotId=${base}`),binding=root.data.rows[0].id;
  const scope=buildDetailRequest({type:'steps',memberId:'worker-1',memberBindingKey:binding,base,parent:root.querySnapshotId,window:{preset:'7'}},{preset:'all'},{pin:false});assert.equal(scope.path,'metrics');assert.equal(scope.query.dimension,'time');assert.equal(scope.query.taskId,undefined);
  const global=await request(scope);assert.equal(global.baseSnapshotId,base);assert.equal(global.parentSnapshotId,root.querySnapshotId);assert.ok(global.data.total>50);assert.ok(global.data.rows.every(r=>r.memberId==='worker-1'&&r.memberBindingKey===binding));
  const day=await s.json(`/api/v2/metrics?dimension=time&view=members&preset=custom&from=2026-10-04&to=2026-10-04&baseSnapshotId=${base}`),dayScope=buildDetailRequest({type:'steps',memberId:'worker-1',memberBindingKey:binding,day:'2026-10-04',base,parent:day.querySnapshotId},{preset:'all'},{pin:false});const daily=await request(dayScope);assert.equal(daily.window.from,'2026-10-04');assert.equal(daily.window.to,'2026-10-04');assert.equal(daily.baseSnapshotId,base);assert.ok(daily.data.total>20);assert.ok(daily.data.rows.every(r=>r.memberId==='worker-1'));
  const searched=await s.json(`/api/v2/metrics?dimension=time&view=members&search=${encodeURIComponent('优化成员1')}&baseSnapshotId=${base}`);const searchChild=await request(buildDetailRequest({type:'steps',memberId:'worker-1',memberBindingKey:binding,base,parent:searched.querySnapshotId},{preset:'7'},{pin:false}));assert.equal(searchChild.data.total,global.data.total);
  const wrong=day.data.rows.find(r=>r.memberId==='worker-2');const rejected=buildDetailRequest({type:'steps',memberId:'worker-2',memberBindingKey:wrong.id,base,parent:searched.querySnapshotId},{preset:'7'},{pin:false});assert.equal((await s.get('/api/v2/'+rejected.path+'?'+new URLSearchParams(Object.entries(rejected.query).filter(([,v])=>v!==undefined)))).status,400);
  const task=buildDetailRequest({type:'steps',taskId:'task-055',base},{preset:'7'},{pin:false});assert.equal(task.path,'timeline');assert.equal((await request(task)).data.total,60);
});

test('actual client recovery and lane restore the complete parent on genuine HTTP 400/404/409, retain retry scope and ignore a cancelled failure',async t=>{
  const s=await serve(t),base=(await s.json('/api/v2/snapshot')).baseSnapshotId,parent=await s.json(`/api/v2/metrics?dimension=time&view=members&memberId=worker-1&baseSnapshotId=${base}`),binding=parent.data.rows[0].id;
  const view={detail:{type:'members',memberId:'worker-1',base,querySnapshotId:parent.querySnapshotId},heading:'成员1耗时',snapshot:parent.querySnapshotId,html:'rendered parent table',controls:'member controls',scrollY:127,data:parent};
  const recovery=createDetailRecovery();let displayed=view,lastError;
  const lane=createRequestLane({request:async scope=>{const response=await s.get('/api/v2/'+scope.path+'?'+new URLSearchParams(Object.entries(scope.query).filter(([,v])=>v!==undefined)));if(!response.ok)throw Object.assign(new Error((await response.json()).error),{status:response.status});return response.json();},apply:()=>assert.fail('failed query applied'),error:(e,scope)=>{lastError=e;displayed=recovery.reject(scope.attempt)??displayed;}});
  for(const [status,query] of [[400,{memberId:'worker-1',memberBindingKey:binding,parentSnapshotId:parent.querySnapshotId,preset:'all'}],[404,{memberId:'missing-member',preset:'7'}],[409,{memberId:'worker-1',preset:'7'}]]){
    if(status===409)s.advance(120001);const attempt={type:'steps',memberId:'worker-1',memberBindingKey:binding,base,parent:parent.querySnapshotId};recovery.begin(displayed);await lane.run({path:'metrics',query:{dimension:'time',view:'steps',baseSnapshotId:base,...query},attempt});assert.equal(lastError.status,status);assert.equal(displayed,view);assert.equal(displayed.data,parent);assert.equal(displayed.heading,'成员1耗时');assert.equal(displayed.scrollY,127);assert.equal(recovery.retry(),attempt);
  }
  const pending=[],late=createRequestLane({request:()=>new Promise((_,reject)=>pending.push(reject)),apply:()=>assert.fail('late applied'),error:()=>assert.fail('cancelled error rolled back active scope')});const work=late.run('child');late.cancel();pending[0](Object.assign(new Error('expired'),{status:409}));await work;
});
test('time works without any daily report, with declared stages and third-page explicit steps locate',async t=>{
  const s=await serve(t),base=await s.json('/api/v2/snapshot');const tasks=await s.json(`/api/v2/metrics?dimension=time&baseSnapshotId=${base.baseSnapshotId}`);assert.equal(tasks.data.total,56);assert.equal(tasks.data.rows.length,20);
  const steps=await s.json(`/api/v2/timeline?view=steps&taskId=task-055&sort=id&direction=asc&pageSize=20&baseSnapshotId=${base.baseSnapshotId}`);assert.ok(steps.data.total>50);const locate=await s.json(`/api/v2/locate?targetKind=step&targetId=fixture-task-055-055&taskId=task-055&sort=id&direction=asc&pageSize=20&baseSnapshotId=${base.baseSnapshotId}&snapshotId=${steps.querySnapshotId}`);assert.equal(locate.data.location.page,3);assert.equal(locate.data.rows.length,20);
  assert.equal(steps.data.summary.intervals.some(r=>r.assurance==='worker-declared'),true);assert.equal(steps.data.summary.waitingMs,null);
});
test('late response cannot override a newer query; cancelled lane never applies abandoned response',async()=>{
  const pending=[],applied=[];const lane=createRequestLane({request:(scope,signal)=>new Promise(resolve=>pending.push({scope,signal,resolve})),apply:(data,scope)=>applied.push({data,scope})});const old=lane.run('member-A'),fresh=lane.run('member-B');assert.ok(pending[0].signal.aborted);pending[1].resolve('B');await fresh;pending[0].resolve('A');await old;assert.deepEqual(applied,[{data:'B',scope:'member-B'}]);
  const hidden=lane.run('hidden');lane.cancel();pending[2].resolve('late-hidden');await hidden;assert.equal(applied.length,1);
});

test('UI state/statistics cadence, hidden cancellation, pause/pagehide restart and 401 boundaries use the actual client poller factory',async()=>{
  for(const [kind,interval] of [['state',5000],['stats',30000]]){
    const timers=new Map(),applied=[];let seq=0,visible=true,finish,signal;
    const poller=createDashboardPoller(kind,{setTimer:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimer:id=>timers.delete(id),visible:()=>visible,request:args=>{signal=args.signal;return new Promise(resolve=>finish=resolve);},onData:r=>applied.push(r),onStatus:()=>{}});
    const first=poller.start();finish(1);await first;assert.equal([...timers.values()][0].ms,interval);
    const pending=poller.refresh();visible=false;await poller.visibilityChanged();assert.ok(signal.aborted);finish(2);await pending;assert.deepEqual(applied,[1]);assert.equal(timers.size,0);
    visible=true;const shown=poller.visibilityChanged();finish(3);await shown;poller.pause();poller.stop();await poller.start();assert.equal(timers.size,0);
    const manual=poller.refresh();finish(4);await manual;assert.deepEqual(applied,[1,3,4]);assert.equal(timers.size,0);poller.stop();
    let requests=0;const denied=createDashboardPoller(kind,{request:async()=>{requests++;throw Object.assign(new Error('401'),{status:401});},onData:()=>assert.fail('unauthorized data'),onStatus:()=>{}});await denied.start();await denied.visibilityChanged();denied.stop();await denied.start();assert.equal(requests,1);denied.stop();
  }
});

test('refresh keeps old source base frozen, explicit contributors join task filtering, and HTTP replies contain no source paths or bodies',async t=>{
  const own=await createDashboardFixture(join(root,'refresh-fixture'),{taskCount:9,stepCount:2,asOf});t.after(()=>releaseStatsSession(own.cache));
  const manifest=JSON.parse(await readFile(own.manifestPath,'utf8')),steps=manifest.sources.find(s=>s.sourceId==='fixture-steps-task-000'),binding=manifest.sources.find(s=>s.sourceId==='fixture-native-worker-2').bindings[0];steps.bindings.push(binding);manifest.revision=2;await writeFile(own.manifestPath,JSON.stringify(manifest));
  const s=await startDashboardServer({statePath:own.statePath,teamId:own.teamId,sourceManifestPath:own.manifestPath,statsCachePath:own.cache,port:0,now:()=>Date.parse(asOf)});t.after(()=>s.close());const token=new URLSearchParams(new URL(s.url).hash.slice(1)).get('token');
  const get=async(path)=>{const response=await fetch(s.origin+path,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200,await response.clone().text());const raw=await response.text();assert.ok(!raw.includes(own.statePath)&&!raw.includes('SYNTHETIC BODY'));return JSON.parse(raw);};
  const initial=await get('/api/v2/snapshot?refresh=stats'),before=await get(`/api/v2/tasks?memberId=worker-2&baseSnapshotId=${initial.baseSnapshotId}`);assert.equal(before.data.total,1);
  const event={schemaVersion:'activity-sidecar/v1',eventId:'explicit-contributor',phase:'begin',teamId:own.teamId,memberId:'worker-2',hostId:binding.hostId,threadId:binding.threadId,role:binding.role,bindingRevision:1,roleEpoch:binding.roleEpoch,taskId:'task-000',roundId:'u2-round',stepId:'contributed-step',at:'2026-10-04T01:00:00.000Z',assurance:'worker-declared',sourceKind:'activity-sidecar',evidenceRef:'fixture:contribution'};await appendFile(steps.path,JSON.stringify(event)+'\n');
  const fresh=await get('/api/v2/snapshot?refresh=stats');assert.notEqual(fresh.baseSnapshotId,initial.baseSnapshotId);const after=await get(`/api/v2/tasks?memberId=worker-2&baseSnapshotId=${fresh.baseSnapshotId}`);assert.equal(after.data.total,2);
  const frozen=await get(`/api/v2/tasks?memberId=worker-2&baseSnapshotId=${initial.baseSnapshotId}&snapshotId=${before.querySnapshotId}`);assert.equal(frozen.data.total,1);const lanes=await get(`/api/v2/timeline?taskId=task-000&view=members&baseSnapshotId=${fresh.baseSnapshotId}`);assert.equal(lanes.data.total,2);
});
