import { createStatsSnapshot, queryStats, querySourceStatus, queryCurrentMemberSummaries, readStatsLease, canonicalWindow } from './stats-query.mjs';
import {memberBindingHash} from './source-status.mjs';
import { refreshStats, readStatsIndex, readStatsData } from './stats-collector.mjs';
import { check, hash, LIMITS, RULES_VERSION } from './stats-contract.mjs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const fields=new Set(['mode','dimension','view','preset','from','to','page','pageSize','sort','direction','search','memberId','memberBindingKey','taskId','roundId','stepId','status','series','assurance','sourceId','snapshotId','baseSnapshotId','parentSnapshotId','targetId','targetKind','refresh','stagePage']);
const statsFields=['preset','from','to','page','pageSize','sort','direction','search','memberId','memberBindingKey','taskId','roundId','stepId','status','series','assurance','sourceId','snapshotId','targetId','targetKind'];
const text=(v,limit=512)=>typeof v==='string'?v.slice(0,limit):null;
const activeStatuses=new Set(['assigned','executing','submitted','reviewing','blocked','rework']);
export function parseDashboardQuery(params){
  const input={};for(const [key,value] of params){check(fields.has(key)&&!Object.hasOwn(input,key)&&value.length<=256,'invalid_query');input[key]=value;}
  for(const key of ['page','pageSize','stagePage'])if(input[key]!==undefined){check(/^\d+$/.test(input[key]),'invalid_query');input[key]=Number(input[key]);check(Number.isSafeInteger(input[key])&&input[key]>0,'invalid_query');}
  if(input.pageSize!==undefined)check([20,50].includes(input.pageSize),'invalid_query');
  if(input.direction!==undefined)check(['asc','desc'].includes(input.direction),'invalid_query');
  for(const key of ['baseSnapshotId','snapshotId','parentSnapshotId'])if(input[key]!==undefined)check(/^[a-f0-9]{64}$/.test(input[key]),'invalid_query');
  for(const key of ['memberId','memberBindingKey','taskId','roundId','stepId','sourceId','targetId'])if(input[key]!==undefined)check(input[key].length>0,'invalid_query');
  if(input.search!==undefined)check(input.search.length<=128,'invalid_query');return input;
}
export function projectDashboardState(state,{asOf=state.updatedAt}={}){
  const progress=new Map();for(const e of state.events)if(e.taskId)progress.set(e.taskId,e.at);
  const roster=state.members.map(m=>({id:m.id,name:text(m.name,256),role:m.role,lifecycle:m.lifecycle,bindingStatus:m.binding.status,bindingHash:memberBindingHash(m),
    nameProvenance:{sourceKind:'current-state-roster',sourceVersion:state.version,asOf:state.updatedAt,evidenceId:hash([state.team.id,state.version,m.id])}}));
  const tasks=state.tasks.map(t=>({id:t.id,taskId:t.id,title:text(t.title),roundId:t.roundId,status:t.status,ownerId:t.workerId,
    assignedAt:t.assignedAt,completedAt:t.completedAt,updatedAt:t.stages.at(-1)?.startedAt??state.updatedAt,
    progressAt:progress.get(t.id)??t.assignedAt,
    stages:t.stages.map(s=>[s.status,s.startedAt,s.endedAt]),
    submissionCount:t.submissions?.length??0,taskWallClockMs:t.assignedAt&&t.completedAt?Date.parse(t.completedAt)-Date.parse(t.assignedAt):null}));
  check(tasks.length<=10000&&roster.length<=10000,'bounded_budget_busy');
  return {teamId:state.team.id,teamName:text(state.team.name,256),sourceVersion:state.version,registryRevision:state.registry?.teamRevision??null,stateAsOf:state.updatedAt,
    stageAsOf:asOf,rounds:state.rounds.map(r=>({id:r.id,title:text(r.title,256),status:r.status})),roster,tasks};
}
function expandedStage(task,tuple,i,asOf){const [status,startAt,endAt]=tuple,terminal=['approved','cancelled'].includes(status);return {id:`stage-${task.id}-state-stage:${i}`,status,startAt,endAt,durationMs:startAt&&endAt&&!terminal?Date.parse(endAt)-Date.parse(startAt):null,declaredElapsedToAsOfMs:startAt&&!endAt&&!terminal?Math.max(0,Date.parse(asOf)-Date.parse(startAt)):null,estimateAsOf:asOf,ownerId:null,assurance:'task-declared'};}
function currentCounts(state){const current=state.roster.filter(m=>m.lifecycle==='active');return {members:current.length,roles:Object.fromEntries(['Manager','Liaison','Worker'].map(role=>[role,current.filter(m=>m.role===role).length])),tasks:state.tasks.length,statuses:Object.fromEntries([...new Set(state.tasks.map(t=>t.status))].map(status=>[status,state.tasks.filter(t=>t.status===status).length]))};}
function pageRows(rows,input){const pageSize=input.pageSize??20,pageCount=Math.max(1,Math.ceil(rows.length/pageSize));let page=Math.min(input.page??1,pageCount),location;
  if(input.targetId){const position=rows.findIndex(r=>r.id===input.targetId);location=position<0?{targetId:input.targetId,page:null,indexInPage:null,matchesCurrentFilters:false,targetState:'filtered'}:{targetId:input.targetId,page:Math.floor(position/pageSize)+1,indexInPage:position%pageSize,matchesCurrentFilters:true,targetState:'present'};if(position>=0)page=location.page;}
  return {rows:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,pageCount,...(location?{location}:{})};}
