import {createServer} from 'node:http';import {request} from 'node:http';import {readFile,mkdir,open,unlink,realpath} from 'node:fs/promises';import {join,resolve,isAbsolute} from 'node:path';import {randomUUID,randomBytes,createHash} from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {atomicWrite} from './store.mjs';import {loadWatchdogDeployment} from './watchdog-deployment.mjs';import {startWatchdogService} from './watchdog-runtime.mjs';
const need=(v,s)=>{if(!v)throw new Error(s);},sha=b=>createHash('sha256').update(b).digest('hex');
async function rootPaths(root){need(typeof root==='string'&&isAbsolute(root),'Explicit absolute control root required');const path=resolve(root);await mkdir(path,{recursive:true});need(await realpath(path)===path,'Redirected control root rejected');return {root:path,descriptor:join(path,'control.json'),lease:join(path,'service.lock')};}
const summary=d=>({phase:d.phase,pid:d.pid,ownerNonce:d.ownerNonce,startedAt:d.startedAt,manifestPath:d.manifestPath,manifestSha256:d.manifestSha256,teams:d.teams??[],lastErrorCode:d.lastErrorCode??null});
export async function startWatchdogControlService({manifestPath,controlRoot,ownerNonce=randomUUID()}){
 const p=await rootPaths(controlRoot),manifest=await realpath(manifestPath),bytes=await readFile(manifest),lease=await open(p.lease,'wx'),controller=new AbortController();
 const d={schemaVersion:1,kind:'watchdog-local-control',phase:'starting',pid:process.pid,ownerNonce,token:randomBytes(32).toString('hex'),startedAt:new Date().toISOString(),manifestPath:manifest,manifestSha256:sha(bytes),teams:[]};
 await lease.writeFile(JSON.stringify({pid:d.pid,ownerNonce,startedAt:d.startedAt})+'\n');await lease.sync();
 let service=null,servicePromise=null,stopPromise=null,closed=false;
 const write=()=>atomicWrite(p.descriptor,JSON.stringify(d,null,2)+'\n');
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${d.token}`||req.headers['x-watchdog-owner']!==d.ownerNonce){res.writeHead(403);res.end('denied');return;}
  if(req.method==='GET'&&req.url==='/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify(summary(d)));return;}
  if(req.method==='POST'&&req.url==='/stop'){
   try{await stop(false);res.setHeader('content-type','application/json');res.end(JSON.stringify(summary(d)));server.close();}catch{res.writeHead(500);res.end('stop-failed');}return;
  }
  res.writeHead(404);res.end();
 });
 async function stop(closeHttp=true){
  if(!stopPromise)stopPromise=(async()=>{d.phase='stopping';await write();controller.abort(new Error('Watchdog controlled stop'));if(servicePromise)await servicePromise.catch(()=>{});if(service)await service.close();d.phase='stopped';await write();await lease.close();const owner=JSON.parse(await readFile(p.lease,'utf8'));need(owner.ownerNonce===d.ownerNonce,'Control lease ownership changed');await unlink(p.lease);closed=true;})();
  await stopPromise;if(closeHttp&&server.listening)await new Promise((r,j)=>server.close(e=>e?j(e):r()));
 }
 try{
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});d.port=server.address().port;await write();
  servicePromise=(async()=>{
   const deployment=await loadWatchdogDeployment(manifest,{signal:controller.signal});
   need(deployment.manifestSha256===d.manifestSha256,'Manifest changed during background startup');
   need(deployment.requireCutover===true,'Background service requires formal production manifest with cutover');
   d.teams=deployment.registrations.map(x=>({...x,status:'initializing'}));await write();
   service=await startWatchdogService(deployment.statePaths,{deployment,readOptions:deployment.readOptions,onCheck:s=>{
    const row=d.teams.find(t=>t.statePath===s.statePath);if(row)Object.assign(row,{status:s.phase,capabilityState:deployment.adapterFor(s.statePath)?.validationStatus().status??'observe-only',enabled:s.enabled,lastCheckedAt:s.lastCheckedAt,lastFault:s.lastFault,cutover:s.cutover??null,counters:s.counters,pendingReason:s.deliveryReason??null,pending:s.anomalies.filter(a=>a.active&&a.delivery==='pending').length,unresolved:s.attempts.filter(a=>['unknown','queued','consumed','intent'].includes(a.outcome)).length});
    console.log(JSON.stringify({event:'team-check',teamId:s.teamId,phase:s.phase,mode:row?.mode??'unknown',fault:s.lastFault?.code??null,pending:row?.pending??0}));
   }});
   if(!controller.signal.aborted){d.phase='running';await write();}
  })();
  await servicePromise;
 }catch(error){d.lastErrorCode='SERVICE_INITIALIZATION_FAILED';console.error(JSON.stringify({event:'service-error',code:d.lastErrorCode}));await stop();throw error;}
 return {status:()=>summary(d),close:()=>stop(),get closed(){return closed;}};
}
async function sendControl(d,method,path){
 need(d.schemaVersion===1&&d.kind==='watchdog-local-control'&&Number.isSafeInteger(d.port)&&d.port>0&&typeof d.token==='string'&&typeof d.ownerNonce==='string','Invalid control descriptor');
 return new Promise((r,j)=>{const req=request({host:'127.0.0.1',port:d.port,path,method,headers:{authorization:`Bearer ${d.token}`,'x-watchdog-owner':d.ownerNonce},timeout:30000},res=>{let text='';res.on('data',chunk=>{text+=chunk;if(text.length>262144)req.destroy(new Error('Control response too large'));});res.on('end',()=>{try{need(res.statusCode===200,'Control endpoint rejected owner');const out=JSON.parse(text);need(out.ownerNonce===d.ownerNonce&&out.pid===d.pid,'Control process identity mismatch');r(out);}catch(e){j(e);}});});req.on('error',j);req.on('timeout',()=>req.destroy(new Error('Control timeout')));req.end();});
}
export async function watchdogBackgroundStatus(controlRoot){const p=await rootPaths(controlRoot);let d;try{d=JSON.parse(await readFile(p.descriptor,'utf8'));}catch(e){if(e.code==='ENOENT')return {phase:'not-started',teams:[]};throw e;}if(d.phase==='stopped')return summary(d);try{return await sendControl(d,'GET','/status');}catch{return {...summary(d),phase:'unreachable-unknown',identityConfirmed:false};}}
export async function stopWatchdogBackground(controlRoot){const p=await rootPaths(controlRoot),d=JSON.parse(await readFile(p.descriptor,'utf8'));if(d.phase==='stopped')return summary(d);return sendControl(d,'POST','/stop');}
export function watchdogBackgroundLaunchSpec(manifestPath,controlRoot,ownerNonce){return {executable:process.execPath,args:[fileURLToPath(new URL('./watchdog-background-worker.mjs',import.meta.url)),manifestPath,controlRoot,ownerNonce],options:{windowsHide:true,detached:true}};}
export async function startWatchdogBackground({manifestPath,controlRoot}){
 const p=await rootPaths(controlRoot),manifest=await realpath(manifestPath),current=await watchdogBackgroundStatus(p.root);
 if(['running','starting'].includes(current.phase)){need(current.manifestPath===manifest&&current.manifestSha256===sha(await readFile(manifest)),'Existing background manifest path/hash changed; stop explicitly before restart');return current;}
 try{await readFile(p.lease);throw new Error('Existing control lease; do not steal or kill any process');}catch(e){if(e.code!=='ENOENT')throw e;}
 const launch=await open(join(p.root,'launch.lock'),'wx');let out,err;
 try{
  const nonce=randomUUID(),spec=watchdogBackgroundLaunchSpec(manifest,p.root,nonce);out=await open(join(p.root,'stdout.log'),'a');err=await open(join(p.root,'stderr.log'),'a');
  const child=spawn(spec.executable,spec.args,{...spec.options,stdio:['ignore',out.fd,err.fd]});await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j);});child.unref();
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));const s=await watchdogBackgroundStatus(p.root);if(s.ownerNonce===nonce&&s.phase!=='not-started')return s;}
  return {phase:'starting-unconfirmed',pid:child.pid,ownerNonce:nonce,manifestPath:manifest};
 }finally{if(out)await out.close();if(err)await err.close();await launch.close();await unlink(join(p.root,'launch.lock'));}
}
