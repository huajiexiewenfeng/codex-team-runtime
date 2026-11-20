// Paste this COMPLETE file into functions.exec, then call runManagerOperations
// with the tools object and verified paths below. No imports, fs, Buffer or Node
// globals run in functions.exec. This template never initializes a team/mode.
function managerOpsBase64(value) {
  const bytes=[];
  for(const char of JSON.stringify(value)) {
    const c=char.codePointAt(0);
    if(c<128)bytes.push(c);else if(c<2048)bytes.push(192|(c>>6),128|(c&63));
    else if(c<65536)bytes.push(224|(c>>12),128|((c>>6)&63),128|(c&63));
    else bytes.push(240|(c>>18),128|((c>>12)&63),128|((c>>6)&63),128|(c&63));
  }
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',out=[];
  for(let i=0;i<bytes.length;i+=3){const n=(bytes[i]<<16)|((bytes[i+1]??0)<<8)|(bytes[i+2]??0);
    out.push(alphabet[(n>>18)&63],alphabet[(n>>12)&63],i+1<bytes.length?alphabet[(n>>6)&63]:'=',i+2<bytes.length?alphabet[n&63]:'=');}
  return out.join('');
}
function managerOpsAssess(raw,target) {
  let value=raw?.structuredContent;
  if(!value&&Array.isArray(raw?.content)){
    const texts=raw.content.filter(c=>c.type==='text');if(texts.length===1){try{value=JSON.parse(texts[0].text);}catch{}}
  }
  const exact=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['threadId','hostId'].includes(k))&&
    value.threadId===target.threadId&&(!('hostId'in value)||value.hostId===target.hostId);
  if(raw?.isError===true&&['POLICY_DENIED','policy-denied'].includes(value?.code??value?.reasonCode))return 'denied';
  return raw?.isError===false&&exact?'accepted':'unknown';
}
function managerOpsProject(value) {
  const out={};
  for(const key of ['status','reasonCode','effects','phase','stage','field','message','nextAction','operationId','requestFingerprint','teamId','roundId','taskId','submissionId',
    'eventId','attemptId','inputFingerprint','briefRef','contentSha256','sourceVersion','recordedVersion','currentStateVersion','readOnly','replayed','sendNow','projectionPending','businessStatus','delivery','reviewStatus']) {
    const v=value?.[key];
    if(typeof v==='string')out[key]=v.slice(0,384);
    else if(v===null||typeof v==='boolean'||typeof v==='number')out[key]=v;
  }
  if(typeof value?.legal==='string')out.legal=value.legal.slice(0,384);
  if(Array.isArray(value?.legal))out.legal=value.legal.slice(0,16).map(v=>String(v).slice(0,128));
  if(value?.shellDiagnostic){
    const d=value.shellDiagnostic,outDiagnostic={};
    for(const k of ['action','stdoutPreview','stderrPreview','causeCode','causeMessage','parsedStatus'])
      if(typeof d[k]==='string')outDiagnostic[k]=d[k].slice(0,k.endsWith('Preview')?600:384);
    for(const k of ['exitCode','exitCodeKnown','nonzeroExitCode','sessionId','pollCount','stdoutChars','stderrChars','previewTruncated'])
      if(d[k]===null||typeof d[k]==='number'||typeof d[k]==='boolean')outDiagnostic[k]=d[k];
    if(Array.isArray(d.chunks))outDiagnostic.chunks=d.chunks.slice(0,8).map(c=>{
      const row={};for(const k of ['tool','stdoutChars','stderrChars','exitCode','sessionId'])
        if(c?.[k]===null||typeof c?.[k]==='number'||typeof c?.[k]==='string')row[k]=typeof c[k]==='string'?c[k].slice(0,80):c[k];return row;
    });
    out.shellDiagnostic=outDiagnostic;
  }
  return out;
}
function managerOpsStages(value) {
  const out={};for(const key of ['frozen','enqueue','prepare','decision','resolve'])if(value?.[key])out[key]=managerOpsProject(value[key]);return out;
}
function managerOpsExporterError(pythonExecutable) {
  if(typeof pythonExecutable!=='string'||pythonExecutable.length>1024||/[\r\n\0]/.test(pythonExecutable)||!(/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(pythonExecutable)))
    return {status:'error',reasonCode:'CAPABILITY_UNKNOWN',field:'pythonExecutable',legal:'verified absolute installed Python exporter executable; no environment fallback or installation',effects:'none',sendNow:false};
  return null;
}
function managerOpsExecutionError(hostExecutionOptions,shellExecutable) {
  const invalid=field=>({status:'error',reasonCode:'INVALID_HOST_EXECUTION_OPTIONS',field,sendNow:false,
    message:'Use only an explicit sandbox_permissions mode and its required justification; no command/cwd overrides'});
  if(hostExecutionOptions!==undefined){
    const o=hostExecutionOptions;
    if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!['sandbox_permissions','justification'].includes(k))||
      !Object.hasOwn(o,'sandbox_permissions')||!['use_default','require_escalated'].includes(o.sandbox_permissions))return invalid('hostExecutionOptions');
    if(o.sandbox_permissions==='require_escalated'){
      if(typeof o.justification!=='string'||!o.justification.trim()||o.justification.length>1000||/[\r\n\0]/.test(o.justification))return invalid('hostExecutionOptions.justification');
    }else if(Object.hasOwn(o,'justification'))return invalid('hostExecutionOptions.justification');
  }
  if(shellExecutable!==undefined&&(typeof shellExecutable!=='string'||shellExecutable.length>1024||
    /[\r\n\0]/.test(shellExecutable)||!(/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(shellExecutable))))return invalid('shellExecutable');
  return null;
}
function managerOpsShellError(error,stage,stages,nextAction) {
  return {status:'reconcile',sendNow:false,stage:error.stage??stage,
    reasonCode:error.reasonCode??'HOST_FLOW_ERROR',stages,error:String(error.message).slice(0,200),
    ...(error.shellDiagnostic?{shellDiagnostic:error.shellDiagnostic}:{}),nextAction};
}
async function managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile,shellExecutable,hostExecutionOptions},action,payload={}) {
  const validation=managerOpsExecutionError(hostExecutionOptions,shellExecutable);
  if(validation)throw Object.assign(Error(validation.message),{reasonCode:validation.reasonCode,stage:action});
  const quote=s=>"'"+String(s).replace(/'/g,"''")+"'";
  const cmd='& '+[nodeExecutable,runtimeRoot+'/scripts/manager-operations-bridge.mjs',action,requestFile,managerOpsBase64(payload),pythonExecutable].map(quote).join(' ');
  const diagnostic={action,exitCode:null,exitCodeKnown:false,sessionId:null,pollCount:0,stdoutChars:0,stderrChars:0,
    stdoutPreview:'',stderrPreview:'',previewTruncated:false,chunks:[]};
  let stdout='',outHead='',outTail='',errHead='',errTail='',outputLimit=false,toolTruncated=false,nonzeroObserved=false;
  const reject=(reason,message,cause)=>{
    if(cause){diagnostic.causeCode=String(cause.code??cause.reasonCode??cause.error?.code??cause.structuredContent?.code??'unknown').slice(0,80);diagnostic.causeMessage=String(cause.message??cause.error?.message??message).slice(0,384);}
    throw Object.assign(Error(message),{reasonCode:reason,stage:action,shellDiagnostic:diagnostic});
  };
  const collect=(response,tool)=>{
    if(!response||typeof response!=='object'||Array.isArray(response))reject('SHELL_RESPONSE_INVALID','Host tool returned no response envelope');
    if(response.isError===true||response.error)reject('SHELL_TOOL_ERROR',String(response.message??response.error?.message??(typeof response.error==='string'?response.error:'Host shell tool rejected execution')),response);
    if(response.output!==undefined&&typeof response.output!=='string')reject('SHELL_RESPONSE_INVALID','Shell output must be a string');
    const out=response.output??'',err=typeof response.stderr==='string'?response.stderr:'';
    diagnostic.stdoutChars+=out.length;diagnostic.stderrChars+=err.length;
    outHead=(outHead+out).slice(0,384);outTail=(outTail+out).slice(-192);
    errHead=(errHead+err).slice(0,384);errTail=(errTail+err).slice(-192);
    diagnostic.stdoutPreview=diagnostic.stdoutChars<=384?outHead:outHead+' … '+outTail;
    diagnostic.stderrPreview=diagnostic.stderrChars<=384?errHead:errHead+' … '+errTail;
    diagnostic.previewTruncated=diagnostic.stdoutChars>576||diagnostic.stderrChars>576;
    if(stdout.length+out.length<=1024*1024)stdout+=out;else outputLimit=true;
    if(response.original_token_count>16000)toolTruncated=true;
    diagnostic.exitCode=null;diagnostic.exitCodeKnown=false;
    if(response.exit_code!==undefined&&response.exit_code!==null){
      if(!Number.isInteger(response.exit_code))reject('SHELL_RESPONSE_INVALID','Invalid shell exit_code');
      diagnostic.exitCode=response.exit_code;diagnostic.exitCodeKnown=true;if(response.exit_code!==0){nonzeroObserved=true;diagnostic.nonzeroExitCode=response.exit_code;}
    }
    if(response.session_id!==undefined&&response.session_id!==null){
      if(!Number.isInteger(response.session_id)||response.session_id<=0)reject('SHELL_RESPONSE_INVALID','Invalid shell session_id');
      diagnostic.sessionId=response.session_id;
    }
    diagnostic.chunks.push({tool,stdoutChars:out.length,stderrChars:err.length,
      exitCode:response.exit_code??null,sessionId:response.session_id??null});
    if(diagnostic.chunks.length>8)diagnostic.chunks.splice(4,1);
    return response.session_id;
  };
  if(cmd.length>24000)reject('PAYLOAD_TOO_LARGE','Payload exceeds shell command limit; use material references or reconcile original raw evidence');
  // Closed explicit options are passed to the ORIGINAL tool. No wrapping,
  // automatic escalation, permission retry, startup probe or command replay.
  const execution={...(shellExecutable?{shell:shellExecutable,login:false}:{}),
    ...(hostExecutionOptions?{sandbox_permissions:hostExecutionOptions.sandbox_permissions,
      ...(hostExecutionOptions.sandbox_permissions==='require_escalated'?{justification:hostExecutionOptions.justification}:{})}:{})};
  let response;
  try{response=await tools.exec_command({cmd,workdir:runtimeRoot,...execution,max_output_tokens:16000,yield_time_ms:10000});}
  catch(error){reject('SHELL_TOOL_ERROR','Host exec_command failed',error);}
  let session=collect(response,'exec_command');
  while(session){
    if(typeof tools.write_stdin!=='function')reject('SHELL_CAPABILITY_UNKNOWN','Active shell session requires write_stdin');
    if(diagnostic.pollCount>=120)reject('SHELL_SESSION_PENDING','Shell session remains pending; inspect original process, never rerun');
    diagnostic.pollCount++;
    try{response=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:5000,max_output_tokens:16000});}
    catch(error){reject('SHELL_TOOL_ERROR','Host write_stdin failed; original execution may still be active',error);}
    session=collect(response,'write_stdin');
  }
  if(outputLimit)reject('SHELL_OUTPUT_LIMIT','Shell stdout exceeds parser limit; complete raw chunks remain in host tool history');
  if(toolTruncated)reject('SHELL_OUTPUT_TRUNCATED','Host shell output was truncated; inspect raw tool history, never replay prepare');
  const trimmed=stdout.trim(),nonzero=nonzeroObserved;
  if(!trimmed)reject(nonzero?'SHELL_EXIT_NONZERO':!diagnostic.exitCodeKnown?'SHELL_EXIT_UNKNOWN':'SHELL_EMPTY_OUTPUT',
    nonzero?'Shell exited nonzero without bridge JSON':'Shell returned empty stdout; exit 0 alone does not prove the Node bridge ran');
  let value;
  try{value=JSON.parse(trimmed);}catch{reject(nonzero?'SHELL_EXIT_NONZERO':'SHELL_NON_JSON','Shell did not return valid bridge JSON; inspect stdout/stderr diagnostics');}
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.status!=='string')
    reject(nonzero?'SHELL_EXIT_NONZERO':'SHELL_INVALID_JSON','Expected one bridge response object with a status');
  diagnostic.parsedStatus=value.status.slice(0,80);
  // CLI deliberately uses exit 1 for structured status:error. Retain its
  // Runtime reason/field. A nonzero claimed success NEVER grants a native send.
  if(value.status==='error')return {...value,stage:action,sendNow:false,shellDiagnostic:diagnostic};
  if(!diagnostic.exitCodeKnown)reject('SHELL_EXIT_UNKNOWN','Terminal shell response has no exit_code; earlier frames cannot prove completion or grant send');
  if(nonzero)reject('SHELL_EXIT_NONZERO','Nonzero shell exit cannot grant bridge success or send permission');
  return value;
}
async function runManagerOperations({tools,nodeExecutable,pythonExecutable,runtimeRoot,requestFile,shellExecutable,hostExecutionOptions,hostSendAuthorized=false,authorizationRef=null}) {
  const executionError=managerOpsExecutionError(hostExecutionOptions,shellExecutable);if(executionError)return executionError;
  const stages={};
  // Caller preflight only: these fields record the Manager's existing human
  // authorization. The actual host tool's permission boundary still applies.
  if(!hostSendAuthorized||typeof authorizationRef!=='string'||!authorizationRef.trim())return {status:'error',stage:'authorization',reasonCode:'AUTHORIZATION_REQUIRED',stages};
  const exporterError=managerOpsExporterError(pythonExecutable);if(exporterError)return exporterError;
  const bridge=(action,payload)=>managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile,shellExecutable,hostExecutionOptions},action,payload);
  let prepared;
  try {prepared=await bridge('prepare');stages.prepare={...managerOpsProject(prepared),...(prepared.stages?{stages:managerOpsStages(prepared.stages)}:{})};}
  catch(error){return managerOpsShellError(error,'prepare',stages,'inspect original saved request and completed process/attempt status; never replay prepare or send');}
  if(prepared.status!=='prepared'||prepared.sendNow!==true||prepared.stages?.prepare?.replayed)return {...managerOpsProject(prepared),status:prepared.status==='error'?'error':'stopped',stage:'prepare',stages,nextAction:typeof prepared.nextAction==='string'?prepared.nextAction.slice(0,384):'inspect original operation; no send'};
  const hostRequest=prepared.hostRequest;
  if(hostRequest?.tool!=='mcp__codex_app__send_message_to_thread'||!hostRequest.arguments||!/^[a-f0-9]{64}$/.test(prepared.inputFingerprint??'')||typeof tools.mcp__codex_app__send_message_to_thread!=='function')
    return {status:'reconcile',stages,reasonCode:'CAPABILITY_UNKNOWN',nextAction:'inspect prepared attempt; no send'};
  let raw,outcome;
  const attemptId=prepared.resultRequestBase.attempt_id;
  try {raw=await tools.mcp__codex_app__send_message_to_thread(hostRequest.arguments);outcome=managerOpsAssess(raw,hostRequest.arguments);}
  catch(error){raw={hostException:String(error.message).slice(0,1000)};outcome='unknown';}
  stages.host={attemptId:String(attemptId).slice(0,128),outcome,authorizationRef:authorizationRef.slice(0,384)};
  try {stages.result=managerOpsProject(await bridge('result',{attemptId,outcome,raw,inputFingerprint:prepared.inputFingerprint}));}
  catch(error){return {status:'reconcile',stage:'result',stages,
    hostEvidence:{source:'original native tool result in this invocation',localPersistence:'unknown',attemptId:String(attemptId).slice(0,128)},
    ...managerOpsShellError(error,'result',stages,'inspect original host result and exact attempt; verify local evidence before same result registration; no resend')};}
  return {status:stages.result.status==='recorded'?'recorded':'reconcile',stages,
    nextAction:outcome==='accepted'?'host accepted; await Worker submission and independent review':'inspect same attempt; no resend'};
}

