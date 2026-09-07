import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../src/cli.mjs';
test('reporting-tick CLI rejects missing or extra arguments before accessing files',async()=>{
 for(const args of [[],['state','ledger','caller'],['state','ledger','caller','automation','time','extra']]) {
  await assert.rejects(run(['reporting-tick',...args],()=>{}),/reporting-tick/);
 }
});
