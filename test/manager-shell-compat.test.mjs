import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8');
const load=name=>runInNewContext(source+'\n'+name+';',{},{timeout:1000});
const paths={nodeExecutable:'C:/node.exe',pythonExecutable:'C:/python.exe',runtimeRoot:'C:/runtime',requestFile:'C:/evidence/new.json',shellExecutable:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'};
const base={...paths,task:{synthetic:true},hostSendAuthorized:true,authorizationRef:'synthetic existing authorization'};
const prepared={status:'prepared',sendNow:true,sendClaimed:true,inputFingerprint:'a'.repeat(64),hostRequest:{tool:'mcp__codex_app__send_message_to_thread',arguments:{hostId:'h',threadId:'w',prompt:'synthetic'}},resultRequestBase:{attempt_id:'synthetic-attempt'}};
function harness(responses,polls=[]){
 let count=0,sends=0;const args=[],pollArgs=[];
 const tools={exec_command:async arg=>{args.push(arg);const item=responses[count++];if(item instanceof Error)throw item;return item;},
 write_stdin:async arg=>{pollArgs.push(arg);const item=polls.shift();if(item instanceof Error)throw item;return item;},
 mcp__codex_app__send_message_to_thread:async()=>{sends++;return {isError:false,structuredContent:{threadId:'w'}};}};
 return {tools,args,pollArgs,get sends(){return sends;},run:(extra={})=>load('runManagerDispatch')({...base,tools,...extra})};
}
for(const options of [
 {sandbox_permissions:'require_escalated',justification:'synthetic explicit host permission'},
 {sandbox_permissions:'use_default'},undefined
])test('closed host options propagate only requested mode '+JSON.stringify(options),async()=>{
 const h=harness([{exit_code:0,output:'{"status":"saved"}'},{exit_code:0,output:JSON.stringify(prepared)},{exit_code:0,output:'{"status":"recorded"}'}]);
 const r=await h.run({hostExecutionOptions:options});assert.equal(r.status,'recorded');assert.equal(h.sends,1);assert.equal(h.args.length,3);
 for(const a of h.args){assert.equal(a.sandbox_permissions,options?.sandbox_permissions);assert.equal(a.justification,options?.justification);assert.equal(a.shell,paths.shellExecutable);assert.equal(a.login,false);assert.equal(a.workdir,paths.runtimeRoot);assert.equal(a.prefix_rule,undefined);}
});
for(const options of [
 {sandbox_permissions:'automatic'}, {sandbox_permissions:'require_escalated'},
 {sandbox_permissions:'require_escalated',justification:''}, {sandbox_permissions:'use_default',justification:'misleading'},
 {sandbox_permissions:'require_escalated',justification:'valid',cmd:'other command'},
 {workdir:'other'}, {shell:'other'}, {prefix_rule:['node']},{login:true},{yield_time_ms:1},
 [],null,'require_escalated'
])test('invalid options fail before any tool '+JSON.stringify(options),async()=>{
 const h=harness([]),r=await h.run({hostExecutionOptions:options});assert.equal(r.status,'error');assert.equal(r.reasonCode,'INVALID_HOST_EXECUTION_OPTIONS');assert.equal(h.args.length,0);assert.equal(h.sends,0);
});
for(const [raw,reason] of [
 [{exit_code:0,output:''},'SHELL_EMPTY_OUTPUT'],
 [{exit_code:0,output:'  \n'},'SHELL_EMPTY_OUTPUT'],
 [{exit_code:0,output:'Access is denied. 非JSON'},'SHELL_NON_JSON'],
 [{exit_code:9,output:'child failed',stderr:'full native stderr'},'SHELL_EXIT_NONZERO'],
 [{exit_code:0,output:'[]'},'SHELL_INVALID_JSON'],
 [{exit_code:0,output:'null'},'SHELL_INVALID_JSON'],
 [{isError:true,code:'PERMISSION_DENIED',message:'denied by actual host'},'SHELL_TOOL_ERROR'],
 [Object.assign(Error('permission denied'),{code:'EACCES'}),'SHELL_TOOL_ERROR']
])test('save failure is actionable, no fictitious recover: '+reason,async()=>{
 const h=harness([raw]),r=await h.run();assert.equal(r.status,'reconcile');assert.equal(r.reasonCode,reason);assert.equal(r.stage,'save');assert.equal(h.args.length,1);assert.equal(h.sends,0);
 assert.ok(r.shellDiagnostic);assert.equal(r.shellDiagnostic.action,'save');assert.doesNotMatch(r.nextAction,/phase=status\/recover/);
 if(raw.output?.includes('Access'))assert.match(r.shellDiagnostic.stdoutPreview,/Access is denied/);
 if(raw.code==='EACCES')assert.equal(r.shellDiagnostic.causeCode,'EACCES');
});
test('nonzero structured CLI error preserves exact reason/field, no permission retry',async()=>{
 const h=harness([{exit_code:1,output:JSON.stringify({status:'error',reasonCode:'ROLE_DENIED',field:'$.caller',message:'actual runtime rejection',sendNow:false})}]);
 const r=await h.run();assert.equal(r.status,'error');assert.equal(r.reasonCode,'ROLE_DENIED');assert.equal(r.field,'$.caller');assert.equal(r.stage,'save');assert.equal(r.shellDiagnostic.exitCode,1);assert.equal(h.args.length,1);assert.equal(h.sends,0);
});
test('nonzero prepared/sendNow response never grants native send',async()=>{
 const h=harness([{exit_code:0,output:'{"status":"saved"}'},{exit_code:4,output:JSON.stringify(prepared)}]);
 const r=await h.run();assert.equal(r.reasonCode,'SHELL_EXIT_NONZERO');assert.equal(r.stage,'entry_prepare');assert.equal(h.sends,0);assert.equal(h.args.length,2);assert.equal(r.shellDiagnostic.parsedStatus,'prepared');
});
test('session stdout is assembled in order, completed exit inspected, no duplicate exec',async()=>{
 const h=harness([{session_id:12,output:'{"status":'},{exit_code:0,output:JSON.stringify(prepared)},{exit_code:0,output:'{"status":"recorded"}'}],
 [{session_id:12,output:'"sa'},{exit_code:0,output:'ved"}',stderr:'synthetic warning'}]);
 const r=await h.run();assert.equal(r.status,'recorded');assert.equal(h.sends,1);assert.equal(h.args.length,3);assert.equal(h.pollArgs.length,2);
 assert.equal(h.pollArgs[0].session_id,12);assert.equal(h.pollArgs[1].session_id,12);assert.equal(h.pollArgs[0].chars,'');
});
test('poll failure retains accumulated stdout, session and phase; never repeats exec',async()=>{
 const h=harness([{session_id:12,output:'partial-original-output'}],[Object.assign(Error('poll interrupted'),{code:'PIPE_LOST'})]);
 const r=await h.run();assert.equal(r.reasonCode,'SHELL_TOOL_ERROR');assert.equal(r.stage,'save');assert.equal(r.shellDiagnostic.sessionId,12);assert.match(r.shellDiagnostic.stdoutPreview,/partial-original-output/);assert.equal(r.shellDiagnostic.causeCode,'PIPE_LOST');assert.equal(h.args.length,1);
});
test('nonzero final poll cannot authorize prepared result despite valid stdout',async()=>{
 const h=harness([{exit_code:0,output:'{"status":"saved"}'},{session_id:8,output:JSON.stringify(prepared)}],[{exit_code:17,output:''}]);
 const r=await h.run();assert.equal(r.reasonCode,'SHELL_EXIT_NONZERO');assert.equal(r.shellDiagnostic.exitCode,17);assert.equal(r.shellDiagnostic.pollCount,1);assert.equal(h.sends,0);assert.equal(h.args.length,2);
});
test('result shell loss occurs after one native call, no retry and bounded diagnostics',async()=>{
 const giant='native stdout with huge content '.repeat(100000);
 const h=harness([{exit_code:0,output:'{"status":"saved"}'},{exit_code:0,output:JSON.stringify(prepared)},{exit_code:0,output:giant}]);
 const r=await h.run();assert.equal(r.status,'reconcile');assert.equal(r.stage,'entry_result');assert.equal(h.sends,1);assert.equal(h.args.length,3);
 assert.ok(Buffer.byteLength(JSON.stringify(r))<8192);assert.ok(r.shellDiagnostic.stdoutChars>1000000);assert.equal(r.shellDiagnostic.previewTruncated,true);assert.doesNotMatch(JSON.stringify(r),/cmd":/);
});
for(const name of ['runManagerOperations','runManagerReviewStage'])test('older interface accepts explicit options and preserves CLI errors: '+name,async()=>{
 const h=harness([{exit_code:1,output:'{"status":"error","reasonCode":"VERSION_CONFLICT","field":"$.expectedVersion"}'}]);
 const r=await load(name)({...base,tools:h.tools,phase:'receive',hostExecutionOptions:{sandbox_permissions:'require_escalated',justification:'synthetic explicit permission'}});
 assert.equal(r.reasonCode,'VERSION_CONFLICT');assert.equal(h.args[0].sandbox_permissions,'require_escalated');assert.equal(h.sends,0);
});

test('error envelope retains nested permission code without JSON parsing',async()=>{
 const h=harness([{isError:true,structuredContent:{code:'APPROVAL_REJECTED'},message:'synthetic host denial'}]);
 const r=await h.run();assert.equal(r.reasonCode,'SHELL_TOOL_ERROR');assert.equal(r.shellDiagnostic.causeCode,'APPROVAL_REJECTED');assert.equal(h.args.length,1);assert.equal(h.sends,0);
});
test('an earlier nonzero chunk is never erased by a later zero exit',async()=>{
 const h=harness([{exit_code:0,output:'{"status":"saved"}'},{session_id:9,exit_code:5,output:JSON.stringify(prepared)}],[{exit_code:0,output:''}]);
 const r=await h.run();assert.equal(r.reasonCode,'SHELL_EXIT_NONZERO');assert.equal(r.shellDiagnostic.chunks[0].exitCode,5);assert.equal(h.sends,0);
});
for(const shellExecutable of ['', 'powershell', 'C:/powershell.exe\nother-command', null])test('invalid shell selection stops before exec '+JSON.stringify(shellExecutable),async()=>{
 const h=harness([]),r=await h.run({shellExecutable});assert.equal(r.reasonCode,'INVALID_HOST_EXECUTION_OPTIONS');assert.equal(h.args.length,0);
});
test('closed options also stop older interfaces before any tool',async()=>{
 for(const name of ['runManagerOperations','runManagerReviewStage']){
  const h=harness([]),r=await load(name)({...base,tools:h.tools,phase:'receive',hostExecutionOptions:{cmd:'overridden'}});
  assert.equal(r.reasonCode,'INVALID_HOST_EXECUTION_OPTIONS');assert.equal(h.args.length,0);
 }
});

for(const kind of ['one-shot','polled','prior-exit-zero'])test('missing terminal exit_code fails closed: '+kind,async()=>{
 const missing={output:JSON.stringify(prepared)},initial=kind==='one-shot'?missing:{session_id:3,...(kind==='prior-exit-zero'?{exit_code:0}:{}),output:''};
 const h=harness([{exit_code:0,output:'{"status":"saved"}'},initial],kind==='one-shot'?[]:[missing]);
 const r=await h.run();assert.equal(r.status,'reconcile');assert.equal(r.reasonCode,'SHELL_EXIT_UNKNOWN');assert.equal(r.stage,'entry_prepare');assert.equal(r.shellDiagnostic.exitCodeKnown,false);assert.equal(r.shellDiagnostic.exitCode,null);assert.equal(h.sends,0);assert.equal(h.args.length,2);
});
test('missing terminal exit_code preserves structured error and never grants permission',async()=>{
 const h=harness([{output:'{"status":"error","reasonCode":"ROLE_DENIED","field":"$.caller","sendNow":true}'}]);
 const r=await h.run();assert.equal(r.status,'error');assert.equal(r.reasonCode,'ROLE_DENIED');assert.equal(r.field,'$.caller');assert.equal(r.sendNow,false);assert.equal(r.shellDiagnostic.exitCodeKnown,false);assert.equal(h.sends,0);assert.equal(h.args.length,1);
});
