import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createState,evolve,snapshot} from '../src/runtime.mjs';
import {initialize} from '../src/store.mjs';
import {render} from '../src/render.mjs';
import {run} from '../src/cli.mjs';
import {exportDashboard} from '../src/dashboard-export.mjs';

const at=n=>new Date(Date.UTC(2026,8,8,0,n)).toISOString();
const source={kind:'fixture',ref:'dashboard-history'};
function history(){
 const member=(id,role)=>({id,role,name:role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId:id}});
 let s=createState({teamId:'history',name:'History',source,members:[member('m','Manager'),member('l','Liaison'),member('w','Worker')]},at(0));
 let n=0;
 const apply=(type,data={},actor='m')=>{s=evolve(s,{id:`e-${++n}`,at:at(n),type,actor,source,...data},s.version);};
 apply('openRound',{roundId:'r-old',title:'Old <round>'});
 apply('assign',{roundId:'r-old',taskId:'t-old',title:'Accepted old task',workerId:'w',required:true,assignedAt:at(2)});
 apply('submit',{roundId:'r-old',taskId:'t-old',summary:'Ready'},'w');
 apply('review',{roundId:'r-old',taskId:'t-old'});
 apply('approve',{roundId:'r-old',taskId:'t-old',summary:'Verified',evidence:['fixture:pass']});
 apply('closeRound',{roundId:'r-old'});
 apply('bindMember',{memberId:'w',binding:{status:'bound',hostId:'fixture',threadId:'new-w'}});
 apply('openRound',{roundId:'r-current',title:'Current round'});
 apply('assign',{roundId:'r-current',taskId:'t-current',title:'Current task',workerId:'w',required:true,assignedAt:at(9)});
 apply('reports',{enabled:false});
 return s;
}
test('round timing freezes when closed while open round timing uses snapshot asOf',()=>{
 const v=snapshot(history(),at(60));
 const html=render(v);
 assert.match(html,/轮次历时/);
 assert.match(html,/0 小时 5 分钟 · 已关闭，计时冻结/);
 assert.match(html,/0 小时 52 分钟 · 截至快照时间/);
 assert.match(render(snapshot(history(),at(120),'r-old')),/0 小时 5 分钟 · 已关闭，计时冻结/);
});
test('historical page footer does not point at the overview JSON as its own evidence',()=>{
 const html=render(snapshot(history(),at(60),'r-old'));
 assert.match(html,/HTML 与对应 JSON 快照来自同一份数据/);
 assert.doesNotMatch(html,/HTML 与 snapshot.json/);
});
test('dashboard CLI exports an offline linked bundle from one source version without source writes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dashboard-history-'));
 const statePath=join(directory,'state.json'),destination=join(directory,'bundle'),s=history();
 await initialize(statePath,s);const before=await readFile(statePath,'utf8');
 await run(['dashboard',statePath,destination,at(60)],()=>{});
 const ready=JSON.parse(await readFile(join(destination,'READY.json'),'utf8'));
 assert.equal(ready.kind,'dashboard-bundle');assert.equal(ready.sourceVersion,s.version);assert.equal(ready.asOf,at(60));
 assert.deepEqual(ready.pages.map(p=>p.roundId),[null,'r-old','r-current']);
 for(const page of ready.pages){
  const v=JSON.parse(await readFile(join(destination,page.json),'utf8'));
  const html=await readFile(join(destination,page.html),'utf8');
  assert.equal(v.sourceVersion,s.version);assert.equal(v.asOf,at(60));assert.equal(v.roundId,page.roundId);assert.equal(v.snapshotId,page.snapshotId);
  assert.match(html,new RegExp(v.snapshotId));
  for(const target of ready.pages)assert.ok(html.includes(`href="${target.html}"`));
  assert.equal((html.split('<body>')[1].match(/aria-current="page"/g)||[]).length,1);
  assert.ok(html.includes(`href="${page.html}" aria-current="page"`));
  assert.doesNotMatch(html,/<script|https?:\/\/|codex:\/\//);
  assert.ok(html.includes('Old &lt;round&gt;'));
 }
 for(const file of ready.files){
  const bytes=await readFile(join(destination,file.name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
 }
 const old=JSON.parse(await readFile(join(destination,ready.pages[1].json),'utf8'));
 assert.equal(old.members.find(m=>m.id==='w').binding.threadId,'w');
 assert.equal(old.reporting.enabled,false);
 assert.equal(old.tasks.length,1);assert.equal(old.tasks[0].id,'t-old');
 assert.equal(await readFile(statePath,'utf8'),before);
 await assert.rejects(run(['dashboard',statePath,destination,at(60)],()=>{}),/exist/i);
 assert.equal(await readFile(statePath,'utf8'),before);
});
test('dashboard rejects invalid input and arguments before creating output',async()=>{
 await assert.rejects(run(['dashboard'],()=>{}),/dashboard <state.json>/);
 await assert.rejects(run(['dashboard','x','y','z','extra'],()=>{}),/dashboard <state.json>/);
 const directory=await mkdtemp(join(tmpdir(),'dashboard-bad-')),statePath=join(directory,'state.json'),destination=join(directory,'bad');
 await initialize(statePath,history());
 await assert.rejects(run(['dashboard',statePath,destination,at(0)],()=>{}),/precedes/);
 await assert.rejects(stat(destination),{code:'ENOENT'});
 assert.deepEqual(await readdir(directory),['state.json']);
});
test('round navigation rejects duplicate or missing current pages and non-local destinations',()=>{
 const v=snapshot(history(),at(60));
 const overview={roundId:null,title:'All',html:'index.html'};
 for(const roundPages of [
  [overview,overview],
  [{roundId:'other',title:'Other',html:'round-1.html'}],
  [{...overview,html:'https://example.com'}],
  [{...overview,html:'../index.html'}],
  [{...overview,html:{toString:()=> 'index.html'}}]
 ])assert.throws(()=>render(v,{roundPages}),/round pages/);
});
test('empty team exports only an overview with no invented rounds or completion',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dashboard-empty-')),statePath=join(directory,'state.json'),destination=join(directory,'bundle');
 const s=createState({teamId:'empty',name:'Empty',source,members:history().members},at(0));
 await initialize(statePath,s);await run(['dashboard',statePath,destination,at(60)],()=>{});
 const ready=JSON.parse(await readFile(join(destination,'READY.json'),'utf8'));
 assert.equal(ready.pages.length,1);assert.equal(ready.files.length,2);
 const html=await readFile(join(destination,'index.html'),'utf8');
 assert.match(html,/尚无工作轮次/);assert.match(html,/尚无验收交付/);
 assert.doesNotMatch(html,/round-1.html/);
});
test('cancelled-only round exports as closed without claiming accepted delivery',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dashboard-cancelled-')),statePath=join(directory,'state.json'),destination=join(directory,'bundle');
 let s=createState({teamId:'cancelled',name:'Cancelled',source,members:history().members},at(0));
 const event=(type,data,n)=>{s=evolve(s,{id:`cancel-${n}`,type,actor:'m',at:at(n),source,...data},s.version);};
 event('openRound',{roundId:'r-cancelled',title:'Withdrawn round'},1);
 const caller={hostId:'fixture',threadId:'m'};
 event('enqueue',{caller,roundId:'r-cancelled',taskId:'t-cancelled',title:'Cancelled task',workerId:'w',required:true,assignedAt:null},2);
 event('cancelQueued',{caller,roundId:'r-cancelled',taskId:'t-cancelled',summary:'Requirement withdrawn'},3);
 event('closeRound',{roundId:'r-cancelled'},4);
 await initialize(statePath,s);await run(['dashboard',statePath,destination,at(60)],()=>{});
 const html=await readFile(join(destination,'round-1.html'),'utf8');
 assert.match(html,/已取消，未执行、未验收：Requirement withdrawn/);
 assert.match(html,/0 小时 3 分钟 · 已关闭，计时冻结/);
 assert.match(html,/尚无验收交付/);
 assert.match(html,/已验收交付<\/p><strong>0<small> \/ 1/);
});
test('opt-in compatibility export records render options and preserves historical thread bindings',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dashboard-links-')),statePath=join(directory,'state.json'),destination=join(directory,'bundle');
 const s=history(),ids=Object.fromEntries(['m','l','w','new-w'].map((id,i)=>[id,`11111111-1111-7111-8111-${String(i+1).padStart(12,'0')}`]));
 // Offline synthetic identities: no URI is opened by this test.
 s.team.source={kind:'manual',ref:'synthetic-navigation-unit-test'};
 for(const event of s.events)event.source=s.team.source;
 for(const m of [...s.members,...s.rounds.flatMap(r=>r.members)])m.binding={...m.binding,hostId:'local',threadId:ids[m.binding.threadId]};
 await initialize(statePath,s);const before=await readFile(statePath,'utf8');
 await run(['dashboard',statePath,destination,at(60),'--codex-links'],()=>{});
 const manifest=JSON.parse(await readFile(join(destination,'READY.json'),'utf8'));
 assert.deepEqual(manifest.renderOptions,{codexLinks:true});
 for(const page of manifest.pages){
  const v=JSON.parse(await readFile(join(destination,page.json),'utf8')),html=await readFile(join(destination,page.html),'utf8');
  assert.equal(html,render(v,{roundPages:manifest.pages,...manifest.renderOptions}));
  const workerId=page.roundId==='r-old'?ids.w:ids['new-w'];
  assert.ok(html.includes(`href="codex://threads/${workerId}"`));
  if(page.roundId==='r-old')assert.ok(!html.includes(`href="codex://threads/${ids['new-w']}"`));
 }
 assert.equal(await readFile(statePath,'utf8'),before);
});
test('compatibility flag never enables fixture links and works without an explicit timestamp',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dashboard-fixture-links-')),statePath=join(directory,'state.json'),destination=join(directory,'bundle');
 await initialize(statePath,history());
 await run(['dashboard',statePath,destination,'--codex-links'],()=>{});
 const ready=JSON.parse(await readFile(join(destination,'READY.json'),'utf8'));
 assert.equal(ready.renderOptions.codexLinks,true);
 assert.doesNotMatch(await readFile(join(destination,'index.html'),'utf8'),/href="codex:/);
});
test('invalid compatibility options fail before output creation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dashboard-option-')),destination=join(directory,'bundle');
 for(const codexLinks of ['true',1,null,{}])await assert.rejects(exportDashboard(history(),destination,at(60),{codexLinks}),/codexLinks/);
 for(const args of [['--codex-links','--codex-links'],['--codex-link'],['--codex-links',at(60)]])await assert.rejects(run(['dashboard','absent-state',destination,...args],()=>{}),/dashboard <state.json>/);
 await assert.rejects(stat(destination),{code:'ENOENT'});
});
