import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createState, evolve } from '../src/runtime.mjs';
import { MetadataJsonParser } from '../src/stats-json-stream.mjs';
import { refreshStats, readStatsData, releaseStatsSession } from '../src/stats-collector.mjs';
import { queryStats, clippedInterval, createStatsSnapshot } from '../src/stats-query.mjs';
import { recordActivity } from '../src/stats-activity.mjs';
import { demoState } from '../src/demo.mjs';
import { bindingKey, hash } from '../src/stats-contract.mjs';
const asOf='2026-10-05T06:00:00.000Z';
const binding={memberId:'worker',bindingRevision:1,hostId:'local',threadId:'thread',role:'Worker',roleEpoch:'worker-epoch-1',from:'2026-09-01T00:00:00.000Z',to:'2026-11-01T00:00:00.000Z',evidenceRef:'fixture:binding'};
const scope={authorizedFrom:binding.from,authorizedTo:binding.to,coverageAssertions:{status:'partial',evidenceRef:'fixture:coverage'},evidenceRef:'fixture:source',bindings:[binding],selection:{taskId:null,roundId:null,turnIds:[],itemIds:[]}};
const temporaryRoots=[];
test.after(async()=>{const parent=await realpath(tmpdir());for(const directory of temporaryRoots){const target=await realpath(directory);assert.ok(target.startsWith(parent+sep)&&/^runtime-stats-u1-/.test(basename(target)));releaseStatsSession(join(directory,'cache'));await new Promise(r=>setImmediate(r));await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});}});
async function setup(kind='codex-jsonl',extra={}){
  const root=await mkdtemp(join(tmpdir(),'runtime-stats-u1-')),path=join(root,'source.jsonl'),cache=join(root,'cache'),manifestPath=join(root,'manifest.json');
  temporaryRoots.push(root);
  const source={sourceId:'source',kind,path,adapterVersion:'v1',mutationPolicy:kind.endsWith('jsonl')?'append-only':'mutable',...scope,...extra};
  const manifest={schemaVersion:'dashboard-sources/v1',teamId:'team',registryId:'registry',revision:1,authorizationRef:'fixture:authorization',sources:[source]};
  await writeFile(manifestPath,JSON.stringify(manifest));await writeFile(path,'');
  return {root,path,cache,manifestPath,manifest,source,refresh:options=>refreshStats(manifestPath,cache,{asOf,...options})};
}
const session=()=>({type:'session_meta',payload:{id:'thread'}});
const usage=(n,at='2026-10-03T00:00:00.000Z')=>({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{last_token_usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2,reasoning_output_tokens:1,total_tokens:99},total_token_usage:{input_tokens:10*n,cached_input_tokens:4*n,output_tokens:2*n,reasoning_output_tokens:n,total_tokens:99*n}}}});
const jsonl=events=>events.map(e=>JSON.stringify(e)).join('\n')+'\n';
const events=index=>({schemaVersion:'activity-sidecar/v1',eventId:`step-${index}`,phase:'begin',teamId:'team',...binding,stepId:`s-${index}`,taskId:'task',roundId:'round',at:'2026-10-03T15:59:50.000Z',assurance:'worker-declared',sourceKind:'activity-sidecar',evidenceRef:'fixture:event'});
function activity(index,patch={}){const {from,to,...event}=events(index);return {...event,...patch};}
async function allRows(s,index){return (await readStatsData(s.cache,index)).flatMap(d=>d.rows);}

