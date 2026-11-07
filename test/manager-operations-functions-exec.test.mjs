import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {fixture} from './manager-operations-helper.mjs';
import {managerOperationsBridge} from '../scripts/manager-operations-bridge.mjs';
import {fingerprint} from '../src/manager-operations-contract.mjs';

for(const mode of ['legacy','queue_first'])for(const outcome of ['accepted','unknown','throw','denied'])
test(`P0-2 functions.exec fake tools ${mode}/${outcome}: exact actual stage values, at most one host send`,async t=>{
  const f=await fixture(t,mode),prior=await f.enqueue({taskId:'unrelated',workerId:'w2'});
  const enqueueInput=await f.base('enqueue',{taskId:'fresh',title:'functions.exec fixture',required:true}),brief={...prior.brief,taskId:'fresh',text:'原始 brief\r\n" $ ` 😀'};
  const requestFile=f.root+"/任务 ' $` request.json",hostEvidencePath=f.root+'/host-response.json';
  const prepareInput={operation_id:'fixed-prepare',reason:'before_dispatch',admission:{native:{host_id:'fake-host',thread_id:'fake-w',status:'idle',evidence_ref:'fixture idle check'}},baseline:{outcome:'not-attempted',evidence_ref:'fixture no in-flight host'}};
  await writeFile(requestFile,JSON.stringify({statePath:f.statePath,enqueueInput,brief,prepareInput,hostEvidencePath}));
  let sends=0,calls=0;const actions=[],payloads=[];
  const tools={exec_command:async({cmd,workdir})=>{
    calls++;assert.equal(workdir,'C:/verified runtime');
    const argv=[...cmd.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replace(/''/g,"'"));
    assert.equal(argv[1],'C:/verified runtime/scripts/manager-operations-bridge.mjs');assert.equal(argv[3],requestFile);
    const payload=JSON.parse(Buffer.from(argv[4],'base64').toString('utf8'));actions.push(argv[2]);payloads.push(payload);
    return {exit_code:0,output:JSON.stringify(await managerOperationsBridge(argv[2],argv[3],payload,f.options))};
  },mcp__codex_app__send_message_to_thread:async request=>{
    sends++;assert.equal(request.threadId,'fake-w');assert.ok(request.prompt.endsWith(brief.text));
    if(outcome==='throw')throw Error('actual fake host output lost');
    if(outcome==='denied')return {isError:true,structuredContent:{code:'POLICY_DENIED'}};
    if(outcome==='unknown')return {isError:false,structuredContent:{unexpected:'unknown shape'}};
    return {isError:false,content:[{type:'text',text:JSON.stringify({hostId:request.hostId,threadId:request.threadId})}]};
  }};
  const source=await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8');
  // Deliberately no Node imports/fs/Buffer/process/tools globals in the sandbox.
  const run=runInNewContext(source+'\nrunManagerOperations;',{},{timeout:1000});
  const args={tools,nodeExecutable:'C:/node.exe',pythonExecutable:'C:/verified python/python.exe',runtimeRoot:'C:/verified runtime',requestFile,hostSendAuthorized:true,authorizationRef:'fixture:existing human authorization'};
  const result=await run(args);assert.equal(sends,1,JSON.stringify(result));assert.deepEqual(actions,['prepare','result']);
  assert.equal(payloads[1].outcome,outcome==='throw'?'unknown':outcome);
  assert.equal(payloads[1].attemptId,(await f.raw()).events.find(e=>e.type==='startTask').id);
  const preserved=JSON.parse(await readFile(hostEvidencePath,'utf8'));assert.deepEqual(preserved,payloads[1]);
  const evidenceBefore=await readFile(hostEvidencePath,'utf8');await run(args);assert.equal(sends,1);assert.equal(await readFile(hostEvidencePath,'utf8'),evidenceBefore);
  const before=calls;await run({...args,hostSendAuthorized:false});assert.equal(calls,before);assert.equal(sends,1);
});

