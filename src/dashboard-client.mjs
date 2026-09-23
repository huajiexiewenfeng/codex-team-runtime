// Served verbatim as a same-origin browser module; no libraries, host APIs or write endpoints.
import {setupDailyTabs} from './metrics-daily-tabs.mjs';
export function createPoller({request,onData,onStatus,visible=()=>true,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=5000,timeoutMs=15000}) {
 let stopped=true,paused=false,unauthorized=false,generation=0,timer=null,running=null,controller=null,deadline=null,failures=0;
 const cancel=()=>{generation++;clearTimer(timer);clearTimer(deadline);timer=deadline=null;controller?.abort();controller=null;running=null;};
 const execute=()=>{
  clearTimer(timer);timer=null;
  if(stopped||!visible())return Promise.resolve();
  if(running)return running;
  const current=++generation,abort=new AbortController();controller=abort;
  onStatus('checking');
  const work=(async()=>{
   try {
    const timeout=new Promise((_,reject)=>{deadline=setTimer(()=>{abort.abort();reject(new Error('Request timed out'));},timeoutMs);});
    const result=await Promise.race([request({signal:abort.signal}),timeout]);
    if(current!==generation||stopped||!visible())return;
    failures=0;unauthorized=false;
    const applied=onData(result)!==false;
    onStatus(paused?'paused':applied?'synced':'deferred');
   }catch(error){
    if(current!==generation||stopped||!visible())return;
    failures++;unauthorized=error.status===401;
    onStatus(unauthorized?'unauthorized':'unavailable');
   }finally{
    if(current===generation){
     clearTimer(deadline);deadline=null;running=null;controller=null;
     if(!stopped&&!paused&&!unauthorized&&visible())timer=setTimer(()=>{void execute();},Math.min(60000,intervalMs*2**Math.min(failures,4)));
    }
   }
  })();
  running=work;return work;
 };
 return {
  start(){
   stopped=false;
   if(paused||unauthorized){onStatus(unauthorized?'unauthorized':'paused');return Promise.resolve();}
   return visible()?execute():(onStatus('hidden'),Promise.resolve());
  },
  pause(){paused=true;cancel();onStatus('paused');},
  resume(){paused=false;return execute();},
  refresh({replace=false}={}){if(replace)cancel();return execute();},
  visibilityChanged(){if(!visible()){cancel();onStatus('hidden');return Promise.resolve();}if(paused||unauthorized){onStatus(unauthorized?'unauthorized':'paused');return Promise.resolve();}return execute();},
  stop(){stopped=true;cancel();}
 };
}

function interactionKey(element) {
 if(!element)return null;
 if(element.id)return `id:${element.id}`;
 if(element.tagName==='SUMMARY')return `summary:${element.parentElement.dataset.liveKey??element.parentElement.className}`;
 if(element.tagName==='A')return `link:${element.closest('[data-live-key]')?.dataset.liveKey??''}:${element.getAttribute('href')}`;
 return null;
}

const readingSelector='[data-live-key],section[id],footer[id]';
const readingKey=element=>element.dataset.liveKey?`key:${element.dataset.liveKey}`:`id:${element.id}`;
export function captureReadingPosition(container) {
 const doc=container.ownerDocument,win=doc.defaultView;
 const focused=doc.activeElement?.closest?.(readingSelector);
 let target=null;try{target=doc.getElementById?.(decodeURIComponent(win.location?.hash?.slice(1)??''));}catch{/* An arbitrary fragment need not be a valid encoded element ID. */}
 const priority=element=>element===focused?0:element===target?1:element.closest?.('aside')?3:2;
 const anchors=[...container.querySelectorAll(readingSelector)].map(element=>({key:readingKey(element),rect:element.getBoundingClientRect(),priority:priority(element)}))
  .filter(({rect})=>rect.height>0&&rect.bottom>0&&rect.top<win.innerHeight)
  .sort((a,b)=>a.priority-b.priority||Math.abs(a.rect.top)-Math.abs(b.rect.top)).map(({key,rect})=>({key,top:rect.top}));
 return {x:win.scrollX,y:win.scrollY,anchors};
}
export function restoreReadingPosition(container,position) {
 const elements=new Map([...container.querySelectorAll(readingSelector)].map(element=>[readingKey(element),element]));
 const win=container.ownerDocument.defaultView;
 let targetY=position.y;
 for(const anchor of position.anchors){
  const rect=elements.get(anchor.key)?.getBoundingClientRect();
  if(rect?.height>0){targetY=win.scrollY+rect.top-anchor.top;break;}
 }
 win.scrollTo(position.x,targetY);
}