test('stream grammar skips large bodies but validates escapes, depth, UTF-8 adjacent metadata and duplicate keys',()=>{
  const p=new MetadataJsonParser();const line=JSON.stringify({type:'session_meta',payload:{id:'thread',message:'secret\n中文"\\'},body:'\"\\\n'.repeat(10000)});
  for(let i=0;i<line.length;i+=7)p.push(line.slice(i,i+7));assert.deepEqual(JSON.parse(JSON.stringify(p.finish())),{type:'session_meta',payload:{id:'thread'}});assert.ok(p.metadataBytes<256);
  for(const bad of ['{"body":"bad\\x"}','{"a":1,"a":2}','[1,]','{"a":01}','{"a":false}oops']){assert.throws(()=>{const parser=new MetadataJsonParser();parser.push(bad);parser.finish();});}
  assert.throws(()=>{const parser=new MetadataJsonParser({maxDepth:2});parser.push('{"a":{"b":{}}}');},/depth/);
});
test('append counter state resumes; second unchanged read is zero; partial tail commits once; repeat counter is deduped',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const first=await s.refresh();assert.equal((await allRows(s,first)).length,1);
  const second=await s.refresh();assert.equal(second.readEvidence.readBytes,0);assert.ok(second.readEvidence.anchorBytes<=8192);
  const line=JSON.stringify(usage(2));await appendFile(s.path,line.slice(0,53));const pending=await s.refresh();assert.equal((await allRows(s,pending)).length,1);
  await appendFile(s.path,line.slice(53)+'\n'+jsonl([usage(2)]));const final=await s.refresh();assert.equal((await allRows(s,final)).length,2);
  const q=await queryStats(s.cache,{view:'token'},{now:Date.parse(asOf)});assert.equal(q.data.summary.token.nativeTotal.total.known,198);assert.equal(q.data.summary.token.nativeTotal.net.known,16);assert.equal(q.data.summary.token.nativeTotal.reasoningOutput.known,2);
  assert.equal(JSON.stringify(await readFile(join(s.cache,final.sources[0].dataRef),'utf8')).includes('last_token_usage'),false);
});
test('40 MiB valid record advances volatile offset across six bounded passes without repeating prefixes',async()=>{
  const s=await setup();const text='{"body":"'+'x'.repeat(40*1024*1024)+'","type":"session_meta","payload":{"id":"thread"}}\n'+jsonl([usage(1)]);await writeFile(s.path,text);
  let bytes=0,last=0,index,passes=0;do{index=await s.refresh();bytes+=index.readEvidence.readBytes;assert.ok(index.readEvidence.readBytes<=8*1024*1024);assert.ok(index.sources[0].volatileScannedBytes>=last);last=index.sources[0].volatileScannedBytes;passes++;assert.ok(passes<100);if(last<40*1024*1024)assert.equal(index.sources[0].committedOffset,0);}while(index.sources[0].status!=='fresh');
  assert.equal(bytes,Buffer.byteLength(text));assert.ok(passes>=6);assert.equal((await allRows(s,index)).length,1);
});
test('crash before atomic commit does not advance checkpoint and retry has no duplicate records',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const first=await s.refresh();await appendFile(s.path,jsonl([usage(2)]));
  await assert.rejects(s.refresh({beforeCommit(){throw new Error('fixture crash');}}),/crash/);assert.equal(JSON.parse(await readFile(join(s.cache,'stats-index.json'))).revision,first.revision);
  releaseStatsSession(s.cache);const recovered=await s.refresh();assert.equal((await allRows(s,recovered)).length,2);
});
test('incomplete long-line restart replays only uncommitted prefix; rotation and truncate replace rather than add generations',async()=>{
  const s=await setup();const text='{"body":"'+'x'.repeat(1024*1024)+'","type":"session_meta","payload":{"id":"thread"}}\n'+jsonl([usage(1)]);await writeFile(s.path,text);
  const first=await s.refresh({maxReadBytes:256*1024});assert.equal(first.sources[0].committedOffset,0);releaseStatsSession(s.cache);
  let index;do{index=await s.refresh({maxReadBytes:256*1024});}while(index.sources[0].status!=='fresh');assert.equal((await allRows(s,index)).length,1);assert.ok(index.sources[0].diagnostics.some(d=>d.code==='restart_incomplete_line_replayed_once'));
  await rename(s.path,join(s.root,'rotated.jsonl'));await writeFile(s.path,jsonl([session(),usage(2)]));const rotated=await s.refresh();assert.ok(rotated.sources[0].generation>index.sources[0].generation);assert.equal((await allRows(s,rotated)).length,1);
  await writeFile(s.path,jsonl([session()]));const truncated=await s.refresh();assert.equal((await allRows(s,truncated)).length,0);
});
test('bad/over-limit source pauses at precise offset, retains lastGood and reads zero on next pass',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)])+'{"bad":"\\x"}\n');const bad=await s.refresh();assert.equal((await allRows(s,bad)).length,1);assert.match(bad.sources[0].status,/source_bad_json/);
  const again=await s.refresh();assert.equal(again.readEvidence.readBytes,0);
  const giant=await setup();await writeFile(giant.path,'{"body":"'+'x'.repeat(64*1024*1024+1));let index;do{index=await giant.refresh();}while(index.sources[0].status==='backfilling');assert.equal(index.sources[0].status,'source_line_limit');assert.equal((await giant.refresh()).readEvidence.readBytes,0);
});
test('declared begin/end intervals remain separate from machine series; overlap union, cross-midnight clipping and missing end',async()=>{
  const s=await setup('activity-jsonl',{selection:{taskId:'task',roundId:'round',turnIds:[],itemIds:[]}});
  await writeFile(s.path,jsonl([activity(1),activity(1,{phase:'end',at:'2026-10-03T16:00:10.000Z'}),activity(2,{at:'2026-10-03T15:59:55.000Z'}),activity(2,{phase:'end',at:'2026-10-03T16:00:15.000Z'}),activity(3)]));
  await s.refresh();const q=await queryStats(s.cache,{view:'time',preset:'custom',from:'2026-10-04',to:'2026-10-04'},{now:Date.parse(asOf)});
  assert.equal(q.data.summary.intervals[0].observedUnionMs,15000);assert.equal(q.data.summary.intervals[0].assurance,'worker-declared');assert.equal(q.data.summary.waitingMs,null);
  const days=await queryStats(s.cache,{view:'days'},{now:Date.parse(asOf)});assert.deepEqual(days.data.rows.map(r=>r.summary.intervals[0].observedUnionMs),[15000,10000]);
  const all=await queryStats(s.cache,{view:'time'},{now:Date.parse(asOf)});assert.equal(all.data.rows.find(r=>r.id==='step-3').durationMs,null);assert.equal(all.data.summary.intervals[0].missingEndpoints,1);
});
test('sidecar producer closed schema, explicit task/epoch/team validation, pending begin and duplicate/conflicting identity',async()=>{
  const s=await setup('activity-jsonl',{selection:{taskId:'task',roundId:'round',turnIds:[],itemIds:[]}});
  for(const patch of [{teamId:'other'},{memberId:'other'},{bindingRevision:2},{taskId:'other'},{secret:'bad'},{assurance:'machine-source-reported'}])await assert.rejects(recordActivity(s.manifestPath,'source',activity(1,patch)));
  await recordActivity(s.manifestPath,'source',activity(1));await recordActivity(s.manifestPath,'source',activity(1));const begin=await s.refresh();assert.equal((await allRows(s,begin)).length,1);assert.equal((await allRows(s,begin))[0].endAt,null);
  await recordActivity(s.manifestPath,'source',activity(1,{phase:'end',at:'2026-10-03T16:00:00.000Z'}));const end=await s.refresh();assert.equal((await allRows(s,end)).length,1);assert.ok((await allRows(s,end))[0].endAt);
  await appendFile(s.path,jsonl([activity(1,{phase:'end',at:'2026-10-03T16:00:01.000Z'})]));const conflict=await s.refresh();assert.match(conflict.sources[0].status,/event_conflict/);assert.equal((await allRows(s,conflict))[0].endAt,'2026-10-03T16:00:00.000Z');
});
test('historical binding/role epochs are preserved, ambiguous identity is unattributed and new members sourcesPending',async()=>{
  const later={...binding,role:'Manager',roleEpoch:'manager-epoch-2',from:'2026-10-03T16:00:00.000Z'};const earlier={...binding,to:later.from};
  const s=await setup('codex-jsonl',{bindings:[earlier,later]});await writeFile(s.path,jsonl([session(),usage(1,'2026-10-03T15:59:59.000Z'),usage(2,'2026-10-03T16:00:01.000Z')]));await s.refresh();
  const q=await queryStats(s.cache,{view:'token'},{now:Date.parse(asOf)});assert.deepEqual(new Set(q.data.rows.map(r=>r.role)),new Set(['Worker','Manager']));assert.equal(new Set(q.data.rows.map(r=>r.memberBindingKey)).size,2);assert.ok(q.data.rows.some(r=>r.attribution==='team-shared'));
  s.manifest.sources[0].bindings.push({...later,roleEpoch:'overlap'});s.manifest.revision++;await writeFile(s.manifestPath,JSON.stringify(s.manifest));await s.refresh();const conflict=await queryStats(s.cache,{view:'token'},{now:Date.parse(asOf)});assert.equal(conflict.data.summary.token.unattributed.total.known,99);
});
function serverEvent(patch={}){return {schemaVersion:1,eventId:randomUUID(),startedAt:'2026-10-03T15:59:59.000Z',completedAt:'2026-10-03T16:00:01.000Z',durationMs:1900,tool:'team_context.read',registryId:'registry',teamId:'team',memberId:'worker',role:'Worker',hostId:'local',threadId:'thread',memberStatus:'active',identitySource:'registry-at-call-start',reason:'resume',reasonSource:'agent-declared',outcome:'matched',errorCode:null,policyRevision:2,runtimeRevision:null,runtimeRevisionSource:'unknown',...patch};}
test('immutable Team Context catalog only reads new files, source series are independent, wrong team fails',async()=>{
  const s=await setup('team-context-root',{mutationPolicy:'immutable'});const root=join(s.root,'observations');s.manifest.sources[0].path=root;s.manifest.sources[0].authorizedFrom='2026-10-03T00:00:00.000Z';s.manifest.sources[0].authorizedTo='2026-10-04T00:00:00.000Z';await mkdir(join(root,'2026-10-03'),{recursive:true});await writeFile(s.manifestPath,JSON.stringify(s.manifest));
  const event=serverEvent();await writeFile(join(root,'2026-10-03',`${event.eventId}.json`),JSON.stringify(event));const first=await s.refresh();assert.equal((await allRows(s,first)).length,1);assert.equal((await s.refresh()).readEvidence.readBytes,0);
  const q=await queryStats(s.cache,{view:'mcp'},{now:Date.parse(asOf)});assert.equal(q.data.summary.mcp.find(r=>r.sourceKind==='team-context').calls,1);assert.equal(q.data.summary.mcp.find(r=>r.sourceKind==='native').calls,null);assert.equal(q.data.rows[0].reportedDurationMs,1900);assert.equal(q.data.rows[0].durationMs,2000);
  const invalid=serverEvent({teamId:'other'});await writeFile(join(root,'2026-10-03',`${invalid.eventId}.json`),JSON.stringify(invalid));const failed=await s.refresh();assert.equal(failed.sources[0].status,'error');assert.equal((await allRows(s,failed)).length,1);
});
test('recorded stages have no inferred member ownership, terminal/missing ends null; same-snapshot pagination/locate survives refresh',async()=>{
  const s=await setup('recorded-state',{bindings:[],authorizedFrom:'2026-09-01T00:00:00.000Z'});s.manifest.teamId='demo-team';await writeFile(s.manifestPath,JSON.stringify(s.manifest));await writeFile(s.path,JSON.stringify(demoState()));await s.refresh();
  const q=await queryStats(s.cache,{view:'tasks',preset:'all',pageSize:20},{now:Date.parse(asOf)});assert.equal(q.data.total,4);const steps=await queryStats(s.cache,{view:'steps',preset:'all',taskId:'T-1'},{now:Date.parse(asOf)});assert.ok(steps.data.rows.every(r=>r.memberBindingKey===null));assert.ok(steps.data.rows.some(r=>r.durationMs===null));
  await s.refresh();const locate=await queryStats(s.cache,{view:'tasks',preset:'all',pageSize:20,snapshotId:q.querySnapshotId,targetId:'T-3'},{now:Date.parse(asOf)+1000});assert.equal(locate.querySnapshotId,q.querySnapshotId);assert.equal(locate.data.location.page,1);
  await assert.rejects(queryStats(s.cache,{view:'tasks',preset:'all',snapshotId:q.querySnapshotId},{now:Date.parse(asOf)+120000}),/snapshot_expired/);
  await assert.rejects(queryStats(s.cache,{view:'tasks',preset:'all',status:'executing',snapshotId:q.querySnapshotId},{now:Date.parse(asOf)}),/mismatch/);
});
test('1000 steps pages and locate have deterministic ties; same normalized latest query reuses a lease; future/unknown queries reject',async()=>{
  const s=await setup('activity-jsonl',{selection:{taskId:'task',roundId:'round',turnIds:[],itemIds:[]}});await writeFile(s.path,jsonl(Array.from({length:1000},(_,i)=>activity(i))));await s.refresh();
  const q=await queryStats(s.cache,{view:'steps',sort:'at',direction:'asc',pageSize:50},{now:Date.parse(asOf)});assert.equal(q.data.total,1000);assert.equal(q.data.rows.length,50);
  const next=await queryStats(s.cache,{view:'steps',sort:'at',direction:'asc',pageSize:50,page:2,snapshotId:q.querySnapshotId},{now:Date.parse(asOf)+100});assert.equal(new Set([...q.data.rows,...next.data.rows].map(r=>r.id)).size,100);
  const locate=await queryStats(s.cache,{view:'steps',sort:'at',direction:'asc',pageSize:50,targetId:'step-999',snapshotId:q.querySnapshotId},{now:Date.parse(asOf)+200});assert.equal(locate.data.location.page,20);
  const again=await queryStats(s.cache,{view:'steps',sort:'at',direction:'asc',pageSize:50},{now:Date.parse(asOf)+5000});assert.equal(again.querySnapshotId,q.querySnapshotId);
  for(const query of [{unexpected:1},{preset:'custom',from:'2026-02-30',to:'2026-03-01'},{preset:'custom',from:'2026-10-05',to:'2026-10-06'},{pageSize:100}])await assert.rejects(queryStats(s.cache,query,{now:Date.parse(asOf)}));
});
test('single-flight coalesces concurrent reads; interrupted file retains published data',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const [a,b]=await Promise.all([s.refresh(),s.refresh()]);assert.equal(a.revision,b.revision);await rename(s.path,join(s.root,'missing.jsonl'));const failed=await s.refresh();assert.equal(failed.sources[0].status,'error');assert.equal((await allRows(s,failed)).length,1);
});
test('real process crash leaves owned cache lock recoverable and uncommitted data excluded',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const initial=await s.refresh();await appendFile(s.path,jsonl([usage(2)]));
  const script=`import {refreshStats} from ${JSON.stringify(new URL('../src/stats-collector.mjs',import.meta.url).href)};await refreshStats(${JSON.stringify(s.manifestPath)},${JSON.stringify(s.cache)},{asOf:${JSON.stringify(asOf)},beforeCommit(){process.exit(17)}});`;
  const code=await new Promise((accept,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore',windowsHide:true});child.on('error',reject);child.on('exit',accept);});assert.equal(code,17);
  assert.equal(JSON.parse(await readFile(join(s.cache,'stats-index.json'))).revision,initial.revision);const recovered=await s.refresh();assert.equal((await allRows(s,recovered)).length,2);
});
test('UTF-8 tail spans byte chunks; metadata overflow/escaped strings reject without retaining secrets; blank lines preserve counter line numbers',async()=>{
  const s=await setup();const text='\n'+jsonl([session(),{type:'event_msg',message:'中文'.repeat(10000)},usage(1)]);await writeFile(s.path,text);let index;do{index=await s.refresh({maxReadBytes:16384});}while(index.sources[0].status!=='fresh');assert.equal((await allRows(s,index)).length,1);assert.equal(index.sources[0].parserState.usage.lineNumber,4);
  const p=new MetadataJsonParser({maxMetadataBytes:128});assert.throws(()=>{p.push('{"type":"'+'\\u0061'.repeat(129)+'"}');p.finish();},/metadata/);
  const bad=await setup();await writeFile(bad.path,Buffer.from([123,34,98,111,100,121,34,58,34,0xc3,0x28,34,125,10]));const invalid=await bad.refresh();assert.match(invalid.sources[0].status,/source_/);
});
test('mutable source detects growth+middle rewrite; append contract periodically revalidates and discloses integrity basis',async()=>{
  const s=await setup('codex-jsonl',{mutationPolicy:'mutable'});await writeFile(s.path,jsonl([session(),usage(1)]));await s.refresh();await writeFile(s.path,jsonl([session(),usage(2),usage(3)]));const replaced=await s.refresh();assert.equal((await allRows(s,replaced)).length,2);assert.equal(replaced.sources[0].integrityBasis,'budgeted-prefix-revalidation');
  const a=await setup();await writeFile(a.path,jsonl([session(),usage(1)]));const old=await a.refresh();const same=await a.refresh({asOf:'2026-10-05T06:01:00.000Z'});assert.equal(same.sources[0].generation,old.sources[0].generation);const audit=await a.refresh({asOf:'2026-10-05T06:10:01.000Z'});assert.ok(audit.sources[0].generation>old.sources[0].generation);assert.equal((await allRows(a,audit)).length,1);assert.equal(audit.sources[0].integrityBasis,'operator-append-contract+boundary-checks');
});
test('immutable catalog >256 files advances durable and volatile cursors, restart is idempotent, modified same ID quarantines',async()=>{
  const s=await setup('team-context-root',{mutationPolicy:'immutable'}),root=join(s.root,'observations');s.manifest.sources[0].path=root;s.manifest.sources[0].authorizedFrom='2026-10-03T00:00:00.000Z';s.manifest.sources[0].authorizedTo='2026-10-03T23:59:59.999Z';await mkdir(join(root,'2026-10-03'),{recursive:true});await writeFile(s.manifestPath,JSON.stringify(s.manifest));
  const records=Array.from({length:300},()=>serverEvent());await Promise.all(records.map(r=>writeFile(join(root,'2026-10-03',`${r.eventId}.json`),JSON.stringify(r))));const first=await s.refresh();assert.equal(first.sources[0].status,'backfilling');assert.equal(first.sources[0].newFiles,256);releaseStatsSession(s.cache);await new Promise(r=>setImmediate(r));const done=await s.refresh();assert.equal((await allRows(s,done)).length,300);assert.equal((await s.refresh()).readEvidence.readBytes,0);
  await writeFile(join(root,'2026-10-03',`${records[0].eventId}.json`),JSON.stringify({...records[0],durationMs:1800}));const conflict=await s.refresh();assert.equal(conflict.sources[0].status,'error');assert.ok(conflict.sources[0].diagnostics.some(d=>d.code==='source_event_conflict'));
});
test('1000 recorded tasks sort/filter/page/locate on server; filtered target does not fall back; unchanged snapshot is pinned',async()=>{
  const s=await setup('recorded-state',{bindings:[],authorizedFrom:'2026-09-01T00:00:00.000Z'});s.manifest.teamId='many-team';await writeFile(s.manifestPath,JSON.stringify(s.manifest));
  const source={kind:'fixture',ref:'fixture:1000tasks'};const workers=Array.from({length:1000},(_,i)=>({id:`worker-${i}`,name:`Worker ${i}`,role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:`thread-${i}`}}));
  let state=createState({teamId:'many-team',name:'many',source,members:[{id:'liaison',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:'liaison-thread'}},{id:'manager',name:'Manager',role:'Manager',lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:'manager-thread'}},...workers]},'2026-10-03T00:00:00.000Z');
  state=evolve(state,{id:'open',type:'openRound',actor:'manager',at:'2026-10-03T00:00:01.000Z',source,roundId:'round',title:'many'},0);
  for(let i=0;i<1000;i++)state=evolve(state,{id:`assign-${i}`,type:'assign',actor:'manager',at:new Date(Date.parse('2026-10-03T00:00:02.000Z')+i).toISOString(),source,roundId:'round',taskId:`task-${String(i).padStart(4,'0')}`,title:`Task ${i}`,workerId:`worker-${i}`,required:false,assignedAt:null},state.version);
  await writeFile(s.path,JSON.stringify(state));const refreshed=await s.refresh();assert.equal(refreshed.sources[0].status,'fresh');
  const first=await queryStats(s.cache,{view:'tasks',sort:'id',direction:'asc',pageSize:20},{now:Date.parse(asOf)});assert.equal(first.data.total,1000);assert.equal(first.data.pageCount,50);assert.equal(first.data.rows.length,20);assert.equal(first.data.rows[0].taskWallClockMs,null);
  const located=await queryStats(s.cache,{view:'tasks',sort:'id',direction:'asc',pageSize:20,snapshotId:first.querySnapshotId,targetId:'task-0999'},{now:Date.parse(asOf)+100});assert.equal(located.data.location.page,50);
  const filtered=await queryStats(s.cache,{view:'tasks',search:'Task 1',targetId:'task-0999'},{now:Date.parse(asOf)});assert.equal(filtered.data.location.matchesCurrentFilters,false);assert.equal(filtered.data.location.page,null);
});
test('lease capacity evicts old query IDs and never silently rebases page; source scopes reject duplicate paths and unknown fields',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));await s.refresh();const old=await queryStats(s.cache,{view:'token',search:'initial'},{now:Date.parse(asOf)});
  for(let i=0;i<32;i++)await queryStats(s.cache,{view:'token',search:`query-${i}`},{now:Date.parse(asOf)+i+1});await assert.rejects(queryStats(s.cache,{view:'token',search:'initial',snapshotId:old.querySnapshotId},{now:Date.parse(asOf)+50}),/snapshot_expired/);
  s.manifest.sources.push({...s.source,sourceId:'duplicate'});await writeFile(s.manifestPath,JSON.stringify(s.manifest));await assert.rejects(s.refresh(),/duplicate_source_path/);
});

