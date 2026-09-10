import {dashboardStyles} from './dashboard-styles.mjs';

const esc=x=>String(x??'未知').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={cancelled:'已取消',queued:'排队中',executing:'执行中',submitted:'已提交 · 待审查',reviewing:'审查中',rework:'返工中',approved:'已验收',blocked:'阻塞'};
const deliveryLabels={unstarted:'尚未开始',unknown:'结果未知','not-delivered':'已确认未送达',delivered:'已确认送达'};
const eventLabels={openRound:'开启轮次',closeRound:'关闭轮次',assign:'分配任务',enqueue:'加入队列',startTask:'开始任务',cancelQueued:'取消排队',observe:'记录观察',submit:'提交交付',review:'开始审查',rework:'要求返工',approve:'验收通过',block:'记录阻塞',unblock:'解除阻塞',deliveryClaim:'领取派发',deliveryCheck:'核对派发',reports:'更新汇报偏好'};
const elapsed=ms=>ms==null?'未知':`${Math.floor(ms/3600000)} 小时 ${Math.floor(ms%3600000/60000)} 分钟`;
const time=value=>value?`<time datetime="${esc(value)}">${esc(value.replace('T',' ').replace('.000Z',' UTC').replace('Z',' UTC'))}</time>`:'未知';
const provenance=o=>o?`${esc(o.summary)}<span class="source">观察 ${time(o.observedAt)} · 收到 ${time(o.at)}<br>${esc(o.source.kind)} / ${esc(o.source.ref)}</span>`:'尚无已知观察';
const group=t=>['executing','rework'].includes(t.status)?'active':['submitted','reviewing','blocked'].includes(t.status)?'attention':t.status;
const pill=status=>`<span class="pill ${esc(status)}">${esc(labels[status])}</span>`;
const conversationHelp='客户端按线程 ID 定位，不保证锁定主机；浏览器唤起尚未验收。请核对打开后的成员身份。';

function conversationEntry(v,m,enabled) {
 const reason={unbound:'未绑定',creating:'创建中：pending ID 不是 thread ID',missing:'绑定任务缺失'}[m.binding.status];
 if(reason)return {reason};
 if(!enabled)return {reason:v.navigation.reason};
 if(!Array.isArray(v.sourceKinds)||!v.sourceKinds.length||v.sourceKinds.some(k=>!['manual','host-observation'].includes(k)))return {reason:'模拟或未知来源：不生成宿主对话链接'};
 if(m.binding.status!=='bound'||m.binding.hostId!=='local')return {reason:'仅为已绑定的本机成员提供兼容入口；远程主机不可由此链接锁定'};
 if(m.binding.pendingId!==undefined||typeof m.binding.threadId!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).test(m.binding.threadId))return {reason:'线程 ID 格式不受兼容入口支持，请核对绑定身份'};
 return {href:`codex://threads/${m.binding.threadId}`,reason:'本机兼容入口 · 请核对成员身份'};
}

