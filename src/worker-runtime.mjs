import {isDeepStrictEqual} from 'node:util';
import {resolve} from 'node:path';
import {readRawState,readState,atomicWrite} from './store.mjs';
import {withStateGuard} from './registry-projection.mjs';
import {evolve,validateCaller} from './runtime.mjs';
import {validateEvidence,validateBlocker,fieldError} from './worker-evidence.mjs';
import {progressSummary} from './progress-summary.mjs';
import {bounded} from './notice-runtime.mjs';

export async function workerRuntime({statePath,registryPath,request:r,options={}}) {
  let writing=false;
  try {
    const common=['action','actor_host_id','actor_thread_id','team_id','reason'];
    const extra={submit:['submission_id','submission'],blocker:['operation_id','task_id','blocker'],summary:['task_id']}[r?.action];
    if(!extra||Object.keys(r).some(k=>![...common,...extra].includes(k))||[...common,...(r.action==='summary'?[]:extra)].some(k=>!Object.hasOwn(r,k)))fieldError('request','fields do not match action schema',{action:'summary',actor_host_id:'local',actor_thread_id:'current verified thread',team_id:'team',reason:'manual'});
    if(!['onboarding','resume','post_compaction','before_dispatch','before_delivery','before_review','identity_conflict','manual','unknown'].includes(r.reason))fieldError('reason','expected supported notice reason','manual');
    if(r.action==='summary'&&'task_id' in r&&(typeof r.task_id!=='string'||!r.task_id.trim()))fieldError('task_id','expected exact task identifier','task-1');
    const caller=validateCaller({hostId:r.actor_host_id,threadId:r.actor_thread_id});
    if(r.action==='submit')validateEvidence(r.submission);
    if(r.action==='blocker')validateBlocker(r.blocker);
    const operation=async state=>{
      if(state.team.id!==r.team_id)throw new Error('Team identity mismatch');
      if(registryPath&&(state.schemaVersion!==2||state.registry.phase!=='active'||resolve(state.registry.registryPath)!==resolve(registryPath)))throw new Error('Active trusted Registry required');
      const actor=state.members.find(m=>m.binding.status==='bound'&&m.binding.hostId===caller.hostId&&m.binding.threadId===caller.threadId&&m.lifecycle==='active');
      if(!actor||state.schemaVersion===2&&!state.registry.readyMemberIds.includes(actor.id))throw new Error('Active ready caller required');
      if(r.action==='summary')return bounded(progressSummary(state,r.task_id??null));
      if(actor.role!=='Worker')throw new Error('Assigned Worker required');
      const taskId=r.action==='submit'?r.submission.taskId:r.task_id;
      const task=state.tasks.find(t=>t.id===taskId),round=state.rounds.find(x=>x.id===task?.roundId);
      const historical=round?.members.find(m=>m.id===actor.id);
      if(!task||task.workerId!==actor.id||historical?.lifecycle!=='active'||historical.role!=='Worker'||!isDeepStrictEqual(historical.binding,actor.binding))throw new Error('Current/historical Worker ownership mismatch');
      const id=r.action==='submit'?r.submission_id:r.operation_id;
      if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))fieldError(r.action==='submit'?'submission_id':'operation_id','invalid identifier','submit-task-1');
      const type=r.action==='submit'?'submit':'reportBlocker',payload=r.action==='submit'?{submission:r.submission}:{blocker:r.blocker};
      const prior=state.events.find(e=>e.id===id);
      if(prior){if(prior.type!==type||prior.actor!==actor.id||prior.taskId!==taskId||!isDeepStrictEqual(prior.caller,caller)||!isDeepStrictEqual(prior[r.action==='submit'?'submission':'blocker'],r.action==='submit'?r.submission:r.blocker))throw Object.assign(new Error('ID reused with different content'),{code:'OPERATION_CONFLICT'});
        return {status:r.action==='submit'?'submitted':'blocker-recorded',submissionId:r.action==='submit'?id:null,sourceVersion:state.version,replayed:true,hostActionExecuted:false};}
      const at=options.at??new Date().toISOString();
      const event={id,type,actor:actor.id,caller,roundId:task.roundId,taskId,at,source:{kind:state.team.source.kind==='fixture'?'fixture':'manual',ref:`worker-structured:${id}`},summary:r.action==='submit'?r.submission.summary:r.blocker.needs,...payload};
      const next=evolve(state,event,state.version);
      writing=true;await atomicWrite(statePath,JSON.stringify(next,null,2)+'\n');writing=false;
      return {status:r.action==='submit'?'submitted':'blocker-recorded',submissionId:r.action==='submit'?id:null,sourceVersion:next.version,replayed:false,hostActionExecuted:false,evidenceAssurance:'worker-declared'};
    };
    return r.action==='summary'?await operation(await readState(statePath,options)):await withStateGuard(statePath,null,readRawState,operation,options);
  }catch(e){return {status:'error',reasonCode:writing?'WRITE_OUTCOME_UNKNOWN':e.code??'INVALID_REQUEST',message:e.message,...(e.field?{field:e.field,example:e.example}:{}),hostActionExecuted:false};}
}