test('one cross-midnight MCP completion counts on only its completion day; duration splits and views agree',async()=>{
  const s=await setup('team-context-event');await writeFile(s.path,JSON.stringify(serverEvent()));await s.refresh();
  const daily=await queryStats(s.cache,{view:'days'},{now:Date.parse(asOf)});
  for(const [date,count] of [['2026-10-03',null],['2026-10-04',1]]){
    const options={preset:'custom',from:date,to:date},mcp=await queryStats(s.cache,{view:'mcp',...options},{now:Date.parse(asOf)}),member=await queryStats(s.cache,{view:'members',...options},{now:Date.parse(asOf)});
    const day=daily.data.rows.find(r=>r.date===date);assert.equal(day.summary.mcp[1].calls,count);assert.equal(mcp.data.summary.mcp[1].calls,count);assert.equal(member.data.rows[0].time.mcp[1].calls,count);assert.equal(mcp.data.total,count??0);
    assert.equal(day.summary.intervals[0].observedUnionMs,1000);assert.equal(member.data.rows[0].time.intervals[0].observedUnionMs,1000);
  }
  await writeFile(s.path,JSON.stringify(serverEvent({startedAt:'2026-10-03T15:59:59.000Z',completedAt:'2026-10-03T16:00:00.000Z',durationMs:1000})));await s.refresh();
  const days=await queryStats(s.cache,{view:'days'},{now:Date.parse(asOf)});assert.equal(days.data.rows.find(r=>r.date==='2026-10-04').summary.intervals[0].observedUnionMs,null);assert.equal(days.data.rows.find(r=>r.date==='2026-10-04').summary.mcp[1].calls,1);
  assert.equal(clippedInterval({startAt:'2026-10-03T15:59:59.000Z',endAt:'2026-10-03T16:00:00.000Z'},days.window&&{...days.window,startAt:'2026-10-03T16:00:00.000Z'}),null);
});

