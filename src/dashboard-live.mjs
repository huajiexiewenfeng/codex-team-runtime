import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readState} from './store.mjs';
import {snapshot} from './runtime.mjs';
import {render} from './render.mjs';
import {dashboardStyles} from './dashboard-styles.mjs';
import {dailyMetricsStyles} from './metrics-daily-export.mjs';
import {readDashboardMetrics} from './dashboard-metrics.mjs';
import {readDashboardTimelines,timelineStyles} from './dashboard-timeline.mjs';
import {readIndexedTimeline} from './dashboard-timeline-index.mjs';
import {loadDashboardTimelineReport} from './dashboard-timeline.mjs';

const shell=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team Runtime · 最新工作台</title><link rel="stylesheet" href="/dashboard.css"><script type="module" src="/dashboard-client.mjs"></script></head><body>
<header class="portal-header"><div class="brand"><span class="brand-mark" aria-hidden="true">tr</span>codex team runtime <span class="pill neutral">只读团队工作台</span></div><span id="portal-team" class="mono">等待团队连接</span></header>
<div class="portal-tabs" role="tablist" aria-label="团队工作台"><button type="button" id="work-tab" role="tab" aria-controls="work-panel" aria-selected="true" tabindex="0">任务进度</button><button type="button" id="metrics-tab" role="tab" aria-controls="metrics-panel" aria-selected="false" tabindex="-1">指标统计</button></div>
<section id="work-panel" role="tabpanel" aria-labelledby="work-tab">
<section class="live-controls" aria-label="记录同步控制">
 <div class="live-heading"><span id="live-status" role="status" aria-atomic="true">正在连接本机记录服务…</span></div>
 <div class="live-actions"><label for="live-round">工作轮次</label><select id="live-round"><option value="">全部轮次</option></select><button id="live-pause" type="button" aria-pressed="false">暂停更新</button><button id="live-refresh" type="button">立即刷新</button></div>
 <p id="live-checked" class="source">尚未读取记录。页面可见时每 5 秒检查；隐藏或暂停后停止请求。</p>
