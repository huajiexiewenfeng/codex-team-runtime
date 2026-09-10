import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoState} from '../src/demo.mjs';
import {snapshot, createState, evolve} from '../src/runtime.mjs';
import {render} from '../src/render.mjs';

const view=()=>snapshot(demoState(),'2026-09-05T01:00:00.000Z','round-demo');
test('long valid team names stay complete and the heading has explicit reflow guards',()=>{
 const token='Runtime'.repeat(400),name=`团队<&>${token}`;
 const s=createState({teamId:'long-name',name,source:{kind:'fixture',ref:'heading-reflow'},members:demoState().members},'2026-09-05T00:00:00.000Z');
 const html=render(snapshot(s,'2026-09-05T01:00:00.000Z'));
 assert.ok(html.includes(`<h1>团队&lt;&amp;&gt;${token}</h1>`),'keep the full escaped team name');
 const css=html.split('<style>')[1].split('</style>')[0];
 // This guards emitted CSS, not measured browser geometry or visual acceptance.
 const headingRule=css.match(/\.heading>div\{([^}]+)\}/)?.[1];
 assert.ok(headingRule,'the heading text child needs its own responsive boundary');
 assert.match(headingRule,/(?:^|;)min-width:0(?:;|$)/);
 assert.match(headingRule,/(?:^|;)max-width:100%(?:;|$)/);
 assert.match(headingRule,/(?:^|;)overflow-wrap:anywhere(?:;|$)/);
 assert.doesNotMatch(headingRule,/hidden|ellipsis|nowrap|line-clamp|break-all/);
});
test('overview heading summarizes round scope while preserving all round titles in history',()=>{
 const v=structuredClone(view());v.roundId=null;
 v.rounds.push({...structuredClone(v.rounds[0]),id:'round-old',title:'Old <round>',status:'closed'});
 const html=render(v),heading=html.split('<div class="heading">')[1].split('</div><a class="snapshot-link"')[0];
 assert.ok(heading.includes('全部 2 轮 · 1 轮开放 · 1 轮已关闭'));
 assert.ok(!heading.includes('Old &lt;round&gt;'),'round catalog should not fill the main heading');
 assert.ok(html.includes('Old &lt;round&gt;'),'full title must remain in history');
 const selected=render(view());assert.ok(selected.includes('离线演示轮次 · 轮次开放'));
});
test('fully accepted view summarizes closure instead of showing a zero stale-work warning',()=>{
 const v=structuredClone(view());v.tasks=[v.tasks[0]];
 const html=render(v);
 assert.ok(html.includes('任务记录均已收口'));
 assert.ok(!html.includes('0 项未收口任务的观察已陈旧'));
});
test('accepted task summary prioritizes acceptance over old progress and stops showing a live phase',()=>{
 const v=structuredClone(view());
 v.tasks[0].acceptance.summary='<Accepted after review>';
 const card=render(v).split('<article id="task-0"')[1].split('<details class="task-detail">')[0];
 assert.ok(card.includes('已验收：&lt;Accepted after review&gt;'),'acceptance must be the visible card summary');
 assert.ok(!card.includes('示例：原子写入测试通过'),'older progress must not displace acceptance');
 assert.ok(!card.includes('当前阶段'),'terminal status must not look like an ongoing phase');
 assert.ok(!card.includes('观察时间未知'));
 assert.ok(card.includes('验收时间 <time'));
 assert.ok(card.includes('完成计时冻结'));
});
test('queued and cancelled task summaries distinguish execution from recorded queue time',()=>{
 let s=demoState();const caller={hostId:'fixture-host',threadId:'fixture-manager'},source={kind:'fixture',ref:'card-timing'};
 s=evolve(s,{id:'queue-card',type:'enqueue',actor:'manager',caller,at:'2026-09-05T00:20:00.000Z',source,roundId:'round-demo',taskId:'T-5',title:'Queued task',workerId:'worker-01',required:true,assignedAt:null},s.version);
 const queued=render(snapshot(s,'2026-09-05T01:00:00.000Z')).split('<article id="task-4"')[1].split('<details class="task-detail">')[0];
 assert.ok(queued.includes('尚未开始执行'));
 assert.ok(queued.includes('排队已等待 0 小时 40 分钟'));
 assert.ok(!queued.includes('未开始计时'));
 s=evolve(s,{id:'cancel-card',type:'cancelQueued',actor:'manager',caller,at:'2026-09-05T00:30:00.000Z',source,roundId:'round-demo',taskId:'T-5',summary:'<No longer needed>'},s.version);
 const cancelled=render(snapshot(s,'2026-09-05T01:00:00.000Z')).split('<article id="task-4"')[1].split('<details class="task-detail">')[0];
 assert.ok(cancelled.includes('已取消：&lt;No longer needed&gt;'));
 assert.ok(cancelled.includes('未执行 · 未验收'));
 assert.ok(!cancelled.includes('尚无已记录进展'));
 assert.ok(!cancelled.includes('当前阶段'));
});
test('a queue-only Worker is not described as having no outstanding work',()=>{
 let s=demoState();
 s=evolve(s,{id:'queue-extra',type:'enqueue',actor:'manager',caller:{hostId:'fixture-host',threadId:'fixture-manager'},at:'2026-09-05T00:20:00.000Z',source:{kind:'fixture',ref:'dashboard-queue'},roundId:'round-demo',taskId:'T-5',title:'Next task',workerId:'worker-01',required:true,assignedAt:null},s.version);
 const html=render(snapshot(s,'2026-09-05T01:00:00.000Z','round-demo'));
 const worker=html.split('<article class="member">')[3].split('</article>')[0];
 assert.match(worker,/1 项未收口记录/);
 assert.doesNotMatch(worker,/无未收口任务/);
});
test('dashboard exposes labelled CSS-only filters with exact snapshot counts',()=>{
 const html=render(view());
 for(const [key,count] of [['all',4],['active',1],['attention',2],['approved',1],['queued',0]]) {
  assert.match(html,new RegExp(`id="filter-${key}"[^>]*type="radio"`));
  assert.match(html,new RegExp(`data-filter-count="${key}">${count}<`));
 }
 assert.match(html,/href="#team"/);
 assert.match(html,/href="#activity"/);
 assert.match(html,/当前筛选下没有任务/);
 assert.doesNotMatch(html,/<script|\son\w+=|http-equiv="refresh"/i);
});
test('dashboard separates delivery evidence from execution and links members to owned task records',()=>{
 let s=demoState();
 // Freshness warnings belong to unfinished work, not a completed task's old observations.
 s=evolve(s,{id:'active-observation',type:'observe',actor:'worker-04',at:'2026-09-05T00:20:00.000Z',source:{kind:'fixture',ref:'active-freshness'},roundId:'round-demo',taskId:'T-4',observedAt:'2026-09-05T00:19:00.000Z',summary:'Earlier active-task observation',progress:false},s.version);
 const html=render(snapshot(s,'2026-09-05T01:00:00.000Z','round-demo'));
 assert.match(html,/初始派发：结果未知/);
 assert.match(html,/领取记录 0 次，不等于实际发送次数/);
 assert.match(html,/href="#task-0"/);
 assert.match(html,/任务历时 未知/);
 assert.match(html,/原生任务执行状态：未接入/);
 assert.match(html,/模型与 Token 用量：未接入/);
 assert.match(html,/观察已陈旧/);
});
test('delivery evidence remains inspectable even outside the last twelve global events',()=>{
 const v=structuredClone(view());
 v.tasks[0].delivery={status:'delivered',attemptId:'claim-old',evidenceEventId:'receipt-old',attempts:1};
 v.events.unshift({id:'receipt-old',type:'deliveryCheck',actor:'manager',roundId:'round-demo',taskId:'T-1',at:'2026-09-05T00:02:00.000Z',outcome:'delivered',summary:'<Old delivery confirmed>',source:{kind:'fixture',ref:'older-delivery-proof'}});
 const html=render(v);
 assert.match(html,/&lt;Old delivery confirmed&gt;/);
 assert.match(html,/older-delivery-proof/);
});
test('empty dashboard never presents completion or a made-up percentage',()=>{
 const s=createState({teamId:'empty',name:'Empty',source:{kind:'fixture',ref:'empty'},members:demoState().members},'2026-09-05T00:00:00.000Z');
 const html=render(snapshot(s,'2026-09-05T01:00:00.000Z'));
 assert.match(html,/尚无工作轮次/);
 assert.match(html,/尚无任务/);
 assert.match(html,/尚无验收交付/);
 assert.doesNotMatch(html.split('<body>')[1],/NaN|Infinity|100%/);
});
test('dashboard retains full escaped evidence and deterministic immutable output',()=>{
 const v=structuredClone(view());
 v.tasks[0].acceptance.evidence=['<img src=x onerror=alert(1)>'];
 v.tasks[1].delivery={status:'delivered',attemptId:'<claim>',evidenceEventId:'<receipt>',attempts:2};
 const before=JSON.stringify(v),html=render(v);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.match(html,/初始派发：已确认送达/);
 assert.match(html,/&lt;receipt&gt;/);
 assert.match(html,/领取记录 2 次，不等于实际发送次数/);
 assert.doesNotMatch(html,/<img|<script|codex:\/\//);
 assert.equal(JSON.stringify(v),before);
 assert.equal(render(v),html);
});
