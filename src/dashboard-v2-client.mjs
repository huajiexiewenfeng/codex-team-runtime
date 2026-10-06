import {createPoller,captureReadingPosition,restoreReadingPosition} from './dashboard-client.mjs';
export function createDashboardPoller(kind,options){if(!['state','stats'].includes(kind))throw new Error('Unknown dashboard poller');return createPoller({...options,intervalMs:kind==='state'?5000:30000});}

// Each UI lane owns cancellation and generation. An old response cannot repaint a new scope.
export function createRequestLane({request,apply,error=()=>{}}){
  let generation=0,controller=null;
  return {cancel(){generation++;controller?.abort();controller=null;},async run(scope){
    const mine=++generation;controller?.abort();const abort=new AbortController();controller=abort;
    try{const value=await request(scope,abort.signal);if(mine===generation&&!abort.signal.aborted)apply(value,scope);}
    catch(e){if(mine===generation&&!abort.signal.aborted)error(e,scope);}
    finally{if(mine===generation)controller=null;}
  }};
}
// A request is tentative until its complete view renders. Failure restores the
// last rendered scope and retains the attempted scope for an explicit retry.
export function createDetailRecovery(){let previous=null,failed=null;return {
  begin(view){previous=view;failed=null;},commit(){previous=null;failed=null;},
  reject(attempt){failed=attempt;const view=previous;previous=null;return view;},
  retry(){return failed;},clear(){previous=failed=null;}
};}
export function buildDetailRequest(d,fallbackWindow,{pin=true,target=null}={}){
  const window=d.day?{preset:'custom',from:d.day,to:d.day}:d.window??fallbackWindow;let path,query;
  if(d.type==='task'){path='task';query={taskId:d.taskId,baseSnapshotId:d.base,stagePage:d.page??1,pageSize:d.pageSize??20};}
  else if(d.type==='lanes'){path='timeline';query={...window,taskId:d.taskId,view:'members',baseSnapshotId:d.base,page:d.page??1,pageSize:d.pageSize??20,sort:'id',direction:'asc'};}
  else if(d.type==='steps'||d.type==='calls'){
    path=target?'locate':d.type==='steps'&&d.taskId?'timeline':'metrics';query={...window,baseSnapshotId:d.base,page:d.page??1,pageSize:d.pageSize??20,sort:'id',direction:'asc',taskId:d.taskId,memberId:d.memberId,memberBindingKey:d.memberBindingKey,series:d.series,parentSnapshotId:d.parent};
    if(target)Object.assign(query,{targetKind:'step',targetId:target,...(d.type==='calls'?{view:'calls'}:{})});
    else if(d.type==='steps')Object.assign(query,{view:'steps',...(!d.taskId?{dimension:'time'}:{})});else Object.assign(query,{dimension:'mcp',view:'calls'});
  }else{path='metrics';query={...window,dimension:d.dimension??'time',view:'members',baseSnapshotId:d.base,parentSnapshotId:d.parent,page:d.page??1,pageSize:d.pageSize??20,memberId:d.memberId,search:d.search,sort:'id',direction:'asc'};}
  if(pin&&d.querySnapshotId&&d.type!=='task')query.snapshotId=d.querySnapshotId;return {path,query};
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=v=>v===null||v===undefined?'未记录':Number(v).toLocaleString('zh-CN');
const ms=v=>v===null||v===undefined?'未记录':v<1000?`${v} ms`:v<60000?`${(v/1000).toFixed(2)} 秒`:`${Math.floor(v/60000)} 分 ${Math.round(v%60000/1000)} 秒`;
const stageTime=s=>['approved','cancelled'].includes(s?.status)?'终态时间点':s?.declaredElapsedToAsOfMs!==null&&s?.declaredElapsedToAsOfMs!==undefined?`${ms(s.declaredElapsedToAsOfMs)} · 进行中声明估算`:ms(s?.durationMs);
const date=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未知';
const labels={executing:'执行中',assigned:'待开始',queued:'排队中',approved:'已验收',submitted:'待验收',reviewing:'审查中',rework:'返工中',blocked:'阻塞',cancelled:'已取消',pending:'缺结束',yielded:'首次 yield',completed:'核验完成','completion-unknown':'完成未知','declared-completed':'声明完成','server-completed':'服务端完成','duration-only':'仅报告耗时'};
const status=v=>labels[v]??v??'未知';
const total=s=>s?.token?.nativeTotal?.total?.known??null;
const calls=(s,kind)=>s?.mcp?.find(r=>r.sourceKind===kind)?.calls??null;
const union=(s,kind)=>s?.intervals?.find(r=>r.sourceKind===kind)?.observedUnionMs??null;
export function declaredActivityText(summary){const groups=summary?.intervals?.filter(r=>r.sourceKind==='activity-sidecar')??[];return groups.length?groups.map(r=>`${r.assurance==='worker-declared'?'Worker声明':r.assurance==='operator-declared'?'Operator声明':r.assurance} ${ms(r.observedUnionMs)}`).join(' · '):'未记录';}
const sourceNames={native:'native','team-context':'Team Context','team-context-report':'报告副本','activity-sidecar':'声明 sidecar'};
const rowsTable=(head,rows,klass='')=>`<div class="card table-panel"><div class="table-wrap"><table class="${klass}"><thead><tr>${head.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${head.length}">当前窗口没有可显示的已记录数据；未知不代表零。</td></tr>`}</tbody></table></div></div>`;
const cell=v=>`<td>${v}</td>`;
const button=(text,attrs='')=>`<button class="row-open" ${attrs}>${esc(text)}</button>`;
export function formatToken(value){
  if(typeof value!=='number'||!Number.isFinite(value))return '未记录';
  const absolute=Math.abs(value),unit=absolute>=1e8?[1e8,' 亿']:absolute>=1e7?[1e7,' 千万']:absolute>=1e6?[1e6,' 百万']:[1,''];
  return (value/unit[0]).toLocaleString('zh-CN',{maximumFractionDigits:2})+unit[1];
}
const tokenAttributes=value=>typeof value==='number'&&Number.isFinite(value)?`title="精确 Token：${esc(String(value))}" aria-description="精确 Token：${esc(String(value))}"`:'';
export const tokenValueMarkup=value=>`<span ${tokenAttributes(value)}>${esc(formatToken(value))}</span>`;
const attributionLabel=r=>r.taskId?'已关联任务':r.attribution==='team-shared'?'团队共享':'缺少任务关联';
export function memberAttributionText(summary){const tc=summary?.mcp?.find(r=>r.sourceKind==='team-context');return tc?.calls!==null&&tc?.calls!==undefined&&tc.attribution?`TC任务关联 ${number(tc.attribution.taskLinked)} / 团队共享 ${number(tc.attribution.teamShared)} / 缺关联 ${number(tc.attribution.unassigned)}`:'TC未记录';}
const metricsNote=s=>{const tc=s?.mcp?.find(r=>r.sourceKind==='team-context'),a=tc?.attribution;return `Token 原生总量 ${formatToken(total(s))} · 成员合计 ${formatToken(s?.token?.memberSum?.total?.known)} · 未归属 ${formatToken(s?.token?.unattributed?.total?.known)}。MCP 三来源独立；未记录不代表零。${tc?.calls!==null&&a?` TC完成调用：任务关联 ${number(a.taskLinked)} / 团队共享 ${number(a.teamShared)} / 缺关联 ${number(a.unassigned)}；服务调用耗时不等于工作时长。`:''}`;};
const metricsNoteExact=s=>`Token 原生总量 ${total(s)??'未记录'} · 成员合计 ${s?.token?.memberSum?.total?.known??'未记录'} · 未归属 ${s?.token?.unattributed?.total?.known??'未记录'}`;
const metricsNoteAttributes=s=>`title="${esc(metricsNoteExact(s))}" aria-description="${esc(metricsNoteExact(s))}"`;
const pager=(scope,d)=>`<div class="task-pager" data-pager="${scope}"><span>共 ${d.total} 条 · 第 ${d.page}/${d.pageCount} 页</span><div class="page-buttons"><button data-focus-key="pager-${scope}-first" data-page="1" data-scope="${scope}" ${d.page===1?'disabled':''}>首页</button>${Array.from({length:Math.min(5,d.pageCount)},(_,i)=>Math.max(1,Math.min(d.page-2,d.pageCount-4))+i).map(p=>`<button data-focus-key="pager-${scope}-${p}" data-page="${p}" data-scope="${scope}" ${p===d.page?'aria-current="page"':''}>第${p}页</button>`).join('')}<button data-focus-key="pager-${scope}-last" data-page="${d.pageCount}" data-scope="${scope}" ${d.page===d.pageCount?'disabled':''}>末页</button></div><label>每页 <select data-focus-key="pager-${scope}-size" data-page-size="${scope}"><option value="20" ${d.pageSize===20?'selected':''}>20</option><option value="50" ${d.pageSize===50?'selected':''}>50</option></select></label></div>`;
const urlKeys=['view','dimension','preset','from','to','tpage','tsize','tsearch','tmember','tround','tstatus','tsort','tdirection','mpage','msize','msearch','opage','osize','detail','taskId','memberId','day','stepPage'];

export function bootDashboardV2(doc=globalThis.document){
  const win=doc.defaultView,$=id=>doc.getElementById(id),root=$('dashboard-main'),dialog=$('detail-dialog');
  const params=new URLSearchParams(win.location.search),fragment=new URLSearchParams(win.location.hash.slice(1));
  let credential=fragment.get('token');try{if(credential)win.sessionStorage.setItem('team-runtime-launcher',credential);else credential=win.sessionStorage.getItem('team-runtime-launcher');}catch{}
  if(fragment.has('token'))win.history.replaceState(null,'',win.location.pathname+win.location.search);
  const state={view:params.get('view')??(win.location.pathname==='/tasks.html'?'tasks':win.location.pathname==='/metrics.html'?'metrics':'overview'),dimension:'time',preset:'7',tpage:1,tsize:20,tsearch:'',tmember:'',tround:'',tstatus:'',tsort:'updatedAt',tdirection:'desc',mpage:1,msize:20,msearch:'',opage:1,osize:20};
  for(const key of urlKeys)if(params.has(key))state[key]=params.get(key);
  for(const key of ['tpage','tsize','mpage','msize','opage','osize'])state[key]=/^\d+$/.test(String(state[key]))?Number(state[key]):1;
  if(!['overview','tasks','metrics'].includes(state.view))state.view='overview';if(!['time','token','mcp'].includes(state.dimension))state.dimension='time';
  let current=null,statsBase=null,pendingBase=null,lastMain=null,lastOverview=null,taskBase=null,taskSnapshot=null,mainSnapshot=null,detail=null,detailData=null,renderedDetail=null,paused=false,authLost=false,restoreDetail=true,pendingTaskTarget=null;
  const detailRecovery=createDetailRecovery();
  const visible=()=>doc.visibilityState!=='hidden';
  const syncUrl=()=>{const q=new URLSearchParams();for(const key of urlKeys)if(state[key]!==undefined&&state[key]!==''&&state[key]!==null)q.set(key,String(state[key]));win.history.replaceState(null,'',win.location.pathname+'?'+q);};
  const windowQuery=()=>state.preset==='custom'?{preset:'custom',from:state.from,to:state.to}:{preset:state.preset};
  const message=text=>{$('sync-status').textContent=text;};
  const request=async(path,query={},signal)=>{const q=new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined&&v!==null&&v!==''));const response=await win.fetch(`/api/v2/${path}${q.size?'?'+q:''}`,{headers:{Authorization:`Bearer ${credential??''}`},signal,credentials:'omit',cache:'no-store'});if(!response.ok){let code='source_unavailable';try{code=(await response.json()).error;}catch{}throw Object.assign(new Error(code),{status:response.status,code});}return response.json();};
  const error=e=>{if(e.status===401){authLost=true;statePoller.stop();statsPoller.stop();mainLane.cancel();detailLane.cancel();message('连接凭据失效 · 自动请求已停止；请重新打开本机启动器给出的完整链接。');}
    else message(e.status===409?'快照已过期或被回收 · 点击立即刷新取得新快照；当前页和详情保持原内容。':e.status===404?'目标未找到；已保留当前筛选与页面。':e.status===400?'查询条件不匹配；请检查窗口、筛选与快照。':'来源读取失败 · 保留最近成功数据，覆盖或统计可能陈旧。');};
  const deferred=new Map();
  const setHtml=(element,html)=>{
    const selection=win.getSelection();if(selection&&!selection.isCollapsed&&element.contains(selection.anchorNode)){deferred.set(element,html);message('新数据已就绪 · 结束文字选择后显示。');return false;}deferred.delete(element);
    if(element.innerHTML===html)return true;
    const reading=captureReadingPosition(root),focus=element.contains(doc.activeElement)?doc.activeElement.dataset.focusKey??doc.activeElement.id:null;
    const scrolls=[...element.querySelectorAll('.table-wrap,.step-scroll')].map(n=>({x:n.scrollLeft,y:n.scrollTop}));
    element.innerHTML=html;[...element.querySelectorAll('.table-wrap,.step-scroll')].forEach((n,i)=>{n.scrollLeft=scrolls[i]?.x??0;n.scrollTop=scrolls[i]?.y??0;});
    if(focus){let target=doc.getElementById(focus)??[...element.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===focus);if(target?.disabled)target=target.closest('.task-pager')?.querySelector('[aria-current="page"]');target?.focus({preventScroll:true});if(!target)message('原阅读位置已移出当前页 · 页码和筛选保持，可用跨页定位重新查找。');}
    restoreReadingPosition(root,reading);return true;
  };
  doc.addEventListener('selectionchange',()=>{if(win.getSelection()?.isCollapsed)for(const [element,html] of [...deferred])if(element.isConnected)setHtml(element,html);else deferred.delete(element);});
  const renderCurrent=data=>{
    const changed=current?.versions.sourceVersion!==data.versions.sourceVersion;current=data;$('team-name').textContent=data.data.teamName;$('team-description').textContent=`当前在册 ${data.data.counts.members} 人 · 历史绑定与统计窗口另列`;
    $('state-asof').textContent=`状态截至 ${date(data.stateAsOf)} · 最近核对 ${date(data.checkedAt)}（北京）`;
    const c=data.data.counts,counts=[['团队成员',c.members,`Manager ${c.roles.Manager} · Liaison ${c.roles.Liaison} · Worker ${c.roles.Worker}`],['任务总数',c.tasks,'全部当前台账'],['已验收',c.statuses.approved??0,'独立验收记录'],['待验收 / 审查',(c.statuses.submitted??0)+(c.statuses.reviewing??0),'当前业务状态'],['执行 / 阻塞',(c.statuses.executing??0)+(c.statuses.blocked??0),'台账声明状态，非实时运行']];
    setHtml($('current-cards'),counts.map(([label,value,note])=>`<article class="card stat"><div class="stat-top">${esc(label)}</div><div class="value">${number(value)}</div><p class="sub">${esc(note)}</p></article>`).join(''));
    const selected={member:$('task-member').value,round:$('task-round').value,status:$('task-status').value};
    $('task-member').innerHTML='<option value="">全部成员</option>'+data.data.rows.map(m=>`<option value="${esc(m.id)}">${esc(m.name)} · ${esc(m.role)}</option>`).join('');$('task-member').value=state.tmember??selected.member;
    $('task-round').innerHTML='<option value="">全部轮次</option>'+data.data.rounds.map(r=>`<option value="${esc(r.id)}">${esc(r.title)}</option>`).join('');$('task-round').value=state.tround??selected.round;
    $('task-status').innerHTML='<option value="">全部状态</option>'+Object.keys(c.statuses).map(s=>`<option value="${s}">${esc(status(s))}</option>`).join('');$('task-status').value=state.tstatus??selected.status;
    if(state.view==='overview'&&lastOverview)renderOverview(lastOverview);if(changed&&state.view==='tasks'&&lastMain)void runMain({pin:false});
  };
  const renderCoverage=data=>{
    if(data.window)$('window-label').textContent=`${data.window.from} — ${data.window.to} · 北京时间`;
    $('stats-asof').textContent=`统计采集 ${date(data.statsAsOf)} · 当前查看快照 ${data.baseSnapshotId?.slice(0,8)??'未知'}`;
    const coverage=data.coverage??[],asOf=[...new Set(coverage.map(s=>s.sourceAsOf).filter(Boolean))];
    setHtml($('coverage-view'),`<p>来源 ${coverage.length} 项 · ${coverage.filter(s=>s.status==='fresh').length} 项已读 · ${coverage.filter(s=>s.status!=='fresh').length} 项陈旧/补采/异常。完整窗口覆盖尚未证明。</p><p>来源实际截至：${asOf.slice(0,5).map(date).join(' / ')||'未知'}。统计核对 ${date(data.checkedAt)}；来源截至与业务状态分别记录。</p><p ${metricsNoteAttributes(data.data.summary)}>${esc(metricsNote(data.data.summary))}</p>`);
    $('dataset-label').textContent='绑定来源 · 部分覆盖；缺端、未归属和未接入维持未知';
  };
  const renderOverview=data=>{
    lastOverview=data;const entries=data.data.members.rows,roster=current?.data.rows??entries.map(r=>({id:r.memberId,name:r.name,role:r.role}));
    const rows=roster.map(m=>{const matches=entries.filter(r=>r.memberId===m.id),r=matches.length===1?matches[0]:null;
      return `<tr data-live-key="member-${esc(m.id)}">${cell(button(m.name??m.id,`data-member="${esc(m.id)}" data-focus-key="member-${esc(m.id)}"`)+`<span class="role-line">${esc(m.role)} · ${matches.length>1?'多个历史绑定':r?.coverage??'sourcesPending'}</span>`)}${cell(m.currentTask?button(m.currentTask.title,`data-task="${esc(m.currentTask.id)}"`):'—')}${cell(esc(status(m.currentTask?.status??'当前无任务')))}${cell(matches.length>1?'查看绑定明细':`<span class="row-meta">步骤活动（声明） ${esc(declaredActivityText(r?.time))}</span><span class="row-meta">MCP 调用（TC） ${ms(union(r?.time,'team-context'))}</span>`)}${cell(matches.length>1?'查看绑定明细':button(formatToken(total(r?.time)),`data-member-metric="token" data-member="${esc(m.id)}" ${tokenAttributes(total(r?.time))}`))}${cell(matches.length>1?'查看绑定明细':button(number(calls(r?.time,'team-context')),`data-member-metric="mcp" data-member="${esc(m.id)}"`))}</tr>`;});
    setHtml($('overview-table'),rowsTable(['成员 / 角色（全名）','当前任务','业务状态','步骤活动 / MCP 调用','Token 消耗','MCP · TC'],rows,'member-table')+pager('overview',current?.data??data.data.members)+`<p class="sub">当前成员名字来自核验台账 ${date(current?.stateAsOf??data.stateAsOf)}，不推定历史 epoch 名称；声明步骤活动与机器MCP调用分别显示，不相加、不代表完整工作时长。`+button('查看窗口内历史绑定', 'data-history-members="true"')+'</p>');
    setHtml($('recent-accepted'),rowsTable(['最近验收成果','验收时间（北京）'],data.data.recentAccepted.map(t=>`<tr>${cell(button(t.title,`data-task="${esc(t.id)}"`))}${cell(date(t.completedAt))}</tr>`),'accepted-table'));
  };
  const renderTasks=data=>{
    taskBase=data.baseSnapshotId;taskSnapshot=data.querySnapshotId;state.tpage=data.data.page;
    const rows=data.data.rows.map(t=>`<tr data-live-key="task-${esc(t.id)}">${cell(button(t.title,`data-task="${esc(t.id)}" data-focus-key="task-${esc(t.id)}"`)+`<span class="task-row-meta">${esc(t.id)} · ${esc(t.roundId)}</span>`)}${cell(esc(t.owner?.name??t.ownerId??'未绑定')+`<span class="role-line">${esc(t.owner?.role??'Unknown')}</span>`)}${cell(`<span class="task-state ${esc(t.status)}">${esc(status(t.status))}</span>`)}${cell(stageTime(t.currentStage)+`<span class="task-row-meta">${esc(status(t.currentStage?.status))} · 声明阶段</span>`)}${cell(date(t.progressAt??t.updatedAt))}${cell(button('详情 / 时间线',`data-task="${esc(t.id)}"`))}</tr>`);
    setHtml($('task-table'),rowsTable(['任务 / 轮次','负责成员','状态','声明阶段历时','最近记录','详情'],rows,'task-table')+pager('tasks',data.data));
    if(data.data.location){pendingTaskTarget=null;message(data.data.location.matchesCurrentFilters?'已跨页定位到同快照中的目标任务。':'目标在当前筛选之外；页码与筛选已保留。');if(data.data.location.matchesCurrentFilters)doc.querySelector(`[data-live-key="task-${CSS.escape(data.data.location.targetId)}"]`)?.scrollIntoView({block:'center'});}
    syncUrl();
  };
  const renderMetrics=data=>{
    mainSnapshot=data.querySnapshotId;state.mpage=data.data.page;$('metrics-summary').textContent=metricsNote(data.data.summary);$('metrics-summary').title=metricsNoteExact(data.data.summary);$('metrics-summary').setAttribute('aria-description',$('metrics-summary').title);let heads,rows;
    if(state.dimension==='time'){heads=['任务 / 轮次','任务墙钟（完整两端）','声明阶段并集','成员观测与步骤'];rows=data.data.rows.map(t=>`<tr data-live-key="time-${esc(t.id)}">${cell(button(t.title,`data-time-task="${esc(t.id)}" data-focus-key="time-${esc(t.id)}"`)+`<span class="row-meta">${esc(t.taskId)} · ${esc(t.roundId)}</span>`)}${cell(ms(t.taskWallClockMs))}${cell(ms(t.time?.taskDeclaredMs))}${cell(button('成员泳道 / 步骤',`data-time-task="${esc(t.id)}"`))}</tr>`);}
    else if(state.dimension==='token'){heads=['北京日期','Manager','Liaison','Worker','Unknown','原生 total','覆盖 / 详情'];rows=data.data.rows.map(d=>`<tr>${cell(button(d.date,`data-day="${d.date}" data-focus-key="day-${d.date}"`))}${['Manager','Liaison','Worker','Unknown'].map(role=>cell(tokenValueMarkup(d.summary.token.byRole?.[role]?.total?.known))).join('')}${cell(tokenValueMarkup(total(d.summary)))}${cell(button('当天成员详情',`data-day="${d.date}"`)+'<span class="row-meta">部分来源；未知不零</span>')}</tr>`);}
    else{heads=['北京日期','native','Team Context','报告副本','覆盖 / 详情'];rows=data.data.rows.map(d=>`<tr>${cell(button(d.date,`data-day="${d.date}" data-focus-key="day-${d.date}"`))}${['native','team-context','team-context-report'].map(kind=>cell(number(calls(d.summary,kind)))).join('')}${cell(button('当天成员详情',`data-day="${d.date}"`)+'<span class="row-meta">按完成日计数 · 三来源不相加</span>')}</tr>`);}
    setHtml($('metrics-table'),rowsTable(heads,rows,`metrics-table ${state.dimension==='token'?'token-table':state.dimension==='mcp'?'mcp-table':'member-time-table'}`)+pager('metrics',data.data));syncUrl();
  };
  const mainLane=createRequestLane({request:({path,query},signal)=>request(path,query,signal),apply:data=>{lastMain=data;renderCoverage(data);if(state.view==='overview')renderOverview(data);else if(state.view==='tasks')renderTasks(data);else renderMetrics(data);if(restoreDetail){restoreDetail=false;if(state.detail==='task'&&state.taskId)openDetail({type:'task',taskId:state.taskId,base:taskBase??statsBase?.id});else if(state.detail==='day'&&state.day)openDetail({type:'members',day:state.day,base:statsBase?.id,parent:mainSnapshot??data.querySnapshotId});else if(state.detail==='member'&&state.memberId)openDetail({type:'members',memberId:state.memberId,dimension:state.dimension,base:statsBase?.id});}},error});
  function runMain({pin=true,target=null}={}){
    if(target)pendingTaskTarget=target;if(state.view==='tasks')target??=pendingTaskTarget;
    if(!visible()||authLost||!statsBase)return Promise.resolve();let path,query;
    if(state.view==='tasks'){path=target?'locate':'tasks';query={search:state.tsearch,memberId:state.tmember,roundId:state.tround,status:state.tstatus,sort:state.tsort,direction:state.tdirection,page:state.tpage,pageSize:state.tsize,...(pin&&taskBase&&taskSnapshot?{baseSnapshotId:taskBase,snapshotId:taskSnapshot}:{})};if(target)Object.assign(query,{targetId:target,targetKind:'task'});}
    else if(state.view==='overview'){path='overview';query={...windowQuery(),baseSnapshotId:statsBase.id,page:state.opage,pageSize:state.osize};}
    else{path='metrics';query={...windowQuery(),dimension:state.dimension,baseSnapshotId:statsBase.id,page:state.mpage,pageSize:state.msize,search:state.msearch,sort:state.dimension==='time'?'updatedAt':'date',direction:'desc',...(pin&&mainSnapshot?{snapshotId:mainSnapshot}:{})};}
    return mainLane.run({path,query});
  }
  const statePoller=createDashboardPoller('state',{visible,request:({signal})=>request('overview',{mode:'current',page:state.opage,pageSize:state.osize},signal),onData:renderCurrent,onStatus:s=>{if(s==='unauthorized')error({status:401});else if(s==='unavailable')message('当前台账读取失败 · 上次状态保留为陈旧，不能视为当前名单。');}});
  const statsPoller=createDashboardPoller('stats',{visible,request:({signal})=>request('snapshot',{refresh:'stats'},signal),onData:data=>{const captured={id:data.baseSnapshotId,expiresAt:data.snapshotExpiresAt};if(dialog.open&&statsBase){pendingBase=captured;message('新统计已采集 · 正在查看的详情保留原快照；关闭详情或显式刷新后更新。');}
    else{statsBase=captured;mainSnapshot=null;void runMain({pin:false});message(paused?'自动更新已暂停 · 本次手动刷新完成。':'状态每5秒 / 统计每30秒 · 页面可见时按需有界读取。');}},onStatus:s=>{if(s==='unauthorized')error({status:401});else if(s==='unavailable')message('统计采集失败 · 保留最近成功数据；可手动重试。');}});
  const memberCells=(r,dimension)=>{
    const name=button(r.name??r.memberId,`data-member="${esc(r.memberId)}"`)+`<span class="row-meta">${esc(r.role)} · ${esc(r.roleEpoch??'unbound')} · 名称截至 ${date(r.nameProvenance?.asOf)}</span>`;
    const coverage=esc(r.coverage)+`<span class="row-meta">${esc(memberAttributionText(r.time))}</span>`;
    if(dimension==='token')return [name,...['input','cachedInput','output','reasoningOutput','total'].map(k=>tokenValueMarkup(r.time.token.nativeTotal[k].known)),esc(r.coverage)];
    if(dimension==='mcp')return [name,...['native','team-context','team-context-report'].map(kind=>calls(r.time,kind)===null?'未记录':button(number(calls(r.time,kind)),`data-calls-member="${esc(r.memberId)}" data-binding="${esc(r.id)}" data-series="${kind}"`)),coverage];
    return [name,...['native','team-context'].map(kind=>ms(union(r.time,kind))),esc(declaredActivityText(r.time)),button('查看明确关联步骤',`data-steps-member="${esc(r.memberId)}" data-binding="${esc(r.id)}"`),coverage];
  };
  const sourceSummary=s=>(s?.intervals??[]).map(r=>`${sourceNames[r.sourceKind]??r.sourceKind}（${r.assurance}）完成区间 ${ms(r.observedUnionMs)}；请求响应 ${ms(r.requestResponseUnionMs)}；缺端 ${r.missingEndpoints}`).join(' / ')||'没有可核验的完整区间。';
  const detailLane=createRequestLane({request:({path,query},signal)=>request(path,query,signal),apply:(data,scope)=>{
    detailData=data;detail.base=data.baseSnapshotId;detail.querySnapshotId=data.querySnapshotId;detail.page=data.data.page??detail.page;
    $('detail-snapshot').textContent=`来源快照 ${data.baseSnapshotId?.slice(0,12)} · 查询 ${data.querySnapshotId?.slice(0,12)} · 状态 ${date(data.stateAsOf)} · 统计 ${date(data.statsAsOf)}${data.window?` · ${data.window.from} — ${data.window.to}（北京）`:''}`;
    let html='',controls='';$('detail-status').textContent='';$('detail-back').hidden=!(detail.history?.length);
    if(detail.type==='task'){
      const t=data.data.task;$('detail-heading').textContent=t.title;html=`<p class="detail-meta">${esc(t.id)} · ${esc(status(t.status))} · 负责人 ${esc(t.owner?.name??t.ownerId??'未知')}</p><dl class="detail-facts"><div><dt>任务墙钟 · 完整两端</dt><dd>${ms(t.taskWallClockMs)}</dd></div><div><dt>提交记录</dt><dd>${t.submissionCount}</dd></div><div><dt>派发</dt><dd>${date(t.assignedAt)}</dd></div><div><dt>最近记录</dt><dd>${date(t.progressAt)}</dd></div></dl><p class="sub">明确关联贡献成员 ${number(data.data.contributorsSummary.memberCount)} 人 / ${number(data.data.contributorsSummary.bindingCount)} 个绑定；未归属记录 ${number(data.data.contributorsSummary.unattributedRecords)} 条。任务阶段未记录 owner，不能分摊给负责人。当前筛选之外的详情仍保留。</p>`+rowsTable(['阶段','声明开始','声明结束','声明历时'],data.data.stages.rows.map(r=>`<tr>${[status(r.status),date(r.startAt),date(r.endAt),stageTime(r)].map(v=>cell(esc(v))).join('')}</tr>`),'stage-table')+pager('stages',data.data.stages);controls=button('耗时 / 成员泳道',`data-time-task="${esc(t.id)}"`)+button('在任务列表定位',`data-find-task="${esc(t.id)}"`);
    }else if(detail.type==='members'){
      $('detail-heading').textContent=`${detail.day??detail.memberId??'窗口'} · ${detail.dimension==='time'?'耗时':detail.dimension==='mcp'?'MCP':'Token'} 成员明细`;
      const headers=detail.dimension==='token'?['成员 / 历史角色','Input','Cached input（子集）','Output','Reasoning（子集）','原生 total','覆盖']:detail.dimension==='mcp'?['成员 / 历史角色','native','Team Context','报告副本','覆盖']:['成员 / 历史角色','native 完成并集','TC 完成并集','声明 sidecar','步骤','覆盖'];
      html=`<p class="sub" ${metricsNoteAttributes(data.data.summary)}>${esc(metricsNote(data.data.summary))}</p><p class="sub">${esc(sourceSummary(data.data.summary))}</p>`+rowsTable(headers,data.data.rows.map(r=>`<tr>${memberCells(r,detail.dimension).map(cell).join('')}</tr>`),detail.dimension==='mcp'?'day-mcp-table':'day-members-table')+pager('detail',data.data);
      controls=`<form id="detail-search-form" class="metrics-filters"><label class="search-label">成员名称或 ID <input id="detail-search" value="${esc(detail.search??'')}" maxlength="128"></label><button class="button">搜索成员</button></form>`;
      if(detail.memberId)controls+=button('该成员任务',`data-member-tasks="${esc(detail.memberId)}"`);controls+=['token','mcp','time'].map(d=>button(d==='time'?'耗时':d==='token'?'Token':'MCP',`data-detail-dimension="${d}" aria-pressed="${detail.dimension===d}"`)).join('');
    }else if(detail.type==='lanes'){
      $('detail-heading').textContent=`${detail.taskId} · 成员泳道`;html=`<p class="sub">${esc(sourceSummary(data.data.summary))}</p><p class="sub">声明阶段保持未归属；空档不算等待。</p>`+button('任务阶段 / 全部明确关联步骤',`data-steps-task="${esc(detail.taskId)}"`)+data.data.rows.map(r=>`<div class="lane"><button class="lane-open" data-steps-task="${esc(detail.taskId)}" data-steps-member="${esc(r.memberId)}" aria-expanded="false"><strong>${esc(r.name??r.memberId)} · ${esc(r.role)}</strong><span>${esc(sourceSummary(r.time))}</span></button></div>`).join('')+pager('detail',data.data);
    }else{
      $('detail-heading').textContent=detail.type==='calls'?`${detail.day??'窗口'} · ${sourceNames[detail.series]??detail.series} 调用`:`${detail.taskId??detail.day??'窗口'} · ${detail.memberId??'未归属阶段与明确关联'} 步骤`;
      const rows=data.data.rows.map(r=>`<tr data-step-row="${esc(r.id)}" data-live-key="step-${esc(r.id)}">${cell(button(r.stepId??r.tool??r.id,`data-step="${esc(r.id)}" data-focus-key="step-${esc(r.id)}"`)+`<span class="row-meta">${esc(attributionLabel(r))} · 步骤成员 ${esc(r.memberName??(r.memberId?'名字未记录':'无绑定证据'))}</span>`)}${cell(esc(status(r.status)))}${cell(date(r.startAt))}${cell(date(r.endAt))}${cell(ms(r.durationMs))}${cell(ms(r.requestResponseMs))}${cell(esc(r.assurance??r.kind)+`<span class="row-meta">${esc(r.missing.join(' / ')||'已记录两端')}</span>`)}</tr>`);
      const completed=data.data.rows.filter(r=>r.startAt&&r.endAt&&r.durationMs!==null),start=Date.parse(data.window?.startAt),end=Date.parse(data.window?.endAt),width=end-start;
      const bars=completed.map((r,i)=>{const x=Math.max(0,(Date.parse(r.startAt)-start)/width*680),w=Math.max(1,Math.min(680-x,(Date.parse(r.endAt)-Math.max(start,Date.parse(r.startAt)))/width*680));return `<rect x="${x+10}" y="${8+i%4*13}" width="${w}" height="9"><title>${esc(r.stepId??r.id)} · ${ms(r.durationMs)}</title></rect>`;}).join('');
      html=`<p class="sub">${esc(sourceSummary(data.data.summary))}</p><div class="timeline-wrap"><svg class="timeline" role="img" aria-label="当前页已闭合区间泳道" viewBox="0 0 700 70">${bars}<line x1="10" x2="690" y1="64" y2="64"/></svg></div>`+rowsTable(['步骤 / 调用','完成证据状态','开始','结束','窗口耗时','首次响应延迟','来源 / 缺口'],rows,'steps-table')+pager('detail',data.data)+'<div id="step-evidence"></div>';
      controls=`<form id="step-locate-form" class="metrics-filters"><label>定位步骤 ID <input id="locate-step-id" maxlength="128"></label><button class="button">跨页定位步骤</button></form>`;
      if(data.data.location){$('detail-status').textContent=data.data.location.matchesCurrentFilters?'已取得目标所在页，下面可查看该步骤。':'目标步骤在当前过滤之外；条件保持。';}
    }
    const scroller=dialog.querySelector('.modal-body'),oldY=scroller.scrollTop;setHtml($('detail-content'),html);setHtml($('detail-controls'),controls);scroller.scrollTop=oldY;
    if(data.data.location?.matchesCurrentFilters)dialog.querySelector(`[data-step-row="${CSS.escape(data.data.location.targetId)}"]`)?.scrollIntoView({block:'center'});
    detailBusy(false);detailRecovery.commit();$('detail-retry').hidden=true;
    if(scope.focusKey){let target=doc.getElementById(scope.focusKey)??[...dialog.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===scope.focusKey);if(target?.disabled)target=target.closest('.task-pager')?.querySelector('[aria-current="page"]');(target??$('detail-refresh')).focus({preventScroll:true});}else if(!dialog.contains(doc.activeElement))$('detail-refresh').focus({preventScroll:true});
    renderedDetail=captureDetailView();
    if(detail.type==='task'){state.taskId=detail.taskId;state.detail='task';}else if(detail.type==='members'&&detail.day){state.day=detail.day;state.detail='day';}else if(detail.type==='members'&&detail.memberId){state.memberId=detail.memberId;state.detail='member';}syncUrl();
  },error:(e,scope)=>{error(e);const previous=detailRecovery.reject(scope.attempt);detailBusy(false);
    if(previous)restoreDetailView(previous);else{$('detail-heading').textContent='目标详情暂不可用';$('detail-snapshot').textContent=`所选来源快照 ${scope.attempt.base?.slice(0,12)??'未知'}`;$('detail-content').innerHTML='<p class="sub">目标详情尚未加载。可以重试、刷新来源或关闭。</p>';$('detail-controls').innerHTML='';$('detail-back').hidden=!(detail?.history?.length);}
    $('detail-status').textContent=(e.status===409?'目标快照已过期；请刷新详情后重新选择目标。':e.status===404?'目标尚未出现在所选来源中。':e.status===400?'目标查询条件不匹配。':'目标详情读取失败。')+(previous?' 已返回并保留上次详情，可重试目标。':' 可重试或关闭。');$('detail-retry').hidden=false;$('detail-retry').focus({preventScroll:true});
  }});
  function detailBusy(value){for(const id of ['detail-content','detail-controls']){$(id).inert=value;$(id).setAttribute('aria-busy',String(value));}}
  function captureDetailView(){return {detail:{...detail,history:[...(detail.history??[])]},data:detailData,heading:$('detail-heading').textContent,snapshot:$('detail-snapshot').textContent,html:$('detail-content').innerHTML,controls:$('detail-controls').innerHTML,scrollY:dialog.querySelector('.modal-body').scrollTop,scrolls:[...dialog.querySelectorAll('.table-wrap,.step-scroll')].map(n=>({x:n.scrollLeft,y:n.scrollTop})),inputs:[...dialog.querySelectorAll('input[id],select[id]')].map(n=>({id:n.id,value:n.value,checked:n.checked}))};}
  function captureRenderedView(){return renderedDetail?{...captureDetailView(),detail:{...renderedDetail.detail},data:renderedDetail.data}:null;}
  function restoreDetailView(view,history=view.detail.history){detail={...view.detail,history:[...history]};detailData=view.data;renderedDetail={...view,detail:{...detail}};deferred.delete($('detail-content'));deferred.delete($('detail-controls'));$('detail-heading').textContent=view.heading;$('detail-snapshot').textContent=view.snapshot;if($('detail-content').innerHTML!==view.html)$('detail-content').innerHTML=view.html;if($('detail-controls').innerHTML!==view.controls)$('detail-controls').innerHTML=view.controls;dialog.querySelector('.modal-body').scrollTop=view.scrollY;[...dialog.querySelectorAll('.table-wrap,.step-scroll')].forEach((n,i)=>{n.scrollLeft=view.scrolls?.[i]?.x??0;n.scrollTop=view.scrolls?.[i]?.y??0;});for(const saved of view.inputs??[]){const n=doc.getElementById(saved.id);if(n&&dialog.contains(n)){n.value=saved.value;if(saved.checked!==undefined)n.checked=saved.checked;}}$('detail-back').hidden=!history.length;}
  function runDetail({pin=true,target=null}={}){
    if(!detail||!visible()||authLost)return Promise.resolve();const d=detail,focusKey=dialog.contains(doc.activeElement)?doc.activeElement.dataset.focusKey??doc.activeElement.id:null;detailRecovery.begin(captureRenderedView());detailBusy(true);$('detail-status').textContent=renderedDetail?'正在读取目标；上次详情暂保留。':'正在按固定快照读取详情…';$('detail-retry').hidden=true;
    return detailLane.run({...buildDetailRequest(d,windowQuery(),{pin,target}),focusKey,attempt:{...d,history:[...(d.history??[])],target}});
  }
  function openDetail(next,opener=doc.activeElement){
    detailLane.cancel();const history=dialog.open&&detail&&renderedDetail?[...(detail.history??[]),{...detail,view:captureRenderedView(),history:undefined}].slice(-20):[];
    detail={page:1,pageSize:20,dimension:state.dimension,base:statsBase?.id,window:dialog.open?detail?.window??windowQuery():windowQuery(),...next,history,openerKey:detail?.openerKey??opener?.dataset.focusKey??opener?.id};detailData=null;
    if(!renderedDetail){$('detail-heading').textContent='目标详情';$('detail-snapshot').textContent='';$('detail-content').innerHTML='<p class="sub">正在按固定快照读取详情…</p>';$('detail-controls').innerHTML='';}$('detail-back').hidden=!history.length;
    if(!dialog.open){dialog.showModal();doc.body.classList.add('metrics-modal-open');}void runDetail({pin:false});
  }
  function navigate(view,dimension=state.dimension){mainLane.cancel();state.view=view;state.dimension=dimension;mainSnapshot=null;
    for(const name of ['overview','tasks','metrics'])$(name==='metrics'?'metrics-panel-v2':`${name}-panel`).hidden=name!==view;
    // Keep the root DOM bounded across navigation, including hidden panels.
    // Query state and frozen data remain in the existing bounded client slots.
    for(const [name,ids] of [['overview',['overview-table','recent-accepted']],['tasks',['task-table']],['metrics',['metrics-table']]])if(name!==view)for(const id of ids){const element=$(id);deferred.delete(element);element.replaceChildren();}
    for(const b of doc.querySelectorAll('[data-nav]'))b.setAttribute('aria-current',b.dataset.nav===view?'page':'false');
    for(const b of doc.querySelectorAll('[data-dimension]')){b.setAttribute('aria-selected',String(b.dataset.dimension===dimension));b.tabIndex=b.dataset.dimension===dimension?0:-1;}
    $('metrics-table').setAttribute('aria-labelledby',`metric-tab-${dimension}`);
    $('view-title').textContent={overview:'团队总览',tasks:'任务进度',metrics:'指标统计'}[view];doc.title=`CODEX / TEAM · ${$('view-title').textContent}`;$('metric-search').placeholder=dimension==='time'?'任务名称或 ID':'北京日期';syncUrl();void runMain({pin:false});
  }
  const closeDetail=()=>dialog.close();
  dialog.addEventListener('close',()=>{detailLane.cancel();detailRecovery.clear();renderedDetail=null;detailBusy(false);$('detail-retry').hidden=true;doc.body.classList.remove('metrics-modal-open');const opener=detail?.openerKey;detail=null;state.detail=null;state.taskId=null;state.day=null;state.memberId=null;deferred.clear();syncUrl();
    if(pendingBase){statsBase=pendingBase;pendingBase=null;mainSnapshot=null;void runMain({pin:false});}
    (doc.getElementById(opener)??[...doc.querySelectorAll('[data-focus-key]')].find(n=>n.dataset.focusKey===opener)??doc.querySelector(`[data-nav="${state.view}"]`))?.focus({preventScroll:true});});
  dialog.addEventListener('click',e=>{const box=dialog.getBoundingClientRect();if(e.target===dialog&&(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom))closeDetail();});
  dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const nodes=[...dialog.querySelectorAll('button,a,input,select,[tabindex]')].filter(n=>!n.disabled&&n.getClientRects().length&&n.tabIndex>=0),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first?.focus();}});
  $('detail-close').onclick=closeDetail;
  $('detail-back').onclick=()=>{detailLane.cancel();detailRecovery.clear();detailBusy(false);$('detail-retry').hidden=true;const previous=detail?.history?.pop();if(previous){const history=detail.history;if(previous.view){restoreDetailView(previous.view,history);$('detail-status').textContent='已返回原来源详情；可显式刷新。';$('detail-refresh').focus({preventScroll:true});}else{detail={...previous,history};void runDetail({pin:false});}}};
  $('detail-retry').onclick=()=>{const attempt=detailRecovery.retry();if(!attempt)return;const sameScope=renderedDetail?.detail.type===attempt.type&&renderedDetail?.detail.querySnapshotId===attempt.querySnapshotId;if(sameScope){detail={...attempt};void runDetail({target:attempt.target});}else openDetail(attempt);};
  $('detail-refresh').onclick=async()=>{if(!detail||authLost)return;try{const fresh=await request('snapshot',{refresh:'stats'});statsBase={id:fresh.baseSnapshotId,expiresAt:fresh.snapshotExpiresAt};pendingBase=null;mainSnapshot=null;detail.base=fresh.baseSnapshotId;detail.querySnapshotId=null;detail.parent=null;await runMain({pin:false});await runDetail({pin:false});message('已显式更新至新来源快照；筛选、页码和所选目标保持。');}catch(e){error(e);}};
  doc.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const d=b.dataset;
    if(d.nav){navigate(d.nav);return;}if(d.dimension){state.mpage=1;navigate('metrics',d.dimension);return;}
    if(d.page){const p=Number(d.page);if(d.scope==='tasks'){state.tpage=p;void runMain();}else if(d.scope==='metrics'){state.mpage=p;void runMain();}else if(d.scope==='overview'){state.opage=p;void statePoller.refresh({replace:true});void runMain({pin:false});}else if(detail){detail.page=p;void runDetail();}syncUrl();return;}
    if(d.findTask){closeDetail();state.view='tasks';navigate('tasks');void runMain({pin:false,target:d.findTask});return;}
    if(d.memberTasks){const id=d.memberTasks;closeDetail();state.tmember=id;state.tpage=1;taskSnapshot=null;taskBase=null;$('task-member').value=id;navigate('tasks');return;}
    if(d.detailDimension&&detail){detail.dimension=d.detailDimension;detail.querySnapshotId=null;void runDetail({pin:false});return;}
    if(d.day){openDetail({type:'members',day:d.day,parent:mainSnapshot,dimension:state.dimension},b);return;}
    if(d.callsMember){openDetail({type:'calls',day:detail?.day,memberId:d.callsMember,memberBindingKey:d.binding,series:d.series,parent:detail?.parent,base:detail?.base},b);return;}
    if(d.stepsTask||d.stepsMember){openDetail({type:'steps',taskId:d.stepsTask??detail?.taskId,memberId:d.stepsMember,memberBindingKey:d.binding,day:detail?.day,parent:detail?.type==='members'?detail.querySnapshotId:detail?.parent,base:detail?.base},b);return;}
    if(d.timeTask){openDetail({type:'lanes',taskId:d.timeTask,base:dialog.open?detail?.base:statsBase?.id},b);return;}
    if(d.task){openDetail({type:'task',taskId:d.task,base:state.view==='tasks'?taskBase:undefined},b);return;}
    if(d.member){openDetail({type:'members',memberId:d.member,dimension:d.memberMetric??(dialog.open?detail.dimension:'time'),day:dialog.open?detail.day:undefined,parent:dialog.open?detail.parent:undefined,base:dialog.open?detail.base:statsBase?.id},b);return;}
    if(d.historyMembers){openDetail({type:'members',dimension:'time',base:statsBase?.id},b);return;}
    if(d.step){const r=detailData?.data.rows.find(r=>r.id===d.step);if(r)setHtml($('step-evidence'),`<div class="step-detail"><h2>${esc(r.stepId??r.tool??r.id)}</h2><dl><dt>记录 ID</dt><dd>${esc(r.id)}</dd><dt>任务 / 轮次 / 步骤</dt><dd>${esc(r.taskId??'未记录')} / ${esc(r.roundId??'未记录')} / ${esc(r.stepId??'未记录')} · ${esc(attributionLabel(r))}</dd><dt>步骤记录成员 / 角色</dt><dd>${esc(r.memberName??'名字未记录')}（${esc(r.memberId??'无绑定证据')}） / ${esc(r.role??'Unknown')}；名称截至 ${date(r.memberNameProvenance?.asOf)}，不推定历史姓名或任务负责人</dd><dt>关联证据</dt><dd>${esc(r.associationSource??(r.sourceKind==='activity-sidecar'?'步骤事件声明':'未提供上下文'))}${r.contextValidation?` · 校验台账版本 ${r.contextValidation.sourceVersion}`:''} · 计时 ${esc(r.assurance??'未知')}</dd><dt>完成状态</dt><dd>${esc(status(r.status))} · completionKnown=${esc(r.completionKnown)}</dd><dt>首次 yield</dt><dd>${date(r.firstYieldAt)}</dd><dt>首次响应</dt><dd>${date(r.responseAt)}</dd><dt>完成证据</dt><dd>${esc(r.completionEvidence??'未提供')}</dd><dt>Host 报告耗时</dt><dd>${ms(r.reportedDurationMs)} · ${esc(r.hostReportedStatus??'未知')}</dd><dt>缺口</dt><dd>${esc(r.missing.join(' / ')||'无已记录缺口；仍不证明完整工作时长')}</dd></dl></div>`);}
  });
  doc.addEventListener('change',e=>{const scope=e.target.dataset.pageSize;if(!scope)return;const size=Number(e.target.value);if(scope==='tasks'){state.tsize=size;state.tpage=1;taskSnapshot=null;void runMain({pin:false});}else if(scope==='metrics'){state.msize=size;state.mpage=1;mainSnapshot=null;void runMain({pin:false});}else if(scope==='overview'){state.osize=size;state.opage=1;void statePoller.refresh({replace:true});void runMain({pin:false});}else if(detail){detail.pageSize=size;detail.page=1;detail.querySnapshotId=null;void runDetail({pin:false});}syncUrl();});
  $('task-filters').onsubmit=e=>{e.preventDefault();Object.assign(state,{tsearch:$('task-search').value,tmember:$('task-member').value,tround:$('task-round').value,tstatus:$('task-status').value,tsort:$('task-sort').value,tdirection:$('task-direction').value,tpage:1});taskSnapshot=null;taskBase=null;pendingTaskTarget=null;syncUrl();void runMain({pin:false});};
  $('task-locate').onsubmit=e=>{e.preventDefault();void runMain({target:$('locate-task-id').value.trim()});};
  $('metric-filters').onsubmit=e=>{e.preventDefault();state.msearch=$('metric-search').value;state.mpage=1;mainSnapshot=null;syncUrl();void runMain({pin:false});};
  doc.addEventListener('submit',e=>{if(e.target.id==='detail-search-form'&&detail){e.preventDefault();detail.search=$('detail-search').value;detail.page=1;detail.querySnapshotId=null;void runDetail({pin:false});}else if(e.target.id==='step-locate-form'&&detail){e.preventDefault();void runDetail({target:$('locate-step-id').value.trim()});}});
  $('window-preset').value=state.preset;$('window-from').value=state.from??'';$('window-to').value=state.to??'';
  $('window-preset').onchange=()=>{if($('window-preset').value==='custom'){$('custom-window').hidden=false;return;}state.preset=$('window-preset').value;state.from=state.to=null;state.mpage=1;mainSnapshot=null;$('custom-window').hidden=true;syncUrl();void runMain({pin:false});};
  $('custom-window').onsubmit=e=>{e.preventDefault();state.preset='custom';state.from=$('window-from').value;state.to=$('window-to').value;state.mpage=1;mainSnapshot=null;syncUrl();void runMain({pin:false});};
  $('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'恢复更新':'暂停更新';$('pause').setAttribute('aria-pressed',String(paused));if(paused){statePoller.pause();statsPoller.pause();mainLane.cancel();detailLane.cancel();message('自动更新已暂停 · 可手动刷新；当前页面与详情保留。');}else{void statePoller.resume();void statsPoller.resume();}};
  $('refresh').onclick=()=>{if(authLost){message('请用启动器完整链接恢复凭据。');return;}void statePoller.refresh({replace:true});void statsPoller.refresh({replace:true});};
  const visibility=()=>{if(!visible()){mainLane.cancel();detailLane.cancel();message('页面已隐藏 · 新请求停止，迟到响应已作废。');}void statePoller.visibilityChanged();void statsPoller.visibilityChanged();if(visible()&&!paused&&detail)void runDetail({pin:true});};
  doc.addEventListener('visibilitychange',visibility);win.addEventListener('pagehide',()=>{statePoller.stop();statsPoller.stop();mainLane.cancel();detailLane.cancel();});win.addEventListener('pageshow',()=>{void statePoller.start();void statsPoller.start();});
  for(const [id,key] of [['task-search','tsearch'],['task-sort','tsort'],['task-direction','tdirection'],['metric-search','msearch']])$(id).value=state[key];
  doc.querySelector('[role="tablist"]').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const tabs=[...doc.querySelectorAll('[data-dimension]')],at=tabs.indexOf(doc.activeElement);if(at<0)return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(at+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click();});
  navigate(state.view,state.dimension);void statePoller.start();void statsPoller.start();
  return {stop(){statePoller.stop();statsPoller.stop();mainLane.cancel();detailLane.cancel();}};
}
if(typeof document!=='undefined'&&document.getElementById('dashboard-main'))bootDashboardV2();