// Only rendered, escaped HTML from the authenticated local endpoint enters this container.
export function replaceView(container,html,{preserve=true}={}) {
 const doc=container.ownerDocument,win=doc.defaultView,selection=win.getSelection();
 if(selection&&!selection.isCollapsed&&container.contains(selection.anchorNode))return false;
 const parsed=new win.DOMParser().parseFromString(html,'text/html');
 if(!parsed.body.querySelector('main'))throw new Error('Invalid dashboard response');
 const focused=container.contains(doc.activeElement),focusKey=focused?interactionKey(doc.activeElement):null;
 const open=preserve?new Map([...container.querySelectorAll('details[data-live-key]')].map(el=>[el.dataset.liveKey,el.open])):new Map();
 const filter=preserve?container.querySelector('input[name="task-filter"]:checked')?.value:null;
 const position=preserve?captureReadingPosition(container):null;
 container.replaceChildren(...parsed.body.childNodes);
 for(const el of container.querySelectorAll('details[data-live-key]'))if(open.has(el.dataset.liveKey))el.open=open.get(el.dataset.liveKey);
 if(filter)for(const el of container.querySelectorAll('input[name="task-filter"]'))el.checked=el.value===filter;
 if(focused){
  const target=[...container.querySelectorAll('a,button,input,summary,[tabindex]')].find(el=>interactionKey(el)===focusKey)??container.querySelector('main');
  if(!target.hasAttribute('tabindex')&&target.tagName==='MAIN')target.tabIndex=-1;
  target.focus({preventScroll:true});
 }
 if(position)restoreReadingPosition(container,position);
 doc.title=parsed.title;return true;
}

