import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoState} from '../src/demo.mjs';
import {snapshot} from '../src/runtime.mjs';
import {render} from '../src/render.mjs';

// Synthetic view only: these tests never invoke a protocol handler or host tool.
const threadId='11111111-1111-7111-8111-111111111111';
function localView(){
 const v=structuredClone(snapshot(demoState(),'2026-09-05T01:00:00.000Z'));
 v.sourceKinds=['manual'];
 v.members=[{id:'worker',name:'Local Worker',role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'local',threadId}}];
 return v;
}
test('opt-in local conversation entry is a plain URI without prompt, host query or script',()=>{
 const v=localView(),before=JSON.stringify(v);
 assert.doesNotMatch(render(v),/href="codex:/);
 const html=render(v,{codexLinks:true});
 assert.match(html,new RegExp(`href="codex://threads/${threadId}"`));
 assert.match(html,/兼容入口/);
 assert.match(html,/客户端按线程 ID 定位，不保证锁定主机/);
 assert.match(html,/浏览器唤起尚未验收/);
 assert.doesNotMatch(html,/<script|\son\w+=|\?hostId=|\?prompt=|target="_blank"/i);
 assert.equal(JSON.stringify(v),before);
 assert.equal(render(v,{codexLinks:true}),html);
});
test('fixture, unknown origin, remote and invalid member identities stay non-navigable',()=>{
 for(const change of [
  v=>{v.sourceKinds=['fixture','manual'];},
  v=>{v.sourceKinds=[];},
  v=>{v.sourceKinds=['unrecognized'];},
  v=>{v.members[0].binding.hostId='remote-machine';},
  v=>{v.members[0].binding={status:'unbound'};},
  v=>{v.members[0].binding={status:'creating',pendingId:threadId};},
  v=>{v.members[0].binding.status='missing';},
  v=>{v.members[0].binding.threadId='new';},
  v=>{v.members[0].binding.threadId=threadId+'?prompt=run';},
  v=>{v.members[0].binding.threadId=threadId+'/review';},
  v=>{v.members[0].binding.threadId='javascript:alert(1)';}
 ]){
  const v=localView();change(v);const html=render(v,{codexLinks:true});
  assert.doesNotMatch(html,/href="codex:/);
  assert.match(html,/<button disabled/);
 }
});
test('conversation compatibility option rejects truthy non-boolean values',()=>{
 for(const codexLinks of ['true',1,null,{},[]])assert.throws(()=>render(localView(),{codexLinks}),/codexLinks/);
});
test('members share one expandable compatibility explanation with accessible link descriptions',()=>{
 const v=localView();
 v.members.push({...structuredClone(v.members[0]),id:'second',name:'Second member',binding:{status:'bound',hostId:'local',threadId:'22222222-2222-7222-8222-222222222222'}});
 const html=render(v,{codexLinks:true});
 assert.equal((html.match(/客户端按线程 ID 定位，不保证锁定主机/g)||[]).length,1);
 assert.ok(html.includes('<details class="conversation-help">'));
 assert.ok(html.includes('id="conversation-help"'));
 for(const index of [0,1])assert.ok(html.includes(`aria-describedby="hint-${index} conversation-help"`));
 assert.ok(html.includes('兼容入口 · 不保证锁定主机'));
 assert.ok(!render(v).includes('id="conversation-help"'));
});