const call=(id,name,at,args={})=>({type:'response_item',timestamp:at,payload:{type:'function_call',name,call_id:id,arguments:JSON.stringify(args)}});
const output=(id,at,value)=>({type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:id,output:value}});
const nativeEnvelope=(patch={})=>JSON.stringify({chunk_id:'abc123',wall_time_seconds:1,session_id:null,exit_code:0,output:'SECRET BODY',...patch});
test('native pending, yielded, arbitrary response and verified completion have distinct counts and time',async()=>{
  const s=await setup();const start='2026-10-03T12:00:00.000Z',end='2026-10-03T12:00:01.000Z';
  await writeFile(s.path,jsonl([session(),call('pending','mcp__sample__run',start),call('yield','mcp__sample__exec_command',start),output('yield',end,'Process running with session ID 12345'),call('unknown','mcp__sample__run',start),output('unknown',end,'SECRET arbitrary response'),call('done','mcp__sample__run',start),output('done',end,nativeEnvelope())]));await s.refresh();
  const q=await queryStats(s.cache,{view:'mcp'},{now:Date.parse(asOf)});assert.equal(q.data.summary.mcp[0].calls,1);assert.equal(q.data.summary.mcp[0].requests,4);assert.equal(q.data.summary.mcp[0].responses,3);assert.equal(q.data.summary.mcp[0].completionUnknown,3);assert.ok(q.data.summary.mcp[0].missing.includes('execution-completion-unproven'));
  const rows=q.data.rows,byStatus=Object.fromEntries(rows.map(r=>[r.status,r]));assert.equal(byStatus.pending.responseAt,null);assert.equal(byStatus.pending.durationMs,null);assert.equal(byStatus.yielded.firstYieldAt,end);assert.equal(byStatus.yielded.endAt,null);assert.equal(byStatus.yielded.requestResponseMs,1000);assert.equal(byStatus['completion-unknown'].completionKnown,false);assert.equal(byStatus.completed.durationMs,1000);assert.equal(q.data.summary.intervals[0].completedSteps,1);assert.equal(q.data.summary.intervals[0].observedUnionMs,1000);assert.equal(q.data.summary.intervals[0].requestResponseUnionMs,1000);
  const cache=await readFile(join(s.cache,(await s.refresh()).sources[0].dataRef),'utf8');assert.equal(cache.includes('SECRET'),false);assert.equal(cache.includes('arguments'),false);
  const only=await setup();await writeFile(only.path,jsonl([session(),call('yield','mcp__sample__exec_command',start),output('yield',end,'Process running with session ID 12345')]));await only.refresh();const yielded=await queryStats(only.cache,{view:'time'},{now:Date.parse(asOf)});assert.equal(yielded.data.summary.intervals[0].observedUnionMs,null);assert.equal(yielded.data.summary.intervals[0].completedSteps,0);assert.equal(yielded.data.summary.intervals[0].requestResponseUnionMs,1000);
});

