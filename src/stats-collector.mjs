import { open, readFile, stat, lstat, realpath, mkdir, opendir, unlink } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { atomicWrite } from './store.mjs';
import { MetadataJsonParser } from './stats-json-stream.mjs';
import { createJsonlAdapter, projectDocument, serverRow } from './stats-adapters.mjs';
import { check, hash, time, LIMITS, validateManifest, COLLECTOR_VERSION, RULES_VERSION } from './stats-contract.mjs';
import {validateServerMcpEvent} from './metrics-mcp-events.mjs';

const sessions=new Map(),rootReaders=new Map(),inflight=new Map();
const cacheName='stats-index.json';
const within=(root,path)=>{const rel=relative(root,path);return rel===''||(!isAbsolute(rel)&&!rel.startsWith('..'));};
async function json(path,limit=LIMITS.snapshotBytes){const info=await stat(path);check(info.isFile()&&info.size<=limit,'cache_or_manifest_limit');return JSON.parse(await readFile(path,'utf8'));}
async function acquireLock(cache){
  const path=join(cache,'stats-refresh.lock'),owner={pid:process.pid,token:randomUUID()};
  for(let attempt=0;attempt<2;attempt++){
    try{await atomicWrite(path,JSON.stringify(owner),true);return async()=>{const current=await json(path,1024);check(current.token===owner.token,'stats_lock_owner_changed');await unlink(path);};}
    catch(e){if(e.code!=='EEXIST')throw e;const old=await json(path,1024);check(Number.isSafeInteger(old.pid)&&old.pid>0&&typeof old.token==='string','stats_lock_requires_operator_recovery');let dead=false;try{process.kill(old.pid,0);}catch(error){if(error.code==='ESRCH')dead=true;else throw error;}
      check(dead,'stats_cache_busy');const current=await json(path,1024);check(current.token===old.token,'stats_cache_busy');await unlink(path);
    }
  }check(false,'stats_cache_busy');
}
export async function readStatsIndex(cache){const index=await json(join(cache,cacheName));check(index.schemaVersion===1,'invalid_stats_cache');check(index.collectorVersion===COLLECTOR_VERSION&&index.rulesVersion===RULES_VERSION,'stats_cache_version_mismatch');return index;}
export async function readStatsData(cache,index){check(index.rulesVersion===RULES_VERSION&&index.collectorVersion===COLLECTOR_VERSION,'stats_cache_version_mismatch');const data=[];for(const s of index.sources)if(s.dataRef){check(/^stats-data-[a-f0-9-]+\.json$/.test(s.dataRef),'invalid_cache_ref');data.push({source:s,...await json(join(cache,s.dataRef))});}return data;}
function fileIdentity(s){return hash([s.dev,s.ino,s.birthtimeMs]);}
async function regular(path){check(!(await lstat(path)).isSymbolicLink(),'source_symlink');const s=await stat(path);check(s.isFile(),'source_not_regular');return s;}
async function anchors(handle,size,budget){
  const length=Math.min(1024,size);if(length===0)return {head:hash(''),tail:hash('')};
  check(budget.bytes+budget.anchorBytes+length*2<=budget.maxBytes,'source_read_budget_exhausted');
  const values=[];for(const offset of [0,Math.max(0,size-length)]){const b=Buffer.alloc(length);const {bytesRead}=await handle.read(b,0,length,offset);budget.anchorBytes+=bytesRead;check(bytesRead===length,'source_truncated');values.push(createHash('sha256').update(b).digest('hex'));}return {head:values[0],tail:values[1]};
}
function mergeRows(rows,incoming,diagnostics=[]){
  const map=new Map(rows.map(r=>[r.id,r]));
  for(const row of incoming){const old=map.get(row.id);if(old){
    if(hash(old)===hash(row))continue;
    if(old.series==='native'&&row.series==='native'&&row.startAt===null&&row.missing?.includes('missing-start')&&old.bindingKey===row.bindingKey&&old.taskId===row.taskId){
      diagnostics.push({code:'native_unpaired_response_conflict'});continue;
    }
    // A paired completion replaces its own pending interval atomically.
    const progresses=old.series==='native'&&old.endAt===null&&old.responseAt===null&&row.responseAt!==null;
    const finalizes=old.kind==='interval'&&old.endAt===null&&(row.endAt!==null||progresses)&&old.startAt===row.startAt&&old.bindingKey===row.bindingKey&&old.taskId===row.taskId&&old.stepId===row.stepId&&old.series===row.series&&old.assurance===row.assurance;
    check(finalizes,'source_event_conflict');
  }map.set(row.id,row);}return [...map.values()];
}
function beginGeneration(previous,source,identity){
  return {sourceId:source.sourceId,descriptorHash:hash(source),kind:source.kind,generation:(previous?.generation??0)+1,
    identity,committedOffset:0,scannedBoundary:0,lineNumber:0,parserState:{},anchors:null,mtimeMs:null,
    dataRef:previous?.dataRef??null,stagingRef:null,revalidating:!!previous?.dataRef,oldGeneration:previous?.generation??null,
    status:'backfilling',diagnostics:previous?.dataRef?[{code:'source_generation_reset',missing:'continuity-not-proven'}]:[],lastSuccessAt:previous?.lastSuccessAt??null,
    integrityBasis:source.mutationPolicy==='append-only'?'operator-append-contract+boundary-checks':'budgeted-prefix-revalidation',coverage:source.coverageAssertions};
}
async function loadData(cache,ref){return ref?json(join(cache,ref)):{rows:[],metadata:{}};}
async function storeData(cache,data){const content=JSON.stringify(data);check(Buffer.byteLength(content)<=LIMITS.snapshotBytes,'stats_data_limit');const ref=`stats-data-${hash(content)}.json`;try{await atomicWrite(join(cache,ref),content,true);}catch(e){if(e.code!=='EEXIST')throw e;}return ref;}
async function collectJsonl(source,manifest,cache,previous,budget,checkedAt,options){
  const info=await regular(source.path),handle=await open(source.path,'r');
  try{
    const opened=await handle.stat(),identity=fileIdentity(opened);let reset=!previous||previous.descriptorHash!==hash(source)||previous.identity!==identity||opened.size<previous.committedOffset;
    // Paused sources require an explicit descriptor/file-generation change.
    // Do not re-read anchors or the failing line on an unchanged poll.
    if(previous?.status.startsWith('source_')&&!reset)return {...previous,readBytes:0,lastCheckedAt:checkedAt};
    if(previous&&!reset&&previous.anchors){const a=await anchors(handle,previous.committedOffset,budget);reset=hash(a)!==hash(previous.anchors)||(opened.size===previous.scannedBoundary&&opened.mtimeMs!==previous.mtimeMs);}
    // Mutable sources cannot claim freshness from sparse boundary checks. An
    // append contract also gets a budgeted full prefix revalidation every 10m.
    const due=previous?.lastFullValidationAt&&Date.parse(checkedAt)-Date.parse(previous.lastFullValidationAt)>=600000;
    if(previous?.status==='fresh'&&(source.mutationPolicy==='mutable'||due))reset=true;
    let next=reset?beginGeneration(previous,source,identity):structuredClone(previous);
    const sessionKey=`${cache}/${source.sourceId}`;
    if(reset)sessions.delete(sessionKey);
    let session=sessions.get(sessionKey);
    if(session&&(session.generation!==next.generation||session.position>opened.size||session.committedOffset!==next.committedOffset||session.descriptorHash!==hash(source)))session=null;
    if(session){const a=await anchors(handle,session.position,budget);if(hash(a)!==hash(session.scanAnchors)){session=null;next=beginGeneration(previous,source,identity);sessions.delete(sessionKey);}}
    if(next.status.startsWith('source_')&&!reset)return {...next,readBytes:0};
    const data=await loadData(cache,next.stagingRef??(next.revalidating?null:next.dataRef));
    const adapter=createJsonlAdapter(source,manifest,next.parserState);
    let position=session?.position??next.committedOffset;
    if(!session){session={generation:next.generation,descriptorHash:hash(source),position,decoder:new TextDecoder('utf-8',{fatal:true}),parser:new MetadataJsonParser(),lineBytes:0,lineOffset:position};
      if(previous&&position<previous.scannedBoundary)next.diagnostics.push({code:'restart_incomplete_line_replayed_once',offset:position});
    }
    let rows=data.rows,readBytes=0;
    try{
      while(position<opened.size&&budget.bytes+budget.anchorBytes<budget.maxBytes-8192&&performance.now()-budget.started<budget.wallMs){
        const size=Math.min(LIMITS.chunkBytes,opened.size-position,budget.maxBytes-budget.bytes-budget.anchorBytes-8192);const buffer=Buffer.allocUnsafe(size);
        const read=await handle.read(buffer,0,size,position);check(read.bytesRead>0,'source_truncated');readBytes+=read.bytesRead;budget.bytes+=read.bytesRead;
        let start=0;
        for(let i=0;i<read.bytesRead;i++){
          if(buffer[i]!==10)continue;
          const bytes=buffer.subarray(start,i);session.lineBytes+=bytes.length;check(session.lineBytes<=LIMITS.lineBytes,'source_line_limit');
          session.parser.push(session.decoder.decode(bytes,{stream:true}));session.parser.push(session.decoder.decode());
          const blank=session.parser.rootState==='value'&&session.parser.stack.length===0&&session.parser.mode===null;
          const result=blank?(adapter.skipLine(),{rows:[],diagnostics:[]}):adapter.push(session.parser.finish(),session.lineOffset,session.parser.rootKeys??[]);rows=mergeRows(rows,result.rows,result.diagnostics);
          next.diagnostics.push(...result.diagnostics);check(next.diagnostics.length<=10000,'source_diagnostic_limit');
          next.committedOffset=position+i+1;next.parserState=adapter.checkpoint();next.lineNumber++;session.lineOffset=next.committedOffset;session.lineBytes=0;
          session.decoder=new TextDecoder('utf-8',{fatal:true});session.parser=new MetadataJsonParser();start=i+1;
        }
        if(start<read.bytesRead){const bytes=buffer.subarray(start,read.bytesRead);session.lineBytes+=bytes.length;check(session.lineBytes<=LIMITS.lineBytes,'source_line_limit');session.parser.push(session.decoder.decode(bytes,{stream:true}));}
        position+=read.bytesRead;session.position=position;await yieldEventLoop();
      }
      check((await handle.stat()).size>=opened.size,'source_truncated');
      next.status=position<opened.size?'backfilling':session.lineBytes>0?'partial':'fresh';
    }catch(error){next.status=error.code??'source_bad_json';if(!next.status.startsWith('source_'))next.status=`source_${next.status}`;next.diagnostics.push({code:next.status,offset:next.committedOffset});sessions.delete(sessionKey);}
    next.scannedBoundary=opened.size;next.volatileScannedBytes=position;next.lineProgress=session.lineBytes;next.mtimeMs=opened.mtimeMs;
    next.anchors=await anchors(handle,next.committedOffset,budget);next.lastCheckedAt=checkedAt;next.readBytes=readBytes;
    // One retained partial-line context per team. Other descriptors fairly wait.
    session.scanAnchors=await anchors(handle,session.position,budget);
    session.committedOffset=next.committedOffset;
    if(next.status==='partial'||next.status==='backfilling')sessions.set(sessionKey,session);else sessions.delete(sessionKey);
    const ref=await storeData(cache,{rows,metadata:{},generation:next.generation});
    if(next.revalidating&&next.status!=='fresh')next.stagingRef=ref;
    else{next.dataRef=ref;next.stagingRef=null;next.revalidating=false;next.lastSuccessAt=checkedAt;}
    if(next.status==='fresh'&&(reset||!next.lastFullValidationAt))next.lastFullValidationAt=checkedAt;
    check(Buffer.byteLength(JSON.stringify(next.parserState))<=LIMITS.checkpointBytes,'source_checkpoint_limit');
    return next;
  }finally{await handle.close();}
}
async function collectDocument(source,manifest,cache,previous,budget,checkedAt){
  const info=await regular(source.path),identity=fileIdentity(info),signature=hash([identity,info.size,info.mtimeMs,hash(source)]);
  if(previous?.signature===signature)return {...previous,readBytes:0,lastCheckedAt:checkedAt};
  check(info.size<=LIMITS.readBytes,'source_document_limit');if(budget.bytes+budget.anchorBytes+info.size>budget.maxBytes)return {...(previous??beginGeneration(null,source,identity)),status:'backfilling',readBytes:0};
  const content=await readFile(source.path);budget.bytes+=content.length;check(content.length===info.size,'source_changed_during_read');
  const after=await stat(source.path);check(after.mtimeMs===info.mtimeMs&&after.size===info.size&&fileIdentity(after)===identity,'source_changed_during_read');
  const data=projectDocument(JSON.parse(content.toString('utf8')),source,manifest);
  const next={...beginGeneration(previous,source,identity),signature,status:'fresh',dataRef:await storeData(cache,data),stagingRef:null,revalidating:false,committedOffset:info.size,scannedBoundary:info.size,readBytes:info.size,lastCheckedAt:checkedAt,lastSuccessAt:checkedAt,
    contentSha256:createHash('sha256').update(content).digest('hex'),sourceAsOf:data.metadata.asOf??null};return next;
}
function sourceDates(source,checkedAt){const dates=[];let at=Date.parse(source.authorizedFrom);const end=Math.min(Date.parse(source.authorizedTo),Date.parse(checkedAt));check(end-at<=366*86400000,'source_range_limit');for(let day=Math.floor(at/86400000)*86400000;day<=end;day+=86400000)dates.push(new Date(day).toISOString().slice(0,10));return dates;}
async function collectRoot(source,manifest,cache,previous,budget,checkedAt,options){
  check(!(await lstat(source.path)).isSymbolicLink(),'source_symlink');const root=await realpath(source.path);check((await stat(root)).isDirectory(),'source_not_directory');
  const next=previous?.descriptorHash===hash(source)?structuredClone(previous):beginGeneration(previous,source,hash(root));next.files??={};next.cursor??={day:0,skip:0};next.readBytes=0;
  const dates=sourceDates(source,checkedAt);let data=await loadData(cache,next.stagingRef??(next.revalidating?null:next.dataRef)),rows=data.rows,newFiles=0,entries=0;let finished=true;
  const readerKey=`${cache}/${source.sourceId}`;let reader=rootReaders.get(readerKey);
  if(reader&&(reader.descriptorHash!==hash(source)||reader.committedDay!==next.cursor.day||reader.committedSkip!==next.cursor.skip)){await reader.dir.close();rootReaders.delete(readerKey);reader=null;}
  outer:for(let day=next.cursor.day;day<dates.length;day++){
    if(performance.now()-budget.started>=budget.wallMs){next.cursor={day,skip:next.cursor.skip};finished=false;break;}
    const path=join(root,dates[day]);try{check(!(await lstat(path)).isSymbolicLink(),'source_symlink');check(within(root,await realpath(path)),'source_path_escape');if(!reader)reader={dir:await opendir(path),ordinal:0,pending:null,descriptorHash:hash(source),committedDay:day,committedSkip:next.cursor.skip};}catch(e){if(e.code==='ENOENT'){next.diagnostics.push({code:'source_date_directory_missing',date:dates[day]});next.cursor={day:day+1,skip:0};continue;}throw e;}
    try{
      while(true){
        if(entries>=LIMITS.entries||newFiles>=LIMITS.newFiles||budget.bytes+budget.anchorBytes>=budget.maxBytes||performance.now()-budget.started>=budget.wallMs){next.cursor={day,skip:Math.max(next.cursor.skip,reader.ordinal-(reader.pending?1:0))};finished=false;break outer;}
        const entry=reader.pending??await reader.dir.read();reader.pending=null;if(!entry)break;
        entries++;if(!reader.wasPending)reader.ordinal++;reader.wasPending=false;
        if(day===next.cursor.day&&reader.ordinal<=next.cursor.skip)continue;
        if(!/^[a-f0-9-]{36}\.json$/.test(entry.name))continue;
        check(entry.isFile()&&!entry.isSymbolicLink(),'source_symlink');const file=join(path,entry.name);check(within(root,await realpath(file)),'source_path_escape');
        const s=await regular(file),key=`${dates[day]}/${entry.name}`,signature=hash([fileIdentity(s),s.size,s.mtimeMs]);
        if(next.files[key]===signature)continue;
        check(s.size<=65536,'source_metadata_limit');if(budget.bytes+budget.anchorBytes+s.size>budget.maxBytes){reader.pending=entry;reader.wasPending=true;next.cursor={day,skip:reader.ordinal-1};finished=false;break outer;}
        const bytes=await readFile(file);budget.bytes+=bytes.length;next.readBytes+=bytes.length;const event=JSON.parse(bytes.toString('utf8'));check(entry.name===`${event.eventId}.json`,'source_event_filename_mismatch');
        if(options.allowedObservationTeams&&event.teamId!==manifest.teamId){
          if(options.allowedObservationTeams.includes(event.teamId))validateServerMcpEvent(event,{registryId:manifest.registryId,teamId:event.teamId});
          next.foreignEventsSkipped=(next.foreignEventsSkipped??0)+1;next.files[key]=signature;newFiles++;continue;
        }
        const row=serverRow(event,source,manifest);if(row&&(!options.strictObservationBindings||row.bindingKey))rows=mergeRows(rows,[row]);else if(row){next.unknownBindingsSkipped=(next.unknownBindingsSkipped??0)+1;if(!next.diagnostics.some(d=>d.code==='managed_unknown_binding'))next.diagnostics.push({code:'managed_unknown_binding'});}next.files[key]=signature;newFiles++;
      }
    }catch(e){await reader.dir.close();rootReaders.delete(readerKey);reader=null;throw e;}
    await reader.dir.close();rootReaders.delete(readerKey);reader=null;
    next.cursor={day:day+1,skip:0};
  }
  next.status=finished?'fresh':'backfilling';if(finished)next.cursor={day:0,skip:0};next.lastCheckedAt=checkedAt;next.lastSuccessAt=checkedAt;next.directoryEntries=entries;next.newFiles=newFiles;
  if(reader){reader.committedDay=next.cursor.day;reader.committedSkip=next.cursor.skip;rootReaders.set(readerKey,reader);}
  const ref=await storeData(cache,{rows,metadata:{},generation:next.generation});
  if(next.revalidating&&!finished)next.stagingRef=ref;else{next.dataRef=ref;next.stagingRef=null;next.revalidating=false;}
  check(Buffer.byteLength(JSON.stringify(next.files))<=LIMITS.checkpointBytes,'source_catalog_limit');return next;
}
async function refresh(manifestPath,cache,options){
  cache=resolve(cache);manifestPath=resolve(manifestPath);const raw=await json(manifestPath,1024*1024),manifest=validateManifest(raw,dirname(manifestPath));
  check(!within(cache,manifestPath)&&manifest.sources.every(s=>!within(cache,s.path)&&!within(s.path,cache)),'cache_source_overlap');
  await mkdir(cache,{recursive:true});const checkedAt=options.asOf??new Date().toISOString();time(checkedAt);
  const releaseLock=await acquireLock(cache);
  try{
    let previous;try{previous=await readStatsIndex(cache);}catch(e){if(e.code!=='ENOENT')throw e;}
    check(!previous||previous.teamId===manifest.teamId,'cache_team_mismatch');
    const budget={bytes:0,anchorBytes:0,maxBytes:options.maxReadBytes??LIMITS.readBytes,wallMs:options.maxWallMs??LIMITS.wallMs,started:performance.now()};
    check(Number.isSafeInteger(budget.maxBytes)&&budget.maxBytes>=16384&&budget.maxBytes<=LIMITS.readBytes&&budget.wallMs>0&&budget.wallMs<=LIMITS.wallMs,'invalid_budget');
    const sources=[];let partialSession=false;
    // Retain a single parser context and round-robin source priority per pass.
    const activeSource=manifest.sources.find(s=>sessions.has(`${cache}/${s.sourceId}`))?.sourceId;
    const start=previous?.nextSource??0,ordered=manifest.sources.map((s,i)=>({s,i})).sort((a,b)=>(a.s.sourceId===activeSource?-1:b.s.sourceId===activeSource?1:((a.i-start+manifest.sources.length)%manifest.sources.length)-((b.i-start+manifest.sources.length)%manifest.sources.length)));
    for(const {s} of ordered){
      const old=previous?.sources.find(x=>x.sourceId===s.sourceId);let next;
      const gate=options.sourceGate?await options.sourceGate(s):null;
      if(options.blockedSourceIds?.includes(s.sourceId)||gate?.allow===false){sources.push({...old??beginGeneration(null,s,null),status:'error',readBytes:0,failedCheckedAt:checkedAt,diagnostics:[...(old?.diagnostics??[]),{code:gate?.code??'managed_source_blocked'}].slice(-10000)});continue;}
      if(budget.bytes+budget.anchorBytes>=budget.maxBytes||performance.now()-budget.started>=budget.wallMs||(partialSession&&s.kind.endsWith('jsonl'))){sources.push({...old??beginGeneration(null,s,null),status:old?.status??'backfilling',readBytes:0});continue;}
      try{next=s.kind.endsWith('jsonl')?await collectJsonl(s,manifest,cache,old,budget,checkedAt,options):s.kind==='team-context-root'?await collectRoot(s,manifest,cache,old,budget,checkedAt,options):await collectDocument(s,manifest,cache,old,budget,checkedAt);}
      catch(e){next={...old??beginGeneration(null,s,null),status:'error',readBytes:0,failedCheckedAt:checkedAt,diagnostics:[...(old?.diagnostics??[]),{code:e.code??'source_validation_failed'}].slice(-10000)};}
      if(s.kind.endsWith('jsonl')&&sessions.has(`${cache}/${s.sourceId}`))partialSession=true;sources.push(next);
    }
    sources.sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
    const index={schemaVersion:1,teamId:manifest.teamId,registryId:manifest.registryId,manifestRevision:manifest.revision,manifestHash:hash(manifest),collectorVersion:COLLECTOR_VERSION,rulesVersion:RULES_VERSION,
      revision:(previous?.revision??0)+1,checkedAt,statsAsOf:sources.every(s=>s.status==='fresh')?checkedAt:previous?.statsAsOf??null,
      sources,bindings:manifest.sources.flatMap(s=>s.bindings),sourceScopes:manifest.sources.map(s=>({sourceId:s.sourceId,kind:s.kind,authorizedFrom:s.authorizedFrom,authorizedTo:s.authorizedTo,bindings:s.bindings.map(b=>({key:b.key,from:b.from,to:b.to,identityHash:hash([b.memberId,b.role,b.hostId,b.threadId])}))})),...(options.managedPolicy?{managedPolicy:options.managedPolicy}:{}),nextSource:(start+1)%Math.max(1,manifest.sources.length),
      readEvidence:{readBytes:budget.bytes,anchorBytes:budget.anchorBytes,wallMs:Math.round(performance.now()-budget.started)},
      phase:previous?'incremental':'initial-backfill',snapshotId:hash([manifest.teamId,manifest.revision,sources.map(s=>[s.sourceId,s.generation,s.dataRef,s.status])])};
    // Offset and data reference are one atomic commit. A crash beforehand leaves
    // only unreferenced sanitized data files; it never advances a checkpoint.
    await options.beforeCommit?.(index);
    // No raw/source files are removed. Known unreferenced cache chunks older than
    // the query lease are reclaimed under this single-writer lock.
    const refs=new Set(sources.flatMap(s=>[s.dataRef,s.stagingRef]).filter(Boolean));let diskBytes=0;
    const leases=await opendir(cache);for await(const entry of leases){if(!/^stats-lease-[a-f0-9]{64}\.json$/.test(entry.name))continue;const lease=await json(join(cache,entry.name),LIMITS.responseBytes);if(lease.expiresAt>Date.now())for(const s of lease.index.sources)if(s.dataRef)refs.add(s.dataRef);}
    const directory=await opendir(cache);for await(const entry of directory){if(!/^stats-data-[a-f0-9-]+\.json$/.test(entry.name))continue;const path=join(cache,entry.name),info=await stat(path);if(!refs.has(entry.name)&&Date.now()-info.mtimeMs>LIMITS.leaseMs)await unlink(path);else diskBytes+=info.size;}
    check(diskBytes+Buffer.byteLength(JSON.stringify(index))<=LIMITS.cacheBytes,'stats_cache_budget');
    await atomicWrite(join(cache,cacheName),JSON.stringify(index));return index;
  }finally{await releaseLock();}
}
export async function refreshStats(manifestPath,cache,options={}){
  if(!options.managedApproved){const descriptor=await json(resolve(manifestPath),1024*1024);if(descriptor.managedPolicy){validateManifest(descriptor,dirname(resolve(manifestPath)));const {readManagedPolicy,refreshManagedMetrics}=await import('./managed-metrics.mjs'),policy=await readManagedPolicy(descriptor.managedPolicy.path);check(policy.policyId===descriptor.managedPolicy.policyId&&resolve(manifestPath)===join(policy.managedRoot,'manifest.json')&&within(policy.managedRoot,resolve(cache))&&resolve(cache)!==policy.managedRoot,'managed_policy_reference');return refreshManagedMetrics(descriptor.managedPolicy.path,{...options,cache:resolve(cache)});}}
  const key=resolve(cache);if(inflight.has(key))return inflight.get(key);
  const promise=refresh(manifestPath,key,options).catch(e=>{releaseStatsSession(key);throw e;}).finally(()=>inflight.delete(key));inflight.set(key,promise);return promise;
}
export async function markStatsBlocked(cache,managedPolicy,asOf){cache=resolve(cache);time(asOf);const release=await acquireLock(cache);try{const previous=await readStatsIndex(cache);check(asOf>=previous.checkedAt,'managed_stale_cutoff');const index={...previous,revision:previous.revision+1,checkedAt:asOf,phase:'managed-blocked',managedPolicy,readEvidence:{readBytes:0,anchorBytes:0,wallMs:0},snapshotId:hash([previous.snapshotId,managedPolicy,asOf])};await atomicWrite(join(cache,cacheName),JSON.stringify(index));return index;}finally{await release();}}
export function releaseStatsSession(cache){for(const key of sessions.keys())if(key.startsWith(`${resolve(cache)}/`))sessions.delete(key);for(const [key,reader] of rootReaders)if(key.startsWith(`${resolve(cache)}/`)){rootReaders.delete(key);reader.dir.close().catch(()=>{});}}
