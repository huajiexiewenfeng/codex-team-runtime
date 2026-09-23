import {open} from 'node:fs/promises';
const esc=value=>String(value??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const duration=value=>{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '未知';
 const ms=Math.round(value),hours=Math.floor(ms/3600000),minutes=Math.floor(ms%3600000/60000),seconds=(ms%60000/1000).toFixed(3);
 return `${hours?`${hours} 小时 `:''}${hours||minutes?`${minutes} 分 `:''}${seconds} 秒`;
};
const stageNames={queued:'排队中',executing:'执行中',submitted:'待审查',reviewing:'审查中',rework:'返工中',approved:'已验收',blocked:'阻塞',cancelled:'已取消'};
export const timelineStyles=`.timeline-card{margin-top:24px;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--surface);min-width:0}.timeline-card summary{cursor:pointer;padding:12px 0;min-height:44px}.timeline-card summary:focus-visible,.timeline-overflow:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.timeline-overflow{overflow-x:auto;max-width:100%}.timeline-card table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}.timeline-card th,.timeline-card td{text-align:left;border-bottom:1px solid var(--line);padding:10px;overflow-wrap:anywhere;min-width:100px}.timeline-card p{overflow-wrap:anywhere}.timeline-card h2{font-size:22px}.timeline-card caption{text-align:left;padding:8px 0}.timeline-card .timeline-warning{color:var(--muted)}@media(max-width:760px){.timeline-card{padding:12px}}`;
function validateReport(r){
 if(!r||r.schemaVersion!==1||!['task-timeline-v1','task-timeline-v2','task-timeline-v3'].includes(r.rulesVersion))throw new Error('Invalid timeline schema');
 if(typeof r.teamId!=='string'||typeof r.taskId!=='string'||r.coverage?.status!=='partial')throw new Error('Invalid timeline identity/coverage');
 for(const k of ['events','spans','gaps','sources'])if(!Array.isArray(r[k]))throw new Error('Invalid timeline collections');
 for(const k of ['asyncSpans','reportedDurations','processSpans'])if(r[k]!==undefined&&!Array.isArray(r[k]))throw new Error('Invalid timeline collections');
 if(r.nativeObservations!==undefined&&(!Array.isArray(r.nativeObservations)||r.nativeObservations.some(s=>!Array.isArray(s?.items))))throw new Error('Invalid native collections');
 if(r.businessTimeline&&(!Array.isArray(r.businessTimeline.stages)||!Array.isArray(r.businessTimeline.events)))throw new Error('Invalid business timeline');
}
export function renderDashboardTimeline(r,{stale=false,freshness=null}={}){
 validateReport(r);
 const table=(label,headers,rows)=>`<details><summary>${esc(label)} · ${rows.length} 条</summary><div class="timeline-overflow" tabindex="0" role="region" aria-label="${esc(label)}"><table><caption>最多显示前 300 条；完整记录见 JSON 报告</caption><thead><tr>${headers.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,300).map(row=>`<tr>${row.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
 const stages=r.businessTimeline?.stages??[];
 const freshnessHtml=freshness?`<p>阶段数据：${freshness.stageData.mode==='refreshed-state'?'最新台账重建（仅本次展示，未覆盖历史报告）':'历史报告快照'} · 台账版本 ${esc(freshness.stageData.sourceVersion??'未知')} · 台账更新时间（UTC） ${esc(freshness.stageData.sourceUpdatedAt??'未知')} · 本次生成时间（UTC） ${esc(freshness.stageData.generatedAt??'未知')}</p><p>工具观测：${freshness.observations.status==='historical'?'沿用历史采样，未重新采集':'未采集或缺少观测证据'} · 最后观测事件（UTC） ${esc(freshness.observations.latestObservedAt??'未知')}（不代表完整覆盖截止）</p><p>采样窗口：${esc(freshness.observations.windows.map(w=>`${w.from??'未知'} — ${w.to??'未知'}`).join('；')||'未知')}。覆盖缺口：${esc(freshness.observations.missing.join('、')||'覆盖仍未核实')}。更新阶段数据不采集日志，不刷新 Token/MCP。</p>`:'';
 return `<section class="timeline-card" aria-label="任务时间线"><h2>任务时间线 · ${esc(r.taskId)}</h2><p>部分覆盖 · 阶段与工具观测为独立数据来源</p>${freshnessHtml}<p>端到端历时：<strong>${duration(r.endToEndMs)}</strong> · 外层工具区间并集：${duration(r.observedToolUnionMs)}</p><p class="timeline-warning">${stale?'业务状态已有新版本，以下为旧快照。':''}业务声明时间不等于程序执行时间。区间可能重叠，不可相加；未知不等于零。重新读取不会采集日志。</p>`+
 table('业务声明阶段',['阶段','声明开始（UTC）','声明结束（UTC）','声明历时'],stages.map(s=>[Object.hasOwn(stageNames,s.status)?stageNames[s.status]:s.status,s.declaredStartAt,s.declaredEndAt,s.kind==='terminal-state'?'终态点':duration(s.durationMs)]))+
 table('观测事件',['时间（UTC）','角色','事件','工具','证据'],r.events.map(e=>[e.observedAt,e.role,e.kind,e.tool,e.eventId]))+
 table('外层调用',['起点证据','返回证据','口径','历时'],r.spans.map(s=>[s.startEventId,s.endEventId,s.kind,duration(s.durationMs)]))+
 table('异步脚本续接（非内部进程）',['起点证据','完成证据','历时'],(r.asyncSpans??[]).map(s=>[s.startEventId,s.endEventId,duration(s.durationMs)]))+
 table('原生进程观测（含轮询间隔，非 CPU 时间）',['起点证据','完成证据','观测历时','退出码','缺口'],(r.processSpans??[]).map(s=>[s.startEventId,s.endEventId,duration(s.durationMs),s.exitCode??'未知',s.missingReason]))+
 table('宿主内部调用报告（选定条目，起止未知，不与外层相加）',['来源','角色','条目 ID','类型','报告耗时','退出码'],(r.nativeObservations??[]).flatMap(s=>s.items.map(i=>[s.sourceRef,s.role,i.itemId,i.kind,duration(i.durationMs),i.exitCode??'未知'])))+
 table('工具报告耗时（独立口径）',['证据','数据块','报告耗时'],(r.reportedDurations??[]).map(d=>[d.eventId,d.block,duration(d.durationMs)]))+
 table('未归因日志间隔',['起点','终点','间隔'],r.gaps.map(g=>[g.startEventId,g.endEventId,duration(g.durationMs)]))+'</section>';
}
export async function readTimelineJson(path,maxBytes=16*1024*1024){
 const file=await open(path,'r');let r;
 try{
  const info=await file.stat();if(!info.isFile()||info.size>maxBytes)throw new Error('Invalid timeline file');
  const bytes=Buffer.alloc(info.size);let offset=0;
  while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Truncated timeline');offset+=bytesRead;}
  r=JSON.parse(bytes.toString('utf8'));
 }finally{await file.close();}
 return r;
}
export async function loadDashboardTimelineReport(path,state,expectedTaskId=null){
 const r=await readTimelineJson(path);
 validateReport(r);
 if(r.teamId!==state.team.id)throw new Error('Timeline team mismatch');
 const task=state.tasks.find(t=>t.id===r.taskId);if(!task)throw new Error('Timeline task mismatch');
 if(expectedTaskId!==null&&r.taskId!==expectedTaskId)throw new Error('Timeline indexed task mismatch');
 if(r.businessTimeline&&(r.businessTimeline.teamId!==r.teamId||r.businessTimeline.taskId!==r.taskId||r.businessTimeline.roundId!==task.roundId))throw new Error('Business timeline task mismatch');
 return r;
}
export function presentDashboardTimeline(r,state,{stageMode='report-snapshot',checkedAt=null}={}){
 const stale=!!r.businessTimeline&&r.businessTimeline.sourceVersion!==state.version;
 const observed=r.events.map(e=>e.observedAt).filter(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))).map(value=>new Date(value).toISOString()).sort();
 const freshness={stageData:{mode:stageMode,sourceVersion:r.businessTimeline?.sourceVersion??null,sourceUpdatedAt:r.businessTimeline?.sourceUpdatedAt??null,generatedAt:stageMode==='refreshed-state'?checkedAt:null},
  observations:{status:r.sources.length||r.events.length||(r.nativeObservations??[]).length?'historical':'not_collected',latestObservedAt:observed.at(-1)??null,windows:r.sources.map(s=>({from:s.from??null,to:s.to??null})),missing:r.coverage.missing??[]}};
 return {status:'ready',teamId:r.teamId,taskId:r.taskId,stale,checkedAt,...freshness,html:renderDashboardTimeline(r,{stale,freshness})};
}
export async function readDashboardTimeline(path,state){
 if(!path)return {status:'not_configured',teamId:state.team.id};
 return presentDashboardTimeline(await loadDashboardTimelineReport(path,state),state);
}
export async function readDashboardTimelines(paths,state,selectedTaskId=null){
 if(!Array.isArray(paths)||paths.length>32)throw new Error('Invalid timeline bindings');
 if(selectedTaskId!==null&&!state.tasks.some(t=>t.id===selectedTaskId))throw new Error('Unknown task');
 const reports=new Map();let unavailableReports=0;
 for(const path of paths){
  let result;try{result=await readDashboardTimeline(path,state);}catch{unavailableReports++;continue;}
  if(result.status!=='ready'){unavailableReports++;continue;}
  if(reports.has(result.taskId))throw new Error('Duplicate timeline task binding');
  reports.set(result.taskId,result);
 }
 const tasks=state.tasks.map(t=>({id:t.id,title:t.title,available:reports.has(t.id)}));
 const taskId=selectedTaskId??reports.keys().next().value??null;
 const result=reports.get(taskId)??{status:paths.length?'task_not_configured':'not_configured',teamId:state.team.id,taskId};
 return {...result,tasks,unavailableReports};
}
