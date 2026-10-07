import {open,readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {TextDecoder} from 'node:util';
import {readState,atomicWrite} from './store.mjs';
import {withFileLocks} from './registry-projection.mjs';
import {hash,check,exact,id,time,validateManifest} from './stats-contract.mjs';
import {MetadataJsonParser} from './stats-json-stream.mjs';

const key=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const proof=s=>hash([s.team.id,s.version,s.registry?.teamRevision??null,s.members.map(m=>[m.id,m.role,m.lifecycle,m.binding])]);
const PLAN=['schemaVersion','statePath','manifestPath','stateProof','beforeHash','request','createdAt','after','planId'];
async function json(path,max=1024*1024){const info=await lstat(path);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=max,'source_input_invalid');return JSON.parse(await readFile(path,'utf8'));}
async function physical(path,directory=false){path=resolve(path);const info=await lstat(path);check(!info.isSymbolicLink()&&(directory?info.isDirectory():info.isFile()),'source_candidate_not_regular');for(let parent=dirname(path);dirname(parent)!==parent;parent=dirname(parent))check(!(await lstat(parent)).isSymbolicLink(),'source_candidate_alias');const canonical=await realpath(path);return {path:canonical,identity:info.ino?hash([info.dev,info.ino]):null};}
async function targetKey(path){path=resolve(path);try{return key(join(await realpath(dirname(path)),basename(path)));}catch(e){if(e.code!=='ENOENT')throw e;return key(path);}}
async function firstIdentity(path){
  const file=await open(path,'r');try{const bytes=Buffer.alloc(65536),{bytesRead}=await file.read(bytes,0,bytes.length,0),end=bytes.subarray(0,bytesRead).indexOf(10);check(end>=0,'source_identity_header_unavailable');
    const parser=new MetadataJsonParser({fields:new Set(['type','payload.id','teamId','hostId']),observeNative:false});parser.push(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end)));const meta=parser.finish();check(meta.type==='session_meta'&&typeof meta.payload?.id==='string','source_identity_header_unavailable');return {threadId:meta.payload.id,teamId:meta.teamId??null,hostId:meta.hostId??null,headerBytes:end+1};
  }finally{await file.close();}
}
async function manifest(path){const raw=await json(path);return {raw,normalized:validateManifest(raw,dirname(path))};}
function rawSource(source){return {...source,bindings:source.bindings.map(({key,...b})=>b)};}
async function build(statePath,manifestPath,request,createdAt){
  exact(request,['authorizationRef','candidates']);check(typeof request.authorizationRef==='string'&&request.authorizationRef.length>0&&request.authorizationRef.length<=4000,'source_authorization_required');check(Array.isArray(request.candidates)&&request.candidates.length>0&&request.candidates.length<=50,'source_candidate_limit');
  const state=await readState(statePath),base=await manifest(manifestPath);check(state.team.id===base.raw.teamId&&(!state.registry||state.registry.registryId===base.raw.registryId),'source_team_mismatch');check(state.updatedAt<=createdAt,'source_future_state');
  check(!base.raw.managedPolicy,'managed_source_requires_policy_ensure');
  const after=structuredClone(base.raw),known=[];
  for(const s of base.normalized.sources){let canonical=s.path,identity=null;try{canonical=await realpath(s.path);const info=await lstat(s.path);identity=info.ino?hash([info.dev,info.ino]):null;}catch(e){if(e.code!=='ENOENT')throw e;}known.push({source:s,path:canonical,identity});}
  for(const c of request.candidates){let source,location;
    if(c.mode==='approved-source'){
      exact(c,['mode','grantManifest','sourceId']);check(typeof c.grantManifest==='string','source_grant_required');id(c.sourceId);const grant=await manifest(resolve(c.grantManifest));check(!grant.raw.managedPolicy,'managed_source_requires_policy_ensure');check(grant.raw.teamId===state.team.id&&grant.raw.registryId===base.raw.registryId,'source_team_mismatch');source=grant.normalized.sources.find(s=>s.sourceId===c.sourceId);check(source,'source_grant_not_found');
      // An explicit verified grant preserves its own historical epochs. It is
      // not evidence that an arbitrary authorizationRef string grants access.
      check(source.bindings.every(b=>state.members.some(m=>m.id===b.memberId)),'source_grant_member_unknown');location=await physical(source.path,source.kind==='team-context-root');source=rawSource({...source,path:location.path});
    }else{
      exact(c,['mode','path','memberId','authorizedTo','from']);check(c.mode==='codex-jsonl','source_candidate_kind');id(c.memberId);check(typeof c.path==='string','source_candidate_path');time(c.authorizedTo);const from=c.from==='now'?createdAt:time(c.from);check(from>=createdAt&&c.authorizedTo>from&&Date.parse(c.authorizedTo)-Date.parse(from)<=366*86400000,'source_historical_authorization_refused');
      const m=state.members.find(m=>m.id===c.memberId&&m.lifecycle==='active'&&m.binding.status==='bound');check(m&&(!state.registry||state.registry.readyMemberIds.includes(m.id)),'source_current_binding_unavailable');location=await physical(c.path);const meta=await firstIdentity(location.path);check(meta.threadId===m.binding.threadId&&(!meta.hostId||meta.hostId===m.binding.hostId),'source_candidate_identity_mismatch');check(!meta.teamId||meta.teamId===state.team.id,'source_team_mismatch');
      const evidence=request.authorizationRef+'; explicit candidate; current-state tuple checked, operator-scoped epoch (not native Registry revision)';
      source={sourceId:'source-'+hash([c.mode,key(location.path)]).slice(0,24),kind:'codex-jsonl',path:location.path,adapterVersion:'v1',mutationPolicy:'append-only',authorizedFrom:from,authorizedTo:c.authorizedTo,coverageAssertions:{status:'partial',evidenceRef:evidence},evidenceRef:evidence,bindings:[{memberId:m.id,hostId:m.binding.hostId,threadId:m.binding.threadId,role:m.role,bindingRevision:1,roleEpoch:'current-'+hash([m.id,m.role,m.binding.hostId,m.binding.threadId]).slice(0,24),from,to:c.authorizedTo,evidenceRef:evidence}],selection:{taskId:null,roundId:null,turnIds:[],itemIds:[]}};
    }
    check(![statePath,manifestPath,manifestPath+'.sources.lock'].some(p=>key(p)===key(source.path)),'source_path_collision');
    const existing=known.find(s=>key(s.path)===key(source.path)||location.identity&&s.identity===location.identity);
    if(existing){
      // A repeat 'now' request may retain an already approved start/epoch, only
      // if the complete descriptor otherwise matches (including end/evidence).
      // This never extends an old grant or remaps a different current binding.
      if(c.mode==='codex-jsonl'&&c.from==='now'&&existing.source.bindings.length===1){source.authorizedFrom=existing.source.authorizedFrom;source.bindings[0].from=existing.source.bindings[0].from;}
      const candidate=validateManifest({...base.raw,sources:[source]},dirname(manifestPath)).sources[0];check(hash({...existing.source,path:source.path})===hash(candidate),'source_descriptor_conflict');continue;
    }
    check(!known.some(s=>s.source.sourceId===source.sourceId),'source_id_conflict');after.sources.push(source);known.push({source:validateManifest({...base.raw,sources:[source]},dirname(manifestPath)).sources[0],path:source.path,identity:location.identity});
  }
  if(after.sources.length!==base.raw.sources.length)after.revision++;validateManifest(after,dirname(manifestPath));
  const plan={schemaVersion:'source-plan/v1',statePath,manifestPath,stateProof:proof(state),beforeHash:hash(base.raw),request:structuredClone(request),createdAt,after};return {...plan,planId:hash(plan)};
}
export async function planSources(statePath,manifestPath,request,{now=()=>new Date().toISOString()}={}){statePath=resolve(statePath);manifestPath=resolve(manifestPath);const at=now();time(at);return build(statePath,manifestPath,request,at);}
export async function writeSourcePlan(path,plan){path=resolve(path);const forbidden=[plan.statePath,plan.statePath+'.lock',plan.manifestPath,plan.manifestPath+'.lock',plan.manifestPath+'.sources.lock',...plan.request.candidates.filter(c=>c.mode==='approved-source').flatMap(c=>[resolve(c.grantManifest),resolve(c.grantManifest)+'.lock']),...validateManifest(plan.after,dirname(plan.manifestPath)).sources.flatMap(s=>[s.path,s.path+'.activity.lock'])];check(!(await Promise.all(forbidden.map(targetKey))).includes(await targetKey(path)),'source_plan_path_collision');await atomicWrite(path,JSON.stringify(plan,null,2)+'\n',true);}
export async function applySources(statePath,manifestPath,plan){
  statePath=resolve(statePath);manifestPath=resolve(manifestPath);exact(plan,PLAN);const {planId,...core}=plan;check(plan.schemaVersion==='source-plan/v1'&&plan.planId===hash(core)&&plan.statePath===statePath&&plan.manifestPath===manifestPath,'source_plan_invalid');
  return withFileLocks([manifestPath+'.sources.lock'],async()=>{
    check(proof(await readState(statePath))===plan.stateProof,'source_plan_stale_state');const current=await manifest(manifestPath);
    if(hash(current.raw)===hash(plan.after))return {status:'unchanged',planId,revision:current.raw.revision,added:0};
    check(hash(current.raw)===plan.beforeHash,'source_plan_stale_manifest');const verified=await build(statePath,manifestPath,plan.request,plan.createdAt);check(hash(verified)===hash(plan),'source_plan_candidate_changed');
    check(hash((await manifest(manifestPath)).raw)===plan.beforeHash&&proof(await readState(statePath))===plan.stateProof,'source_plan_changed_during_apply');
    await atomicWrite(manifestPath,JSON.stringify(plan.after,null,2)+'\n');return {status:'applied',planId,revision:plan.after.revision,added:plan.after.sources.length-current.raw.sources.length};
  });
}
