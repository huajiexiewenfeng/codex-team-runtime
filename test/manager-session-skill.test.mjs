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

test('Manager role governs ordinary workflow selection and recall is conditional', async () => {
  const skill = await readFile(join(root, 'skills/manager-session/SKILL.md'), 'utf8');
  const guide = await readFile(join(root, 'skills/manager-session/references/manager-supervision.md'), 'utf8');
  const entry = skill.indexOf('Established Manager only: keep Manager duties before ordinary workflow routing');
  assert.ok(entry >= 0 && entry < skill.indexOf('## Intent routing'));
  assert.match(skill.slice(entry), /Reuse valid context; if missing, stale or conflicting, use \[Manager recall\]/);
  const managerEntry = guide.split('## Manager entry and recall')[1].split('## Progress and acceptance')[0];
  assert.match(managerEntry, /Apply the established Manager role first.*Continue\/start\/fix.*delegate implementation to a formal Worker/);
  assert.match(managerEntry, /Questions alone do not start dispatch, review or contact/);
  assert.match(managerEntry, /honor explicit changes of role or allocation within scope/);
  assert.match(managerEntry, /Reuse valid identity\/team\/duties; recover missing, stale or conflicting/);
  assert.match(managerEntry, /only at existing checkpoints, never per turn\/tool/);
  assert.match(managerEntry, /sharedRules.*roleDuties.*managerGuidance.*never apply the native filter/);
  assert.match(managerEntry, /Recovery\/readiness is no dispatch authority or admission bypass/);
});

test('normal Manager supervision keeps decision boundaries in the core and routes technical detail on demand', async () => {
  const dir = join(root, 'skills/manager-session/references');
  const guide = await readFile(join(dir, 'manager-supervision.md'), 'utf8');
  const detail = await readFile(join(dir, 'manager-supervision-reference.md'), 'utf8');
  assert.match(guide, /normal supervision read this guide only.*unfamiliar host, unsupported result shape or parameter\/capability question/);
  assert.match(guide, /no separate model round just to load a file/);
  assert.match(guide, /No Worker\/Liaison reads, calls, fields or steps/);
  assert.match(guide, /taskChecks.*pendingSubmissions.*exact .task_id.*explicit team overview/);
  assert.match(guide, /actual diff\/artifacts.*without Worker turns/);
  assert.match(guide, /whitelist metadata before output, never raw results or bodies/);
  assert.match(guide, /Keep executing\/rework completion discovery at existing checkpoints/);
  assert.match(guide, /exact ended\/idle with neither current submission nor active blocker, last turn only/);
  assert.match(guide, /unknown.*grants no body read, resend, redispatch, release, polling or timers/);
  assert.match(guide, /keeping mode and admission unchanged.*Receive starts review only.*independent acceptance/);
  assert.match(guide, /manager-supervision-reference\.md#manager-only-named-operations-local-trial/);
  assert.match(detail, /^## Manager-only named operations \(local trial\)$/m);
  assert.match(detail, /2048 characters, with a 4096-character aggregate/);
  assert.match(detail, /Resume that same execution via functions.wait/);
});

test('formal Manager receipt and decision route through one supervision entry', async () => {
  const dir = join(root, 'skills/manager-session');
  const skill = await readFile(join(dir, 'SKILL.md'), 'utf8');
  const notice = await readFile(join(dir, 'references/completion-notification.md'), 'utf8');
  const guide = await readFile(join(dir, 'references/manager-supervision.md'), 'utf8');
  const route = 'manager-supervision.md#manager-only-named-operations-local-trial';
  const skillEntry = skill.split('\n').find(line => line.includes('Worker stage completion / submission / Manager receipt'));
  assert.ok(skillEntry.includes('references/' + route));
  assert.doesNotMatch(skillEntry + notice, /receive-submission/);
  assert.ok(notice.split('## Manager receipt and review')[1].includes(route));
  const managerEntry = guide.split('## Manager-only named operations (local trial)')[1];
  assert.match(managerEntry, /runManagerReviewStage.*phase: 'receive'.*After independent review.*separate invocation.*phase: 'decision'.*managerDecisionConfirmed: true.*record_decision/);
  assert.match(managerEntry, /receive-submission.*verified older installations.*exact original operation/);
  assert.match(managerEntry, /unknown outcome, partial effect or conflict: stop and reconcile.*Never automatically fall back.*or resend/);
});
