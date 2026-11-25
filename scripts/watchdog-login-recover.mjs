import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile), here=path.dirname(fileURLToPath(import.meta.url));
import {loadWatchdogDeployment} from '../src/watchdog-deployment.mjs';
export function options(args){const out={apply:false,noDelay:false};for(let i=0;i<args.length;i++){const k=args[i];if(k==='--apply')out.apply=true;else if(k==='--check')out.check=true;else if(k==='--no-delay')out.noDelay=true;else if(['--binding','--installation-sha256','--manifest','--manifest-sha256'].includes(k)){need(!out[k]&&args[i+1]&&!args[i+1].startsWith('--'),'Missing/duplicate '+k);out[k]=args[++i];}else throw Error('Unknown argument '+k);}need(!(out.apply&&out.check),'Conflicting mode');for(const k of ['--binding','--manifest'])need(typeof out[k]==='string'&&path.isAbsolute(out[k]),'Explicit absolute '+k+' required');for(const k of ['--installation-sha256','--manifest-sha256'])need(/^[a-f0-9]{64}$/.test(out[k]??''),'Pinned '+k+' required');return out;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms)), need=(v,m)=>{if(!v)throw Error(m);};
const sha=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
async function raw(p){try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function json(p){const b=await raw(p);return b===null?null:JSON.parse(b);}
async function canonical(p){need(same(await fs.realpath(p),p),'Redirected path');}
async function ps(code){let result;try{result=await run('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+code,'utf16le').toString('base64')],{windowsHide:true,timeout:20000});}catch{throw Error('Windows process/listener query failed; ownership unknown');}return result.stdout.trim();}
async function absent(pid){need(Number.isSafeInteger(pid)&&pid>0,'Invalid PID');need(await ps(`if (@(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').Count -eq 0) {'ABSENT'} else {'PRESENT'}`)==='ABSENT','PID present or unknown');}
async function deadPort(port){need(Number.isSafeInteger(port)&&port>0&&port<65536,'Invalid port');
 await new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port});s.setTimeout(3000);s.once('connect',()=>{s.destroy();reject(Error('Port reachable'));});s.once('timeout',()=>{s.destroy();reject(Error('Port unknown'));});s.once('error',e=>e.code==='ECONNREFUSED'?resolve():reject(Error('Port unknown')));});
 need(await ps(`if (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq ${port}).Count -eq 0) {'NO_LISTENER'} else {'LISTENER'}`)==='NO_LISTENER','Port listening or unknown');
}
async function status(d){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:d.port,path:'/status',headers:{authorization:`Bearer ${d.token}`,'x-watchdog-owner':d.ownerNonce},timeout:3000},r=>{let b='';r.on('data',x=>{b+=x;if(b.length>262144)req.destroy(Error('Response too large'));});r.on('end',()=>{try{need(r.statusCode===200,'Control rejected');const s=JSON.parse(b);need(s.pid===d.pid&&s.ownerNonce===d.ownerNonce&&s.startedAt===d.startedAt,'Control identity mismatch');resolve(s);}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Control timeout')));req.end();});}
export function descriptor(d,{manifest,trustedHash}){need(d&&d.kind==='watchdog-local-control'&&d.schemaVersion===1&&typeof d.ownerNonce==='string'&&d.ownerNonce.length>0&&Number.isFinite(Date.parse(d.startedAt)),'Invalid descriptor');need(same(d.manifestPath,manifest)&&d.manifestSha256===trustedHash,'Different deployment');}
async function transaction(p,expected=null,archive=null){
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'watchdog-login-transaction-guard.ps1'),'-LiteralPath',p];
 if(archive)args.push('-Action','Archive','-ExpectedBase64',Buffer.from(JSON.stringify(expected),'utf8').toString('base64'),'-ArchivePath',archive);
 try{const {stdout}=await run('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',args,{windowsHide:true,timeout:20000});return JSON.parse(stdout.trim());}catch{throw Error('Watchdog transaction ownership is not provably pre-boot and exclusive');}
}
async function inspect(rt,m,trust,ownLaunch=null){
 const {manifest,trustedHash}=trust;
 const c=rt.controlRoot,d=await json(path.join(c,'control.json'));if(d)descriptor(d,trust);
 const files=[path.join(c,'control.json'),path.join(c,'service.lock')];
 need(await raw(path.join(c,'launch.lock'))===ownLaunch,'Launch in progress or abandoned; manual review required');
 let live=null;if(d&&d.phase!=='stopped'){try{live=await status(d);}catch{}}
 if(live){need(['running','starting'].includes(live.phase),'Live service not ready');need(live.manifestSha256===trustedHash&&same(live.manifestPath,manifest),'Live deployment mismatch');return {healthy:true,d};}
 const lease=await json(files[1]);
 if(lease){need(d&&lease.pid===d.pid&&lease.ownerNonce===d.ownerNonce&&lease.startedAt===d.startedAt,'Control lease mismatch');await absent(d.pid);await deadPort(d.port);}
 else if(d){need(d.phase==='stopped','Missing control lock with non-stopped descriptor');await absent(d.pid);await deadPort(d.port);}
 const owners=[],transactions=[];for(const t of m.teams){const s=await fs.realpath(t.statePath),dir=s+'.watchdog';await canonical(dir);const lp=path.join(dir,'service.lock'),hp=path.join(dir,'heartbeat.json');files.push(lp,hp);const tx=path.join(dir,'transaction.lock');if(await raw(tx)!==null)transactions.push(tx);const l=await json(lp),h=await json(hp);
  if(!lease){need(!l&&!h,'Team ownership remains without control lock');continue;}
  need(l&&h&&typeof l.ownerToken==='string'&&l.ownerToken.length>0&&l.pid===d.pid&&h.pid===l.pid&&typeof l.ownerToken==='string'&&l.ownerToken.length>0&&l.ownerToken===h.ownerToken,'Team lease/heartbeat mismatch');
  need(Number.isFinite(Date.parse(l.startedAt))&&Date.parse(l.startedAt)>=Date.parse(d.startedAt)&&Date.parse(h.at)>=Date.parse(l.startedAt)&&Date.now()-Date.parse(h.at)>120000,'Team heartbeat not expired or invalid');await absent(l.pid);owners.push([l.ownerToken,l.startedAt]);
 }
 if(lease)need(new Set(owners.map(x=>JSON.stringify(x))).size===1,'Different team lease owners');
 need(!transactions.length||lease,'Transaction recovery requires complete stale control/team ownership');
 const transactionSnapshots=[];for(const p of transactions)transactionSnapshots.push(await transaction(p));
 return {healthy:false,d,files,snapshot:await Promise.all(files.map(raw)),transactions:transactionSnapshots};
}
async function verify(rt,m,old,trust){const end=Date.now()+180000;while(Date.now()<end){try{const d=await json(path.join(rt.controlRoot,'control.json'));descriptor(d,trust);need(d.phase==='running'&&(!old||d.ownerNonce!==old.ownerNonce),'Not new running owner');const s=await status(d);need(s.phase==='running'&&s.manifestSha256===trust.trustedHash&&same(s.manifestPath,trust.manifest),'Not running same deployment');const controlLease=await json(path.join(rt.controlRoot,'service.lock'));need(controlLease&&controlLease.pid===d.pid&&controlLease.ownerNonce===d.ownerNonce&&controlLease.startedAt===d.startedAt,'Control lease mismatch');need(Array.isArray(s.teams)&&s.teams.length===m.teams.length&&m.teams.every(t=>s.teams.some(x=>same(x.statePath,t.statePath)&&x.teamId===t.teamId&&x.mode===t.mode)),'Live team registration mismatch');const tokens=[];for(const t of m.teams){const dir=(await fs.realpath(t.statePath))+'.watchdog',l=await json(path.join(dir,'service.lock')),h=await json(path.join(dir,'heartbeat.json'));need(l&&h&&l.pid===d.pid&&h.pid===d.pid&&h.ownerToken===l.ownerToken&&Date.parse(l.startedAt)>=Date.parse(d.startedAt)&&Date.parse(h.at)>=Date.parse(l.startedAt)&&Date.now()-Date.parse(h.at)>=0&&Date.now()-Date.parse(h.at)<=120000,'New heartbeat missing');tokens.push(JSON.stringify([l.ownerToken,l.startedAt]));}need(new Set(tokens).size===1,'Different team owners');return;}catch{}await sleep(2000);}throw Error('New deployment heartbeat verification timed out; no automatic stop or retry');}
export async function main(args=process.argv.slice(2)){
 const opts=options(args),apply=opts.apply,manifest=opts['--manifest'],trustedHash=opts['--manifest-sha256'],trust={manifest,trustedHash};need(process.platform==='win32','Windows only');
 const rt=await json(opts['--binding']);need(rt&&same(rt.nodeExecutable,process.execPath),'Node binding mismatch');await canonical(rt.runtimeRoot);await canonical(rt.controlRoot);
 const installBytes=await fs.readFile(rt.manifestPath);need(sha(installBytes)===opts['--installation-sha256'],'Pinned installation manifest changed');const install=JSON.parse(installBytes);need(install.schemaVersion==='watchdog-independent-production-package/v1'&&same(rt.manifestPath,path.join(rt.runtimeRoot,'INSTALL-MANIFEST.json'))&&same(install.runtimeRoot,rt.runtimeRoot)&&same(install.controlRoot,rt.controlRoot),'Installation binding mismatch');
 for(const f of install.runtimeFiles){const p=path.resolve(rt.runtimeRoot,f.path);need(p.startsWith(path.resolve(rt.runtimeRoot)+path.sep),'Invalid runtime file');await canonical(p);need(sha(await fs.readFile(p))===f.sha256,'Installed runtime changed');}
 need(install.runtimeFiles.some(f=>same(path.join(rt.runtimeRoot,f.path),fileURLToPath(import.meta.url))),'Recovery entry is not installed');
 await canonical(manifest);need(sha(await fs.readFile(manifest))===trustedHash,'Trusted production manifest changed');const m=await json(manifest);need(m.kind==='watchdog-production-deployment','Production deployment required');const deployment=await loadWatchdogDeployment(manifest);need(deployment.requireCutover&&deployment.manifestSha256===trustedHash,'Production deployment mismatch');
 if(apply&&!opts.noDelay)await sleep(45000);
 const plan=await inspect(rt,m,trust);if(plan.healthy){await verify(rt,m,null,trust);console.log('healthy: same deployment, no changes');return;}
 need(await raw(path.join(rt.controlRoot,'login-recovery.lock'))===null,'Previous recovery guard remains; manual review required');
 if(!apply){console.log('check: recoverable ownership; no changes');return;}
 const guard=path.join(rt.controlRoot,'login-recovery.lock'),id=randomUUID();let handle=await fs.open(guard,'wx'),mutating=false,done=false;
 await handle.writeFile(JSON.stringify({pid:process.pid,id,at:new Date().toISOString()}));await handle.sync();
 let launch=null;const launchPath=path.join(rt.controlRoot,'launch.lock'),launchBody=JSON.stringify({id,pid:process.pid});
 try{launch=await fs.open(launchPath,'wx');await launch.writeFile(launchBody);await launch.sync();const again=await inspect(rt,m,trust,launchBody);need(!again.healthy&&JSON.stringify(again.snapshot)===JSON.stringify(plan.snapshot)&&JSON.stringify(again.transactions)===JSON.stringify(plan.transactions),'Ownership changed');
  // Journal/guard is deliberately retained after any mutation failure or crash.
  const journal=path.join(rt.controlRoot,'login-recovery-'+id+'.json');await fs.writeFile(journal,JSON.stringify({id,phase:'prepared',files:plan.files.filter((_,i)=>plan.snapshot[i]!==null),transactions:plan.transactions},null,2),{flag:'wx'});
  need(sha(await fs.readFile(manifest))===trustedHash,'Production manifest changed before mutation');
  mutating=true;
  for(const t of plan.transactions)await transaction(t.path,t,t.path+'.login-recovery-'+id);
  // Move the control lease last: formal launch remains excluded while team leases move.
  const order=plan.files.filter(p=>!p.endsWith(path.sep+'service.lock')||p!==path.join(rt.controlRoot,'service.lock')).concat(path.join(rt.controlRoot,'service.lock'));
  for(const p of [...new Set(order)]){const i=plan.files.indexOf(p);if(plan.snapshot[i]===null)continue;need(await raw(p)===plan.snapshot[i],'File changed during archive');await fs.rename(p,p+'.login-recovery-'+id);}
  await launch.close();launch=null;need(await raw(launchPath)===launchBody,'Launch guard changed');await fs.unlink(launchPath);
  need(sha(await fs.readFile(manifest))===trustedHash,'Production manifest changed before launch');
  await run(rt.nodeExecutable,[path.join(rt.runtimeRoot,'src/cli.mjs'),'watchdog-background-start',manifest,rt.controlRoot],{windowsHide:true,timeout:60000,maxBuffer:1048576});
  await verify(rt,m,plan.d,trust);await fs.writeFile(journal,JSON.stringify({id,phase:'verified',at:new Date().toISOString()}));done=true;console.log('recovered: matching fresh deployment heartbeats');
 }finally{if(launch){await launch.close();if(!mutating){need(await raw(launchPath)===launchBody,'Launch guard changed');await fs.unlink(launchPath);}}await handle.close();if(!mutating||done){const g=await json(guard);need(g.id===id,'Recovery guard owner changed');await fs.unlink(guard);}}
}
if(process.argv[1]&&same(process.argv[1],fileURLToPath(import.meta.url)))main().catch(e=>{console.error('watchdog-login-recovery: '+e.message);process.exitCode=1;});
