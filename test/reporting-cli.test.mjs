import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';
import { start,attach } from '../src/session.mjs';

test('reporting CLI initializes ledger and plans without changing business state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reporting-cli-'));
 const statePath=join(dir,'state.json'),ledgerPath=join(dir,'ledger.json'),callerPath=join(dir,'caller.json');
 const caller={hostId:'fixture-host',threadId:'fixture-manager'},target={hostId:'fixture-host',threadId:'fixture-liaison'},source={kind:'fixture',ref:'reporting-cli'};
 await start(statePath,{teamId:'fixture-team',name:'Test',caller,source},'2026-09-06T00:00:00.000Z');
 await attach(statePath,{mode:'invite',id:'invite',caller,target,at:'2026-09-06T00:01:00.000Z',expiresAt:'2026-09-06T01:00:00.000Z',source},0);
 await attach(statePath,{mode:'confirm',id:'confirm',caller:target,invitationId:'invite',invitationVersion:1,at:'2026-09-06T00:02:00.000Z',source},1);
 await writeFile(callerPath,JSON.stringify(caller));
 const before=await readFile(statePath,'utf8');
 await run(['reporting-init',statePath,ledgerPath,callerPath,'2026-09-06T00:03:00.000Z'],()=>{});
 const ledgerBefore=await readFile(ledgerPath,'utf8');let output;
 await run(['reporting-plan',statePath,ledgerPath,callerPath],x=>{output=JSON.parse(x);});
 assert.equal(output.kind,'NONE');assert.equal(output.readOnly,true);assert.equal(output.hostActionExecuted,false);assert.equal(output.observedOutcome,'unknown');
 assert.equal(await readFile(statePath,'utf8'),before);
 assert.equal(await readFile(ledgerPath,'utf8'),ledgerBefore);
 await assert.rejects(run(['reporting-init',statePath,ledgerPath,callerPath],()=>{}));
 assert.equal(await readFile(ledgerPath,'utf8'),ledgerBefore);
 assert.deepEqual((await readdir(dir)).sort(),['caller.json','ledger.json','state.json']);
 const eventPath=join(dir,'prepare.json');
 await writeFile(eventPath,JSON.stringify({id:'noop',type:'prepare',at:'2026-09-06T00:04:00.000Z',expiresAt:'2026-09-06T00:05:00.000Z',source:{kind:'fixture',evidenceRef:'cli-no-work'}}));
 await run(['reporting-apply',statePath,ledgerPath,callerPath,eventPath,'0'],()=>{});
 const applied=await readFile(ledgerPath,'utf8');
 assert.equal(JSON.parse(applied).version,1);assert.deepEqual(JSON.parse(applied).operations,[]);
 await assert.rejects(run(['reporting-apply',statePath,ledgerPath,callerPath,eventPath,'0'],()=>{}),/version conflict/i);
 assert.equal(await readFile(ledgerPath,'utf8'),applied);assert.equal(await readFile(statePath,'utf8'),before);
 const liaisonPath=join(dir,'liaison.json');await writeFile(liaisonPath,JSON.stringify(target));
 await assert.rejects(run(['reporting-tick',statePath,ledgerPath,liaisonPath,'unconfirmed-id'],()=>{}),/automation identity/i);
 assert.equal(await readFile(ledgerPath,'utf8'),applied);assert.equal(await readFile(statePath,'utf8'),before);
});

test('reporting CLI validates argument counts and expected version',async()=>{
 for(const [cmd,args] of [['reporting-init',[]],['reporting-plan',['state']],['reporting-apply',['state','ledger','caller','event','x']]]) {
  await assert.rejects(run([cmd,...args],()=>{}),new RegExp(cmd));
 }
});