// Separate invocations: receive never approves. Call decision only AFTER the
// Manager independently inspects evidence and explicitly chooses approve/rework.
async function runManagerReviewStage({tools,nodeExecutable,pythonExecutable,runtimeRoot,requestFile,shellExecutable,hostExecutionOptions,phase,managerDecisionConfirmed=false}) {
  const executionError=managerOpsExecutionError(hostExecutionOptions,shellExecutable);if(executionError)return executionError;
  if(!['receive','decision'].includes(phase))return {status:'error',reasonCode:'INVALID_PHASE'};
  if(phase==='decision'&&!managerDecisionConfirmed)return {status:'error',reasonCode:'EXPLICIT_MANAGER_DECISION_REQUIRED'};
  const exporterError=managerOpsExporterError(pythonExecutable);if(exporterError)return exporterError;
  try{const result=await managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile,shellExecutable,hostExecutionOptions},phase);return {...managerOpsProject(result),...(result.stages?{stages:managerOpsStages(result.stages)}:{})};}
  catch(error){return managerOpsShellError(error,phase,{},'inspect exact request/operation status; do not invent approval or repeat a write');}
}

// Fill from verified current context AFTER separate installation approval:
// text(await runManagerOperations({tools,nodeExecutable:'C:/Program Files/nodejs/node.exe',
//   pythonExecutable:'VERIFIED_ABSOLUTE_INSTALLED_PYTHON_EXECUTABLE',
//   runtimeRoot:'VERIFIED_RUNTIME_ROOT',requestFile:'EXISTING_IMMUTABLE_TASK_REQUEST.json',
//   hostSendAuthorized:false,authorizationRef:null}));

