import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {linkedShellFixture,realPowerShellTool} from './manager-operations-shell-helper.mjs';

const pythonExecutable=process.env.MANAGER_OPS_TEST_PYTHON;
const settings={skip:process.platform!=='win32'||!pythonExecutable};
const load=async()=>runInNewContext(await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8')+'\nrunManagerOperations;',{},{timeout:1000});
test('real PowerShell/Node/installed exporter: success, exactly one fake send, replay no send, no env dependency',settings,async t=>{
  const f=await linkedShellFixture(t,{pythonExecutable}),run=await load();let sends=0,commands=0;
  const inherited=process.env.CODEX_TEAM_CONTEXT_PYTHON;
  const tools={exec_command:async args=>{commands++;return realPowerShellTool(args.cmd,{workdir:args.workdir});},mcp__codex_app__send_message_to_thread:async request=>{
    sends++;assert.equal(request.threadId,'shell-worker');assert.ok(request.prompt.endsWith(f.input.brief.text));return {isError:false,structuredContent:{hostId:request.hostId,threadId:request.threadId}};
  }};
  const args={...f,tools,hostSendAuthorized:true,authorizationRef:'fixture:only fake native sender authorized'};
  const first=await run(args);assert.equal(first.status,'recorded',JSON.stringify(first));assert.equal(sends,1);assert.equal(commands,2);
  const second=await run(args);assert.equal(sends,1);assert.notEqual(second.status,'recorded');
  const state=JSON.parse(await readFile(f.statePath,'utf8'));assert.equal(state.tasks[0].status,'executing');assert.equal(state.events.filter(e=>e.type==='startTask').length,1);
  const raw=JSON.parse(await readFile(f.input.hostEvidencePath,'utf8'));assert.equal(raw.outcome,'accepted');
  assert.equal(process.env.CODEX_TEAM_CONTEXT_PYTHON,inherited);
  console.log(JSON.stringify({realShell:true,realNode:true,realInstalledExporter:true,exporterEnvRemovedInShell:true,nativeSender:'fake',sends,commands,first:first.status,replay:second.status,setup:f.setup}));
});

test('real shell: missing exporter and actual exporter failure retain bounded corrective prepare fields',settings,async t=>{
  const f=await linkedShellFixture(t,{pythonExecutable}),run=await load();let sends=0,commands=0;
  const tools={exec_command:async args=>{commands++;return realPowerShellTool(args.cmd,{workdir:args.workdir});},mcp__codex_app__send_message_to_thread:async()=>{sends++;throw Error('must not send');}};
  const args={...f,tools,hostSendAuthorized:true,authorizationRef:'fixture fake-host only'},before=await readFile(f.statePath,'utf8');
  const missing=await run({...args,pythonExecutable:undefined});assert.equal(missing.reasonCode,'CAPABILITY_UNKNOWN');assert.equal(missing.field,'pythonExecutable');assert.equal(commands,0);
  const nonexistent=await run({...args,pythonExecutable:f.root+'/missing-python.exe'});assert.equal(nonexistent.reasonCode,'CAPABILITY_UNKNOWN');assert.equal(nonexistent.field,'pythonExecutable');assert.match(nonexistent.message,/missing or unavailable/);
  // Node exists but cannot execute Python's -I exporter command: genuine child
  // execution failure rather than an injected error object.
  const failed=await run({...args,pythonExecutable:process.execPath});assert.equal(failed.status,'error');assert.equal(failed.reasonCode,'HOST_FLOW_ERROR');assert.equal(failed.field,'host');assert.match(failed.message,/Registry exporter failed/);
  assert.equal(failed.stages.prepare.reasonCode,'HOST_FLOW_ERROR');assert.ok(failed.stages.prepare.message.length>0);
  assert.equal(sends,0);assert.equal(await readFile(f.statePath,'utf8'),before);assert.ok(Buffer.byteLength(JSON.stringify(failed))<8192);
  console.log(JSON.stringify({nativeSender:'fake',sends,commands,missing,nonexistent,failed}));
});
