import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, transact, readState } from '../src/store.mjs';
import { demoState } from '../src/demo.mjs';

async function fixture() {
 const dir = await fs.mkdtemp(join(tmpdir(), 'store-retry-review-'));
 const path = join(dir, 'state.json'), state = demoState();
 await initialize(path, state);
 const bytes = await fs.readFile(path, 'utf8');
 const event = { id: 'retry-report', type: 'reports', actor: 'manager', at: state.updatedAt, source: { kind: 'fixture', ref: 'store-retry' }, enabled: false };
 return { dir, path, state, bytes, event };
}
async function withRename(t, implementation, work) {
 const original = fs.rename;
 t.mock.method(fs, 'rename', (from, to) => implementation(original, from, to));
 syncBuiltinESMExports();
 try { await work(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}
for (const code of ['EPERM', 'EBUSY']) {
 test(`transient ${code} retries same replacement while retaining transaction lock`, { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(); let calls = 0, injectedFailures = 0, platformFailures = 0, temporary;
  await withRename(t, async (realRename, from, to) => {
   calls++; temporary ??= from;
   assert.equal(from, temporary); assert.equal(to, f.path);
   assert.equal(await fs.readFile(f.path, 'utf8'), f.bytes);
   await fs.access(`${f.path}.lock`);
   await assert.rejects(transact(f.path, f.state.version, { ...f.event, id: 'competing-write' }), { code: 'EEXIST' });
   if (calls <= 2) { injectedFailures++; throw Object.assign(new Error('Injected transient Windows replacement contention'), { code }); }
   try { return await realRename(from, to); }
   catch (error) { platformFailures++; throw error; }
  }, async () => {
   const result = await transact(f.path, f.state.version, f.event);
   assert.equal(result.version, f.state.version + 1); assert.equal(result.events.filter(e => e.id === f.event.id).length, 1);
   assert.equal((await readState(f.path)).reporting.enabled, false);
   assert.equal(injectedFailures, 2);
   assert.equal(calls, injectedFailures + platformFailures + 1);
   assert.ok(calls >= 3 && calls <= 21, `Replacement attempts exceeded contract: ${calls}`);
  });
  assert.deepEqual(await fs.readdir(f.dir), ['state.json']);
 });
}
test('persistent Windows replacement denial is bounded and preserves old state', { skip: process.platform !== 'win32' }, async t => {
 const f = await fixture(); let calls = 0;
 await withRename(t, async () => { calls++; await fs.access(`${f.path}.lock`); throw Object.assign(new Error('Persistent denial'), { code: 'EPERM' }); }, async () => {
  await assert.rejects(transact(f.path, f.state.version, f.event), { code: 'EPERM' });
  assert.equal(calls, 21);
 });
 assert.equal(await fs.readFile(f.path, 'utf8'), f.bytes);
 assert.deepEqual(await fs.readdir(f.dir), ['state.json']);
});
test('explicit access denial is not retried and preserves old state', async t => {
 const f = await fixture(); let calls = 0;
 await withRename(t, async () => { calls++; throw Object.assign(new Error('Explicit access denial'), { code: 'EACCES' }); }, async () => {
  await assert.rejects(transact(f.path, f.state.version, f.event), { code: 'EACCES' });
  assert.equal(calls, 1);
 });
 assert.equal(await fs.readFile(f.path, 'utf8'), f.bytes);
 assert.deepEqual(await fs.readdir(f.dir), ['state.json']);
});
