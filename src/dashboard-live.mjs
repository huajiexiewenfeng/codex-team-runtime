import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readState} from './store.mjs';
import {snapshot} from './runtime.mjs';
import {render} from './render.mjs';
import {dashboardStyles} from './dashboard-styles.mjs';

const shell=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team Runtime · 最新工作台</title><link rel="stylesheet" href="/dashboard.css"><script type="module" src="/dashboard-client.mjs"></script></head><body>
<section class="live-controls" aria-label="记录同步控制">
 <div class="live-heading"><strong>最新工作台 <span class="pill neutral">只读</span></strong><span id="live-status" role="status" aria-atomic="true">正在连接本机记录服务…</span></div>
 <div class="live-actions"><label for="live-round">工作轮次</label><select id="live-round"><option value="">全部轮次</option></select><button id="live-pause" type="button" aria-pressed="false">暂停更新</button><button id="live-refresh" type="button">立即刷新</button></div>
 <p id="live-checked" class="source">尚未读取记录。页面可见时每 5 秒检查；隐藏或暂停后停止请求。</p>
</section><div id="live-view"><div class="live-placeholder"><h1>等待团队记录</h1><p>此服务仅更新展示，不派工、不验收、不唤醒 Agent。</p></div></div>
<noscript><p class="live-placeholder">最新工作台需要 JavaScript。仍可用 dashboard 命令导出无需脚本的离线快照。</p></noscript></body></html>`;
const styles=dashboardStyles+`
.live-controls{max-width:1600px;margin:0 auto;padding:16px 24px;border-bottom:1px solid var(--line);background:var(--surface)}
.live-heading,.live-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.live-heading{justify-content:space-between}.live-heading>strong{font-size:15px}.live-heading .pill{margin-left:8px}
#live-status{font-size:13px;color:var(--accent);overflow-wrap:anywhere}#live-status[data-state="unavailable"],#live-status[data-state="unauthorized"]{color:var(--amber)}
.live-actions{margin-top:12px;font-size:13px}.live-actions select{min-width:0;max-width:100%;flex:1 1 220px;font:inherit;min-height:44px;padding:8px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px}
.live-actions button{min-height:44px;padding:8px 14px;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:8px;cursor:pointer}.live-actions button:hover{background:var(--bg)}.live-actions button:disabled{cursor:wait;color:var(--muted);border-color:var(--line);background:var(--bg)}
.live-actions select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.live-placeholder{max-width:900px;margin:48px auto;padding:24px}.live-controls .source{margin:8px 0 0}
@media(max-width:760px){.live-controls{padding:16px}.live-actions label{flex-basis:100%}.live-actions select{flex-basis:100%}}
@media print{.live-actions{display:none}}
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
export async function startDashboardServer({statePath,port=4319,codexLinks=false,read=readState,now=Date.now,cacheMs=1000}={}) {
 if(typeof statePath!=='string'||!statePath.trim())throw new Error('dashboard-serve requires a state path');
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid dashboard port');
 if(typeof codexLinks!=='boolean'||!Number.isFinite(cacheMs)||cacheMs<0||cacheMs>1000)throw new Error('Invalid dashboard options');
 const path=resolve(statePath),token=randomBytes(32).toString('hex'),credential=Buffer.from(`Bearer ${token}`);
 const client=await readFile(new URL('./dashboard-client.mjs',import.meta.url),'utf8');
 let origin,host,cached,readAt=0,inflight=null,teamId=null,closed=false;
 const current=async()=>{
  if(cached&&now()-readAt>=0&&now()-readAt<cacheMs)return cached;
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
  if(url.pathname==='/api/view') {
   if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return error(403,'foreign_site');
   const supplied=Buffer.from(req.headers.authorization??'');
   if(supplied.length!==credential.length||!timingSafeEqual(supplied,credential))return error(401,'launcher_credential_required');
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
    return send(200,JSON.stringify({snapshotId:view.snapshotId,sourceVersion:view.sourceVersion,registryRevision:view.registry?.teamRevision??null,asOf:view.asOf,checkedAt,roundId,rounds:state.rounds.map(({id,title,status})=>({id,title,status})),html:render(view,{live:true,codexLinks})}),undefined,headers);
   }catch{return error(503,'source_unavailable');}
  }
  if(url.search)return error(400,'invalid_query');
  if(url.pathname==='/')return send(200,shell,'text/html; charset=utf-8');
  if(url.pathname==='/dashboard.css')return send(200,styles,'text/css; charset=utf-8');
  if(url.pathname==='/dashboard-client.mjs')return send(200,client,'text/javascript; charset=utf-8');
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