test('explicit process and script continuation proves later completion across checkpoint restart, retaining first yield',async()=>{
  for(const [kind,tool,first,poll,args,last] of [
    ['process','functions.exec_command',nativeEnvelope({session_id:12345,exit_code:null}),'functions.write_stdin',{session_id:12345},nativeEnvelope()],
    ['script','functions.exec','Script running with cell ID cell1\nWall time 1 seconds\nOutput:\nSECRET','functions.wait',{cell_id:'cell1'},'Script completed\nWall time 4 seconds\nOutput:\nSECRET']]){
    const s=await setup(),start='2026-10-03T12:00:00.000Z',yieldAt='2026-10-03T12:00:01.000Z',end='2026-10-03T12:00:05.000Z';await writeFile(s.path,jsonl([session(),call('root',tool,start),output('root',yieldAt,first)]));await s.refresh();releaseStatsSession(s.cache);
    await appendFile(s.path,jsonl([call('poll',poll,'2026-10-03T12:00:04.000Z',args),output('poll',end,last)]));const index=await s.refresh();assert.equal(index.sources[0].status,'fresh',kind);const q=await queryStats(s.cache,{view:'time'},{now:Date.parse(asOf)}),root=q.data.rows.find(r=>r.tool===tool);assert.equal(root.startAt,start);assert.equal(root.responseAt,yieldAt);assert.equal(root.firstYieldAt,yieldAt);assert.equal(root.endAt,end);assert.equal(root.durationMs,5000);assert.equal(root.requestResponseMs,1000);assert.equal(root.completionKnown,true);assert.match(root.completionEvidence,/explicit-continuation/);assert.equal(q.data.summary.intervals[0].observedUnionMs,5000);
  }
});