const compare=(a,b)=>a===b?0:a===null||a===undefined?1:b===null||b===undefined?-1:a<b?-1:1;
const pick=(input,keys)=>Object.fromEntries(keys.filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
export function sanitizeDashboardResponse(value){
  if(Array.isArray(value))return value.map(sanitizeDashboardResponse);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,v])=>!['path','command','arguments','sourceRef','authorizationRef'].includes(key)&&(key!=='output'||v===null||typeof v==='number'||v&&typeof v==='object'&&!Array.isArray(v)&&Object.hasOwn(v,'known')&&Object.keys(v).every(k=>['known','knownRecords','missingRecords'].includes(k))&&Object.values(v).every(n=>n===null||typeof n==='number'))).map(([key,v])=>key==='evidenceRef'?['evidenceId',hash(v)]:[key,sanitizeDashboardResponse(v)]));return value;
}
const taskFields=['search','memberId','roundId','status','sort','direction','page','pageSize','snapshotId','baseSnapshotId','targetId'];
function validateEndpoint(endpoint,input){
  const allowed=endpoint==='snapshot'?['refresh']:endpoint==='overview'&&input.mode==='current'?['mode','page','pageSize','search','sort','direction']:
    endpoint==='overview'?['preset','from','to','baseSnapshotId','page','pageSize','search']:endpoint==='tasks'?taskFields:
    endpoint==='task'?['taskId','baseSnapshotId','stagePage','pageSize']:endpoint==='metrics'?['dimension','view','baseSnapshotId','parentSnapshotId',...statsFields]:
    endpoint==='timeline'?['view','baseSnapshotId','parentSnapshotId',...statsFields]:endpoint==='locate'&&input.targetKind==='task'?['targetKind',...taskFields]:
    endpoint==='locate'?['view','targetKind','baseSnapshotId','parentSnapshotId',...statsFields]:endpoint==='coverage'?['baseSnapshotId','preset','from','to','page','pageSize','sourceId']:[];
  check(Object.keys(input).every(k=>allowed.includes(k)),'invalid_query');
  if(input.preset!==undefined){check(['today','7','30','all','custom'].includes(input.preset),'invalid_query');check(input.preset==='custom'?!!input.from&&!!input.to:input.from===undefined&&input.to===undefined,'invalid_query');}
  else check(input.from===undefined&&input.to===undefined,'invalid_query');
  if(input.series!==undefined)check(['native','team-context','team-context-report','activity-sidecar'].includes(input.series),'invalid_query');
  if(input.assurance!==undefined)check(['machine-source-reported','worker-declared','operator-declared','task-declared','host-reported-duration'].includes(input.assurance),'invalid_query');
  if(input.status!==undefined)check(['queued','assigned','executing','submitted','reviewing','approved','cancelled','blocked','rework','pending','yielded','completed','completion-unknown','declared-completed','server-completed','duration-only'].includes(input.status),'invalid_query');
  if(endpoint==='overview'&&input.sort!==undefined)check(['name','id'].includes(input.sort),'invalid_query');
  if(endpoint==='timeline'){check(input.taskId,'invalid_query');if(input.view!==undefined)check(['members','steps','time'].includes(input.view),'invalid_query');}
  if(endpoint==='locate')check(input.targetId&&['task','step','member'].includes(input.targetKind),'invalid_query');
  if(endpoint==='locate'&&input.view!==undefined)check(input.targetKind==='step'&&input.view==='calls','invalid_query');
}

