import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,unlink} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {linkedShellFixture,realPowerShellTool} from './manager-operations-shell-helper.mjs';
const pythonExecutable=process.env.MANAGER_OPS_TEST_PYTHON;
const settings={skip:process.platform!=='win32'||!pythonExecutable};
test('fixed dispatch actual PowerShell/Node/installed Python exporter, fake native only',settings,async t=>{
 const f=await linkedShellFixture(t,{pythonExecutable}),source=await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8');
 // Original helper saved its own advanced input; remove ONLY that synthetic
 // request so the production fixed entry must create task material itself.
 await unlink(f.requestFile);
 const run=runInNewContext(source+'\nrunManagerDispatch;',{},{timeout:1000});
 let sends=0,shells=0;const shellReplies=[];const tools={exec_command:async args=>{shells++;assert.equal(args.sandbox_permissions,'require_escalated');assert.equal(args.justification,'synthetic explicit shell permission');const response=await realPowerShellTool(args.cmd,{workdir:args.workdir});shellReplies.push(response);return response;},
 mcp__codex_app__send_message_to_thread:async request=>{
  sends++;assert.equal(request.threadId,'shell-worker');assert.ok(request.prompt.endsWith(f.input.brief.text));
  return {isError:false,structuredContent:{hostId:request.hostId,threadId:request.threadId}};
 }};
 const e=f.input.enqueueInput,b=f.input.brief,p=f.input.prepareInput;
 const task={statePath:f.statePath,hostEvidencePath:f.input.hostEvidencePath,operationId:e.operationId,caller:e.caller,
  teamId:e.teamId,roundId:e.roundId,workerId:e.workerId,expectedVersion:e.expectedVersion,mode:e.mode,reason:e.reason,title:e.title,required:e.required,
  brief:{text:b.text,scope:b.scope,materialRefs:b.materialRefs,authorizationRef:b.authorizationRef,dependencyRef:b.dependencyRef},
  admission:p.admission,baseline:p.baseline};
 const args={...f,tools,task,hostExecutionOptions:{sandbox_permissions:'require_escalated',justification:'synthetic explicit shell permission'},hostSendAuthorized:true,authorizationRef:'synthetic fake-native authorization'};
 const first=await run(args);assert.equal(first.status,'recorded',JSON.stringify(first));assert.equal(sends,1);assert.equal(shells,3);
 const saved=JSON.parse(await readFile(f.requestFile,'utf8'));assert.match(saved.enqueueInput.taskId,/^task-[a-f0-9]{48}$/);
 const second=await run(args);assert.equal(second.status,'recorded',JSON.stringify({second,shellReplies}));assert.equal(sends,1);
 const status=await run({...args,phase:'status'});assert.equal(status.transport.sendClaimed,true);assert.equal(status.transport.rawResultSaved,true);
 const raw=JSON.parse(await readFile(f.input.hostEvidencePath,'utf8'));assert.equal(raw.outcome,'accepted');
 console.log(JSON.stringify({realPowerShell:true,realNode:true,realInstalledExporter:true,nativeSender:'FAKE',sends,shells,status:status.transport,setup:f.setup}));
});
