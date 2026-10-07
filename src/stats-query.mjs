import { readFile, stat, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './store.mjs';
import { localDate } from './metrics-daily.mjs';
import { rollup } from './metrics-rollup.mjs';
import { readStatsIndex, readStatsData } from './stats-collector.mjs';
import { check, exact, hash, time, LIMITS, RULES_VERSION, COLLECTOR_VERSION } from './stats-contract.mjs';
import {sourceStatus} from './source-status.mjs';

const dayMs=86400000;
// Frozen query results are held only for their existing lease lifetime. The
// process cache has a separate 16 MiB / 16 entry ceiling; lease admission and
// expiry are still checked on disk before every use.
const queryResults=new Map();let queryResultBytes=0;
const preparedFlights=new Map(),recordTimes=new WeakMap(),windowTimes=new WeakMap();
function cachedResult(key,now){for(const [k,v] of queryResults)if(v.expiresAt<=now){queryResultBytes-=v.bytes;queryResults.delete(k);}const value=queryResults.get(key);if(value){queryResults.delete(key);queryResults.set(key,value);}return value?.data;}
function rememberResult(key,data,expiresAt,bytes=Buffer.byteLength(JSON.stringify({...data,availableTargets:[...(data.availableTargets??[])]}))){if(bytes>16*LIMITS.responseBytes)return;
  if(queryResults.has(key)){queryResultBytes-=queryResults.get(key).bytes;queryResults.delete(key);}
  while(queryResults.size>=16||queryResultBytes+bytes>16*LIMITS.responseBytes){const oldest=queryResults.keys().next().value;queryResultBytes-=queryResults.get(oldest).bytes;queryResults.delete(oldest);}queryResults.set(key,{data,expiresAt,bytes});queryResultBytes+=bytes;}
function realDate(v){check(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v),'invalid_query');const t=Date.parse(`${v}T00:00:00.000Z`);check(Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v,'invalid_query');return t;}
export function canonicalWindow(query,asOf){
  time(asOf);const today=localDate(asOf),preset=query.preset??'7';let from=query.from,to=query.to;
  check(['today','7','30','all','custom'].includes(preset),'invalid_query');
  if(preset==='custom')check(from&&to,'invalid_query');
  else{check(from===undefined&&to===undefined,'invalid_query');to=today;from=preset==='today'?to:preset==='all'?'1970-01-01':new Date(realDate(to)-(Number(preset)-1)*dayMs).toISOString().slice(0,10);}
  check(realDate(from)<=realDate(to)&&to<=today,'invalid_query');if(preset==='custom')check(realDate(to)-realDate(from)<366*dayMs,'query_range_limit');
  return {preset,from,to,timeZone:'Asia/Shanghai',startAt:new Date(realDate(from)-8*3600000).toISOString(),endAt:new Date(realDate(to)+16*3600000).toISOString(),cutoffAtInclusive:asOf};
}
function normalize(input,index,asOf){
  exact(input,['view','preset','from','to','memberId','memberBindingKey','taskId','roundId','stepId','sourceId','series','assurance','status','search','sort','direction','page','pageSize','snapshotId','baseSnapshotId','targetId','targetKind'],[]);
  const view=input.view??'tasks';check(['tasks','members','steps','coverage','token','mcp','time','days'].includes(view),'invalid_query');
  const sort=input.sort??(view==='tasks'?'updatedAt':'id'),direction=input.direction??'desc';check(['id','updatedAt','at','durationMs','total','date'].includes(sort)&&['asc','desc'].includes(direction),'invalid_query');
  const page=input.page??1,pageSize=input.pageSize??20;check(Number.isSafeInteger(page)&&page>=1&&[20,50].includes(pageSize),'invalid_query');
  check(input.search===undefined||(typeof input.search==='string'&&input.search.length<=128),'invalid_query');
  for(const k of ['memberId','memberBindingKey','taskId','roundId','stepId','sourceId','series','assurance','status','snapshotId','targetId','targetKind'])if(input[k]!==undefined)check(typeof input[k]==='string'&&input[k].length>0&&input[k].length<=256,'invalid_query');
  if(input.targetKind)check(['task','step','member'].includes(input.targetKind),'invalid_query');
  if(input.memberBindingKey)check(index.bindings.some(b=>b.key===input.memberBindingKey),'invalid_query');
  if(input.sourceId)check(index.sources.some(s=>s.sourceId===input.sourceId),'invalid_query');
  return {query:{view,window:canonicalWindow(input,asOf),sort,direction,pageSize,...Object.fromEntries(['memberId','memberBindingKey','taskId','roundId','stepId','sourceId','series','assurance','status','search'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))},page};
}
function intervalSpan(row,window,endAt){
  if(!row.startAt||!endAt||row.terminal)return null;
  const r=recordTimes.get(row),w=windowTimes.get(window),endTime=r?(endAt===row.endAt?r[1]:endAt===row.responseAt?r[2]:Date.parse(endAt)):Date.parse(endAt);
  const start=Math.max(r?r[0]:Date.parse(row.startAt),w?w[0]:Date.parse(window.startAt),row.authorizedFrom!=null?(r?r[3]:Date.parse(row.authorizedFrom)):(r?r[0]:Date.parse(row.startAt)));
  const end=Math.min(endTime,w?w[1]:Date.parse(window.endAt),w?w[2]:Date.parse(window.cutoffAtInclusive),row.authorizedTo!=null?(r?r[4]:Date.parse(row.authorizedTo)):endTime,row.epochEnd!=null?(r?r[5]:Date.parse(row.epochEnd)):endTime);
  return end>start?[start,end]:null;
}
export function clippedInterval(row,window){return intervalSpan(row,window,row.endAt);}
export function intervalUnion(intervals){
  if(intervals.length===0)return null;const sorted=intervals.toSorted((a,b)=>a[0]-b[0]||a[1]-b[1]);let total=0,[start,end]=sorted[0];
  for(const [a,b] of sorted.slice(1)){if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b;}}return total+end-start;
}
const isMcp=r=>['interval','reported-step'].includes(r.kind)&&(r.series?.startsWith('team-context')||/^(?:mcp[_.]|team_context\.)/.test(r.tool??''));
const pointInWindow=(at,w)=>!!at&&at>=w.startAt&&at<w.endAt&&at<=w.cutoffAtInclusive;
const recordPointInWindow=(r,at,w)=>pointInWindow(at,w)&&at>=(r.authorizedFrom??at)&&at<=(r.authorizedTo??at);
const completedInWindow=(r,w)=>r.completionKnown===true&&recordPointInWindow(r,r.completedAt,w);
const responseSpan=(r,w)=>r.responseAt?intervalSpan(r,w,r.responseAt):null;
function summary(rows,window){
  const tokens=rows.filter(r=>r.kind==='token');const known=tokens.filter(r=>r.bindingKey!==null),unknown=tokens.filter(r=>r.bindingKey===null);
  const series=[...new Set(rows.filter(r=>r.kind==='interval').map(r=>`${r.series}/${r.assurance}`))];
  return {token:{nativeTotal:rollup(tokens),memberSum:rollup(known),unattributed:rollup(unknown),byRole:Object.fromEntries(['Manager','Liaison','Worker','Unknown'].map(role=>[role,rollup(tokens.filter(r=>(r.role??'Unknown')===role))])),semantics:'native total; cache/reasoning are subsets; separate historical aggregates'},
    intervals:series.map(key=>{const [sourceKind,assurance]=key.split('/'),selected=rows.filter(r=>`${r.series}/${r.assurance}`===key);return {sourceKind,assurance,observedUnionMs:intervalUnion(selected.filter(r=>r.completionKnown===true).map(r=>clippedInterval(r,window)).filter(Boolean)),requestResponseUnionMs:intervalUnion(selected.map(r=>responseSpan(r,window)).filter(Boolean)),completedSteps:selected.filter(r=>completedInWindow(r,window)).length,completionUnknown:selected.filter(r=>r.completionKnown!==true).length,missingEndpoints:selected.filter(r=>!r.startAt||!r.endAt).length};}),
    mcp:['native','team-context','team-context-report'].map(series=>{const selected=rows.filter(r=>isMcp(r)&&r.series===series),completed=selected.filter(r=>completedInWindow(r,window)),unknown=selected.filter(r=>r.completionKnown!==true);return {sourceKind:series,calls:completed.length?completed.length:null,requests:selected.filter(r=>recordPointInWindow(r,r.startAt,window)).length,responses:selected.filter(r=>recordPointInWindow(r,r.responseAt,window)).length,completionUnknown:unknown.length,attribution:{taskLinked:completed.filter(r=>r.taskId).length,teamShared:completed.filter(r=>!r.taskId&&r.attribution==='team-shared').length,unassigned:completed.filter(r=>!r.taskId&&r.attribution!=='team-shared').length},missing:[...(!completed.length?['no-verified-completions-in-window']:[]),...(unknown.length?['execution-completion-unproven']:[])],countBasis:'completedAt; half-open local day',canCombineWithOtherSources:false};}),
    reportedSteps:{count:rows.filter(r=>r.kind==='reported-step').length,totalDurationMs:null,missing:'absolute boundaries and nesting unavailable; durations are not additive'},
    taskDeclaredMs:intervalUnion(rows.filter(r=>r.kind==='stage').map(r=>clippedInterval(r,window)).filter(Boolean)),waitingMs:null,waitingMissing:'no-explicit-wait-producer; gaps are unattributed'};
}
function redacted(row,window,roster){const span=clippedInterval(row,window),member=roster?.get(row.memberId);return {id:row.id,kind:row.kind,at:row.at??null,taskId:row.taskId??null,roundId:row.roundId??null,memberId:row.memberId??null,memberName:member?.name??null,memberNameProvenance:member?.nameProvenance??null,memberBindingKey:row.bindingKey??null,role:row.role??null,
  sourceId:row.sourceId,sourceKind:row.series??row.kind,assurance:row.assurance??null,attribution:row.attribution,associationSource:row.associationSource??null,contextValidation:row.contextValidation??null,stepId:row.stepId??null,status:row.status??null,tool:row.tool??null,startAt:row.startAt??null,endAt:row.endAt??null,
  durationMs:span?span[1]-span[0]:null,responseAt:row.responseAt??null,firstYieldAt:row.firstYieldAt??null,completedAt:row.completedAt??null,completionKnown:row.completionKnown??null,completionEvidence:row.completionEvidence??null,hostReportedStatus:row.hostReportedStatus??null,requestResponseMs:responseSpan(row,window)?.reduce((a,b)=>b-a)??null,timeScope:row.series==='native'?'observed execution interval; request-response latency reported separately':null,reportedDurationMs:row.reportedDurationMs??null,usage:row.usage??null,total:row.usage?.total??null,missing:row.missing??[]};}
