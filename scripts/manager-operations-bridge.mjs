import {readFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve,isAbsolute} from 'node:path';
import {prepareManagerDispatch,recordManagerDecision} from '../src/manager-operations-host.mjs';
import {managerRequest} from '../src/manager-operations.mjs';
import {dispatchRuntime} from '../src/dispatch-runtime.mjs';
import {atomicWrite,readRawState} from '../src/store.mjs';
import {fingerprint,fail} from '../src/manager-operations-contract.mjs';
import {parseInboxJson} from '../src/manager-inbox-contract.mjs';

export async function managerOperationsBridge(action,requestFile,payload={},options={}) {
  try {
    const input=parseInboxJson(await readFile(requestFile,'utf8'),1024*1024);
    if(['receive','decision'].includes(action)) {
      const allowed=['statePath','request',...(action==='decision'?['resolveRequest']:[])];
      if(Object.keys(input).some(k=>!allowed.includes(k))||!input.statePath||input.request?.action!==(action==='receive'?'receive':'record_decision'))
        fail('INVALID_REQUEST','input','exact phase-specific Manager request');
      return action==='receive'?managerRequest({...input,options}):recordManagerDecision({...input,options});
    }
    const allowed=['statePath','enqueueInput','brief','prepareInput','hostEvidencePath'];
    if(Object.keys(input).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(input,k)))fail('INVALID_REQUEST','input','closed Manager dispatch evidence file');
    if(action==='prepare')return {...await prepareManagerDispatch({...input,options}),inputFingerprint:fingerprint(input)};
    if(!['result','status'].includes(action))fail('INVALID_REQUEST','action',['prepare','result','status']);
    const e=input.enqueueInput,p=input.prepareInput,common={actor_host_id:e.caller.hostId,actor_thread_id:e.caller.threadId,team_id:e.teamId,
      round_id:e.roundId,task_id:e.taskId,worker_id:e.workerId,reason:p.reason};
    const s=await readRawState(input.statePath),call=request=>dispatchRuntime({statePath:input.statePath,registryPath:s.registry?.registryPath,request,options});
    const status=await call({...common,action:'status',operation_id:p.operation_id,...(payload.attemptId?{attempt_id:payload.attemptId}:{})});
    if(action==='status'||status.status==='error'||!status.recorded)return status;
    if(Object.keys(payload).some(k=>!['attemptId','outcome','raw','inputFingerprint'].includes(k))||payload.inputFingerprint!==fingerprint(input))
      fail('OPERATION_CONFLICT','inputFingerprint','exact original dispatch evidence file from prepare');
    if(!['accepted','unknown','denied'].includes(payload.outcome)||payload.attemptId!==status.attemptId)
      fail('INVALID_REQUEST','payload','exact prepare attempt and actual host result');
    // Raw host evidence is task-local, exclusive, immutable evidence. It is NOT
    // an operation ledger. An interrupted result can be registered again with
    // the identical payload; a different result never overwrites it.
    const bytes=JSON.stringify(payload)+'\n';
    try {await atomicWrite(input.hostEvidencePath,bytes,true);}
    catch(error){if(error.code!=='EEXIST'||await readFile(input.hostEvidencePath,'utf8')!==bytes)throw error;}
    return call({...common,action:'result',operation_id:'mr-'+fingerprint([p.operation_id,'result']),attempt_id:payload.attemptId,
      result:{outcome:payload.outcome,evidence_ref:input.hostEvidencePath,summary:'Native host result retained verbatim in referenced evidence; outcome is transport only'}});
  } catch(error) {return {status:'error',reasonCode:error.code??'BRIDGE_ERROR',field:error.field??'bridge',message:String(error.message).slice(0,300),
    effects:'unknown',hostActionExecuted:false,sendNow:false,nextAction:'inspect exact operation status; do not resend'};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  let payload={};try{
    const python=process.argv[5];
    if(typeof python!=='string'||!isAbsolute(python)||!await stat(python).then(s=>s.isFile(),()=>false))
      fail('CAPABILITY_UNKNOWN','pythonExecutable','verified absolute installed Python exporter executable','Python exporter executable is missing or unavailable');
    if(process.argv[4])payload=JSON.parse(Buffer.from(process.argv[4],'base64').toString('utf8'));
    const result=await managerOperationsBridge(process.argv[2],process.argv[3],payload,{python});console.log(JSON.stringify(result));if(result.status==='error')process.exitCode=1;
  }catch(error){console.log(JSON.stringify({status:'error',reasonCode:error.code??'INVALID_REQUEST',field:error.field??'bridge',legal:error.legal??'valid CLI arguments',message:String(error.message).slice(0,300),effects:'none',hostActionExecuted:false,sendNow:false}));process.exitCode=1;}
}