test('Manager review regression: status missing queued task retains original query fingerprint and unknown',async t=>{
  const f=await fixture(t),original='a'.repeat(64),request=await f.base('status',{operationId:'possibly-lost-enqueue',taskId:'not-created',requestFingerprint:original});
  const result=await f.call(request);assert.equal(result.status,'unknown');assert.equal(result.effects,'unknown');assert.equal(result.requestFingerprint,original);
  assert.match(result.nextAction,/execution-ended/);
});

test('Manager review regression: huge native failure + result output loss stay bounded without invented persistence',async()=>{
  const source=await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8');
  const run=runInNewContext(source+'\nrunManagerOperations;',{},{timeout:1000});
  for(const loss of ['result-throws','result-malformed','prepare-malformed']) {
    let sends=0,calls=0;
    const giant='原始错误正文\n'.repeat(25000),tools={exec_command:async()=>{
      calls++;
      if(loss==='prepare-malformed')return {output:giant};
      if(calls===1)return {output:JSON.stringify({status:'prepared',sendNow:true,inputFingerprint:'a'.repeat(64),stages:{prepare:{status:'prepared',message:giant,unrecognizedBody:giant}},
        hostRequest:{tool:'mcp__codex_app__send_message_to_thread',arguments:{hostId:'h',threadId:'w',prompt:'original'}},resultRequestBase:{attempt_id:'real-attempt'}})};
      if(loss==='result-throws')throw Error(giant);
      return {output:giant};
    },mcp__codex_app__send_message_to_thread:async()=>{sends++;return {isError:true,content:[{type:'text',text:giant}]};}};
    const result=await run({tools,nodeExecutable:'node',pythonExecutable:'C:/verified python/python.exe',runtimeRoot:'r',requestFile:'input',hostSendAuthorized:true,authorizationRef:'actual reference'});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<8192);assert.equal(sends,loss==='prepare-malformed'?0:1);
    assert.equal(result.status,'reconcile');assert.equal(result.rawHostResult,undefined);
    if(sends)assert.equal(result.hostEvidence.localPersistence,'unknown');
  }
});

for(const mode of ['legacy','queue_first'])test(`P0-2 ${mode} functions.exec receive is separate from explicit Manager decision`,async t=>{
  const f=await fixture(t,mode),q=await f.enqueue();await f.dispatch(q);await f.event('submit',{summary:'original'},'w');
  // Helper obtains an existing claim/notice and starts review. The exact request
  // then travels through the concrete bridge, preserving the original operation.
  const recv=await f.receive(),source=await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8');
  const run=runInNewContext(source+'\nrunManagerReviewStage;',{},{timeout:1000}),path=f.root+'/review-stage.json';
  let calls=0;const tools={exec_command:async({cmd})=>{calls++;const argv=[...cmd.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replace(/''/g,"'"));
    return {output:JSON.stringify(await managerOperationsBridge(argv[2],argv[3],{},f.options))};}};
  const args={tools,nodeExecutable:'node',pythonExecutable:'C:/verified python/python.exe',runtimeRoot:'runtime',requestFile:path};
  await writeFile(path,JSON.stringify({statePath:f.statePath,request:recv.request}));
  const received=await run({...args,phase:'receive'});assert.equal(received.status,'recorded');assert.equal((await f.raw()).tasks[0].status,'reviewing');
  const before=calls;assert.equal((await run({...args,phase:'decision'})).reasonCode,'EXPLICIT_MANAGER_DECISION_REQUIRED');assert.equal(calls,before);
  await writeFile(path,JSON.stringify({statePath:f.statePath,request:await f.decision(recv)}));
  const result=await run({...args,phase:'decision',managerDecisionConfirmed:true});assert.equal(result.status,mode==='queue_first'?'resolve-pending':'recorded');
  assert.equal((await f.raw()).tasks[0].status,'approved');
});