function selected(row,q){return (!q.taskId||row.taskId===q.taskId)&&(!q.roundId||row.roundId===q.roundId)&&(!q.stepId||row.stepId===q.stepId)&&(!q.memberId||row.memberId===q.memberId)&&(!q.memberBindingKey||row.bindingKey===q.memberBindingKey)&&(!q.sourceId||row.sourceId===q.sourceId)&&(!q.series||row.series===q.series)&&(!q.assurance||row.assurance===q.assurance)&&(!q.status||row.status===q.status);}
function inWindow(row,w){const at=row.at??row.startAt??row.endAt;return !!at&&at<=w.cutoffAtInclusive&&(clippedInterval(row,w)!==null||responseSpan(row,w)!==null||[row.at,row.startAt,row.responseAt,row.completedAt].some(t=>recordPointInWindow(row,t,w)));}
async function prepareRecords(cache,index){
  const scopes=new Map((index.sourceScopes??[]).map(s=>[s.sourceId,s]));
  const documents=(await readStatsData(cache,index)).map(d=>({sourceId:d.source.sourceId,rows:d.rows.map(row=>{const scope=scopes.get(d.source.sourceId),binding=scope?.bindings.find(b=>b.key===row.bindingKey);if(!scope)return row;const from=[row.authorizedFrom,scope.authorizedFrom,binding?.from].filter(Boolean).sort().at(-1),to=[row.authorizedTo,scope.authorizedTo,binding?.to].filter(Boolean).sort().at(0);return {...row,authorizedFrom:from,authorizedTo:to,epochEnd:binding?.to??row.epochEnd};}),metadata:d.metadata}));let records=documents.flatMap(d=>d.rows);
  // Same native event in two approved files cannot silently double the total.
  // Different MCP series remain independent. Conflicting IDs fail closed.
  const seen=new Map();records=records.filter(r=>{const key=hash([r.kind,r.series,r.hostId,r.threadId,r.id]),before=seen.get(key);const clean={...r,sourceId:null};if(before){check(hash(before)===hash(clean),'cross_source_identity_conflict');return false;}seen.set(key,clean);return true;});
  const times=records.map(r=>[r.startAt,r.endAt,r.responseAt,r.authorizedFrom,r.authorizedTo,r.epochEnd].map(t=>t==null?null:Date.parse(t)));records.forEach((r,i)=>recordTimes.set(r,times[i]));
  // records references rows already owned by documents; counting their JSON
  // again would double the document payload. Charge documents once, numeric
  // time arrays, and a conservative 128 bytes per record for the reference
  // array/WeakMap time-index overhead, within the same shared cache budget.
  const bytes=Buffer.byteLength(JSON.stringify({documents,times}))+records.length*128;return {documents,records,bytes};
}
async function preparedRecords(cache,index,now,expiresAt){
  const key=hash(['prepared-records',cache,index.snapshotId,index.manifestHash,index.bindings]);let value=cachedResult(key,now);if(value)return {value,hit:true};
  if(preparedFlights.has(key))return {value:await preparedFlights.get(key),hit:true};check(preparedFlights.size<16,'bounded_budget_busy');
  const pending=prepareRecords(cache,index).then(value=>{rememberResult(key,value,expiresAt,value.bytes);return value;}).finally(()=>preparedFlights.delete(key));preparedFlights.set(key,pending);return {value:await pending,hit:false};
}
async function rowsFor(cache,index,q,{now,expiresAt,profile}={}){
  let phaseAt=performance.now();const phase=(name,extra={})=>{profile?.({phase:name,ms:performance.now()-phaseAt,...extra});phaseAt=performance.now();};
  const prepared=await preparedRecords(cache,index,now,expiresAt),sources=new Map(index.sources.map(s=>[s.sourceId,s])),documents=prepared.value.documents.map(d=>({...d,source:sources.get(d.sourceId)}));let records=prepared.value.records;
  phase('immutable-documents-read-dedup-time-index',{preparedHit:prepared.hit,accountedBytes:prepared.value.bytes});windowTimes.set(q.window,[Date.parse(q.window.startAt),Date.parse(q.window.endAt),Date.parse(q.window.cutoffAtInclusive)]);
  const taskList=documents.flatMap(d=>d.metadata.tasks??[]),tasks=new Map(taskList.map(t=>[t.taskId,t]));
  const roster=new Map(documents.flatMap(d=>(d.metadata.roster??[]).map(m=>({...m,nameProvenance:{sourceKind:'recorded-state-roster',sourceId:d.source.sourceId,sourceVersion:d.metadata.sourceVersion,asOf:d.metadata.asOf,labelBasis:'name at roster snapshot; no historical-name inference'}}))).map(m=>[m.memberId,m]));
  const pendingMembers=[...roster.values()].filter(m=>m.lifecycle==='active'&&!index.bindings.some(b=>b.memberId===m.memberId));
  const availableTargets=new Set(q.view==='tasks'?[...tasks.keys()]:q.view==='members'?[...index.bindings.map(b=>b.key),...pendingMembers.map(m=>hash([index.teamId,'sourcesPending',m.memberId]))]:records.flatMap(r=>[r.id,r.stepId].filter(Boolean)));
  if(q.taskId)check(tasks.has(q.taskId)||records.some(r=>r.taskId===q.taskId),'target_not_found');
  if(q.roundId)check(taskList.some(t=>t.roundId===q.roundId)||records.some(r=>r.roundId===q.roundId),'target_not_found');
  if(q.memberId)check(roster.has(q.memberId)||index.bindings.some(b=>b.memberId===q.memberId),'target_not_found');
  phase('metadata-target-validation');records=records.filter(r=>selected(r,q)&&inWindow(r,q.window));let rows=[];
  const byTask=new Map(),byBinding=new Map();for(const r of records){for(const [map,key] of [[byTask,r.taskId],[byBinding,r.bindingKey]])if(key){if(!map.has(key))map.set(key,[]);map.get(key).push(r);}}
  phase('window-filter-group');if(q.view==='tasks'){
    rows=[...tasks.values()].filter(t=>(!q.taskId||q.taskId===t.taskId)&&(!q.roundId||q.roundId===t.roundId)&&(!q.status||q.status===t.status)&&(!q.memberBindingKey||index.bindings.some(b=>b.key===q.memberBindingKey&&b.memberId===t.ownerId))&&
      (!q.memberId||t.ownerId===q.memberId||(byTask.get(t.taskId)??[]).some(r=>r.memberId===q.memberId&&r.bindingKey))&&
      (t.updatedAt<=q.window.cutoffAtInclusive&&(t.updatedAt>=q.window.startAt||byTask.has(t.taskId)))).map(t=>{const span=clippedInterval({startAt:t.assignedAt,endAt:t.completedAt},q.window);return {id:t.taskId,...t,taskWallClockMs:span?span[1]-span[0]:null,taskWallClockMissing:span?[]:['missing-start-or-completion'],time:summary(byTask.get(t.taskId)??[],q.window),stageOwnership:'unattributed; task owner is not stage owner'};});
  }else if(q.view==='members'){
    const bindings=new Map(index.bindings.map(b=>[b.key,b]));rows=[...bindings.values()].filter(b=>(!q.memberId||b.memberId===q.memberId)&&(!q.memberBindingKey||b.key===q.memberBindingKey)&&(!(q.taskId||q.roundId)||byBinding.has(b.key))&&b.from<=q.window.cutoffAtInclusive&&b.to>q.window.startAt).map(b=>({id:b.key,memberId:b.memberId,name:roster.get(b.memberId)?.name??null,nameProvenance:roster.get(b.memberId)?.nameProvenance??null,role:b.role,roleEpoch:b.roleEpoch,bindingRevision:b.bindingRevision,time:summary(byBinding.get(b.key)??[],q.window),coverage:byBinding.has(b.key)?'partial':'sourcesPending'}));
    if(!q.memberBindingKey&&!q.taskId&&!q.roundId)rows.push(...pendingMembers.filter(m=>!q.memberId||m.memberId===q.memberId).map(m=>({id:hash([index.teamId,'sourcesPending',m.memberId]),memberId:m.memberId,name:m.name,nameProvenance:m.nameProvenance,role:m.role,roleEpoch:null,bindingRevision:null,time:summary([],q.window),coverage:'sourcesPending',missing:['no-verified-binding-source'],rosterBasis:'recorded-state-snapshot'})));
  }else if(q.view==='coverage')rows=index.sources.filter(s=>!q.sourceId||s.sourceId===q.sourceId).map(s=>({id:s.sourceId,sourceKind:s.kind,status:s.status,generation:s.generation,asOf:s.lastSuccessAt,sourceAsOf:s.sourceAsOf??null,committedBytes:s.committedOffset,scannedBytes:s.volatileScannedBytes??s.committedOffset,readBytes:s.readBytes,integrityBasis:s.integrityBasis,coverage:s.coverage,diagnostics:s.diagnostics.slice(-1000)}));
  else if(q.view==='days'){
    const dateMemo=new Map(),dateOf=t=>{if(dateMemo.has(t))return dateMemo.get(t);const date=localDate(t);if(dateMemo.size<10000)dateMemo.set(t,date);return date;};
    const dates=new Set(records.flatMap(r=>[r.at,r.startAt,r.responseAt,r.completedAt].filter(t=>recordPointInWindow(r,t,q.window)).map(dateOf)));
    // Split completed intervals at Beijing midnight before per-day unions.
    for(const r of records)for(const span of [clippedInterval(r,q.window),responseSpan(r,q.window)].filter(Boolean))for(let n=Math.floor((span[0]+8*3600000)/dayMs)*dayMs-8*3600000;n<span[1];n+=dayMs)dates.add(dateOf(new Date(n).toISOString()));
    rows=[...dates].filter(date=>date>=q.window.from&&date<=q.window.to).map(date=>{
      const w={...q.window,startAt:new Date(realDate(date)-8*3600000).toISOString(),endAt:new Date(realDate(date)+16*3600000).toISOString()};
      windowTimes.set(w,[Date.parse(w.startAt),Date.parse(w.endAt),Date.parse(w.cutoffAtInclusive)]);
      const dayRecords=records.filter(r=>inWindow(r,w));return {id:date,date,summary:summary(dayRecords,w),memberCount:new Set(dayRecords.map(r=>r.bindingKey).filter(Boolean)).size,memberDetails:'query members with same date window; separately paged'};
    });
  }else rows=records.filter(r=>q.view==='token'?r.kind==='token':q.view==='mcp'?isMcp(r)&&(r.completionKnown===true?completedInWindow(r,q.window):[r.at,r.startAt,r.responseAt].some(t=>recordPointInWindow(r,t,q.window))):q.view==='time'?['interval','stage','reported-step'].includes(r.kind):r.kind!=='token').map(r=>redacted(r,q.window,roster));
  phase('view-aggregation');if(q.search){const text=q.search.toLowerCase();rows=rows.filter(r=>[r.id,r.title,r.name,r.memberId,r.tool,r.stepId].filter(Boolean).some(v=>v.toLowerCase().includes(text)));}
  check(rows.length<=10000,'query_index_limit');const compare=(a,b)=>a===b?0:a===null||a===undefined?1:b===null||b===undefined?-1:a<b?-1:1;
  rows.sort((a,b)=>{const x=a[q.sort],y=b[q.sort];return (q.direction==='asc'?1:-1)*compare(x,y)||compare(a.id,b.id);});
  const coverage=documents.map(d=>({sourceId:d.source.sourceId,sourceKind:d.source.kind,status:d.source.status,asOf:d.source.lastSuccessAt,sourceAsOf:d.source.sourceAsOf??null,coverage:d.source.coverage,generation:d.source.generation,missing:d.source.diagnostics.map(x=>x.code).slice(-100)}));
  const aggregates=documents.filter(d=>d.metadata.daily).map(d=>({sourceId:d.source.sourceId,sourceKind:'historical-daily-report',asOf:d.metadata.asOf,from:d.metadata.from,to:d.metadata.to,canCombineWithNativeRecords:false,days:d.metadata.daily.filter(x=>x.date>=q.window.from&&x.date<=q.window.to)}));
  phase('sort-and-envelope');const totals=summary(records,q.window);phase('whole-window-summary');return {rows,summary:totals,coverage,aggregates,availableTargets};
}
function leaseIndex(index){return {...index,bindings:index.bindings,sources:index.sources.map(s=>({...s,parserState:undefined,files:undefined,anchors:undefined,diagnostics:s.diagnostics.slice(-100)}))};}
async function pruneLeases(cache,now){const dir=await opendir(cache),leases=[];for await(const e of dir){if(!/^stats-lease-[a-f0-9]{64}\.json$/.test(e.name))continue;const path=join(cache,e.name),info=await stat(path);check(info.size<=LIMITS.responseBytes,'stats_lease_limit');const value=JSON.parse(await readFile(path,'utf8'));if(value.expiresAt<=now)await unlink(path);else leases.push({path,at:value.createdAt,bytes:info.size});}leases.sort((a,b)=>a.at-b.at);while(leases.length>=LIMITS.leases){await unlink(leases.shift().path);}check(leases.reduce((n,l)=>n+l.bytes,0)<=32*LIMITS.responseBytes,'stats_lease_budget');}
export async function readStatsLease(cache,snapshotId,{now=Date.now()}={}){
  check(typeof snapshotId==='string'&&/^[a-f0-9]{64}$/.test(snapshotId),'invalid_query');
  let lease;try{lease=JSON.parse(await readFile(join(cache,`stats-lease-${snapshotId}.json`),'utf8'));}catch(e){if(e.code==='ENOENT')check(false,'snapshot_expired');throw e;}
  check(lease.expiresAt>now,'snapshot_expired');check(lease.index.rulesVersion===RULES_VERSION&&lease.index.collectorVersion===COLLECTOR_VERSION,'stats_cache_version_mismatch');return lease;
}
export async function createStatsSnapshot(cache,{now=Date.now()}={}){
  const index=await readStatsIndex(cache);await pruneLeases(cache,now);
  // Content and capture instant define a new base after expiry. Old IDs never revive.
  const snapshotId=hash(['base',index.snapshotId,index.checkedAt,now,RULES_VERSION]);
  const lease={schemaVersion:1,kind:'base',createdAt:now,expiresAt:now+LIMITS.leaseMs,snapshotId,index:leaseIndex(index)};
  const text=JSON.stringify(lease);check(Buffer.byteLength(text)<=LIMITS.responseBytes,'stats_lease_limit');await atomicWrite(join(cache,`stats-lease-${snapshotId}.json`),text);
  return {baseSnapshotId:snapshotId,expiresAt:lease.expiresAt,index:lease.index};
}
export async function queryStats(cache,input={}, {now=Date.now(),profile}={}){
  let index,normalized,lease,base=null;
  if(input.baseSnapshotId){base=await readStatsLease(cache,input.baseSnapshotId,{now});check(base.kind==='base','snapshot_query_mismatch');}
  if(input.snapshotId){check(/^[a-f0-9]{64}$/.test(input.snapshotId),'invalid_query');try{lease=JSON.parse(await readFile(join(cache,`stats-lease-${input.snapshotId}.json`),'utf8'));}catch(e){if(e.code==='ENOENT')check(false,'snapshot_expired');throw e;}
    check(lease.expiresAt>now,'snapshot_expired');check(lease.kind!=='base','snapshot_query_mismatch');if(base)check(lease.baseSnapshotId===input.baseSnapshotId,'snapshot_query_mismatch');index=lease.index;check(index.rulesVersion===RULES_VERSION&&index.collectorVersion===COLLECTOR_VERSION,'stats_cache_version_mismatch');normalized=normalize(input,index,lease.query.window.cutoffAtInclusive);check(hash(normalized.query)===hash(lease.query),'snapshot_query_mismatch');
  }else{index=base?.index??await readStatsIndex(cache);normalized=normalize(input,index,index.checkedAt);const snapshotId=hash([index.snapshotId,normalized.query,input.baseSnapshotId??null,RULES_VERSION]);const path=join(cache,`stats-lease-${snapshotId}.json`);
    try{lease=JSON.parse(await readFile(path,'utf8'));if(lease.expiresAt<=now)lease=null;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!lease){await pruneLeases(cache,now);if(base)await readStatsLease(cache,input.baseSnapshotId,{now});lease={schemaVersion:1,createdAt:now,expiresAt:Math.min(now+LIMITS.leaseMs,base?.expiresAt??Infinity),snapshotId,baseSnapshotId:input.baseSnapshotId??null,query:normalized.query,index:leaseIndex(index)};const text=JSON.stringify(lease);check(Buffer.byteLength(text)<=LIMITS.responseBytes,'stats_lease_limit');await atomicWrite(path,text);}
  }
  const q=normalized.query,resultKey=hash([cache,lease.snapshotId]);let frozenResult=cachedResult(resultKey,now);if(!frozenResult){frozenResult=await rowsFor(cache,index,q,{now,expiresAt:lease.expiresAt,profile});rememberResult(resultKey,frozenResult,lease.expiresAt);}const {rows,summary:totals,coverage,aggregates,availableTargets}=frozenResult;let page=normalized.page;
  let location;
  if(input.targetId){const position=rows.findIndex(r=>r.id===input.targetId||r.stepId===input.targetId);check(position>=0||availableTargets.has(input.targetId),'target_not_found');
    if(position<0)location={targetId:input.targetId,page:null,indexInPage:null,matchesCurrentFilters:false,targetState:'filtered'};
    else{page=Math.floor(position/q.pageSize)+1;location={targetId:input.targetId,page,indexInPage:position%q.pageSize,matchesCurrentFilters:true,targetState:'present'};}}
  const pageCount=Math.max(1,Math.ceil(rows.length/q.pageSize));page=Math.min(page,pageCount);
  const result={schemaVersion:2,teamId:index.teamId,rulesVersion:RULES_VERSION,queryHash:hash(q),querySnapshotId:lease.snapshotId,baseSnapshotId:lease.baseSnapshotId??null,snapshotExpiresAt:new Date(lease.expiresAt).toISOString(),checkedAt:new Date(now).toISOString(),statsAsOf:index.statsAsOf,window:q.window,
    versions:{sourceManifestRevision:index.manifestRevision,collectorVersion:index.collectorVersion,statsRevision:index.revision},freshness:{stats:index.managedPolicy&&index.managedPolicy.status!=='active'?'stale':index.sources.every(s=>s.status==='fresh')?'partial':index.sources.some(s=>s.status==='backfilling')?'backfilling':'stale',coverageNotProven:true},coverage,...(index.managedPolicy?{managedPolicy:index.managedPolicy}:{}),
    data:{rows:rows.slice((page-1)*q.pageSize,page*q.pageSize),total:rows.length,page,pageSize:q.pageSize,pageCount,sort:q.sort,direction:q.direction,summary:totals,historicalAggregates:aggregates,...(location?{location}:{})}};
  check(Buffer.byteLength(JSON.stringify(result))<=LIMITS.responseBytes,'stats_response_limit');return result;
}

