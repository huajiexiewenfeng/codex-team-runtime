import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../src/cli.mjs';
import { demoState } from '../src/demo.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await rm(roots.pop(), { recursive: true, force: true }); });
const json = value => JSON.stringify(value, null, 2) + '\n';
async function inputs() {
  const root = await mkdtemp(join(tmpdir(), 'daily-cli-')); roots.push(root);
  const statePath = join(root, 'state.json'), ledgerPath = join(root, 'ledger.json'), optionsPath = join(root, 'options.json');
  await writeFile(statePath, json(demoState()));
  await writeFile(ledgerPath, json({ schemaVersion: 1, teamId: 'demo-team', records: [], links: [], diagnostics: [] }));
  await writeFile(optionsPath, json({ from: '2026-09-05', to: '2026-09-05', asOf: '2026-09-05T01:00:00.000Z' }));
  return { root, statePath, ledgerPath, optionsPath };
}

test('metrics-daily prints reproducible JSON and leaves every source file unchanged', async () => {
  const paths = await inputs(), before = await Promise.all([paths.statePath, paths.ledgerPath, paths.optionsPath].map(path => readFile(path, 'utf8'))), output = [];
  await run(['metrics-daily', paths.statePath, paths.ledgerPath, paths.optionsPath], value => output.push(value));
  assert.equal(output.length, 1); assert.equal(JSON.parse(output[0]).daily.asOf, '2026-09-05T01:00:00.000Z');
  assert.deepEqual(await Promise.all([paths.statePath, paths.ledgerPath, paths.optionsPath].map(path => readFile(path, 'utf8'))), before);
});

test('metrics-daily-export writes a new snapshot and reports its HTML path', async () => {
  const paths = await inputs(), output = join(paths.root, 'report'), messages = [];
  await run(['metrics-daily-export', paths.statePath, paths.ledgerPath, paths.optionsPath, output], value => messages.push(value));
  assert.match(messages[0], /index\.html/); assert.match(await readFile(join(output, 'index.html'), 'utf8'), /每日趋势/);
});

test('daily commands reject missing, extra and unknown options without creating output', async () => {
  const paths = await inputs();
  for (const args of [
    ['metrics-daily', paths.statePath, paths.ledgerPath],
    ['metrics-daily', paths.statePath, paths.ledgerPath, paths.optionsPath, 'extra'],
    ['metrics-daily-export', paths.statePath, paths.ledgerPath, paths.optionsPath],
    ['metrics-daily-export', paths.statePath, paths.ledgerPath, paths.optionsPath, join(paths.root, 'out'), 'extra']
  ]) await assert.rejects(run(args, () => {}), new RegExp(args[0]));
  const invalidOptions = join(paths.root, 'invalid-options.json'), output = join(paths.root, 'never');
  await writeFile(invalidOptions, json({ from: '2026-09-05', to: '2026-09-05', asOf: '2026-09-05T01:00:00.000Z', now: true }));
  await assert.rejects(run(['metrics-daily-export', paths.statePath, paths.ledgerPath, invalidOptions, output], () => {}), /unknown.*option/i);
  await assert.rejects(readFile(join(output, 'READY.json')), error => error.code === 'ENOENT');
});

test('daily commands read explicit MCP files relative to options and reject invalid descriptors before export', async () => {
  const paths = await inputs(), observations = join(paths.root, 'observations'); await mkdir(observations);
  const value = { schemaVersion: 1, eventId: '00000000-0000-4000-8000-000000000001', startedAt: '2026-09-04T16:00:00.000Z', completedAt: '2026-09-04T16:00:00.001Z', durationMs: 1, tool: 'team_context.read', registryId: 'registry-demo', teamId: 'demo-team', memberId: 'manager', role: 'Manager', hostId: 'host', threadId: 'thread', memberStatus: 'active', identitySource: 'registry-at-call-start', reason: 'manual', reasonSource: 'agent-declared', outcome: 'matched', errorCode: null, policyRevision: 1, runtimeRevision: null, runtimeRevisionSource: 'unknown' };
  await writeFile(join(observations, 'one.json'), json(value));
  await writeFile(paths.optionsPath, json({ from: '2026-09-05', to: '2026-09-05', asOf: '2026-09-05T01:00:00.000Z', mcpObservations: { registryId: 'registry-demo', teamId: 'demo-team', sourceKind: 'fixture', files: ['observations/one.json'] } }));
  const messages = [];
  await run(['metrics-daily', paths.statePath, paths.ledgerPath, paths.optionsPath], value => messages.push(value));
  assert.equal(JSON.parse(messages[0]).serverMcp.days[0].observedCalls, 1);
  const invalid = join(paths.root, 'invalid-mcp.json'), output = join(paths.root, 'never-mcp');
  await writeFile(invalid, json({ from: '2026-09-05', to: '2026-09-05', asOf: '2026-09-05T01:00:00.000Z', mcpObservations: null }));
  await assert.rejects(run(['metrics-daily-export', paths.statePath, paths.ledgerPath, invalid, output], () => {}), /descriptor|mcp/i);
  await assert.rejects(readFile(join(output, 'READY.json')), error => error.code === 'ENOENT');
});
