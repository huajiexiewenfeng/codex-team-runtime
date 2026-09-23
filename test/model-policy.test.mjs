import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleUrl = new URL('../skills/manager-session/scripts/model-policy.mjs', import.meta.url);

test('bundled policy defaults Worker, Liaison and subagent to GPT-6 Sol; preserves Manager', async () => {
  const { run } = await import(moduleUrl);
  const result = await run(['show'], () => {});
  assert.deepEqual(result.policy.defaults.worker, { model: 'gpt-6-sol', effort: 'medium' });
  assert.deepEqual(result.policy.defaults.subagent, result.policy.defaults.worker);
  assert.deepEqual(result.policy.defaults.manager, { model: null, effort: null });
  assert.deepEqual(result.policy.defaults.liaison, { model: 'gpt-6-sol', effort: 'medium' });
  assert.equal(result.effectiveModelVerified, false);
  assert.ok(result.configPath.endsWith('model-policy.json'));
});

test('queries are read-only and resolve explicit host fields', async () => {
  const { run, defaultConfigPath } = await import(moduleUrl);
  const before = await readFile(defaultConfigPath, 'utf8');
  const worker = await run(['resolve', 'worker'], () => {});
  assert.deepEqual(worker.hostFields, { model: 'gpt-6-sol', thinking: 'medium' });
  const helper = await run(['resolve', 'subagent', '--parent-model', 'gpt-6-sol'], () => {});
  assert.deepEqual(helper.hostFields, { model: 'gpt-6-sol', reasoning_effort: 'medium' });
  assert.equal(helper.ceilingAdjusted, false);
  const manager = await run(['resolve', 'manager'], () => {});
  assert.deepEqual(manager.hostFields, {});
  assert.equal(await readFile(defaultConfigPath, 'utf8'), before);
});

test('helper selection honors every direct-parent ceiling without lowering effort', async () => {
  const { run } = await import(moduleUrl);
  for (const parent of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const result = await run(['resolve', 'subagent', '--parent-model', parent], () => {});
    assert.equal(result.selected.model, parent);
    assert.equal(result.selected.effort, 'medium');
    assert.equal(result.ceilingAdjusted, true);
    assert.equal(result.configured.model, 'gpt-6-sol');
  }
  const astra = await run(['resolve', 'subagent', '--parent-model', 'gpt-6-astra'], () => {});
  assert.equal(astra.selected.model, 'gpt-6-sol');
});

test('unknown parents, roles, paths and unsupported/duplicate arguments do not silently fall back', async () => {
  const { run } = await import(moduleUrl);
  for (const args of [
    ['resolve', 'subagent'], ['resolve', 'subagent', '--parent-model', 'unknown'],
    ['resolve', 'leader'], ['show', '--parent-model', 'gpt-6-sol'],
    ['set', 'worker'], ['show', '--config'], ['show', '--config', 'missing.json'],
    ['show', '--config', 'a', '--config', 'b'],
  ]) await assert.rejects(run(args, () => {}));
});

test('configuration validation rejects typos, unmapped models and manager overrides', async () => {
  const { run, validatePolicy, resolvePolicy } = await import(moduleUrl);
  const { policy } = await run(['show'], () => {});
  for (const modify of [
    p => { p.schemaVersion = 2; },
    p => { p.defaults.workre = p.defaults.worker; },
    p => { p.defaults.worker.effort = 'medum'; },
    p => { p.defaults.worker.model = 'unknown'; },
    p => { p.defaults.manager.model = 'gpt-6-sol'; },
    p => { p.modelOrder.push(p.modelOrder[0]); },
    p => { p.defaults.subagent.extra = true; },
  ]) {
    const invalid = structuredClone(policy);
    modify(invalid);
    assert.throws(() => validatePolicy(invalid));
  }
  const custom = structuredClone(policy);
  custom.defaults.subagent = { model: 'gpt-5.6-terra', effort: 'high' };
  validatePolicy(custom);
  assert.deepEqual(resolvePolicy(custom, 'subagent', 'gpt-6-sol').selected, custom.defaults.subagent);
});