export async function querySourceStatus(cache,roster,input={}, {baseSnapshotId,now=Date.now()}={}){
  exact(input,['preset','from','to'],[]);const index=baseSnapshotId?(await readStatsLease(cache,baseSnapshotId,{now})).index:await readStatsIndex(cache),window=canonicalWindow(input,index.checkedAt);
  const prepared=await preparedRecords(cache,index,now,now+LIMITS.leaseMs);
  return {checkedAt:index.checkedAt,manifestRevision:index.manifestRevision,window,rows:sourceStatus(index,roster,prepared.value.records,window,inWindow),coverageNotProven:true};
}

// Current roster summaries use all immutable records, never a page of epoch
// aggregates. Authorization segments can share an identity; true changed
// host/thread/role/revision histories remain in the existing binding views.
export async function queryCurrentMemberSummaries(cache,roster,input={}, {baseSnapshotId,now=Date.now()}={}){
  exact(input,['preset','from','to'],[]);check(roster.length<=50,'bounded_budget_busy');
  const index=baseSnapshotId?(await readStatsLease(cache,baseSnapshotId,{now})).index:await readStatsIndex(cache),window=canonicalWindow(input,index.checkedAt);
  const prepared=await preparedRecords(cache,index,now,now+LIMITS.leaseMs),bindings=[...new Map(index.bindings.map(b=>[b.key,b])).values()],keysToMember=new Map(),groups=new Map();
  const rows=roster.map(m=>{const identityHash=m.bindingHash??null,matching=bindings.filter(b=>b.memberId===m.id&&hash([b.memberId,b.role,b.hostId,b.threadId])===identityHash),verified=index.managedPolicy?.currentBindings?.find(b=>b.memberId===m.id&&b.identityHash===identityHash),revisions=new Set(matching.map(b=>b.bindingRevision)),revision=verified?.bindingRevision??(revisions.size===1?matching[0].bindingRevision:null);
    const eligible=revision===null?[]:matching.filter(b=>b.bindingRevision===revision&&b.from<=window.cutoffAtInclusive&&b.to>window.startAt);for(const b of eligible)keysToMember.set(b.key,m.id);groups.set(m.id,[]);
    return {memberId:m.id,name:m.name,role:m.role,identityHash,bindingRevision:revision,bindingKeys:eligible.map(b=>b.key),historicalBindingCount:bindings.filter(b=>b.memberId===m.id&&!eligible.some(e=>e.key===b.key)).length,identityBasis:verified?'current Registry tuple and revision at frozen collection':'current verified roster tuple; one unambiguous source revision',coverage:eligible.length?'partial':'sourcesPending'};});
  for(const record of prepared.value.records){const member=keysToMember.get(record.bindingKey);if(member&&inWindow(record,window))groups.get(member).push(record);}
  return rows.map(r=>({...r,time:summary(groups.get(r.memberId),window)}));
}
