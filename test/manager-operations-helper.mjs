import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {createState,evolve} from '../src/runtime.mjs';
import {freezeDispatchBrief,dispatchRuntime} from '../src/dispatch-runtime.mjs';
import {managerRequest} from '../src/manager-operations.mjs';
import {inboxRuntime} from '../src/manager-inbox.mjs';
import {prepareSubmissionNotice} from '../src/submission-notice.mjs';
import {operationEventId} from '../src/manager-operations-contract.mjs';

export const at='2026-10-28T00:00:00.000Z',caller={hostId:'fake-host',threadId:'fake-m'};
export async function fixture(t,mode='legacy') {
  const root=await realpath(await mkdtemp(join(tmpdir(),'manager-operations-'))),statePath=join(root,'state.json'),registryPath=join(root,'registry.json');
  t.after(async()=>{if(!root.startsWith(await realpath(tmpdir())+sep))throw Error('unsafe fixture cleanup');await rm(root,{recursive:true,force:true,maxRetries:3});});
  const source={kind:'manual',ref:'synthetic offline fixture, no native host or real team'};
  const member=(id,role)=>({id,role,name:id,lifecycle:'active',binding:{status:'bound',hostId:'fake-host',threadId:'fake-'+id}});
  let s=createState({teamId:'team',name:'Offline',source,members:[member('m','Manager'),member('l','Liaison'),member('w','Worker'),member('w2','Worker')]},at);
  s=evolve(s,{id:'open',type:'openRound',actor:'m',at,source,roundId:'r',title:'Offline'},s.version);
  s={...s,schemaVersion:2,registry:{registryId:'registry',registryPath,teamId:'team',migrationId:'migration',sourceSha256:'a'.repeat(64),sourceVersion:s.version,phase:'active',teamRevision:1,readyMemberIds:['m','l','w','w2']}};
  await writeFile(statePath,JSON.stringify(s));
  await writeFile(registryPath,JSON.stringify({registryId:'registry',teams:[{id:'team',revision:1,leaderMemberId:'m',runtime:{statePath},members:s.members.map(m=>({...m,binding:{...m.binding,revision:1}}))}]}));
  const options={at,exporter:async s=>({registryId:'registry',teamId:'team',teamRevision:1,migrationId:'migration',statePath,members:s.members,readyMemberIds:s.registry.readyMemberIds})};
  const raw=()=>readFile(statePath,'utf8').then(JSON.parse),ledger=()=>readFile(statePath+'.manager-inbox.json','utf8').then(JSON.parse);
  let seq=0;
  const inbox=(action,extra={},opts={})=>inboxRuntime({statePath,registryPath,options:{...options,...opts},request:{action,actor_host_id:caller.hostId,actor_thread_id:caller.threadId,team_id:'team',reason:'manual',...(action==='status'?{}:{operation_id:'fixture-'+(++seq)}),...extra}});
  if(mode!=='legacy') {
    const init=await inbox('control',{command:'init',authorization_ref:'fixture setup only',expected_absent:true,expected_state_version:s.version,team_revision:1});
    if(init.status==='error')throw Error(JSON.stringify(init));
    if(mode==='queue_first'){
      const l=await ledger();await inbox('control',{command:'set_mode',authorization_ref:'fixture setup only',expected_control_revision:l.controlRevision,mode,protocol_loaded:['m','w','w2'].map(member_id=>({member_id,binding_revision:1,evidence_ref:'fixture'}))});
      await inbox('control',{command:'resume_claims',authorization_ref:'fixture',expected_control_revision:(await ledger()).controlRevision});
    }
  }
  const base=async(action,extra={})=>({schemaVersion:1,action,operationId:'op-'+(++seq),caller,teamId:'team',roundId:'r',taskId:'t',workerId:'w',expectedVersion:(await raw()).version,mode,reason:'manual',...extra});
  const call=(request,opts={})=>managerRequest({statePath,request,options:{...options,...opts}});
  const event=async(type,extra={},actor='m')=>{
    const s=await raw(),next=evolve(s,{id:'old-'+(++seq),type,actor,at,source,roundId:'r',taskId:'t',...extra},s.version);
    await writeFile(statePath,JSON.stringify(next));return next.events.at(-1);
  };
  const enqueue=async(extra={},text='原文 中文\r\nbrief; cross-project D:/project-a; PDC optional')=>{
    const taskId=extra.taskId??'t',brief={schemaVersion:1,teamId:'team',roundId:'r',taskId,actor:caller,text,
      scope:'fixture only',materialRefs:['fixture'],authorizationRef:'fixture:authorization',dependencyRef:'fixture:dependency'};
    const frozen=await freezeDispatchBrief(statePath,brief,options);
    const request=await base('enqueue',{title:'Generic task',required:true,briefRef:frozen.briefRef,...extra});
    return {request,result:await call(request),brief,frozen};
  };
  const dispatch=async q=>{
    const r={action:'prepare',operation_id:'fake-prepare-'+(++seq),actor_host_id:caller.hostId,actor_thread_id:caller.threadId,
      team_id:'team',round_id:'r',task_id:q.request.taskId,worker_id:q.request.workerId,reason:'before_dispatch',
      enqueue_event_id:q.result.eventId,brief_ref:q.frozen.briefRef,admission:{native:{host_id:'fake-host',thread_id:'fake-'+q.request.workerId,status:'idle',evidence_ref:'fixture idle'}},baseline:{outcome:'not-attempted',evidence_ref:'fixture never sent'}};
    return {request:r,result:await dispatchRuntime({statePath,registryPath,request:r,options})};
  };
  const receive=async(extra={},opts={})=>{
    const s=await raw(),taskId=extra.taskId??'t',workerId=extra.workerId??'w',notice=prepareSubmissionNotice(s,{hostId:'fake-host',threadId:'fake-'+workerId},taskId).notice;
    let data={notice};
    if(mode==='queue_first'){
      let l=await ledger();const cp=await inbox('checkpoint',{run_id:'run',expected_control_revision:l.controlRevision,trigger:'step_complete'});
      const item=cp.items.find(i=>i.taskId===taskId);l=await ledger();
      const c=await inbox('claim',{run_id:'run',generation:l.consumer.generation,expected_control_revision:l.controlRevision,expected_work_id:l.activeWorkId,
        checkpoint_id:cp.checkpointId,item_id:item.itemId,payload_seq:item.payloadSeq,boundary_ref:'fixture independent review boundary'});
      if(c.status==='error')throw Error(JSON.stringify(c));
      data={claim:{runId:'run',generation:c.claim.generation,claimId:c.claim.id,itemId:c.claim.itemId}};
    }
    const request=await base('receive',{submissionId:notice.submissionId,...data,...extra});
    return {request,result:await call(request,opts)};
  };
  const decision=async(recv,decision='approve',extra={})=>base('record_decision',{submissionId:recv.request.submissionId,reviewEventId:recv.result.eventId,
    decision,summary:'Manager 原文独立检查\nconclusion',evidence:decision==='approve'?['fixture independent check']:[],...(recv.request.claim?{claim:recv.request.claim}:{}),...extra});
  const settle=async(recv,eventId)=>{
    const l=await ledger(),c=recv.request.claim;
    return inbox('resolve',{run_id:c.runId,generation:c.generation,expected_control_revision:l.controlRevision,expected_work_id:l.activeWorkId,
      item_id:c.itemId,claim_id:c.claimId,disposition:'settle',reason_ref:'fixture actual decision',decision_event_id:eventId});
  };
  return {root,statePath,registryPath,mode,source,options,raw,ledger,base,call,event,enqueue,dispatch,receive,decision,settle,inbox,operationEventId};
}