// Preferred Manager-only entry for independent NEW tasks. Paste this complete
// file once in the existing authorized dispatch invocation; no imports in V8.
// input is the closed original task material, not manually manufactured events.
async function runManagerDispatch({tools,nodeExecutable,pythonExecutable,runtimeRoot,requestFile,input,task,
  shellExecutable,hostExecutionOptions,hostSendAuthorized=false,authorizationRef=null,repairFingerprint,phase='dispatch'}) {
  const executionError=managerOpsExecutionError(hostExecutionOptions,shellExecutable);if(executionError)return executionError;
  if(!['dispatch','recover','status'].includes(phase))return {status:'error',reasonCode:'INVALID_PHASE'};
  if(phase==='dispatch'&&(!hostSendAuthorized||typeof authorizationRef!=='string'||!authorizationRef.trim()))
    return {status:'error',reasonCode:'AUTHORIZATION_REQUIRED',sendNow:false};
  const exporterError=managerOpsExporterError(pythonExecutable);if(exporterError)return exporterError;
  if(typeof tools?.exec_command!=='function'||phase==='dispatch'&&typeof tools?.mcp__codex_app__send_message_to_thread!=='function')
    return {status:'error',reasonCode:'CAPABILITY_UNKNOWN',sendNow:false};
  let currentStage=phase;
  const stages={},bridge=(action,payload={})=>{currentStage=action;return managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile,shellExecutable,hostExecutionOptions},action,payload);};
  try {
    if(phase!=='dispatch'){const result=await bridge(phase==='status'?'entry_status':'recover');return {...managerOpsProject(result),...(result.transport?{transport:result.transport}:{})};}
    if(input||task){
      const saved=await bridge('save',{...(task?{task}:{input}),...(repairFingerprint?{repairFingerprint}:{})});
      stages.material=managerOpsProject(saved);if(saved.status!=='saved')return {...managerOpsProject(saved),stage:'save',stages,nextAction:'inspect the named field and shell diagnostics; verify material existence and original execution ended before continuing; no send'};
    }
    const prepared=await bridge('entry_prepare');
    stages.prepare={...managerOpsProject(prepared),...(prepared.stages?{stages:managerOpsStages(prepared.stages)}:{})};
    if(prepared.status!=='prepared'||prepared.sendNow!==true){
      // Normal repeated invocation automatically reconciles a SAVED native result.
      // Missing raw evidence remains unknown; recovery never invokes native send.
      if(prepared.reasonCode==='PREPARE_ALREADY_RECORDED'){
        stages.result=managerOpsProject(await bridge('recover'));
        return {status:stages.result.status==='recorded'?'recorded':'reconcile',sendNow:false,stages};
      }
      return {...managerOpsProject(prepared),stages,sendNow:false};
    }
    const request=prepared.hostRequest,attemptId=prepared.resultRequestBase?.attempt_id;
    if(request?.tool!=='mcp__codex_app__send_message_to_thread'||!request.arguments||typeof attemptId!=='string'||
      !/^[a-f0-9]{64}$/.test(prepared.inputFingerprint??''))
      return {status:'reconcile',reasonCode:'CAPABILITY_UNKNOWN',stages,sendNow:false};
    const claim=prepared.sendClaimed===true?{status:'claimed',sendNow:true,attemptId}:{status:'reconcile',reasonCode:'FRESH_SEND_CLAIM_REQUIRED',sendNow:false};
    stages.claim=managerOpsProject(claim);
    if(claim.status!=='claimed'||claim.sendNow!==true)return {status:'reconcile',stages,sendNow:false};
    let raw;
    try{raw=await tools.mcp__codex_app__send_message_to_thread(request.arguments);}
    catch(error){raw={hostException:String(error.message).slice(0,1000)};}
    stages.host={attemptId,outcome:managerOpsAssess(raw,request.arguments),authorizationRef:authorizationRef.slice(0,384)};
    const result=await bridge('entry_result',{attemptId,inputFingerprint:prepared.inputFingerprint,raw});
    stages.result=managerOpsProject(result);
    return {status:result.status==='recorded'?'recorded':'reconcile',sendNow:false,stages};
  }catch(error){
    const stage=error.stage??currentStage;
    const next=stage==='save'?'inspect shell diagnostics; verify whether task material exists and the original invocation ended before continuing; no send':
      stage==='entry_prepare'?'inspect saved task material and exact E04 operation after the original process ends; never replay prepare or send':
      stage==='entry_result'?'inspect original native result and same attempt; use recover only if exact raw evidence was saved; never resend':
      'inspect shell diagnostics and trusted original requestFile; do not create material or repeat writes/send';
    return managerOpsShellError(error,stage,stages,next);
  }
}