export function bootDashboard(doc=globalThis.document) {
 const win=doc.defaultView,container=doc.getElementById('live-view'),status=doc.getElementById('live-status'),checked=doc.getElementById('live-checked');
 const pause=doc.getElementById('live-pause'),refresh=doc.getElementById('live-refresh'),round=doc.getElementById('live-round');
 const tokenKey='team-runtime-launcher',fragment=new URLSearchParams(win.location.hash.slice(1));
 let token=fragment.get('token'),viewId=null,viewRound=null,hasView=false,paused=false,activeTab=0;
 try{if(token)win.sessionStorage.setItem(tokenKey,token);else token=win.sessionStorage.getItem(tokenKey);}catch{/* Memory-only credentials still work when storage is disabled. */}
 if(fragment.has('token'))win.history.replaceState(null,'',win.location.pathname+win.location.search);
 const messages={checking:'正在读取团队记录…',synced:'自动同步已开启 · 更新团队记录，非 Agent 实时遥测',paused:'自动更新已暂停 · 可手动刷新',hidden:'页面已隐藏 · 自动请求已停止',deferred:'发现更新 · 结束文字选择后显示',unavailable:'无法同步 · 保留上次成功视图；请检查本机服务、状态文件或 Registry，稍后自动重试',unauthorized:'连接凭据无效 · 请重新打开服务启动时给出的完整链接'};
 const showStatus=value=>{
  refresh.disabled=value==='checking';
  if(value==='checking'&&hasView)return;
  const message=value==='unavailable'&&!hasView?'无法读取团队记录 · 请检查本机服务、状态文件或 Registry，稍后自动重试':messages[value];
  if(status.textContent!==message)status.textContent=message;
  status.dataset.state=value;
 };
 const poller=createPoller({
  visible:()=>doc.visibilityState!=='hidden'&&activeTab===0,
  request:async({signal})=>{
   const query=round.value?`?round=${encodeURIComponent(round.value)}`:'';
   const headers={Authorization:`Bearer ${token??''}`};if(viewId&&viewRound===round.value)headers['If-None-Match']=`"${viewId}"`;
   const response=await win.fetch(`/api/view${query}`,{headers,signal,cache:'no-store',credentials:'omit'});
   if(response.status===304)return {unchanged:true,checkedAt:response.headers.get('x-checked-at')};
   if(!response.ok)throw Object.assign(new Error('Unable to read records'),{status:response.status});
   return response.json();
  },
  onData:data=>{
   if(!data.unchanged){
    doc.getElementById('portal-team').textContent=data.teamId;
    const scope=data.roundId??'';
    if(!replaceView(container,data.html,{preserve:hasView&&scope===viewRound}))return false;
    const options=[new win.Option('全部轮次',''),...data.rounds.map(item=>new win.Option(`${item.title}${item.status==='closed'?' · 已关闭':''}`,item.id))];
    round.replaceChildren(...options);round.value=scope;viewId=data.snapshotId;viewRound=scope;hasView=true;
   }
   checked.textContent=`最近成功核对：${data.checkedAt?.replace('T',' ').replace('Z',' UTC')??'未知'}。页面可见时每 5 秒检查；隐藏或暂停后停止请求。`;
   return true;
  },onStatus:showStatus
 });
 const metricsStatus=doc.getElementById('metrics-status'),metricsRefresh=doc.getElementById('metrics-refresh');
 const metricsRoot=doc.getElementById('metrics-view').attachShadow({mode:'open'});
 metricsRoot.append(doc.getElementById('metrics-template').content.cloneNode(true));
 let metricsAbort=null,metricsLoaded=false,timelineAbort=null,selectedTimelineTask=null,activeMetricTab=0,timelineMode='snapshot';
 const metricsOverview=metricsRoot.getElementById('metrics-overview');
 const tokenReport=metricsRoot.getElementById('token-report'),mcpReport=metricsRoot.getElementById('mcp-report');
 const timelineStatus=metricsRoot.getElementById('timeline-status'),timelineView=metricsRoot.getElementById('timeline-view');
 const timelineSelect=metricsRoot.getElementById('timeline-task');
 const timelineUpdate=metricsRoot.getElementById('timeline-update');
 const cancelMetrics=()=>{metricsAbort?.abort();metricsAbort=null;};
 const cancelTimeline=()=>{timelineAbort?.abort();timelineAbort=null;timelineUpdate.disabled=false;};
 const loadTimeline=async()=>{
  if(!token||doc.visibilityState==='hidden'||activeTab!==1||activeMetricTab!==2)return;
  timelineAbort?.abort();const controller=new AbortController();timelineAbort=controller;
  const refreshState=timelineMode==='state';timelineUpdate.disabled=true;
  const timeout=win.setTimeout(()=>controller.abort(),15000);
  timelineView.replaceChildren();timelineStatus.textContent=refreshState?'正在按最新台账更新阶段数据…':'正在读取所选任务历史报告…';
  try{
   const params=new URLSearchParams();if(selectedTimelineTask!==null)params.set('task',selectedTimelineTask);if(refreshState)params.set('refresh','state');
   const query=params.size?'?'+params.toString():'';
   const response=await win.fetch(`/api/timeline${query}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal,cache:'no-store',credentials:'omit'});
   if(!response.ok)throw new Error('timeline_unavailable');
   const data=await response.json();if(controller.signal.aborted||timelineAbort!==controller)return;
   doc.getElementById('portal-team').textContent=data.teamId;
   selectedTimelineTask=data.taskId??selectedTimelineTask;
   timelineSelect.replaceChildren(new win.Option('请选择任务',''),...(data.tasks??[]).map(t=>new win.Option(`${t.title??t.id} · ${t.id}${(t.reportConfigured??t.available)?'':' · 未绑定历史报告'}`,t.id)));
   timelineSelect.value=selectedTimelineTask??'';
   const warning=data.unavailableReports?` ${data.unavailableReports} 份绑定报告不可用，请核对文件和任务身份。`:'';
   if(['not_configured','task_not_configured','report_unavailable'].includes(data.status)){
    timelineStatus.textContent=`${selectedTimelineTask?'任务 '+selectedTimelineTask:'团队'}${data.status==='report_unavailable'?'历史报告读取失败':'未绑定历史报告'}。可点击「更新阶段数据」查看最新台账；不等于零耗时，不会显示其他任务的数据。${warning}`;return;
   }
   if(data.status!=='ready'||typeof data.html!=='string')throw new Error('invalid_timeline');
   const parsed=new win.DOMParser().parseFromString(data.html,'text/html');
   timelineView.replaceChildren(...Array.from(parsed.body.childNodes).map(node=>doc.importNode(node,true)));
   timelineStatus.textContent=`任务 ${data.taskId} · ${data.stageData?.mode==='refreshed-state'?'阶段已按最新台账更新，工具观测未重采集':data.stale?'业务状态已有更新，显示历史报告':'历史报告 · 部分覆盖，非实时遥测'} · 本次读取 ${data.checkedAt??'时间未知'}。${warning}`;
  }catch{
   if(timelineAbort===controller)timelineStatus.textContent=(refreshState?'阶段数据更新失败':'历史报告读取失败')+'：请核对数据源、报告与团队身份；未展示新的数据，不影响任务执行。';
  }finally{win.clearTimeout(timeout);if(timelineAbort===controller){timelineAbort=null;timelineUpdate.disabled=false;}}
 };
 timelineUpdate.addEventListener('click',()=>{timelineMode='state';void loadTimeline();});
 timelineSelect.addEventListener('change',()=>{selectedTimelineTask=timelineSelect.value||null;void loadTimeline();});
 container.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-timeline-task]');if(!button)return;
  selectedTimelineTask=button.dataset.timelineTask;metricsRoot.getElementById('timeline-tab').click();doc.getElementById('metrics-tab').click();timelineSelect.focus();
 });
 const loadMetrics=async()=>{
  if(metricsAbort||!token||doc.visibilityState==='hidden'||activeTab!==1||activeMetricTab===2)return;
  const controller=new AbortController();metricsAbort=controller;
  const timeout=win.setTimeout(()=>controller.abort(),15000);
  metricsStatus.textContent='正在核对团队并读取指标报告…';
  try{
   const response=await win.fetch('/api/metrics',{headers:{Authorization:`Bearer ${token}`},signal:controller.signal,cache:'no-store',credentials:'omit'});
   if(!response.ok)throw new Error('metrics_unavailable');
   const data=await response.json();if(controller.signal.aborted||metricsAbort!==controller)return;
   doc.getElementById('portal-team').textContent=data.teamId;
   if(data.status==='not_configured'){
    metricsOverview.replaceChildren();tokenReport.textContent='Token 日报未绑定；未采集不等于 0。';mcpReport.textContent='MCP 日报未绑定；未采集不等于 0。';metricsStatus.textContent='指标未接入：启动团队工作台时使用 --metrics-report 绑定本团队的 metrics-daily-export report.json。未采集不等于 0；时间线可在独立 Tab 查看。';
    metricsLoaded=false;return;
   }
   const parsed=new win.DOMParser().parseFromString(data.html,'text/html');
   const main=parsed.querySelector('main'),tokenPanel=parsed.getElementById('token-panel'),mcpPanel=parsed.getElementById('mcp-panel');
   if(!main||!tokenPanel||!mcpPanel)throw new Error('invalid_metrics');
   const copy=nodes=>Array.from(nodes).map(node=>doc.importNode(node,true));
   const overview=Array.from(main.children).filter(node=>node!==tokenPanel&&node!==mcpPanel&&node.getAttribute('role')!=='tablist');
   metricsOverview.replaceChildren(...copy(overview));
   tokenReport.replaceChildren(...copy(tokenPanel.childNodes));mcpReport.replaceChildren(...copy(mcpPanel.childNodes));
   metricsStatus.textContent=`团队 ${data.teamId} · 数据截至 ${data.asOf} · ${data.from} — ${data.to} (${data.timeZone})。当前 ${data.currentMemberCount} 位成员中，${data.observedCurrentMembers} 位有用量记录；覆盖完整性未核实。${data.missingMemberIds.length?'无用量记录：'+data.missingMemberIds.join('、')+'。':''}重新读取只加载文件，不生成新统计。`;
   metricsLoaded=true;
  }catch{
   if(metricsAbort===controller)metricsStatus.textContent='指标报告不可用：请核对连接凭据、报告格式及团队身份。'+(metricsLoaded?'以下保留上次成功读取的历史快照，当前读取失败。':'未展示任何统计数据。');
  }finally{win.clearTimeout(timeout);if(metricsAbort===controller)metricsAbort=null;}
 };
 const loadSelectedMetric=()=>{
  if(!token){(activeMetricTab===2?timelineStatus:metricsStatus).textContent='连接凭据无效，请重新打开服务给出的完整链接。';return;}
  if(activeMetricTab===2)void loadTimeline();else void loadMetrics();
 };
 setupDailyTabs(metricsRoot,index=>{
  activeMetricTab=index;const timeline=index===2;
  metricsOverview.hidden=timeline;metricsStatus.hidden=timeline;
  metricsRefresh.textContent=timeline?'重新读取历史报告':'重新读取报告';
  if(timeline)cancelMetrics();else cancelTimeline();
  if(activeTab===1)loadSelectedMetric();
 });
 setupDailyTabs(doc,index=>{activeTab=index;void poller.visibilityChanged();if(index===1)loadSelectedMetric();else {cancelMetrics();cancelTimeline();}});
 metricsRefresh.addEventListener('click',()=>{if(activeMetricTab===2)timelineMode='snapshot';loadSelectedMetric();});
 // Fragment links inside Shadow DOM need explicit local targeting.
 metricsRoot.addEventListener('click',event=>{const link=event.target.closest?.('a[href^="#"]');if(!link)return;const target=metricsRoot.getElementById(link.getAttribute('href').slice(1));if(target){event.preventDefault();if(target.tagName==='DETAILS')target.open=true;target.scrollIntoView({block:'start'});}});
 pause.addEventListener('click',()=>{paused=!paused;pause.textContent=paused?'恢复更新':'暂停更新';pause.setAttribute('aria-pressed',String(paused));if(paused)poller.pause();else void poller.resume();});
 refresh.addEventListener('click',()=>{void poller.refresh();});
 round.addEventListener('change',()=>{void poller.refresh({replace:true});});
 doc.addEventListener('visibilitychange',()=>{void poller.visibilityChanged();if(doc.visibilityState==='hidden'){cancelMetrics();cancelTimeline();}else if(activeTab===1)loadSelectedMetric();});
 win.addEventListener('pagehide',()=>{poller.stop();cancelMetrics();cancelTimeline();});
 win.addEventListener('pageshow',event=>{if(event.persisted)void poller.start();});
 if(!token){showStatus('unauthorized');return poller;}
 void poller.start();return poller;
}

if(typeof document!=='undefined'&&document.getElementById('live-view'))bootDashboard();
