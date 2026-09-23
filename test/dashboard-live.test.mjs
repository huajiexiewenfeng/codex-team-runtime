import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {request as httpRequest} from 'node:http';
import {demoState} from '../src/demo.mjs';
import {snapshot} from '../src/runtime.mjs';
import {render} from '../src/render.mjs';
import {initialize, readState} from '../src/store.mjs';
import {applyRegistryProjection} from '../src/registry-projection.mjs';
import {startDashboardServer} from '../src/dashboard-live.mjs';
import {run} from '../src/cli.mjs';

const now=()=>Date.parse('2026-09-11T10:00:12.000Z');
test('timeline endpoint requires auth, rejects path input and does not collect when unbound',async t=>{
 const s=await serve(t);
 assert.equal((await fetch(s.origin+'/api/timeline')).status,401);
 assert.equal((await s.get('/api/timeline?path=secret')).status,400);
 assert.equal((await (await s.get('/api/timeline')).json()).status,'not_configured');
 const shell=await (await fetch(s.origin)).text();assert.match(shell,/timeline-view/);
});
async function serve(t,options={}) {
 const service=await startDashboardServer({statePath:resolve('fixture-state.json'),port:0,read:async()=>demoState(),now,cacheMs:0,...options});
 t.after(()=>service.close());
 const token=new URLSearchParams(new URL(service.url).hash.slice(1)).get('token');
 const get=(path='/api/view',init={})=>fetch(service.origin+path,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers}});
 return {...service,token,get};
}

