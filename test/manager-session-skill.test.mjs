import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run } from '../skills/manager-session/scripts/status.mjs';
import { demoState } from '../src/demo.mjs';
import { snapshot } from '../src/runtime.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const asOf = '2026-09-05T01:00:00.000Z';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'manager-skill-'));
  t.after(async () => {
    const expectedParent = await realpath(tmpdir());
    const target = await realpath(dir);
    assert.equal(dirname(target), expectedParent, 'Refuse cleanup outside exact temp parent');
    assert.ok(basename(target).startsWith('manager-skill-'), 'Refuse cleanup without fixture prefix');
    await rm(target, { recursive: true, force: true });
  });
  const path = join(dir, 'state.json'), state = demoState();
  await writeFile(path, JSON.stringify(state));
  return { dir, path, state, args: ['--runtime-root', root, '--state', path, '--as-of', asOf] };
}
test('skill status delegates canonical snapshot without changing state or creating files', async t => {
  const f = await fixture(t), before = await readFile(f.path, 'utf8');
  let output;
  const result = await run(f.args, value => { output = value; });
  assert.deepEqual(result, snapshot(f.state, asOf));
  assert.deepEqual(JSON.parse(output), result);
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.deepEqual(await readdir(f.dir), ['state.json']);
  assert.equal(result.reporting.actual, 'unknown');
});
test('skill history selects a round without reopening or resuming reports', async t => {
  const f = await fixture(t);
  const result = await run([...f.args, '--round', 'round-demo'], () => {});
  assert.deepEqual(result, snapshot(f.state, asOf, 'round-demo'));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.state);
});
test('skill rejects mutations, duplicates, missing arguments and unknown rounds', async t => {
  const f = await fixture(t);
  for (const args of [[], ['apply'], [...f.args, '--state', f.path], [...f.args, '--round'], [...f.args, '--round', 'absent']]) await assert.rejects(run(args, () => {}));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.state);
});
test('skill fails closed on malformed state or non-runtime checkout', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '{');
  await assert.rejects(run(f.args, () => {}));
  assert.equal(await readFile(f.path, 'utf8'), '{');
  await writeFile(join(f.dir, 'package.json'), JSON.stringify({name:'other'}));
  await assert.rejects(run(['--runtime-root', f.dir, '--state', f.path], () => {}), /not codex-team-runtime/);
});
test('skill executable prints JSON and returns nonzero for rejected arguments', async t => {
  const f = await fixture(t), script = join(root, 'skills/manager-session/scripts/status.mjs');
  const ok = spawnSync(process.execPath, [script, ...f.args], {encoding:'utf8'});
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).snapshotId, snapshot(f.state, asOf).snapshotId);
  const bad = spawnSync(process.execPath, [script, '--activate'], {encoding:'utf8'});
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Error:/);
});
