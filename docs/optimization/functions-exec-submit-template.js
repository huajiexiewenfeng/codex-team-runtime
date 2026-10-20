// Paste the entire file into ONE Codex functions.exec invocation after filling inputs.
// Requires this candidate runtime/tools to be installed by a separately authorized operator.
// Resolve the existing manager-inbox route first. queue_first uses durable submit + exact inbox post.
// Never use this E03/native flow as fallback for an inbox/post/bridge failure.
const notificationMode = null; // fill only from verified current installed mode: legacy or observe
const hostSendAuthorized = false; // set true only when human explicitly authorized notifying this Manager
const request = { actor_host_id:'local', actor_thread_id:'REPLACE_VERIFIED_WORKER_THREAD', team_id:'REPLACE_TEAM', reason:'manual', submission_id:'REPLACE_STABLE_SUBMISSION_ID', submission:{taskId:'REPLACE_TASK',summary:'REPLACE_SUMMARY',files:[],verification:[],artifacts:[],gaps:[]} };
const noticeOperationId = 'REPLACE_STABLE_NOTICE_OPERATION_ID';
const baseline = null; // or verified {outcome:'not-attempted',evidence:{kind:'observation',ref:'actual context reference',detail:'actual no-send evidence'}}
if(!['legacy','observe'].includes(notificationMode)) throw new Error('Verified legacy/observe mode required; queue_first uses manager-inbox with no native fallback');
if(!hostSendAuthorized) throw new Error('Human host-send authorization required; no tools executed');
const toolName = suffix => {const matches=ALL_TOOLS.filter(t=>t.name.endsWith(suffix));if(matches.length!==1)throw Error('Missing or ambiguous tool '+suffix);return matches[0].name;};
const submitName=toolName('team_context_submit'), noticeName=toolName('team_context_notice');
const decode = value => {if(value.structuredContent)return value.structuredContent;if(value.content){const block=value.content.find(c=>c.type==='text');if(block)return JSON.parse(block.text);}return typeof value==='string'?JSON.parse(value):value;};
// Legacy/observe host-only orchestration. Resolve the effective installed inbox mode first.
// This caller-supplied mode is not authentication or a mode switch; MCP never sends.
async function runFixedSubmission({notificationMode,request,noticeOperationId,baseline,submit,prepare,send,record,assess}) {
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
function assessNativeSend(raw,target,evidenceRef) {
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

const output = await runFixedSubmission({notificationMode,request,noticeOperationId,baseline,
 submit:async r=>decode(await tools[submitName](r)),
 prepare:async r=>decode(await tools[noticeName](r)),
 send:async r=>await tools.mcp__codex_app__send_message_to_thread({hostId:r.hostId,threadId:r.threadId,prompt:r.prompt}),
 // Observed native threadId response is host acceptance, not Manager review.
 assess:async (raw,target)=>assessNativeSend(raw,target,'host-flow:'+noticeOperationId),
 record:async r=>decode(await tools[noticeName](r))
});
text(output); // submitted is not Manager approval; retain output for recovery