test('metrics workspace has persistent peer tabs including timeline without a daily report',async t=>{
 const s=await serve(t);
 const html=await (await fetch(s.origin)).text();
 const template=html.match(/<template id="metrics-template">([\s\S]*?)<\/template>/)?.[1];
 assert.ok(template,'metrics navigation must exist before either report loads');
 for(const [id,title] of [['token','Token 使用量'],['mcp','MCP 调用情况'],['timeline','任务时间线']]){
  assert.match(template,new RegExp(`id="${id}-tab"[^>]*role="tab"[^>]*aria-controls="${id}-panel"[^>]*>${title}`));
  assert.match(template,new RegExp(`id="${id}-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="${id}-tab"`));
 }
 assert.equal((template.match(/id="timeline-view"/g)||[]).length,1);
 assert.match(template,/<section id="timeline-panel"[^>]*hidden>[\s\S]*id="timeline-view"/);
 assert.equal((await (await s.get('/api/metrics')).json()).status,'not_configured');
 assert.equal((await (await s.get('/api/timeline')).json()).status,'not_configured');
});
test('live service is idle until authenticated data requests; shell/assets disclose no team data',async t=>{
 let reads=0;const s=await serve(t,{read:async()=>{reads++;return demoState();}});
 assert.match(s.origin,/^http:\/\/127\.0\.0\.1:\d+$/);assert.match(s.token,/^[a-f0-9]{64}$/);
 const page=await fetch(s.origin);assert.equal(page.status,200);
 const html=await page.text();assert.match(html,/role="status"/);assert.match(html,/暂停更新/);
 assert.ok(!html.includes(demoState().team.id));assert.ok(!html.includes(s.token));
 assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
 assert.equal(page.headers.get('referrer-policy'),'no-referrer');
 assert.equal((await fetch(s.origin+'/dashboard-client.mjs')).status,200);
 assert.equal((await fetch(s.origin+'/api/view')).status,401);
 assert.equal((await s.get('/api/view',{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal(reads,0);
 const response=await s.get();assert.equal(response.status,200);const view=await response.json();
 assert.equal(reads,1);assert.match(view.html,/最新工作台/);assert.equal(view.sourceVersion,demoState().version);
 assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);
 assert.ok(!JSON.stringify(view).includes(s.token));
});
test('routes reject mutations, foreign origins/hosts and arbitrary paths before reading any data',async t=>{
 let reads=0;const s=await serve(t,{read:async()=>{reads++;return demoState();}});
 for(const method of ['POST','PUT','DELETE','OPTIONS'])assert.equal((await s.get('/api/view',{method})).status,405);
 for(const path of ['/api/register','/state.json','/src/cli.mjs','/api/view?path=C:/secret','/api/view?round=a&round=b','/api/view?token=wrong'])assert.ok([400,404].includes((await s.get(path)).status),path);
 assert.equal((await s.get('/api/view',{headers:{Origin:'https://foreign.example'}})).status,403);
 const foreignHost=await new Promise((resolveResult,reject)=>{const req=httpRequest(s.origin+'/api/view',{headers:{Host:'evil.example',Authorization:`Bearer ${s.token}`}},res=>{res.resume();resolveResult(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(foreignHost,403);assert.equal(reads,0);
});
test('each fresh request projects current records; ETag and round navigation are read only',async t=>{
 let current=demoState();const before=JSON.stringify(current);const s=await serve(t,{read:async()=>structuredClone(current)});
 const response=await s.get(),view=await response.json(),etag=response.headers.get('etag');
 assert.equal(view.roundId,null);assert.equal(view.rounds[0].id,'round-demo');
 assert.equal((await s.get('/api/view',{headers:{'If-None-Match':etag}})).status,304);
 current={...current,team:{...current.team,name:'New <team>'}};
 const updated=await (await s.get('/api/view',{headers:{'If-None-Match':etag}})).json();
 assert.notEqual(updated.snapshotId,view.snapshotId);assert.match(updated.html,/New &lt;team&gt;/);
 const selected=await (await s.get('/api/view?round=round-demo')).json();assert.equal(selected.roundId,'round-demo');
 assert.equal((await s.get('/api/view?round=missing')).status,400);
 assert.equal(JSON.stringify(demoState()),before);
});
test('projection failure retains no successful fallback response or leaked filesystem error',async t=>{
 let broken=false;const s=await serve(t,{read:async()=>{if(broken)throw new Error('SECRET C:/private/registry.json');return demoState();}});
 const first=await s.get();assert.equal(first.status,200);broken=true;
 const failed=await s.get('/api/view',{headers:{'If-None-Match':first.headers.get('etag')}});
 assert.equal(failed.status,503);const body=await failed.text();assert.match(body,/source_unavailable/);assert.doesNotMatch(body,/SECRET|private/);
 broken=false;assert.equal((await s.get()).status,200);
});
test('a service never silently switches to another team at the same state path',async t=>{
 let current=demoState();const s=await serve(t,{read:async()=>current});assert.equal((await s.get()).status,200);
 current={...current,team:{...current.team,id:'another-team'}};assert.equal((await s.get()).status,503);
});
test('simultaneous pages share one in-flight read and bounded request-time cache',async t=>{
 let reads=0,release;const gate=new Promise(resolve=>release=resolve);
 const s=await serve(t,{cacheMs:1000,read:async()=>{reads++;await gate;return demoState();}});
 const pending=Array.from({length:5},()=>s.get());release();
 for(const result of await Promise.all(pending))assert.equal(result.status,200);
 assert.equal(reads,1);assert.equal((await s.get()).status,200);assert.equal(reads,1);
});
test('real readState sees Registry-only membership updates without writing Node or Registry state',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-projection-')),statePath=join(dir,'state.json');
 const original=demoState(),registryPath=join(dir,'registry.json');
 const prepared={...original,schemaVersion:2,registry:{registryId:'registry',registryPath,teamId:original.team.id,migrationId:'migration',sourceSha256:'a'.repeat(64),sourceVersion:original.version,phase:'prepared',teamRevision:0,readyMemberIds:[]}};
 let exported={registryId:'registry',teamId:original.team.id,teamRevision:1,migrationId:'migration',statePath,members:structuredClone(original.members),readyMemberIds:original.members.map(m=>m.id)};
 const active=applyRegistryProjection(prepared,exported,statePath);await initialize(statePath,active);
 const before=await readFile(statePath,'utf8');
 const s=await serve(t,{statePath,read:path=>readState(path,{exporter:async()=>exported})});
 const first=await s.get(),view=await first.json();
 exported={...exported,teamRevision:2,members:[...exported.members,{id:'added-worker',name:'New Worker',role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:'fixture-added-worker'}}],readyMemberIds:[...exported.readyMemberIds,'added-worker']};
 const second=await s.get('/api/view',{headers:{'If-None-Match':first.headers.get('etag')}});assert.equal(second.status,200);
 const updated=await second.json();assert.equal(updated.sourceVersion,view.sourceVersion);assert.equal(updated.registryRevision,2);assert.notEqual(updated.snapshotId,view.snapshotId);assert.match(updated.html,/New Worker/);
 assert.equal(await readFile(statePath,'utf8'),before);
});
test('static renderer stays script-free and live presentation keeps explicit source limits',()=>{
 const v=snapshot(demoState(),'2026-09-11T10:00:00.000Z');
 assert.match(render(v),/固定快照 · 不会自行刷新/);assert.doesNotMatch(render(v),/<script|data-live-key/);
 const live=render(v,{live:true});assert.match(live,/最新工作台/);assert.doesNotMatch(live,/重新导出快照查看|固定快照 · 不会自行刷新/);
 assert.match(live,/data-timeline-task="T-1"/);assert.doesNotMatch(render(v),/data-timeline-task/);
 assert.match(live,/原生任务执行状态：未接入/);assert.match(live,/data-live-key="/);assert.match(live,/Token 用量：未接入/);
 assert.throws(()=>render(v,{live:'yes'}),/live/i);
});
test('CLI exposes explicit local server and rejects unsafe/ambiguous options',async t=>{
 for(const args of [[],['s','--host','0.0.0.0'],['s','--port','-1'],['s','--port','65536'],['s','--port','1x'],['s','--port','0','--port','0'],['s','other']])await assert.rejects(()=>run(['dashboard-serve',...args],()=>{}),/dashboard-serve|port/);
 const lines=[];const service=await run(['dashboard-serve','test-state.json','--port','0'],line=>lines.push(line));t.after(()=>service.close());
 assert.ok(lines.join('\n').includes(service.url));assert.ok(lines.join('\n').includes('Ctrl+C'));
 await assert.rejects(()=>startDashboardServer({statePath:'s',port:Number(new URL(service.origin).port)}),/EADDRINUSE/);
});