// Only launcher-fixed sources. All leases hold sanitized projections or immutable refs.
export function createDashboardQueries({teamId,current,manifestPath,cache,now=Date.now}){
  const bases=new Map(),taskLeases=new Map();let collecting=null,latestKey=null,latestBase=null;
  const prune=(reserveBytes=0)=>{for(const map of [bases,taskLeases])for(const [key,value] of map)if(value.expiresAt<=now())map.delete(key);
    const bytes=()=>[...bases.values(),...taskLeases.values()].reduce((n,v)=>n+v.bytes,0);
    while(bases.size+taskLeases.size>=32||bytes()+reserveBytes>32*LIMITS.responseBytes){const all=[...bases.entries()].map(([key,v])=>({map:bases,key,at:v.createdAt})).concat([...taskLeases.entries()].map(([key,v])=>({map:taskLeases,key,at:v.createdAt}))).sort((a,b)=>a.at-b.at);check(all.length,'bounded_budget_busy');all[0].map.delete(all[0].key);}
  };
  const stateNow=async()=>{const state=await current();check(state.team.id===teamId,'scope_denied');check(Date.parse(state.updatedAt)<=now(),'source_unavailable');return projectDashboardState(state,{asOf:new Date(now()).toISOString()});};
  const thaw=value=>({...value,state:JSON.parse(inflateRawSync(value.projection,{maxOutputLength:32*LIMITS.responseBytes}).toString('utf8'))});
  const refresh=async()=>{if(!collecting)collecting=refreshStats(manifestPath,cache,{asOf:new Date(now()).toISOString()}).finally(()=>{collecting=null;});const result=await collecting;check(result.teamId===teamId,'scope_denied');return result;};
  const base=async(input={})=>{
    prune();if(input.baseSnapshotId){const value=bases.get(input.baseSnapshotId);check(value&&value.expiresAt>now(),'snapshot_expired');await readStatsLease(cache,value.statsBaseId,{now:now()});return thaw(value);}
    const state=await stateNow();let index;try{index=await readStatsIndex(cache);}catch(e){if(e.code!=='ENOENT')throw e;index=await refresh();}check(index.teamId===teamId,'scope_denied');
    const key=hash([index.snapshotId,index.checkedAt,state.sourceVersion]);if(latestKey===key&&bases.has(latestBase)&&bases.get(latestBase).expiresAt>now())return thaw(bases.get(latestBase));
    // Lossless internal encoding keeps the existing 1 MiB per projection and
    // 32 MiB aggregate admission limits. Decode is bounded by that same total
    // budget; only response pages expand stages. No task/history is discarded.
    const raw=JSON.stringify(state);check(Buffer.byteLength(raw)<=32*LIMITS.responseBytes,'bounded_budget_busy');const projection=deflateRawSync(raw),bytes=projection.byteLength;check(bytes<=LIMITS.responseBytes,'bounded_budget_busy');prune(bytes);
    const frozen=await createStatsSnapshot(cache,{now:now()}),id=hash([frozen.baseSnapshotId,state.sourceVersion]),createdAt=now(),value={id,statsBaseId:frozen.baseSnapshotId,projection,createdAt,expiresAt:frozen.expiresAt,bytes,statsAsOf:index.statsAsOf,statsCheckedAt:index.checkedAt,manifestRevision:index.manifestRevision,collectorVersion:index.collectorVersion,managedPolicy:index.managedPolicy??null};
    bases.set(id,value);latestKey=key;latestBase=id;return {...value,state};
  };
  const envelope=(b,data,extra={})=>({schemaVersion:2,teamId,queryHash:hash(data.query??data),querySnapshotId:b.id,baseSnapshotId:b.id,snapshotExpiresAt:new Date(b.expiresAt).toISOString(),checkedAt:new Date(now()).toISOString(),stateAsOf:b.state.stateAsOf,statsAsOf:b.statsAsOf,
    versions:{sourceVersion:b.state.sourceVersion,registryRevision:b.state.registryRevision,sourceManifestRevision:b.manifestRevision,collectorVersion:b.collectorVersion,rulesVersion:RULES_VERSION,runtimeRevision:null,runtimeRevisionSource:'not-provided'},freshness:{state:'fresh',stats:b.managedPolicy&&b.managedPolicy.status!=='active'?'stale':'partial',coverageNotProven:true},...(b.managedPolicy?{managedPolicy:b.managedPolicy}:{}),data,...extra});
  const metrics=async(b,input,view)=>{
    if(input.parentSnapshotId){const parent=await readStatsLease(cache,input.parentSnapshotId,{now:now()});check(parent.baseSnapshotId===b.statsBaseId,'snapshot_query_mismatch');
      check(parent.kind!=='base'&&parent.query,'snapshot_query_mismatch');const childWindow=canonicalWindow(input,b.statsCheckedAt);
      check(childWindow.from>=parent.query.window.from&&childWindow.to<=parent.query.window.to&&childWindow.cutoffAtInclusive===parent.query.window.cutoffAtInclusive,'snapshot_query_mismatch');
      for(const key of ['memberId','memberBindingKey','taskId','roundId','stepId','series','assurance','sourceId','status'])if(parent.query[key]!==undefined)check(input[key]===parent.query[key],'snapshot_query_mismatch');
      if(parent.query.search!==undefined){if(parent.query.view==='days')check(childWindow.from===childWindow.to&&childWindow.from.toLowerCase().includes(parent.query.search.toLowerCase()),'snapshot_query_mismatch');
        else if(parent.query.view==='members'&&['steps','mcp'].includes(view)&&input.memberBindingKey){
          const {window,...parentQuery}=parent.query,selected=await queryStats(cache,{...parentQuery,preset:window.preset,...(window.preset==='custom'?{from:window.from,to:window.to}:{}),snapshotId:input.parentSnapshotId,baseSnapshotId:b.statsBaseId,targetId:input.memberBindingKey},{now:now()});
          check(selected.data.location.matchesCurrentFilters&&selected.data.rows[selected.data.location.indexInPage]?.memberId===input.memberId,'snapshot_query_mismatch');
          // A member-name search selects bindings, not tool/step text. The
          // selected binding must actually belong to the filtered parent view.
        }else check(input.search===parent.query.search,'snapshot_query_mismatch');}}
    const result=await queryStats(cache,{...pick(input,statsFields),view,baseSnapshotId:b.statsBaseId},{now:now()});check(result.teamId===teamId,'scope_denied');
    const active=b.state.roster.filter(m=>m.lifecycle==='active'),ids=new Set([...result.data.rows.map(r=>r.memberId).filter(Boolean),...active.slice(((input.page??1)-1)*(input.pageSize??20),(input.page??1)*(input.pageSize??20)).map(m=>m.id)]);
    const audit=await querySourceStatus(cache,active.filter(m=>ids.has(m.id)),pick(input,['preset','from','to']),{baseSnapshotId:b.statsBaseId,now:now()});const health=new Map(audit.rows.map(r=>[r.memberId,r]));
    const data={...result.data,currentSourceStatus:audit.rows,currentSourceStatusTotal:active.length,rows:result.data.rows.map(r=>{const current=health.get(r.memberId);return current?.bindingKeys.includes(r.id)?{...r,sourceStatus:current.metrics}:r;})};
    return {...result,data,baseSnapshotId:b.id,statsSourceSnapshotId:b.statsBaseId,stateAsOf:b.state.stateAsOf,versions:{...result.versions,sourceVersion:b.state.sourceVersion,registryRevision:b.state.registryRevision,rulesVersion:RULES_VERSION,runtimeRevision:null,runtimeRevisionSource:'not-provided'},freshness:{...result.freshness,state:'fresh'},parentSnapshotId:input.parentSnapshotId??null};
  };
  const taskRows=async(b,input)=>{
    const query={...pick(input,['search','memberId','roundId','status']),sort:input.sort??'updatedAt',direction:input.direction??'desc',pageSize:input.pageSize??20};check(['id','updatedAt','assignedAt','title','status'].includes(query.sort),'invalid_query');
    if(input.memberId)check(b.state.roster.some(m=>m.id===input.memberId),'target_not_found');if(input.roundId)check(b.state.rounds.some(r=>r.id===input.roundId),'target_not_found');
    const key=hash([b.id,query]);let lease=taskLeases.get(key);
    if(input.snapshotId){check(taskLeases.has(input.snapshotId),'snapshot_expired');check(input.snapshotId===key&&lease,'snapshot_query_mismatch');}
    if(!lease){let contributions=new Set();if(input.memberId){const frozen=await readStatsLease(cache,b.statsBaseId,{now:now()});const documents=await readStatsData(cache,frozen.index);contributions=new Set(documents.flatMap(d=>d.rows).filter(r=>r.memberId===input.memberId&&r.bindingKey&&r.taskId).map(r=>r.taskId));}
      const ids=b.state.tasks.filter(t=>(!input.search||`${t.id} ${t.title}`.toLowerCase().includes(input.search.toLowerCase()))&&(!input.memberId||t.ownerId===input.memberId||contributions.has(t.id))&&(!input.roundId||t.roundId===input.roundId)&&(!input.status||t.status===input.status)).toSorted((a,c)=>(query.direction==='asc'?1:-1)*compare(a[query.sort],c[query.sort])||compare(a.id,c.id)).map(t=>t.id);
      lease={ids,createdAt:now(),expiresAt:b.expiresAt,bytes:Buffer.byteLength(JSON.stringify(ids))};prune(lease.bytes);taskLeases.set(key,lease);}
    if(input.targetId)check(b.state.tasks.some(t=>t.id===input.targetId),'target_not_found');const tasks=new Map(b.state.tasks.map(t=>[t.id,t]));
    const paged=pageRows(lease.ids.map(id=>tasks.get(id)),input);paged.rows=paged.rows.map(({stages,...t})=>({...t,currentStage:stages.length?expandedStage(t,stages.at(-1),stages.length-1,b.state.stageAsOf):null,owner:b.state.roster.find(m=>m.id===t.ownerId)??null}));
    return envelope(b,{...paged,sort:query.sort,direction:query.direction,query},{queryHash:hash(query),querySnapshotId:key});
  };
  return {async handle(endpoint,input){
    validateEndpoint(endpoint,input);
    if(endpoint==='overview'&&input.mode==='current'){
      check(Object.keys(input).every(k=>['mode','page','pageSize','search','sort','direction'].includes(k)),'invalid_query');const s=await stateNow();let roster=s.roster.filter(m=>m.lifecycle==='active'&&(!input.search||`${m.name} ${m.id}`.toLowerCase().includes(input.search.toLowerCase())));if(input.sort==='name')roster.sort((a,b)=>compare(a.name,b.name)||compare(a.id,b.id));
      return {schemaVersion:2,teamId,checkedAt:new Date(now()).toISOString(),stateAsOf:s.stateAsOf,versions:{sourceVersion:s.sourceVersion,registryRevision:s.registryRevision},freshness:{state:'fresh'},data:{teamName:s.teamName,counts:currentCounts(s),rounds:s.rounds,...pageRows(roster.map(m=>({...m,currentTask:s.tasks.find(t=>t.ownerId===m.id&&activeStatuses.has(t.status))??null})).map(({currentTask,...m})=>({...m,currentTask:currentTask?{id:currentTask.id,title:currentTask.title,status:currentTask.status}:null})),input)}};
    }
    if(endpoint==='snapshot'){check(Object.keys(input).every(k=>k==='refresh'),'invalid_query');check(input.refresh===undefined||input.refresh==='stats','invalid_query');let readEvidence=null;if(input.refresh==='stats')readEvidence=(await refresh()).readEvidence;const b=await base();return envelope(b,{readEvidence});}
    const b=await base(input);
    if(endpoint==='tasks'||endpoint==='locate'&&(input.targetKind??'task')==='task')return taskRows(b,input);
    if(endpoint==='task'){
      check(input.taskId,'invalid_query');const t=b.state.tasks.find(t=>t.id===input.taskId);check(t,'target_not_found');const frozen=await readStatsLease(cache,b.statsBaseId,{now:now()}),documents=await readStatsData(cache,frozen.index),records=documents.flatMap(d=>d.rows).filter(r=>r.taskId===t.id);const stageData=pageRows(t.stages,{...input,page:input.stagePage??1});stageData.rows=stageData.rows.map((s,i)=>expandedStage(t,s,(stageData.page-1)*stageData.pageSize+i,b.state.stageAsOf));return envelope(b,{task:{...t,stages:undefined,owner:b.state.roster.find(m=>m.id===t.ownerId)??null},contributorsSummary:{memberCount:new Set(records.filter(r=>r.bindingKey).map(r=>r.memberId)).size,bindingCount:new Set(records.map(r=>r.bindingKey).filter(Boolean)).size,unattributedRecords:records.filter(r=>!r.bindingKey).length,basis:'explicit sanitized task association; recorded owner is separate'},acceptance:{status:t.status,completedAt:t.completedAt,recorded:t.status==='approved'},stages:stageData,stageOwnership:'unattributed; task owner is not stage owner',coverage:'partial'});
    }
    if(endpoint==='overview'){
      const result=await metrics(b,{...input,view:undefined,search:undefined,page:1,pageSize:20},'days');const members=await metrics(b,{...input,page:input.page??1,pageSize:input.pageSize??20},'members');const currentIds=new Set(b.state.roster.filter(m=>m.lifecycle==='active').map(m=>m.id));
      const currentPage=pageRows(b.state.roster.filter(m=>m.lifecycle==='active'),input),currentMemberSummaries=await queryCurrentMemberSummaries(cache,currentPage.rows,pick(input,['preset','from','to']),{baseSnapshotId:b.statsBaseId,now:now()});
      return {...result,data:{teamName:b.state.teamName,counts:currentCounts(b.state),members:members.data,currentMemberSummaries,currentSourceStatus:members.data.currentSourceStatus,currentMemberCount:currentIds.size,summary:result.data.summary,recentAccepted:b.state.tasks.filter(t=>t.status==='approved').toSorted((a,c)=>compare(c.completedAt,a.completedAt)||compare(a.id,c.id)).slice(0,3).map(t=>({id:t.id,title:t.title,completedAt:t.completedAt})),historyBasis:'current tuple/revision summaries across authorization segments; true historical bindings stay separate'}};
    }
    if(endpoint==='coverage')return metrics(b,input,'coverage');
    if(endpoint==='timeline'){check(input.taskId,'invalid_query');return metrics(b,input,input.view==='steps'?'steps':input.view==='members'?'members':'time');}
    if(endpoint==='locate'){check(['step','member'].includes(input.targetKind),'invalid_query');return metrics(b,input,input.targetKind==='member'?'members':input.view==='calls'?'mcp':'steps');}
    if(endpoint==='metrics'){
      check(['time','token','mcp'].includes(input.dimension),'invalid_query');check(input.view===undefined||['tasks','members','steps','calls','days'].includes(input.view),'invalid_query');
      const view=input.view==='calls'?'mcp':input.view??(input.dimension==='time'?'tasks':'days');return metrics(b,input,view);
    }
    check(false,'target_not_found');
  },close(){bases.clear();taskLeases.clear();}};
}