export function render(v,{roundPages=[],codexLinks=false}={}) {
 if(typeof codexLinks!=='boolean')throw new Error('Invalid codexLinks option');
 if(!Array.isArray(roundPages)||roundPages.some(p=>!p||typeof p.title!=='string'||typeof p.html!=='string'||!(/^(index|round-[1-9]\d*)\.html$/).test(p.html)))throw new Error('Invalid dashboard round pages');
 if(roundPages.length&&(new Set(roundPages.map(p=>p.html)).size!==roundPages.length||new Set(roundPages.map(p=>p.roundId)).size!==roundPages.length||roundPages.filter(p=>p.roundId===v.roundId).length!==1))throw new Error('Invalid dashboard round pages');
 const roundNav=roundPages.length?`<details class="round-navigation"><summary>切换轮次 · ${esc(roundPages.find(p=>p.roundId===v.roundId)?.title??'当前视图')}</summary><nav aria-label="轮次导航">${roundPages.map(p=>`<a href="${p.html}"${p.roundId===v.roundId?' aria-current="page"':''}>${esc(p.title)}</a>`).join('')}</nav><p class="source">各页来自同一次导出；切换历史不会重新开工。汇报栏仍显示团队当前记录。</p></details>`:'';
 const roundTiming=v.rounds.length?`<details class="round-timing"${v.roundId?' open':''}><summary>轮次历时 · ${v.rounds.length} 轮</summary><ul>${v.rounds.map(r=>`<li><strong>${esc(r.title)}</strong><span>${elapsed(Date.parse(r.closedAt??v.asOf)-Date.parse(r.openedAt))} · ${r.status==='closed'?'已关闭，计时冻结':'截至快照时间'}</span><span class="source">${time(r.openedAt)} → ${time(r.closedAt??v.asOf)}</span></li>`).join('')}</ul><p class="source">从轮次开启到关闭或快照时间，包含排队与等待；并行轮次不相加为团队总工时。</p></details>`:'';
 const counts=Object.fromEntries(['all','active','attention','approved','queued','cancelled'].map(k=>[k,k==='all'?v.tasks.length:v.tasks.filter(t=>group(t)===k).length]));
 const openRounds=v.rounds.filter(r=>r.status==='open').length;
 const scopeSummary=!v.rounds.length?'尚无工作轮次':v.roundId?v.rounds.map(r=>`${r.title} · ${r.status==='closed'?'轮次已关闭':'轮次开放'}`).join(' / '):`全部 ${v.rounds.length} 轮 · ${openRounds} 轮开放 · ${v.rounds.length-openRounds} 轮已关闭`;
 const entries=v.members.map(m=>conversationEntry(v,m,codexLinks));
 const sharedConversationHelp=entries.some(e=>e.href)?`<details class="conversation-help"><summary>兼容入口 · 不保证锁定主机</summary><p id="conversation-help" class="source">${conversationHelp}</p></details>`:'';
 const blocked=v.tasks.filter(t=>t.status==='blocked');
 const review=v.tasks.filter(t=>['submitted','reviewing'].includes(t.status));
 const stale=v.tasks.filter(t=>t.freshness==='stale'&&!['approved','cancelled'].includes(t.status));
 const pendingCount=counts.all-counts.approved-counts.cancelled;
 const workSummary=!counts.all?'尚无任务记录':!pendingCount?'任务记录均已收口':stale.length?`${stale.length} 项未收口任务的观察已陈旧`:`未收口 ${pendingCount} 项 · 非实时记录`;
 const owner=t=>v.rounds.find(r=>r.id===t.roundId)?.members.find(m=>m.id===t.workerId)?.name??t.workerId;
 const cancellation=t=>v.events.find(e=>e.type==='cancelQueued'&&e.taskId===t.id&&e.roundId===t.roundId)?.summary??'取消原因未知';
 const cardSummary=t=>t.status==='approved'?`已验收：${t.acceptance.summary}`:t.status==='cancelled'?`已取消：${cancellation(t)}`:t.latestProgress?.summary??t.latestObservation?.summary??(t.status==='queued'?'等待 Worker 可接单后由 Manager 启动。':'尚无已记录进展；不能据此推断任务没有推进。');
 const deliveryEvidence=t=>{
  const records=v.events.filter(e=>e.taskId===t.id&&e.roundId===t.roundId&&['deliveryClaim','deliveryCheck'].includes(e.type));
  return records.length?`<ul>${records.map(e=>`<li>${esc(eventLabels[e.type])}${e.outcome?` · ${esc(deliveryLabels[e.outcome])}`:''}：${esc(e.summary)}<span class="source">${time(e.at)} · ${esc(e.actor)}<br>${esc(e.source.kind)} / ${esc(e.source.ref)}<br>事件 ${esc(e.id)} · 尝试 ${esc(e.attemptId)}</span></li>`).join('')}</ul>`:'<p class="source">此快照没有初始派发核对记录。</p>';
 };
 const card=(t,index)=>`<article id="task-${index}" class="task" data-group="${esc(group(t))}">
  <p class="target-note">定位任务 · 此任务保留显示，不受当前筛选限制</p>
  <div class="row"><div><p class="eyebrow">${esc(t.id)} / ${esc(t.roundId)}</p><h3>${esc(t.title)}</h3></div>${pill(t.status)}</div>
  <p class="task-description">${esc(cardSummary(t))}</p>
  <div class="task-facts"><strong>${esc(owner(t))}</strong>${t.status==='queued'?`<span>尚未开始执行</span><span>排队已等待 ${elapsed(t.phaseElapsedMs)}</span>`:t.status==='cancelled'?`<span>未执行 · 未验收</span><span>排队等待 ${elapsed(t.stages[0]?.durationMs)}</span>`:`<span>任务历时 ${elapsed(t.elapsedMs)}</span>${t.status==='approved'?`<span>验收时间 ${time(t.acceptance.at)}</span>`:`<span>当前阶段 ${elapsed(t.phaseElapsedMs)}</span>`}`}</div>
  <div class="task-foot">${t.completedAt?`<span>${t.status==='approved'?'已完成 · 以验收记录为准':`取消时间 ${time(t.completedAt)}`}</span>`:`<span class="freshness ${t.freshness==='stale'?'stale':''}">${esc({unknown:'观察时间未知',stale:'观察已陈旧',recorded:'已记录，非实时'}[t.freshness])}</span>`}<span>${t.completedAt?'完成计时冻结':'包含等待 · 截至快照时间'}</span></div>
  <details class="task-detail"><summary>任务详情<span aria-hidden="true"> · 阶段 / 派发 / 证据</span></summary><div class="detail-body">
   <p>${t.required?'必需交付':'可选交付'} · 提交 ${t.submissions} 次 · 原生任务执行状态：未接入</p>
   <h4>初始派发：${esc(deliveryLabels[t.delivery.status])}</h4><p>领取记录 ${t.delivery.attempts} 次，不等于实际发送次数。</p><p class="source">尝试 ID ${esc(t.delivery.attemptId)} · 核对事件 ${esc(t.delivery.evidenceEventId)}<br>派发证据与业务执行状态独立；结果未知不等于未发送。</p>
   ${deliveryEvidence(t)}
   <h4>阶段历时（包含等待）</h4><ol class="stages">${t.stages.map(p=>`<li><div class="row"><span>${esc(labels[p.status])}</span><strong>${elapsed(p.durationMs)}</strong></div><span class="source">${time(p.startedAt)} → ${time(p.endedAt??t.completedAt??v.asOf)}</span></li>`).join('')||'<li>尚无执行阶段。</li>'}</ol>
   <h4>验收证据</h4>${t.acceptance?`<p>${esc(t.acceptance.summary)}</p><p class="source">${esc(t.acceptance.actor)} · ${time(t.acceptance.at)}</p><ul>${t.acceptance.evidence.map(e=>`<li class="mono">${esc(e)}</li>`).join('')}</ul>`:t.status==='cancelled'?`<p>已取消，未执行、未验收：${esc(v.events.find(e=>e.type==='cancelQueued'&&e.taskId===t.id&&e.roundId===t.roundId)?.summary)}</p>`:'<p>尚未验收；Worker final 只是提交。</p>'}
   <h4>最近观察</h4><p>${provenance(t.latestObservation)}</p><h4>最近有效进展</h4><p>${provenance(t.latestProgress)}</p>
   <h4>全部观察记录</h4><ul>${t.observations.map(o=>`<li>${provenance(o)}</li>`).join('')||'<li>暂无观察记录。</li>'}</ul>
  </div></details></article>`;
 const member=(m,index)=>{
  const owned=v.tasks.map((t,i)=>({t,i})).filter(({t})=>t.workerId===m.id);
  const pending=owned.filter(({t})=>!['approved','cancelled'].includes(t.status));
  const entry=entries[index];
  const duty=m.role==='Manager'?'协调、审查与验收':m.role==='Liaison'?'需求沟通与进度解释':pending.length?`${pending.length} 项未收口记录`:'此视图无未收口任务';
  return `<article class="member"><div class="member-top"><span class="avatar ${m.role==='Manager'?'manager':''}" aria-hidden="true">${esc(m.role==='Manager'?'M':m.role==='Liaison'?'L':'W')}</span><div><h3>${esc(m.name)}</h3><p class="source">${esc(m.role)} · ${esc(m.lifecycle)}</p></div></div><p>${duty}</p>
   ${owned.length?`<ul class="assignments">${owned.map(({t,i})=>`<li><a href="#task-${i}">${esc(t.id)} · ${esc(labels[t.status])}</a><span class="source">${elapsed(t.elapsedMs)}</span></li>`).join('')}</ul>`:''}
   ${entry.href?`<a class="conversation-link" href="${entry.href}" aria-describedby="hint-${index} conversation-help">在 Codex 中查看 ↗</a>`:`<button disabled aria-describedby="hint-${index}">打开对话 ↗</button>`}<p id="hint-${index}" class="source">${esc(entry.reason)}</p>
   <details><summary>查看绑定身份</summary><p class="mono">memberId: ${esc(m.id)}<br>hostId: ${esc(m.binding.hostId)}<br>threadId: ${esc(m.binding.threadId)}${m.binding.pendingId?`<br>pendingId: ${esc(m.binding.pendingId)}`:''}</p></details>
  </article>`;
 };
 const filters=[['all','全部任务'],['active','进行中'],['attention','需关注'],['queued','排队中'],['approved','已验收'],['cancelled','已取消']];
 const metric=(label,value,note)=>`<div class="metric"><p>${label}</p><strong>${value}</strong><span>${note}</span></div>`;
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Team Runtime · ${esc(v.team.name)}</title><style>${dashboardStyles}</style></head><body>
 <a href="#main" class="skip">跳到工作区</a><header class="top"><div class="brand"><span class="brand-mark" aria-hidden="true">tr</span>codex team runtime</div><div class="top-meta"><span class="mono">${esc(v.team.id)}</span><span class="pill neutral">只读快照</span></div></header>
 <div class="layout"><nav class="rail" aria-label="工作台区域"><p class="eyebrow">WORKSPACE</p><a href="#overview">工作概览 <span>01</span></a><a href="#work">任务交付 <span>${counts.all}</span></a><a href="#team">团队成员 <span>${v.members.length}</span></a><a href="#activity">关键动态 <span>↗</span></a><div class="rail-note"><strong>长期协作，逐轮交付。</strong><p>提交不等于验收。<br>轮次结束不等于团队退出。</p><span class="mono">SNAPSHOT / v${v.sourceVersion}</span></div></nav>
 <main id="main"><section id="overview"><div class="source-banner">${v.sourceKinds.includes('fixture')?'模拟来源 / FIXTURE · 包含离线示例，不代表真实团队成功。':'来源记录快照 · 未连接实时宿主。'}<span>页面不会发送消息、创建任务或改变业务状态。</span></div>
 <div class="heading"><div><p class="eyebrow">TEAM / DELIVERY WORKSPACE</p><h1>${esc(v.team.name)}</h1><p>${esc(scopeSummary)}</p></div><a class="snapshot-link" href="#snapshot">查看快照来源 ↗</a></div>
 ${roundNav}${roundTiming}
 <div class="metrics">${metric('已验收交付',`${counts.approved}<small> / ${counts.all}</small>`,'以 Manager 验收记录为准')}${metric('进行中',String(counts.active),'执行中与返工中的业务任务')}${metric('待审查 / 审查中',String(review.length),'提交之后仍需独立验收')}${metric('阻塞',String(blocked.length),'需跟进，不一定需用户决策')}</div>
 </section><div class="columns"><div class="primary">
 ${blocked.length?`<section class="attention" aria-labelledby="attention-title"><div class="row"><h2 id="attention-title">需要跟进 · ${blocked.length} 项阻塞</h2><span class="pill blocked">待协调</span></div>${blocked.map(t=>`<p><strong>${esc(t.title)}</strong>：${esc(v.events.filter(e=>e.taskId===t.id&&e.roundId===t.roundId&&e.type==='block').at(-1)?.summary)}</p>`).join('')}<p class="source">请在 Liaison 中讨论；此页不执行控制。</p></section>`:''}
 <section id="work" class="work"><div class="section-head"><h2>任务交付</h2><span>${workSummary}</span></div>
 <fieldset class="task-browser"><legend class="sr-only">筛选任务</legend><div class="filters">${filters.map(([key,label])=>`<label><input id="filter-${key}" type="radio" name="task-filter" value="${key}"${key==='all'?' checked':''}><span>${label} <b data-filter-count="${key}">${counts[key]}</b></span></label>`).join('')}</div><div class="task-list">${v.tasks.map(card).join('')}<p class="empty">${counts.all?'当前筛选下没有任务。选择其他分类查看。':'尚无任务。由 Manager 分配后，重新导出快照查看。'}</p></div></fieldset></section>
 <section id="activity" class="activity"><div class="section-head"><h2>关键动态</h2><span>最近 ${Math.min(12,v.events.length)} 条审计事件</span></div><ol class="timeline">${v.events.slice(-12).reverse().map(e=>`<li><div class="event-time">${time(e.at)}</div><div><strong>${esc(eventLabels[e.type]??e.type)}</strong><p>${esc(e.summary??e.taskId??e.roundId??'团队')}</p><span class="source">${esc(e.actor)} · ${esc(e.source.kind)} / ${esc(e.source.ref)}</span></div></li>`).join('')||'<li>暂无审计事件。</li>'}</ol></section>
 <section class="panel completion"><h2>完成摘要</h2><p>${v.rounds.some(r=>r.status==='closed')?'已关闭轮次均已收口；已取消任务不计作验收，角色仍保留。':'尚无已关闭轮次。提交不等于批准。'}</p>${v.tasks.filter(t=>t.status==='approved').map(t=>`<p><strong>${esc(t.title)}</strong> · ${esc(t.acceptance.summary)}<span class="source">冻结历时 ${elapsed(t.elapsedMs)}</span></p>`).join('')||'<p>尚无验收交付。</p>'}<p class="source">已取消（未执行）：${counts.cancelled} 项</p></section>
 </div><aside><section id="team" class="panel"><div class="section-head"><h2>团队成员</h2><span>${v.members.length} 位</span></div><p class="source">角色与任务记录，不代表 Agent 正在计算。${v.roundId?'按所选轮次保留绑定身份。':'任务归属按成员 ID 汇总；历史任务可能属于该成员的旧绑定。'}</p>${sharedConversationHelp}${v.members.map(member).join('')}</section>
 <section class="panel reporting"><p class="eyebrow">COMMUNICATION</p><h2>沟通与汇报</h2><p>${v.reporting.enabled?'汇报偏好开启':'用户关闭汇报'}</p><p class="source">团队当前期望：${esc(v.reporting.desired)}<br>宿主实际状态：未知 / 未接入<br>意图版本 ${v.reporting.intentVersion}</p><p class="source">${v.reporting.offlineReceipt?`离线回执：${esc(v.reporting.offlineReceipt.actual)}；仅测试决策，不是宿主暂停确认。`:'没有宿主停止确认。'} 本页不创建定时器。</p></section>
 <section class="panel"><h2>成本与模型</h2><p>模型与 Token 用量：未接入</p><p class="source">任务历时不是模型计算时间。未采集的数据不按 0 计算，也不推算节省比例。</p></section></aside></div>
 <footer id="snapshot"><strong>固定快照 · 不会自行刷新</strong><p>源版本 ${v.sourceVersion} · 状态更新时间 ${time(v.sourceUpdatedAt)}<br>计算时间 ${time(v.asOf)} · 全部时间以 UTC 标示</p><p class="mono">快照 ID ${esc(v.snapshotId)}</p><p>任务历时包含等待，不代表实际模型计算耗时。查看新进展需重新导出；HTML 与对应 JSON 快照来自同一份数据。</p></footer>
 </main></div></body></html>`;
}
