// Code-only, hash-pinned installer. Never reads or restores business state.
import {readFile,writeFile,open,mkdir,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
export const ALLOWED=Object.freeze({companion:['src/manager-inbox-contract.mjs','src/manager-inbox.mjs','src/manager-operations-contract.mjs','src/manager-operations.mjs','src/manager-operations-host.mjs','scripts/manager-operations-bridge.mjs','scripts/manager-operations-functions-exec.js','docs/manager-operations.md','src/cli.mjs'],skill:['references/manager-supervision.md']});
const demand=(ok,code)=>{if(!ok)throw Error(code);};
const key=p=>resolve(p).toLowerCase();
const inside=(root,path)=>{const r=relative(resolve(root),resolve(path));return !!r&&!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};
const safe=p=>typeof p==='string'&&!p.includes('\\')&&!isAbsolute(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!x.includes(':'));
async function fingerprint(path){try{const s=await lstat(path);demand(s.isFile()&&!s.isSymbolicLink(),'UNSAFE_FILE '+path);return sha(await readFile(path));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function noLinks(path){
  let p=resolve(path);
  for(;;){try{const s=await lstat(p);demand(!s.isSymbolicLink(),'SYMLINK_PATH '+p);}catch(e){if(e.code!=='ENOENT')throw e;}const up=dirname(p);if(up===p)break;p=up;}
}
async function durable(path,bytes,exclusive=false){await mkdir(dirname(path),{recursive:true});const h=await open(path,exclusive?'wx':'w');try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
async function journal(c,r){const tmp=join(c.receiptDir,'receipt-'+randomUUID()+'.tmp');await durable(tmp,JSON.stringify(r,null,2)+'\n',true);await rename(tmp,join(c.receiptDir,'receipt.json'));}

export async function capabilities(nodeExecutable,pythonExecutable){
  demand(isAbsolute(nodeExecutable??'')&&isAbsolute(pythonExecutable??''),'CAPABILITY absolute executables required');
  for(const p of [nodeExecutable,pythonExecutable]){await noLinks(p);demand(await fingerprint(p),'CAPABILITY executable missing');}
  try{
    const node=JSON.parse((await execute(nodeExecutable,['--input-type=module','-e',`if(Number(process.versions.node.split('.')[0])<22||typeof ''.isWellFormed!=='function')throw Error('Node 22+ required');console.log(JSON.stringify({version:process.versions.node,isWellFormed:true}));`],{windowsHide:true,timeout:10000,encoding:'utf8'})).stdout);
    const code="import sys,json,hashlib,inspect\nfrom pathlib import Path\nfrom codex_team_context.runtime_link import export_registry\nfrom codex_team_context.team_registry import TeamRegistry\nassert callable(export_registry) and callable(TeamRegistry)\nmods=[m for n,m in sorted(sys.modules.items()) if n.startswith('codex_team_context') and getattr(m,'__file__',None)]\nprint(json.dumps({'version':list(sys.version_info[:3]),'exportSignature':str(inspect.signature(export_registry)),'modules':[{'path':str(Path(m.__file__).resolve()),'sha256':hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()} for m in mods]}))";
    const python=JSON.parse((await execute(pythonExecutable,['-I','-X','utf8','-c',code],{windowsHide:true,timeout:20000,encoding:'utf8'})).stdout);
    return {nodeExecutable:resolve(nodeExecutable),pythonExecutable:resolve(pythonExecutable),nodeSha256:await fingerprint(nodeExecutable),pythonSha256:await fingerprint(pythonExecutable),node,python};
  }catch(e){throw Error('CAPABILITY '+String(e.message).slice(0,400));}
}
async function context(args){
  demand(isAbsolute(args.packageRoot??'')&&/^[a-f0-9]{64}$/.test(args.manifestSha256??''),'PACKAGE_HASH pinned manifest required');
  await noLinks(args.packageRoot);const bytes=await readFile(join(args.packageRoot,'manifest.json'));
  demand(sha(bytes)===args.manifestSha256,'PACKAGE_HASH manifest mismatch');const m=JSON.parse(bytes);
  demand(m.schemaVersion==='manager-operations-code-package/v1'&&Array.isArray(m.files)&&Array.isArray(m.baseline),'MANIFEST_SCHEMA');
  demand(m.files.length===Object.values(ALLOWED).flat().length,'MANIFEST_PATH incomplete payload');
  const seen=new Set();for(const f of m.files){demand(safe(f.path)&&ALLOWED[f.scope]?.includes(f.path)&&!seen.has(f.scope+'/'+f.path),'MANIFEST_PATH');seen.add(f.scope+'/'+f.path);demand(/^[a-f0-9]{64}$/.test(f.sha256)&&(f.beforeSha256===null||/^[a-f0-9]{64}$/.test(f.beforeSha256)),'MANIFEST_HASH');}
  demand(m.files.at(-2).scope==='companion'&&m.files.at(-2).path==='src/cli.mjs'&&m.files.at(-1).scope==='skill','MANIFEST_ACTIVATION_ORDER');
  for(const f of m.baseline)demand(safe(f.path)&&['companion','skill'].includes(f.scope)&&/^[a-f0-9]{64}$/.test(f.sha256),'MANIFEST_PATH baseline');
  demand(isAbsolute(m.evidenceRoot)&&isAbsolute(m.targets.companion)&&isAbsolute(m.targets.skill),'TARGET_PATH');
  let roots=m.targets;
  if(args.sandboxRoot){demand(isAbsolute(args.sandboxRoot)&&inside(join(m.evidenceRoot,'sandboxes'),args.sandboxRoot),'TARGET_PATH sandbox');roots={companion:join(args.sandboxRoot,'companion'),skill:join(args.sandboxRoot,'manager-session')};}
  // Caller cannot pass arbitrary companion/Skill destinations.
  demand(!args.companion&&!args.skill,'TARGET_PATH override denied');
  for(const p of Object.values(roots)){await noLinks(p);demand((await lstat(p)).isDirectory(),'TARGET_PATH root');demand(key(await realpath(p))===key(p),'TARGET_PATH canonical root');}
  const c={...args,m,roots,nodeExecutable:args.nodeExecutable??m.capabilities.nodeExecutable,pythonExecutable:args.pythonExecutable??m.capabilities.pythonExecutable};
  c.target=f=>join(roots[f.scope],f.path);
  for(const f of m.files){const p=join(args.packageRoot,'payload',f.scope,f.path);await noLinks(p);demand(await fingerprint(p)===f.sha256,'PAYLOAD_HASH '+f.scope+'/'+f.path);await noLinks(c.target(f));}
  demand(await fingerprint(join(args.packageRoot,'install.mjs'))===m.installerSha256,'PACKAGE_HASH installer');
  if(args.receiptDir){demand(isAbsolute(args.receiptDir)&&inside(join(m.evidenceRoot,'receipts'),args.receiptDir),'RECEIPT_PATH');await noLinks(args.receiptDir);}
  return c;
}
async function baseline(c){
  for(const f of c.m.baseline){await noLinks(c.target(f));demand(await fingerprint(c.target(f))===f.sha256,'BASELINE_DRIFT '+f.scope+'/'+f.path);}
  for(const f of c.m.files)demand(await fingerprint(c.target(f))===f.beforeSha256,'BASELINE_DRIFT '+f.scope+'/'+f.path);
}
async function checkCapabilities(c){demand(JSON.stringify(await capabilities(c.nodeExecutable,c.pythonExecutable))===JSON.stringify(c.m.capabilities),'CAPABILITY_DRIFT');}
function requireWrite(c){demand(c.sandboxRoot||c.allowRealInstall===true,'REAL_INSTALL_NOT_AUTHORIZED');demand(c.receiptDir,'RECEIPT_PATH required');}
async function lock(c,recover=false){
  const dir=join(c.m.evidenceRoot,'locks');await mkdir(dir,{recursive:true});
  const p=join(dir,sha(JSON.stringify(c.roots))+'.json');await noLinks(p);
  const data=JSON.stringify({pid:process.pid,receiptDir:c.receiptDir,manifestSha256:c.manifestSha256});
  try{await durable(p,data,true);}catch(e){
    if(e.code!=='EEXIST')throw e;const old=await readFile(p,'utf8'),value=JSON.parse(old);let live=true;
    try{process.kill(value.pid,0);}catch(error){if(error.code==='ESRCH')live=false;}
    demand(recover&&!live&&key(value.receiptDir)===key(c.receiptDir)&&value.manifestSha256===c.manifestSha256,'INSTALL_INCOMPLETE_OR_BUSY '+value.receiptDir);
    demand(await readFile(p,'utf8')===old,'INSTALL_LOCK_DRIFT');await unlink(p);await durable(p,data,true);
  }
  return async()=>{demand(await readFile(p,'utf8')===data,'INSTALL_LOCK_DRIFT');await unlink(p);};
}
export async function preflight(args){const c=await context(args);const p=join(c.m.evidenceRoot,'locks',sha(JSON.stringify(c.roots))+'.json');demand(await fingerprint(p)===null,'INSTALL_INCOMPLETE_OR_BUSY');await baseline(c);await checkCapabilities(c);return {status:'ready',manifestSha256:c.manifestSha256,targets:c.roots,files:c.m.files.length,businessStateRead:false};}
export async function verifyInstalled(args){const c=await context(args);for(const f of c.m.files)demand(await fingerprint(c.target(f))===f.sha256,'INSTALLED_DRIFT '+f.scope+'/'+f.path);await checkCapabilities(c);return {status:'installed',manifestSha256:c.manifestSha256,targets:c.roots};}
async function undo(c,{recover=false}={}){
  const r=JSON.parse(await readFile(join(c.receiptDir,'receipt.json')));
  demand(r.manifestSha256===c.manifestSha256&&JSON.stringify(r.targets)===JSON.stringify(c.roots),'RECEIPT_BINDING');
  demand(['installed','installing','preparing','rollback-pending','rolling-back','rolled-back'].includes(r.status),'RECEIPT_STATUS');
  const partial=recover||r.status!=='installed';
  // Check ALL destinations and backups before restoring even one file.
  for(const f of c.m.files){const current=await fingerprint(c.target(f));demand(current===f.sha256||((partial||r.status==='rolled-back')&&current===f.beforeSha256),'ROLLBACK_DRIFT '+f.scope+'/'+f.path);if(f.beforeSha256!==null)demand(await fingerprint(join(c.receiptDir,'before',f.scope,f.path))===f.beforeSha256,'BACKUP_HASH '+f.scope+'/'+f.path);}
  r.status='rolling-back';await journal(c,r);
  for(const f of [...c.m.files].reverse()){
    const current=await fingerprint(c.target(f));if(current===f.beforeSha256)continue;
    demand(current===f.sha256,'ROLLBACK_DRIFT '+f.path);
    if(f.beforeSha256===null)await unlink(c.target(f));
    else{const tmp=join(c.receiptDir,'restore-'+randomUUID()+'.tmp');await durable(tmp,await readFile(join(c.receiptDir,'before',f.scope,f.path)),true);demand(await fingerprint(c.target(f))===f.sha256,'ROLLBACK_DRIFT '+f.path);await rename(tmp,c.target(f));}
    r.restored=[...(r.restored??[]),f.scope+'/'+f.path];await journal(c,r);
  }
  r.status='rolled-back';r.finishedAt=new Date().toISOString();await journal(c,r);
  return {status:r.status,receiptDir:c.receiptDir,businessStateRestored:false};
}
export async function rollback(args){const c=await context(args);requireWrite(c);const release=await lock(c,args.recover===true);try{return await undo(c,{recover:args.recover===true});}finally{await release();}}
export async function install(args){
  const c=await context(args);requireWrite(c);const release=await lock(c);let started=false;
  try{
    await baseline(c);await checkCapabilities(c);await mkdir(dirname(c.receiptDir),{recursive:true});await mkdir(c.receiptDir,{recursive:false});
    const r={schemaVersion:'manager-operations-code-receipt/v1',manifestSha256:c.manifestSha256,targets:c.roots,status:'preparing',startedAt:new Date().toISOString(),files:c.m.files.map(f=>({scope:f.scope,path:f.path,beforeSha256:f.beforeSha256,afterSha256:f.sha256})),written:[]};
    // Backups finish before the first target mutation. No business directory is copied.
    for(const f of c.m.files)if(f.beforeSha256!==null)await durable(join(c.receiptDir,'before',f.scope,f.path),await readFile(c.target(f)),true);
    await journal(c,r);started=true;
    for(let i=0;i<c.m.files.length;i++){const f=c.m.files[i];await durable(join(c.receiptDir,'staged',String(i)),await readFile(join(c.packageRoot,'payload',f.scope,f.path)),true);}
    r.status='installing';await journal(c,r);
    for(let i=0;i<c.m.files.length;i++){
      const f=c.m.files[i];demand(await fingerprint(c.target(f))===f.beforeSha256,'BASELINE_DRIFT '+f.path);await mkdir(dirname(c.target(f)),{recursive:true});
      await args.fault?.('before-write:'+i);
      // Recheck after any awaited external action. This detects cooperative
      // concurrent edits; filesystem rename is NOT a compare-and-swap against
      // arbitrary non-cooperating OS writers. Coordinate code edits at install.
      demand(await fingerprint(c.target(f))===f.beforeSha256,'BASELINE_DRIFT '+f.path);
      await rename(join(c.receiptDir,'staged',String(i)),c.target(f));await args.fault?.('after-write:'+i);
      r.written.push(f.scope+'/'+f.path);await journal(c,r);
    }
    for(const f of c.m.files)demand(await fingerprint(c.target(f))===f.sha256,'INSTALLED_DRIFT '+f.path);
    r.status='installed';r.finishedAt=new Date().toISOString();await journal(c,r);
    return {status:'installed',receiptDir:c.receiptDir,files:r.files,businessStateRead:false};
  }catch(e){
    if(started){try{await undo(c,{recover:true});}catch(recovery){
      const pending=JSON.parse(await readFile(join(c.receiptDir,'receipt.json')));pending.status='rollback-pending';pending.recoveryError=String(recovery.message).slice(0,512);await journal(c,pending);
      throw Error(String(e.message)+'; ROLLBACK_PENDING '+String(recovery.message)+'; receipt='+c.receiptDir);
    }}
    throw e;
  }finally{await release();}
}

async function main(argv){
  const [action,...rest]=argv,args={packageRoot:dirname(fileURLToPath(import.meta.url))};
  for(let i=0;i<rest.length;i++){const k=rest[i];if(k==='--apply-real-install')args.allowRealInstall=true;else{const name={'--manifest-sha256':'manifestSha256','--sandbox-root':'sandboxRoot','--receipt':'receiptDir','--python':'pythonExecutable','--node':'nodeExecutable'}[k];demand(name&&rest[i+1],'INVALID_ARGUMENT');args[name]=rest[++i];}}
  demand(['preflight','install','verify','rollback','recover'].includes(action),'INVALID_ACTION');
  if(action==='recover')args.recover=true;
  return ({preflight,install,verify:verifyInstalled,rollback,recover:rollback})[action](args);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}catch(e){console.error(JSON.stringify({status:'error',message:e.message,effects:'inspect receipt; no business state rollback'}));process.exitCode=1;}}
