// Build from ACTUAL installed bytes. Never synchronize a source checkout wholesale.
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ALLOWED,capabilities} from './manager-operations-install.mjs';

const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
export const DEFAULTS=Object.freeze({
  companion:'C:/Users/admin/.codex-clean-20260710/runtimes/codex-team-context/coordination-tax-opt-1-2-20261014/companion',
  skill:'C:/Users/admin/.codex-clean-20260710/skills/manager-session',
  nodeExecutable:'C:/Program Files/nodejs/node.exe',
  pythonExecutable:'C:/Users/admin/.codex-clean-20260710/runtimes/codex-team-context/coordination-tax-opt-1-2-20261014/venv/Scripts/python.exe',
  evidenceRoot:resolve(sourceRoot,'artifacts/manager-operations-install-readiness-20261029')});
export const ROUTE_ADDITION=`\n\n## Manager-only named operations (local trial)\n\nAt the existing authorized dispatch, submission-receive and decision-recording checkpoints, after verifying the installed companion has \`src/manager-operations.mjs\`, \`src/manager-inbox.mjs\`, \`src/manager-inbox-contract.mjs\` and the fixed bridge/template, use \`<verified-runtime-root>/docs/manager-operations.md\` and \`<verified-runtime-root>/scripts/manager-operations-functions-exec.js\`. Use verified Node/Python/runtime paths; the template passes Python explicitly to each child. Load/fill the fixed template within that existing functions.exec invocation; do not add a model round solely to load it. Dispatch still requires existing human authorization, exact task/Worker identity, native idle and original admission checks. Receive only starts review; record a decision only after independent evidence inspection and an explicit Manager decision.\n\nThis route is Manager-only and does not create a supervision checkpoint, send a task, enable inbox/queue_first, change review criteria, or add Worker/Liaison reads. Keep the current mode; unavailable capability or failed/unknown output stops this route and requires exact-operation status/reconciliation. Never fall back to another sender or resend to resolve unknown effects. Code rollback preserves all task/Registry/notification/attempt/review facts.\n`;
const hash=b=>createHash('sha256').update(b).digest('hex');
const need=(ok,msg)=>{if(!ok)throw Error(msg);};
async function absentRead(path){try{return await readFile(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function inventory(root,scope,path=''){
  const rows=[];for(const entry of await readdir(join(root,path),{withFileTypes:true})){
    need(!entry.isSymbolicLink(),'baseline symlink '+entry.name);const rel=join(path,entry.name);
    if(entry.isDirectory())rows.push(...await inventory(root,scope,rel));
    else{need(entry.isFile(),'baseline special file');const b=await readFile(join(root,rel));rows.push({scope,path:rel.replaceAll('\\','/'),sha256:hash(b),size:b.length});}
  }return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
async function closure(roots){
  const seen=new Set(),rows=[];
  async function visit(path){if(seen.has(path))return;seen.add(path);const bytes=await readFile(join(sourceRoot,path));
    const old=await absentRead(join(roots.companion,path));
    need(!old||bytes.toString().replaceAll('\r\n','\n')===old.toString().replaceAll('\r\n','\n'),'SHARED_CORE_UPGRADE_REQUIRES_REVIEW '+path);
    need(old||ALLOWED.companion.includes(path),'UNLISTED_DEPENDENCY '+path);
    rows.push({path,candidateSha256:hash(bytes),installedSha256:old&&hash(old),action:old?'retain installed bytes':'add exact candidate bytes',normalizedEqual:old?true:null});
    for(const match of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g))await visit(relative(sourceRoot,resolve(sourceRoot,dirname(path),match[1])).replaceAll('\\','/'));
  }
  for(const path of ['src/manager-operations.mjs','src/manager-operations-host.mjs','scripts/manager-operations-bridge.mjs'])await visit(path);
  return rows;
}
export async function buildPackage({output=join(DEFAULTS.evidenceRoot,'package'),...overrides}={}){
  const settings={...DEFAULTS,...overrides},targets={companion:settings.companion,skill:settings.skill};
  need(resolve(output).startsWith(resolve(settings.evidenceRoot)+'/')||resolve(output).startsWith(resolve(settings.evidenceRoot)+'\\'),'package output outside evidence root');
  await mkdir(output,{recursive:false});
  const baseline=[...await inventory(targets.companion,'companion'),...await inventory(targets.skill,'skill')],dependencies=await closure(targets),files=[];
  const cli=await readFile(join(targets.companion,'src/cli.mjs')),candidate=await readFile(join(sourceRoot,'src/cli.mjs'),'utf8');
  const start=candidate.indexOf(" if(args[0]==='manager-request') {"),end=candidate.indexOf(' if(/^inbox-',start);
  need(start>0&&end>start&&!cli.includes(Buffer.from('manager-request')),'CLI_ROUTE_BASELINE');
  const anchor='export async function run(args,output=console.log) {',old=cli.toString();
  need(old.split(anchor).length===2,'CLI_ROUTE_ANCHOR');
  const patchedCli=Buffer.from(old.replace(anchor,anchor+'\n'+candidate.slice(start,end)));
  const originalSkill=await readFile(join(targets.skill,'references/manager-supervision.md'));
  need(!originalSkill.includes(Buffer.from('## Manager-only named operations')),'SKILL_ROUTE_ALREADY_EXISTS');
  for(const [scope,paths] of Object.entries(ALLOWED))for(const path of paths){
    const before=await absentRead(join(targets[scope],path));
    let bytes=scope==='skill'?Buffer.concat([originalSkill,Buffer.from(ROUTE_ADDITION)]):path==='src/cli.mjs'?patchedCli:await readFile(join(sourceRoot,path));
    if(!['src/cli.mjs','references/manager-supervision.md'].includes(path))need(before===null,'NEW_PATH_OCCUPIED '+path);
    const dest=join(output,'payload',scope,path);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes,{flag:'wx'});
    files.push({scope,path,kind:before?'modify':'add',beforeSha256:before&&hash(before),sha256:hash(bytes),size:bytes.length});
  }
  const installer=await readFile(new URL('./manager-operations-install.mjs',import.meta.url));await writeFile(join(output,'install.mjs'),installer,{flag:'wx'});
  const manifest={schemaVersion:'manager-operations-code-package/v1',createdAt:new Date().toISOString(),sourceHead:'f673659cb9eb996ccfd5876b4466de4ca42ec420',evidenceRoot:settings.evidenceRoot,targets,capabilities:await capabilities(settings.nodeExecutable,settings.pythonExecutable),installerSha256:hash(installer),baseline,dependencies,files,
    excluded:['all state/Registry/notification/task data','Python/MCP/config/model settings','shared SKILL.md/structured-submission.md','Worker/Liaison rules and prompts','all existing shared core files including worker-runtime.mjs','source E05 CLI routes','test/benchmark/compatibility/fixture tooling']};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(join(output,'manifest.json'),bytes,{flag:'wx'});
  const manifestSha256=hash(bytes);await writeFile(join(output,'SHA256SUMS'),[`${manifestSha256}  manifest.json`,`${hash(installer)}  install.mjs`,...files.map(f=>`${f.sha256}  payload/${f.scope}/${f.path}`)].join('\n')+'\n',{flag:'wx'});
  return {packageRoot:resolve(output),manifestSha256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await buildPackage({output:process.argv[2]?resolve(process.argv[2]):undefined}),null,2));}catch(e){console.error(e);process.exitCode=1;}}
