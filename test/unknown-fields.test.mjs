import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createState, evolve, validateCaller } from '../src/runtime.mjs';

const source = {kind:'fixture',ref:'unknown-fields-test'};
const at = '2026-10-01T00:00:00.000Z';
const setup = () => createState({teamId:'team',name:'Team',source,members:
 ['Manager','Liaison','Worker'].map((role,i)=>({id:`m${i}`,role,name:role,lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:`fixture-${i}`}}))},at);

test('CLI apply openRound rejects caller by name and preserves exact state bytes', async () => {
 const dir = await mkdtemp(join(tmpdir(),'unknown-field-cli-'));
 const statePath = join(dir,'state.json'), eventPath = join(dir,'event.json');
 const bytes = JSON.stringify(setup(),null,2)+'\n';
 await writeFile(statePath,bytes);
 await writeFile(eventPath,JSON.stringify({id:'open',type:'openRound',actor:'m0',at,source,roundId:'r',title:'Round',caller:{hostId:'SECRET_VALUE',threadId:'SECRET_VALUE'}}));
 const call = promisify(execFile);
 await assert.rejects(call(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)), 'apply',statePath,eventPath,'0']), error => {
  assert.equal(error.code,1);
  assert.match(error.stderr,/Unknown field in event openRound: "caller"/);
  assert.doesNotMatch(error.stderr,/SECRET_VALUE/);
  return true;
 });
 assert.equal(await readFile(statePath,'utf8'),bytes);
});

test('submit still rejects caller without mutating its input state', () => {
 let state = setup();
 const event = data=>({actor:'m0',at,source,...data});
 state=evolve(state,event({id:'open',type:'openRound',roundId:'r',title:'Round'}),0);
 state=evolve(state,event({id:'assign',type:'assign',roundId:'r',taskId:'t',title:'Task',workerId:'m2',required:true,assignedAt:at}),1);
 const before=JSON.stringify(state);
 assert.throws(()=>evolve(state,event({id:'submit',type:'submit',actor:'m2',roundId:'r',taskId:'t',summary:'Done',caller:{hostId:'fixture-host',threadId:'fixture-2'}}),2),/Unknown field in event submit: "caller"/);
 assert.equal(JSON.stringify(state),before);
});

test('nested unknown field names are exposed with no field values', () => {
 assert.throws(()=>validateCaller({hostId:'h',threadId:'t',token:'SECRET_VALUE'}),error=>{
  assert.match(error.message,/Unknown field: "token"/);
  assert.doesNotMatch(error.message,/SECRET_VALUE/);
  return true;
 });
});

test('unusual names are bounded and escaped, with a bounded list of fields', () => {
 const key='\n\u001b\u202e'+ '\ud800' + 'x'.repeat(2000);
 assert.throws(()=>validateCaller({hostId:'h',threadId:'t',[key]:'SECRET_VALUE',a:1,b:2,c:3,d:4}),error=>{
  assert.match(error.message,/\\n\\u001b\\u202e\\ud800/);
  assert.match(error.message,/truncated/);
  assert.match(error.message,/additional fields omitted/);
  assert.doesNotMatch(error.message,/[\n\x1b\u202e\ud800]|SECRET_VALUE/);
  assert.ok(error.message.length<500);
  return true;
 });
});
