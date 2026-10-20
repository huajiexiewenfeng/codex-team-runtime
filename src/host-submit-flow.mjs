// Legacy/observe host-only orchestration. Resolve the effective installed inbox mode first.
// This caller-supplied mode is not authentication or a mode switch; MCP never sends.
export async function runFixedSubmission({notificationMode,request,noticeOperationId,baseline,submit,prepare,send,record,assess}) {
  if(!['legacy','observe'].includes(notificationMode))return {stage:'route',error:'Verified legacy/observe notification mode required',nextAction:notificationMode==='queue_first'?'use-manager-inbox-no-native-fallback':'verify-installed-inbox-mode'};
  if(typeof noticeOperationId!=='string'||!/^[A-Za-z0-9_-]{1,121}$/.test(noticeOperationId))return {stage:'validate',error:'noticeOperationId must be 1..121 identifier characters; reserve _result suffix'};
  let committed;
  try{committed=await submit(request);}catch(e){return {stage:'submit',submission:'unknown',error:e.message,nextAction:'retry-same-submission-id'};}
  if(committed.status!=='submitted')return {stage:'submit',result:committed};
  const common={actor_host_id:request.actor_host_id,actor_thread_id:request.actor_thread_id,team_id:request.team_id,task_id:request.submission.taskId,submission_id:request.submission_id,reason:request.reason};
  let prepared;
  try{prepared=await prepare({...common,action:'prepare',operation_id:noticeOperationId,...(baseline?{baseline}:{})});}
  catch(e){return {stage:'prepare',submission:'submitted',error:e.message,nextAction:'notice-status-by-operation-id',operationId:noticeOperationId};}
  if(prepared.status!=='ready_to_send'||prepared.sendNow!==true||prepared.replayed)return {stage:'prepare',submission:'submitted',result:prepared,nextAction:'inspect-notice-status-without-resend'};
  let result,raw;
  try{raw=await send(prepared.hostRequest);result=await assess(raw,prepared.hostRequest);}
  catch(e){result={outcome:'unknown',evidence:{kind:'observation',ref:`host-flow:${prepared.attemptId}`,detail:`Host send or assessment failed: ${e.message}`}};}
  try{const recorded=await record({...common,action:'result',operation_id:noticeOperationId+'_result',attempt_id:prepared.attemptId,result});
    const nextAction=recorded.status!=='recorded'?'reconcile-same-attempt-no-resend':result.outcome==='accepted'?'await-manager-review':result.outcome==='policy-denied'?'stop-policy-denied':result.outcome==='transient-not-delivered'?'inspect-retry-policy':'reconcile-same-attempt-no-resend';
    return {stage:'result',submission:'submitted',attemptId:prepared.attemptId,hostResult:raw??null,result:recorded,nextAction};
  }catch(e){return {stage:'result',submission:'submitted',attemptId:prepared.attemptId,hostResult:raw??null,unrecordedResult:result,error:e.message,nextAction:'record-same-result-id-no-resend'};}
}

// Observed Codex native shape: content text JSON {threadId: exact target}, isError:false.
// This is host acceptance only, never Manager receipt/review or authenticated identity.
export function assessNativeSend(raw,target,evidenceRef) {
  let value=raw?.structuredContent;
  if(!value&&Array.isArray(raw?.content)){
    const texts=raw.content.filter(c=>c.type==='text');
    if(texts.length===1){try{value=JSON.parse(texts[0].text);}catch{}}
  }
  const exact=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['threadId','hostId'].includes(k))&&value.threadId===target.threadId&&(!('hostId' in value)||value.hostId===target.hostId);
  const denied=raw?.isError===true&&['POLICY_DENIED','policy-denied'].includes(value?.code??value?.reasonCode);
  const outcome=denied?'policy-denied':raw?.isError===false&&exact?'accepted':'unknown';
  const full=JSON.stringify(raw);
  const boundedField=v=>typeof v==='string'?{value:v.slice(0,256),truncated:v.length>256}:null;
  const detail=typeof full==='string'&&full.length<=3000?full:JSON.stringify({projection:true,isError:typeof raw?.isError==='boolean'?raw.isError:null,threadId:boundedField(value?.threadId),hostId:boundedField(value?.hostId),code:boundedField(value?.code??value?.reasonCode),outcome,fullResponseRetainedInHostFlow:true});
  return {outcome,evidence:{kind:'host-result',ref:evidenceRef,detail}};
}
