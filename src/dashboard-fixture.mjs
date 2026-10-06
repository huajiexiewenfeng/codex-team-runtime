import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createState,evolve} from './runtime.mjs';
import {refreshStats} from './stats-collector.mjs';

// Explicit, disposable fixtures only; this function never opens a production source.
export async function createDashboardFixture(directory,{taskCount=56,stepCount=60,activityTaskCount=taskCount,longNames=false,asOf=new Date().toISOString()}={}){
  if(!Number.isInteger(taskCount)||taskCount<9||taskCount>1000||!Number.isInteger(stepCount)||stepCount<1||!Number.isInteger(activityTaskCount)||activityTaskCount<0||activityTaskCount>Math.min(taskCount,977)||activityTaskCount*stepCount>9000||typeof longNames!=='boolean')throw new Error('Invalid bounded fixture size');
  await mkdir(directory);const source={kind:'fixture',ref:'dashboard-u2-synthetic'},teamId='dashboard-u2-fixture',roundId='u2-round';
  const member=(id,role,name)=>({id,name,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:`fixture-thread-${id}`}});
  const members=[member('manager','Manager','编排规划与交付验收负责人'),member('liaison','Liaison','跨团队沟通协调与需求联络'),...Array.from({length:9},(_,i)=>member(`worker-${i+1}`,'Worker',`开发工程与可观测性优化成员${i+1}`))];
  const from='2026-09-01T00:00:00.000Z',to='2026-11-01T00:00:00.000Z',start=Date.parse('2026-10-02T00:00:00.000Z');let n=0;
  let state=createState({teamId,name:'Dashboard 集成验证（合成）',source,members},new Date(start).toISOString());
  const apply=(type,data,actor='manager')=>{const at=new Date(start+(++n)*5000).toISOString();state=evolve(state,{id:`fixture-event-${n}`,type,actor,at,source,...data},state.version);};
  apply('openRound',{roundId,title:'U2 · 三视图正式集成'});
  for(let i=0;i<taskCount;i++){
    const taskId=`task-${String(i).padStart(3,'0')}`,workerId=`worker-${i%9+1}`;apply('assign',{roundId,taskId,title:`任务 ${String(i).padStart(3,'0')} · 边界、统计与集成验证`,workerId,required:false,assignedAt:i===taskCount-1?null:new Date(start+(n+1)*5000).toISOString()});
    if(i<taskCount-9){apply('submit',{roundId,taskId,summary:'合成交付记录'},workerId);apply('review',{roundId,taskId});apply('approve',{roundId,taskId,summary:'合成独立验收',evidence:['fixture:assertions']});}
    else if(i===taskCount-8)apply('block',{roundId,taskId,summary:'合成缺输入'});
    else if(i===taskCount-7){apply('submit',{roundId,taskId,summary:'合成待审'},workerId);apply('review',{roundId,taskId});}
    else if(i===taskCount-6){apply('submit',{roundId,taskId,summary:'合成待审'},workerId);apply('review',{roundId,taskId});apply('rework',{roundId,taskId,summary:'合成返工'});}
  }
  if(longNames){for(const t of state.tasks)t.title+=` · ${'跨日来源核对与可观测性容量验证中文长任务名称，保留历史阶段和全部定位记录。'.repeat(6)}`;for(const m of state.members)m.name+=` · ${'团队协作与历史归属来源核对成员长名称'.repeat(4)}`;}
  const statePath=join(directory,'state.json');await writeFile(statePath,JSON.stringify(state));
  const bindings=members.map(m=>({memberId:m.id,role:m.role,hostId:m.binding.hostId,threadId:m.binding.threadId,bindingRevision:1,roleEpoch:`${m.id}-epoch-1`,from,to,evidenceRef:'fixture:known-binding'}));
  const emptySelection={taskId:null,roundId:null,turnIds:[],itemIds:[]};
  const base={adapterVersion:'v1',mutationPolicy:'immutable',authorizedFrom:from,authorizedTo:asOf,coverageAssertions:{status:'partial',evidenceRef:'fixture:explicit-synthetic-partial-coverage'},evidenceRef:'fixture:source',bindings,selection:emptySelection};
  const sources=[{...base,sourceId:'fixture-state',kind:'recorded-state',path:statePath,bindings:[],mutationPolicy:'mutable'}];
  for(const m of bindings){
    const entries=[{type:'session_meta',payload:{id:m.threadId}}];for(let day=0;day<7;day++){
      const at=new Date(Date.parse('2026-09-29T00:00:00.000Z')+day*86400000).toISOString(),count=day+1;
      entries.push({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{last_token_usage:{input_tokens:1000,cached_input_tokens:400,output_tokens:100,reasoning_output_tokens:20,total_tokens:1500},total_token_usage:{input_tokens:1000*count,cached_input_tokens:400*count,output_tokens:100*count,reasoning_output_tokens:20*count,total_tokens:1500*count}}}});
      const callId=`${m.memberId}-call-${day}`;entries.push({type:'response_item',timestamp:at,payload:{type:'function_call',call_id:callId,name:'mcp__fixture__read',arguments:'{}'}});
      entries.push({type:'response_item',timestamp:new Date(Date.parse(at)+300).toISOString(),payload:{type:'function_call_output',call_id:callId,output:JSON.stringify({chunk_id:'fixture-chunk',wall_time_seconds:.3,exit_code:m.memberId==='worker-9'&&day===6?null:0,session_id:m.memberId==='worker-9'&&day===6?12345:null,output:'SYNTHETIC BODY OMITTED FROM CACHE'})}});
    }
    const path=join(directory,`tokens-${m.memberId}.jsonl`);await writeFile(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');sources.push({...base,sourceId:`fixture-native-${m.memberId}`,kind:'codex-jsonl',path,bindings:[m],mutationPolicy:'append-only'});
    const event={schemaVersion:1,eventId:randomUUID(),startedAt:'2026-10-03T15:59:59.000Z',completedAt:'2026-10-03T16:00:01.000Z',durationMs:1900,tool:'team_context.read',registryId:'fixture-registry',teamId,memberId:m.memberId,role:m.role,hostId:m.hostId,threadId:m.threadId,memberStatus:'active',identitySource:'registry-at-call-start',reason:'resume',reasonSource:'agent-declared',outcome:'matched',errorCode:null,policyRevision:2,runtimeRevision:null,runtimeRevisionSource:'unknown'};
    const eventPath=join(directory,`mcp-${m.memberId}.json`);await writeFile(eventPath,JSON.stringify(event));sources.push({...base,sourceId:`fixture-server-${m.memberId}`,kind:'team-context-event',path:eventPath,bindings:[m]});
  }
  for(const task of activityTaskCount?state.tasks.slice(-activityTaskCount):[]){const m=bindings.find(b=>b.memberId===task.workerId),entries=[];for(let i=0;i<stepCount;i++){
    const at=new Date(Date.parse('2026-10-03T15:59:40.000Z')+i*1000).toISOString(),event={schemaVersion:'activity-sidecar/v1',eventId:`fixture-${task.id}-${String(i).padStart(3,'0')}`,phase:'begin',teamId,memberId:m.memberId,hostId:m.hostId,threadId:m.threadId,role:m.role,bindingRevision:1,roleEpoch:m.roleEpoch,taskId:task.id,roundId,stepId:`STEP-${task.id}-${String(i).padStart(3,'0')}`,at,assurance:i%2?'operator-declared':'worker-declared',sourceKind:'activity-sidecar',evidenceRef:'fixture:declared-step'};
    entries.push(event);if(i!==stepCount-1)entries.push({...event,phase:'end',at:new Date(Date.parse(at)+2000).toISOString()});}
    const path=join(directory,`steps-${task.id}.jsonl`);await writeFile(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');sources.push({...base,sourceId:`fixture-steps-${task.id}`,kind:'activity-jsonl',path,bindings:[m],mutationPolicy:'append-only',selection:{taskId:task.id,roundId,turnIds:[],itemIds:[]}});
  }
  const manifestPath=join(directory,'manifest.json'),cache=join(directory,'stats-cache');await writeFile(manifestPath,JSON.stringify({schemaVersion:'dashboard-sources/v1',teamId,registryId:'fixture-registry',revision:1,authorizationRef:'fixture:explicit-synthetic-sources',sources},null,2));
  let index;for(let pass=0;pass<100;pass++){index=await refreshStats(manifestPath,cache,{asOf});if(index.sources.every(s=>s.status==='fresh'))break;if(index.sources.some(s=>s.status==='error'||s.status.startsWith('source_')))throw new Error('Fixture collection failed');}
  if(!index.sources.every(s=>s.status==='fresh'))throw new Error('Fixture bounded backfill incomplete');
  return {teamId,statePath,manifestPath,cache,taskCount,memberCount:members.length,stepCount,activityTaskCount,longNames,sourceCount:sources.length,synthetic:true};
}
