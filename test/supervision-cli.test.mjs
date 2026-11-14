import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoState } from '../src/demo.mjs';
import { run } from '../src/cli.mjs';

test('supervision-plan CLI emits bounded native requests without changing files', async () => {
 const dir=await mkdtemp(join(tmpdir(),'supervision-cli-'));
 const state=demoState(), path=join(dir,'state.json'), caller=join(dir,'caller.json');
 await writeFile(path,JSON.stringify(state));
 await writeFile(caller,JSON.stringify({hostId:'fixture-host',threadId:'fixture-manager'}));
 const before=await readFile(path,'utf8'); let output;
 await run(['supervision-plan',path,caller],value=>{output=JSON.parse(value);});
 assert.equal(output.sourceVersion,state.version);
 assert.equal(output.readOnly,true); assert.equal(output.executed,false);
 assert.equal(output.batches.length,1); assert.equal(output.batches[0].timeoutMs,0);
 assert.equal(output.batches[0].targets.length,3);
 assert.equal(await readFile(path,'utf8'),before);
 assert.deepEqual((await readdir(dir)).sort(),['caller.json','state.json']);
 await writeFile(caller,JSON.stringify({hostId:'fixture-host',threadId:'fixture-liaison'}));
 await assert.rejects(run(['supervision-plan',path,caller],()=>{}));
 assert.equal(await readFile(path,'utf8'),before);
});

test('supervision-plan rejects incomplete or extra arguments', async () => {
 for(const args of [[],['state'],['state','caller','cursors','extra']]) {
  await assert.rejects(run(['supervision-plan',...args],()=>{}),/supervision-plan/);
 }
});

test('existing Manager plan supplies a paste-ready filtered wait with exact opaque cursors', async () => {
 const dir=await mkdtemp(join(tmpdir(),'supervision-wait-source-'));
 const state=demoState(), path=join(dir,'state.json'), caller=join(dir,'caller.json'), cursors=join(dir,'cursors.json');
 await writeFile(path,JSON.stringify(state));
 await writeFile(caller,JSON.stringify({hostId:'fixture-host',threadId:'fixture-manager'}));
 let plan;
 await run(['supervision-plan',path,caller],value=>{plan=JSON.parse(value);});
 assert.equal(Object.hasOwn(plan,'waitSource'),false);
 const cursor={...plan.batches[0].targets[0],afterCursor:'opaque"\\$&; // intact'};
 await writeFile(cursors,JSON.stringify([cursor]));
 await run(['supervision-plan',path,caller,cursors,'--wait-batch=1'],value=>{plan=JSON.parse(value);});
 const {batch,source}=plan.waitSource;
 assert.equal(batch,1);
 assert.match(source,/^\/\/ @exec:/);
 const calls=[],outputs=[],secret='PRIVATE_ASSISTANT_AND_TOOL_BODY';
 const tools=new Proxy({}, {get(_target,name){
  assert.equal(name,'mcp__codex_app__wait_threads');
  return async request=>{
   calls.push(request);
   const target=request.targets[0];
   return {structuredContent:{timedOut:true,wake:null,polls:[{
    schemaVersion:1,cursor:'new-opaque',revision:4,changed:true,latestTurn:null,
    thread:{id:target.threadId,hostId:target.hostId,status:{type:'idle'}},
    latestAssistantMessage:{text:secret},latestToolMarker:{output:secret}
   }]}};
  };
 }});
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('tools','text',source)(tools,value=>outputs.push(value));
 assert.deepEqual(calls,[plan.batches[0]]);
 assert.equal(calls[0].targets[0].afterCursor,cursor.afterCursor);
 assert.equal(outputs.length,1);
 assert.equal(outputs[0].targets[0].cursor,'new-opaque');
 assert.equal(outputs[0].targets[0].threadStatus,'idle');
 assert.equal(outputs[0].targets[0].submissionRef,null);
 assert.ok(!JSON.stringify(outputs).includes(secret));
 const unsupported=[];
 await new AsyncFunction('tools','text',source)({},value=>unsupported.push(value));
 assert.deepEqual(unsupported,[{signal:'capability_unavailable',targets:[]}]);
 await run(['supervision-plan',path,caller,'--wait-batch=2'],value=>{plan=JSON.parse(value);});
 assert.deepEqual(plan.waitSource,{batch:2,source:null,signal:'batch_unavailable'});
 assert.ok(plan.taskChecks.length>0,'unavailable native batch does not hide ledger work');
 await writeFile(caller,JSON.stringify({hostId:'fixture-host',threadId:'fixture-liaison'}));
 await assert.rejects(run(['supervision-plan',path,caller,'--wait-batch=1'],()=>{}),/current active bound Manager/);
});