test('native completion cannot be borrowed from wrong handles, ambiguous output blocks or another binding epoch',async()=>{
  const s=await setup('codex-jsonl',{bindings:[{...binding,to:'2026-10-03T16:00:00.000Z'},{...binding,roleEpoch:'second',from:'2026-10-03T16:00:00.000Z'}]});
  await writeFile(s.path,jsonl([session(),call('root','exec_command','2026-10-03T15:59:58.000Z'),output('root','2026-10-03T15:59:59.000Z',nativeEnvelope({session_id:1,exit_code:null})),call('wrong','write_stdin','2026-10-03T15:59:59.000Z',{session_id:2}),output('wrong','2026-10-03T15:59:59.500Z',nativeEnvelope()),call('other-epoch','write_stdin','2026-10-03T16:00:01.000Z',{session_id:1}),output('other-epoch','2026-10-03T16:00:02.000Z',nativeEnvelope()),call('blocks','mcp__sample__run','2026-10-03T16:00:03.000Z'),output('blocks','2026-10-03T16:00:04.000Z',[{type:'text',text:nativeEnvelope()},{type:'text',text:'unknown'}])]));const index=await s.refresh();assert.equal(index.sources[0].status,'fresh');const q=await queryStats(s.cache,{view:'time'},{now:Date.parse(asOf)});assert.equal(q.data.rows.find(r=>r.tool==='exec_command').completionKnown,false);assert.equal(q.data.rows.find(r=>r.tool==='mcp__sample__run').completionKnown,false);assert.ok(index.sources[0].diagnostics.some(d=>d.code==='native_continuation_scope_mismatch'));
});