</section><div id="live-view"><div class="live-placeholder"><h1>等待团队记录</h1><p>此服务仅更新展示，不派工、不验收、不唤醒 Agent。</p></div></div>
</section><section id="metrics-panel" role="tabpanel" aria-labelledby="metrics-tab" hidden><div class="metrics-controls"><div><h1>指标统计</h1><p class="source">日报与任务时间线快照 · 与任务轮次筛选独立 · 不会自动采集日志</p></div><button id="metrics-refresh" type="button">重新读取报告</button></div><p id="metrics-status" role="status" class="metrics-status">选择指标统计后读取已绑定报告。</p><div id="metrics-view"></div></section>
<template id="metrics-template"><link rel="stylesheet" href="/metrics.css"><main>
<div class="tabs" role="tablist" aria-label="指标视图"><button type="button" id="token-tab" role="tab" aria-controls="token-panel" aria-selected="true" tabindex="0">Token 使用量</button><button type="button" id="mcp-tab" role="tab" aria-controls="mcp-panel" aria-selected="false" tabindex="-1">MCP 调用情况</button><button type="button" id="timeline-tab" role="tab" aria-controls="timeline-panel" aria-selected="false" tabindex="-1">任务时间线</button></div>
<div id="metrics-overview"></div>
<section id="token-panel" role="tabpanel" aria-labelledby="token-tab"><div id="token-report">尚未读取 Token 报告。</div></section>
<section id="mcp-panel" role="tabpanel" aria-labelledby="mcp-tab" hidden><div id="mcp-report">尚未读取 MCP 报告。</div></section>
<section id="timeline-panel" role="tabpanel" aria-labelledby="timeline-tab" hidden><label for="timeline-task">选择任务 </label><div class="timeline-actions"><select id="timeline-task"><option value="">请选择任务</option></select><button type="button" id="timeline-update">更新阶段数据</button></div><p class="meta">更新阶段数据：按最新台账重建本次展示，不覆盖历史报告、不采集日志。上方「重新读取历史报告」读取原快照，Token/MCP 与工具采样不会因此更新。</p><p id="timeline-status" role="status">选择任务时间线后读取已绑定报告；不会采集日志。</p><div id="timeline-view"></div></section>
</main></template>
<noscript><p class="live-placeholder">最新工作台需要 JavaScript。仍可用 dashboard 命令导出无需脚本的离线快照。</p></noscript></body></html>`;
const styles=dashboardStyles+timelineStyles+`
.timeline-open,#timeline-task{min-height:44px;max-width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}.timeline-open{cursor:pointer}.timeline-open:focus-visible,#timeline-task:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
.portal-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:16px 32px;background:var(--surface);border-bottom:1px solid var(--line)}
.portal-tabs{display:flex;gap:8px;padding:0 32px;background:var(--surface);border-bottom:1px solid var(--line)}
.portal-tabs button{min-height:48px;padding:10px 20px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);cursor:pointer;font:inherit;font-weight:600}
.portal-tabs button[aria-selected="true"]{border-bottom-color:var(--accent);color:var(--accent)}.portal-tabs button:hover{background:var(--accent-soft)}
#metrics-panel{max-width:1600px;margin:auto;padding:24px 32px}.metrics-controls{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.metrics-controls h1{font-size:24px}.metrics-controls button{font:inherit;min-height:44px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--accent);cursor:pointer}.metrics-status{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
#live-view .layout{grid-template-columns:148px minmax(0,1fr)}#live-view main{padding:20px 24px}#live-view .rail{padding:20px 8px}#live-view .rail-note{margin-top:24px}
#live-view .heading{margin:0 0 16px}#live-view .heading h1{font-size:26px}#live-view .eyebrow{font-size:11px}
#live-view #overview{display:flex;flex-direction:column}#live-view .source-banner{order:3;margin:0 0 16px;background:transparent;border:0;padding:0}#live-view .source-banner span{display:inline;margin-left:8px}
#live-view .metrics{margin-bottom:12px;padding:16px 0}#live-view .round-timing{order:2;margin:0 0 12px;padding:0 12px}#live-view .metric>strong{font-size:30px}
#live-view .task{padding:16px 20px 0}#live-view .task-description{margin:10px 0}#live-view .columns{gap:20px}
.live-controls{max-width:1600px;margin:0 auto;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--surface);display:flex;align-items:center;flex-wrap:wrap;gap:4px 20px}.live-heading{order:2;flex:1 1 340px}.live-controls .live-actions{margin-top:0;flex:1 1 540px}.live-controls #live-checked{flex-basis:100%;margin:0}
.live-heading,.live-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.live-heading{justify-content:space-between}.live-heading>strong{font-size:15px}.live-heading .pill{margin-left:8px}
#live-status{font-size:13px;color:var(--accent);overflow-wrap:anywhere}#live-status[data-state="unavailable"],#live-status[data-state="unauthorized"]{color:var(--amber)}
.live-actions{margin-top:12px;font-size:13px}.live-actions select{min-width:0;max-width:100%;flex:1 1 220px;font:inherit;min-height:44px;padding:8px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px}
.live-actions button{min-height:44px;padding:8px 14px;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:8px;cursor:pointer}.live-actions button:hover{background:var(--bg)}.live-actions button:disabled{cursor:wait;color:var(--muted);border-color:var(--line);background:var(--bg)}
.live-actions select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.live-placeholder{max-width:900px;margin:48px auto;padding:24px}.live-controls .source{margin:8px 0 0}
@media(max-width:760px){.live-controls{padding:16px}.live-actions label{flex-basis:100%}.live-actions select{flex-basis:100%}}
@media(max-width:1000px){#live-view .layout{grid-template-columns:1fr}#live-view .rail{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}#live-view .rail>.eyebrow,#live-view .rail-note{display:none}}
@media(max-width:760px){.portal-header,.portal-tabs{padding-left:16px;padding-right:16px}.portal-header .brand{flex-wrap:wrap}#metrics-panel,#live-view main{padding:16px}#live-view .columns{grid-template-columns:1fr}.live-controls .live-actions{flex-basis:100%}.live-actions label{flex-basis:auto}.live-actions select{flex-basis:160px}#live-view .heading{gap:12px;flex-wrap:wrap}}
@media print{.live-actions{display:none}}
.live-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,340px);gap:4px 20px}.live-controls .live-actions{grid-column:1;grid-row:1}.live-controls .live-heading{order:0;grid-column:2;grid-row:1}.live-controls #live-checked{grid-column:1/-1;grid-row:2}
@media(max-width:1000px){.live-controls{grid-template-columns:1fr}.live-controls .live-heading{grid-column:1;grid-row:3}.live-controls #live-checked{grid-row:2}}
`;
const metricsStyles=dailyMetricsStyles+timelineStyles+`
.tabs{flex-wrap:wrap}.tabs [role="tab"]{min-height:44px}#timeline-task{font:inherit;min-height:44px;max-width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}#timeline-task:focus-visible{outline:3px solid var(--accent);outline-offset:2px}#timeline-status{color:var(--muted);overflow-wrap:anywhere}#timeline-panel{min-width:0}
.timeline-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.timeline-actions select{flex:1;min-width:0}#timeline-update{font:inherit;min-height:44px;padding:8px 12px;border:1px solid var(--accent);border-radius:8px;color:var(--accent);background:var(--surface);cursor:pointer}#timeline-update:focus-visible{outline:3px solid var(--accent);outline-offset:2px}#timeline-update:disabled{cursor:wait;opacity:.6}@media(max-width:520px){.timeline-actions select{flex-basis:100%}}
`;
const securityHeaders={
 'Cache-Control':'no-store',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',
 'Cross-Origin-Resource-Policy':'same-origin',
 'X-Frame-Options':'DENY'
};

// Dependencies are programmatic test seams, never accepted through HTTP or request JSON.
export async function startDashboardServer({statePath,metricsReportPath=null,timelineReportPath=null,timelineIndexPath=null,port=4319,codexLinks=false,read=readState,now=Date.now,cacheMs=1000}={}) {
 if(typeof statePath!=='string'||!statePath.trim())throw new Error('dashboard-serve requires a state path');
 if(metricsReportPath!==null&&(typeof metricsReportPath!=='string'||!metricsReportPath.trim()))throw new Error('Invalid metrics report path');
 const metricsPath=metricsReportPath===null?null:resolve(metricsReportPath);
 if(timelineIndexPath!==null&&(typeof timelineIndexPath!=='string'||!timelineIndexPath.trim()||timelineReportPath!==null))throw new Error('Invalid or conflicting timeline index');
 const indexPath=timelineIndexPath===null?null:resolve(timelineIndexPath);
 const bindings=timelineReportPath===null?[]:Array.isArray(timelineReportPath)?timelineReportPath:[timelineReportPath];
 if(bindings.length>32||bindings.some(p=>typeof p!=='string'||!p.trim()))throw new Error('Invalid timeline report path');
 const timelinePaths=bindings.map(p=>resolve(p));
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid dashboard port');
 if(typeof codexLinks!=='boolean'||!Number.isFinite(cacheMs)||cacheMs<0||cacheMs>1000)throw new Error('Invalid dashboard options');
 const path=resolve(statePath),token=randomBytes(32).toString('hex'),credential=Buffer.from(`Bearer ${token}`);
 const client=await readFile(new URL('./dashboard-client.mjs',import.meta.url),'utf8');
 const tabsClient=await readFile(new URL('./metrics-daily-tabs.mjs',import.meta.url),'utf8');
 let origin,host,cached,readAt=0,inflight=null,teamId=null,closed=false;
 const current=async(force=false)=>{
  if(force&&inflight)await inflight;
  if(!force&&cached&&now()-readAt>=0&&now()-readAt<cacheMs)return cached;
  if(!inflight)inflight=(async()=>{
   const state=await read(path); // Includes current Registry projection; no fallback on error.
   if(teamId!==null&&state.team.id!==teamId)throw new Error('Team identity changed');
   teamId=state.team.id;cached=state;readAt=now();return state;
  })().catch(error=>{cached=null;throw error;}).finally(()=>{inflight=null;});
  return inflight;
 };
 const server=createServer(async(req,res)=>{
  const send=(status,body='',type='application/json; charset=utf-8',extra={})=>{
   if(res.destroyed)return;
   res.writeHead(status,{...securityHeaders,'Content-Type':type,...extra});res.end(body);
  };
  const error=(status,code)=>send(status,JSON.stringify({error:code}));
  if(req.headers.host!==host)return error(403,'forbidden_host');
  if(req.method!=='GET')return send(405,JSON.stringify({error:'read_only'}),undefined,{Allow:'GET'});
  if(req.headers.origin!==undefined&&req.headers.origin!==origin)return error(403,'foreign_origin');
  // Refuse absolute-form targets and ambiguous query parameters; there is no file browser.
  if(!req.url?.startsWith('/')||req.url.startsWith('//'))return error(400,'invalid_target');
  let url;try{url=new URL(req.url,origin);}catch{return error(400,'invalid_target');}
  if(['/api/view','/api/metrics','/api/timeline'].includes(url.pathname)) {
   if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return error(403,'foreign_site');
   const supplied=Buffer.from(req.headers.authorization??'');
   if(supplied.length!==credential.length||!timingSafeEqual(supplied,credential))return error(401,'launcher_credential_required');
   if(url.pathname==='/api/timeline') {
    if([...url.searchParams.keys()].some(key=>!['task','refresh'].includes(key))||url.searchParams.getAll('task').length>1||url.searchParams.getAll('refresh').length>1||(url.searchParams.has('refresh')&&url.searchParams.get('refresh')!=='state'))return error(400,'invalid_query');
    try{
     const refreshState=url.searchParams.get('refresh')==='state',state=await current(refreshState),task=url.searchParams.get('task');
     if(task!==null&&!state.tasks.some(t=>t.id===task))return error(400,'unknown_task');
     if(indexPath||!timelinePaths.length)return send(200,JSON.stringify(await readIndexedTimeline(indexPath,state,task,{refreshState,checkedAt:new Date(now()).toISOString()})));
     if(refreshState){
      // Legacy bounded path lists remain compatible; indexed configurations avoid this scan.
      const bindings=new Map();
      for(const path of timelinePaths){let report;try{report=await loadDashboardTimelineReport(path,state);}catch{continue;}
       if(bindings.has(report.taskId))throw Error('Duplicate timeline task');bindings.set(report.taskId,path);}
      return send(200,JSON.stringify(await readIndexedTimeline(null,state,task,{refreshState,checkedAt:new Date(now()).toISOString(),bindings})));
     }
     return send(200,JSON.stringify(await readDashboardTimelines(timelinePaths,state,task)));
    }
    catch{return error(503,'timeline_unavailable');}
   }
   if(url.pathname==='/api/metrics') {
    if(url.search)return error(400,'invalid_query');
    try{return send(200,JSON.stringify(await readDashboardMetrics(metricsPath,await current())));}
    catch{return error(503,'metrics_unavailable');}
   }
   if([...url.searchParams.keys()].some(key=>key!=='round')||url.searchParams.getAll('round').length>1)return error(400,'invalid_query');
   const roundId=url.searchParams.get('round')||null;
   try {
    const state=await current();
    if(roundId!==null&&!state.rounds.some(round=>round.id===roundId))return error(400,'unknown_round');
    const checkedAt=new Date(now()).toISOString();
    if(Date.parse(state.updatedAt)>now())throw new Error('Source is in the future');
    // Elapsed labels use minutes. Avoid replacing the DOM every five seconds on unchanged records.
    const asOf=new Date(Math.max(Math.floor(now()/60000)*60000,Date.parse(state.updatedAt))).toISOString();
    const view=snapshot(state,asOf,roundId),etag=`"${view.snapshotId}"`;
    const headers={ETag:etag,'X-Checked-At':checkedAt};
    if(req.headers['if-none-match']===etag)return send(304,'',undefined,headers);
    return send(200,JSON.stringify({teamId:state.team.id,snapshotId:view.snapshotId,sourceVersion:view.sourceVersion,registryRevision:view.registry?.teamRevision??null,asOf:view.asOf,checkedAt,roundId,rounds:state.rounds.map(({id,title,status})=>({id,title,status})),html:render(view,{live:true,embedded:true,codexLinks})}),undefined,headers);
   }catch{return error(503,'source_unavailable');}
  }
  if(url.search)return error(400,'invalid_query');
  if(url.pathname==='/')return send(200,shell,'text/html; charset=utf-8');
  if(url.pathname==='/dashboard.css')return send(200,styles,'text/css; charset=utf-8');
  if(url.pathname==='/dashboard-client.mjs')return send(200,client,'text/javascript; charset=utf-8');
  if(url.pathname==='/metrics-daily-tabs.mjs')return send(200,tabsClient,'text/javascript; charset=utf-8');
  if(url.pathname==='/metrics.css')return send(200,metricsStyles.replace(':root',':host')+'\nmain{max-width:none;padding:0}#metrics-overview>h1{display:none}','text/css; charset=utf-8');
  return error(404,'not_found');
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
 await new Promise((resolveStarted,reject)=>{
  server.once('error',reject);
  server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolveStarted();});
 });
 host=`127.0.0.1:${server.address().port}`;origin=`http://${host}`;
 return {origin,url:`${origin}/#token=${token}`,close:async()=>{
  if(closed)return;closed=true;
  const finished=new Promise((resolveClosed,reject)=>server.close(error=>error?reject(error):resolveClosed()));
  server.closeAllConnections();await finished;
 }};
}
