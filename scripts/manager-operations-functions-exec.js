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
  for(const key of ['status','reasonCode','effects','phase','field','message','nextAction','operationId','requestFingerprint','teamId','roundId','taskId','submissionId',
    'eventId','attemptId','briefRef','contentSha256','sourceVersion','recordedVersion','currentStateVersion','readOnly','replayed','sendNow','projectionPending','businessStatus','delivery','reviewStatus']) {
    const v=value?.[key];
    if(typeof v==='string')out[key]=v.slice(0,384);
    else if(v===null||typeof v==='boolean'||typeof v==='number')out[key]=v;
  }
  if(typeof value?.legal==='string')out.legal=value.legal.slice(0,384);
  if(Array.isArray(value?.legal))out.legal=value.legal.slice(0,16).map(v=>String(v).slice(0,128));
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
async function managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile},action,payload={}) {
  const quote=s=>"'"+String(s).replace(/'/g,"''")+"'";
    // The path is an explicit argument to this Node child. The bridge supplies
    // options.python to the existing exporter; no shell/global env is changed.
    const cmd='& '+[nodeExecutable,runtimeRoot+'/scripts/manager-operations-bridge.mjs',action,requestFile,managerOpsBase64(payload),pythonExecutable].map(quote).join(' ');
    let response=await tools.exec_command({cmd,workdir:runtimeRoot,max_output_tokens:16000,yield_time_ms:10000}),stdout=response.output??'';
    while(response.session_id){response=await tools.write_stdin({session_id:response.session_id,chars:'',yield_time_ms:5000,max_output_tokens:16000});stdout+=response.output??'';}
    // Truncated/unknown bridge output never authorizes a send. Never rerun a
    // prepare merely to obtain a lost stdout chunk.
    return JSON.parse(stdout.trim());
}
async function runManagerOperations({tools,nodeExecutable,pythonExecutable,runtimeRoot,requestFile,hostSendAuthorized=false,authorizationRef=null}) {
  const stages={};
  // Caller preflight only: these fields record the Manager's existing human
  // authorization. The actual host tool's permission boundary still applies.
  if(!hostSendAuthorized||typeof authorizationRef!=='string'||!authorizationRef.trim())return {status:'error',stage:'authorization',reasonCode:'AUTHORIZATION_REQUIRED',stages};
  const exporterError=managerOpsExporterError(pythonExecutable);if(exporterError)return exporterError;
  const bridge=(action,payload)=>managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile},action,payload);
  let prepared;
  try {prepared=await bridge('prepare');stages.prepare={...managerOpsProject(prepared),...(prepared.stages?{stages:managerOpsStages(prepared.stages)}:{})};}
  catch(error){return {status:'reconcile',stage:'prepare',stages,error:String(error.message).slice(0,200),nextAction:'bridge status using original requestFile; no send'};}
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
    error:String(error.message).slice(0,200),nextAction:'inspect original host result and exact attempt; verify local evidence before same result registration; no resend'};}
  return {status:stages.result.status==='recorded'?'recorded':'reconcile',stages,
    nextAction:outcome==='accepted'?'host accepted; await Worker submission and independent review':'inspect same attempt; no resend'};
}

// Separate invocations: receive never approves. Call decision only AFTER the
// Manager independently inspects evidence and explicitly chooses approve/rework.
async function runManagerReviewStage({tools,nodeExecutable,pythonExecutable,runtimeRoot,requestFile,phase,managerDecisionConfirmed=false}) {
  if(!['receive','decision'].includes(phase))return {status:'error',reasonCode:'INVALID_PHASE'};
  if(phase==='decision'&&!managerDecisionConfirmed)return {status:'error',reasonCode:'EXPLICIT_MANAGER_DECISION_REQUIRED'};
  const exporterError=managerOpsExporterError(pythonExecutable);if(exporterError)return exporterError;
  try{const result=await managerOpsBridge(tools,{nodeExecutable,pythonExecutable,runtimeRoot,requestFile},phase);return {...managerOpsProject(result),...(result.stages?{stages:managerOpsStages(result.stages)}:{})};}
  catch(error){return {status:'reconcile',stage:phase,error:String(error.message).slice(0,200),nextAction:'inspect exact request/operation status; do not invent approval'};}
}

// Fill from verified current context AFTER separate installation approval:
// text(await runManagerOperations({tools,nodeExecutable:'C:/Program Files/nodejs/node.exe',
//   pythonExecutable:'VERIFIED_ABSOLUTE_INSTALLED_PYTHON_EXECUTABLE',
//   runtimeRoot:'VERIFIED_RUNTIME_ROOT',requestFile:'EXISTING_IMMUTABLE_TASK_REQUEST.json',
//   hostSendAuthorized:false,authorizationRef:null}));