test('v1 cache and frozen leases fail closed and leave evidence intact; fresh v2 rebuild succeeds',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const index=await s.refresh();const first=await queryStats(s.cache,{view:'token'},{now:Date.parse(asOf)});
  const leasePath=join(s.cache,`stats-lease-${first.querySnapshotId}.json`),lease=JSON.parse(await readFile(leasePath));lease.index.rulesVersion='dashboard-stats-v1';await writeFile(leasePath,JSON.stringify(lease));await assert.rejects(queryStats(s.cache,{view:'token',snapshotId:first.querySnapshotId},{now:Date.parse(asOf)}),/stats_cache_version_mismatch/);
  const old={...index,rulesVersion:'dashboard-stats-v1',collectorVersion:'bounded-metadata-v1'},oldText=JSON.stringify(old);await writeFile(join(s.cache,'stats-index.json'),oldText);await assert.rejects(queryStats(s.cache,{view:'token'},{now:Date.parse(asOf)}),/stats_cache_version_mismatch/);await assert.rejects(s.refresh(),/stats_cache_version_mismatch/);assert.equal(await readFile(join(s.cache,'stats-index.json'),'utf8'),oldText);
  const freshCache=join(s.root,'v3-cache');await refreshStats(s.manifestPath,freshCache,{asOf});const rebuilt=await queryStats(freshCache,{view:'token'},{now:Date.parse(asOf)});assert.equal(rebuilt.rulesVersion,'dashboard-stats-v3');assert.equal(rebuilt.data.summary.token.nativeTotal.total.known,99);
});

test('host duration-only retains host status but cannot invent absolute completion or MCP completion date',async()=>{
  const s=await setup('native-items',{selection:{taskId:'task',roundId:'round',turnIds:['turn'],itemIds:['item']}});
  await writeFile(s.path,JSON.stringify({schemaVersion:1,thread:{id:'thread',hostId:'local'},turns:[{id:'turn',startedAt:'2026-10-03T00:00:00.000Z',items:[{id:'item',type:'mcpToolCall',tool:'mcp__sample__run',status:'completed',durationMs:4800,arguments:'SECRET',output:'SECRET'}]}]}));await s.refresh();
  const q=await queryStats(s.cache,{view:'mcp'},{now:Date.parse(asOf)}),row=q.data.rows[0];assert.equal(row.status,'duration-only');assert.equal(row.hostReportedStatus,'completed');assert.equal(row.reportedDurationMs,4800);assert.equal(row.durationMs,null);assert.equal(row.completedAt,null);assert.equal(row.completionKnown,false);assert.equal(q.data.summary.mcp[0].calls,null);assert.equal(q.data.summary.mcp[0].requests,0);assert.equal(q.data.summary.mcp[0].completionUnknown,1);assert.equal(JSON.stringify(q).includes('SECRET'),false);
});

