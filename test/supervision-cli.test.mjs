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