test('event ending outside authorized scope contributes only clipped time, never an unauthorized completion date',async()=>{
  const s=await setup('team-context-event',{authorizedTo:'2026-10-03T16:00:00.000Z'});await writeFile(s.path,JSON.stringify(serverEvent()));await s.refresh();
  const q=await queryStats(s.cache,{view:'days'},{now:Date.parse(asOf)});assert.deepEqual(q.data.rows.map(r=>r.date),['2026-10-03']);assert.equal(q.data.rows[0].summary.intervals[0].observedUnionMs,1000);assert.equal(q.data.summary.mcp[1].calls,null);assert.equal((await queryStats(s.cache,{view:'mcp'},{now:Date.parse(asOf)})).data.total,0);
});

test('v2 attribution-less cache stays intact on v3 admission error and a separate cache rebuilds approved sources',async()=>{const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const index=await s.refresh(),old={...index,rulesVersion:'dashboard-stats-v2',collectorVersion:'bounded-metadata-v2'},text=JSON.stringify(old);await writeFile(join(s.cache,'stats-index.json'),text);await assert.rejects(queryStats(s.cache,{view:'token'}),/version_mismatch/);await assert.rejects(s.refresh(),/version_mismatch/);assert.equal(await readFile(join(s.cache,'stats-index.json'),'utf8'),text);const next=join(s.root,'new-cache-v3');await refreshStats(s.manifestPath,next,{asOf});const result=await queryStats(next,{view:'token'});assert.equal(result.rulesVersion,'dashboard-stats-v3');assert.equal(result.data.summary.token.nativeTotal.total.known,99);});

test('distinct windows share immutable preparation and concurrent first reads coalesce without sharing query results',async()=>{
  const s=await setup('activity-jsonl',{selection:{taskId:'task',roundId:'round',turnIds:[],itemIds:[]}});
  await writeFile(s.path,jsonl([activity(1),activity(1,{phase:'end',at:'2026-10-03T16:00:10.000Z'})]));await s.refresh();
  const phases=[],base=await createStatsSnapshot(s.cache,{now:Date.parse(asOf)}),query=date=>({view:'days',preset:'custom',from:date,to:date,baseSnapshotId:base.baseSnapshotId});
  const [before,after]=await Promise.all(['2026-10-03','2026-10-04'].map(date=>queryStats(s.cache,query(date),{now:Date.parse(asOf),profile:p=>phases.push(p)})));
  assert.notEqual(before.queryHash,after.queryHash);assert.equal(before.data.summary.intervals[0].observedUnionMs,10000);assert.equal(after.data.summary.intervals[0].observedUnionMs,10000);
  const preparations=phases.filter(p=>p.phase==='immutable-documents-read-dedup-time-index');assert.equal(preparations.length,2);assert.equal(preparations.filter(p=>!p.preparedHit).length,1);
  const later=[];const both=await queryStats(s.cache,{view:'days',preset:'custom',from:'2026-10-03',to:'2026-10-04',baseSnapshotId:base.baseSnapshotId},{now:Date.parse(asOf),profile:p=>later.push(p)});
  assert.equal(later[0].preparedHit,true);assert.equal(both.data.rows.length,2);assert.equal(both.data.summary.intervals[0].observedUnionMs,20000);
  await assert.rejects(queryStats(s.cache,query('2026-10-05'),{now:base.expiresAt}),/snapshot_expired/);
});

test('immutable rows reuse across unchanged refresh while coverage stays bound to each frozen source envelope',async()=>{
  const s=await setup();await writeFile(s.path,jsonl([session(),usage(1)]));const first=await s.refresh(),now=Date.parse(asOf),base=await createStatsSnapshot(s.cache,{now});
  const old=await queryStats(s.cache,{view:'coverage',baseSnapshotId:base.baseSnapshotId},{now});assert.ok(old.data.rows[0].readBytes>0);
  const nextAt='2026-10-05T06:00:01.000Z',second=await s.refresh({asOf:nextAt});assert.equal(first.snapshotId,second.snapshotId);
  const newerBase=await createStatsSnapshot(s.cache,{now:now+1000}),phases=[],fresh=await queryStats(s.cache,{view:'coverage',baseSnapshotId:newerBase.baseSnapshotId},{now:now+1000,profile:p=>phases.push(p)});
  assert.equal(phases[0].preparedHit,true);assert.equal(fresh.data.rows[0].readBytes,0);assert.equal(fresh.data.rows[0].asOf,nextAt);assert.equal(fresh.statsAsOf,nextAt);
  const frozen=await queryStats(s.cache,{view:'coverage',baseSnapshotId:base.baseSnapshotId,snapshotId:old.querySnapshotId},{now:now+1000});assert.equal(frozen.data.rows[0].asOf,asOf);assert.equal(frozen.data.rows[0].readBytes,old.data.rows[0].readBytes);
  await appendFile(s.path,jsonl([usage(2)]));await s.refresh({asOf:'2026-10-05T06:00:02.000Z'});const updated=[];const token=await queryStats(s.cache,{view:'token'},{now:now+2000,profile:p=>updated.push(p)});assert.equal(updated[0].preparedHit,false);assert.equal(token.data.summary.token.nativeTotal.total.known,198);
});
