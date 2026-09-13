import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../src/cli.mjs';
import { demoState } from '../src/demo.mjs';
import { buildMetrics } from '../src/metrics.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await rm(roots.pop(), { recursive: true, force: true }); });
async function workspace() { const path = await mkdtemp(join(tmpdir(), 'team-metrics-')); roots.push(path); return path; }
const json = value => JSON.stringify(value, null, 2) + '\n';
const emptyLedger = { schemaVersion: 1, teamId: 'demo-team', records: [], links: [], diagnostics: [] };
const usage = (id, threadId, at, values = {}) => ({
  id, hostId: 'fixture-host', threadId, at, turnId: null, model: null,
  usage: { input: null, cachedInput: null, output: null, reasoningOutput: null, total: null, ...values },
  source: { kind: 'fixture', ref: `record-${id}` }
});
function reportFixture() {
  const state = demoState();
  const ledger = {
    schemaVersion: 1, teamId: 'demo-team', diagnostics: [],
    records: [
      usage('manager-use', 'fixture-manager', '2026-09-05T00:06:30.000Z', { input: 10, cachedInput: 4, output: 2, reasoningOutput: 1, total: 12 }),
      usage('worker-use', 'fixture-worker-01', '2026-09-05T00:05:30.000Z', { output: 3 })
    ],
    links: [
      { recordId: 'manager-use', roundId: 'round-demo', taskId: 'T-1', memberId: 'manager', operation: 'review', evidenceRef: '<script>not-a-link</script>' },
      { recordId: 'worker-use', roundId: 'round-demo', taskId: 'T-1', memberId: 'worker-01', operation: 'implementation', evidenceRef: 'fixture:worker-proof' }
    ]
  };
  return buildMetrics(state, ledger, '2026-09-05T01:00:00.000Z');
}
async function writeImportInputs(root, descriptorOverrides = {}, lineOverrides = {}) {
  const ledgerPath = join(root, 'ledger.json'), sourcePath = join(root, 'usage.jsonl'), descriptorPath = join(root, 'source.json');
  const line = {
    timestamp: '2026-09-05T00:05:30.000Z', type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 }, total_token_usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12 } } },
    ...lineOverrides
  };
  await writeFile(ledgerPath, json(emptyLedger));
  await writeFile(sourcePath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-worker-01' } })}\n${JSON.stringify(line)}\n`);
  await writeFile(descriptorPath, json({ path: 'usage.jsonl', hostId: 'fixture-host', threadId: 'fixture-worker-01', sourceRef: 'synthetic-cli-sample', ...descriptorOverrides }));
  return { ledgerPath, descriptorPath };
}

test('metrics-import resolves one explicit source relative to its descriptor and repeated imports are idempotent', async () => {
  const root = await workspace(), { ledgerPath, descriptorPath } = await writeImportInputs(root);
  const first = join(root, 'ledger-1.json'), second = join(root, 'ledger-2.json');
  await run(['metrics-import', ledgerPath, descriptorPath, first], () => {});
  await run(['metrics-import', first, descriptorPath, second], () => {});
  const one = JSON.parse(await readFile(first, 'utf8')), two = JSON.parse(await readFile(second, 'utf8'));
  assert.equal(one.records.length, 1);
  assert.deepEqual(two, one);
});

test('metrics-import rejects descriptor unknown fields, invalid IDs and source identity mismatches without output', async () => {
  for (const [overrides, pattern] of [[{ extra: true }, /unknown field/i], [{ hostId: '../bad' }, /invalid hostId/i], [{ threadId: 'another-thread' }, /identity mismatch/i]]) {
    const root = await workspace(), { ledgerPath, descriptorPath } = await writeImportInputs(root, overrides), output = join(root, 'never.json');
    await assert.rejects(run(['metrics-import', ledgerPath, descriptorPath, output], () => {}), pattern);
    await assert.rejects(readFile(output), error => error.code === 'ENOENT');
  }
});

test('metrics-import rejects a non-regular explicit source before parsing it', async () => {
  const root = await workspace(), { ledgerPath, descriptorPath } = await writeImportInputs(root), output = join(root, 'never.json');
  await writeFile(descriptorPath, json({ path: '.', hostId: 'fixture-host', threadId: 'fixture-worker-01', sourceRef: 'directory-is-not-a-file' }));
  await assert.rejects(run(['metrics-import', ledgerPath, descriptorPath, output], () => {}), /regular file/i);
});

test('metrics-import consumes native six-field wire into immutable idempotent v2 observations', async () => {
  const root = await workspace(), { ledgerPath, descriptorPath } = await writeImportInputs(root), first = join(root, 'first.json'), second = join(root, 'second.json');
  const before = await readFile(ledgerPath, 'utf8');
  await run(['metrics-import', ledgerPath, descriptorPath, first], () => {});
  await run(['metrics-import', first, descriptorPath, second], () => {});
  const one=JSON.parse(await readFile(first,'utf8')),two=JSON.parse(await readFile(second,'utf8'));
  assert.equal(one.schemaVersion,2);assert.equal(one.observations.length,1);assert.deepEqual(two,one);assert.equal(await readFile(ledgerPath,'utf8'),before);
});

test('metrics-import upgrades mixed v1 history while leaving old records observation-unavailable', async () => {
  const root = await workspace(), { ledgerPath, descriptorPath } = await writeImportInputs(root), output = join(root, 'mixed.json');
  const old = usage('old-record', 'fixture-worker-01', '2026-09-05T00:01:00.000Z', { input: 1, cachedInput: 0, output: 1, reasoningOutput: 0, total: 2 });
  await writeFile(ledgerPath, json({ ...emptyLedger, records: [old] }));
  await run(['metrics-import', ledgerPath, descriptorPath, output], () => {});
  const mixed = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(mixed.schemaVersion, 2);
  assert.deepEqual(mixed.records.find(item => item.id === old.id), old);
  assert.equal(mixed.observations.length, 1);
  assert.notEqual(mixed.observations[0].recordId, old.id);
});

test('metrics commands enforce exact arity', async () => {
  for (const args of [
    ['metrics-import', 'ledger', 'source'], ['metrics-import', 'ledger', 'source', 'out', 'extra'],
    ['metrics', 'state'], ['metrics', 'state', 'ledger', 'asOf', 'extra'],
    ['metrics-export', 'state', 'ledger'], ['metrics-export', 'state', 'ledger', 'out', 'asOf', 'extra']
  ]) await assert.rejects(run(args, () => {}), new RegExp(`${args[0].replace('-', '\\-')} `));
});

test('metrics prints only JSON from a recorded historical state and leaves source bytes unchanged', async () => {
  const root = await workspace(), statePath = join(root, 'state.json'), ledgerPath = join(root, 'ledger.json');
  const bytes = json(demoState()); await writeFile(statePath, bytes); await writeFile(ledgerPath, json(emptyLedger));
  const output = []; await run(['metrics', statePath, ledgerPath, '2026-09-05T01:00:00.000Z'], value => output.push(value));
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.deepEqual(report.sourceScope, { kind: 'recorded-state-snapshot', registryRefreshed: false, liveTelemetry: false });
  assert.equal(await readFile(statePath, 'utf8'), bytes);
});

test('metrics-export refuses existing output and writes complete JSON, HTML and READY last', async () => {
  const root = await workspace(), statePath = join(root, 'state.json'), ledgerPath = join(root, 'ledger.json'), output = join(root, 'report');
  await writeFile(statePath, json(demoState())); await writeFile(ledgerPath, json(emptyLedger));
  await run(['metrics-export', statePath, ledgerPath, output, '2026-09-05T01:00:00.000Z'], () => {});
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const ready = JSON.parse(await readFile(join(output, 'READY.json'), 'utf8'));
  assert.equal(report.sourceScope.kind, 'recorded-state-snapshot');
  assert.match(html, /report\.json/);
  assert.deepEqual(ready, { schemaVersion: 1, teamId: 'demo-team', sourceVersion: report.sourceVersion, asOf: report.asOf, files: ['report.json', 'index.html'] });
  await assert.rejects(run(['metrics-export', statePath, ledgerPath, output], () => {}), /EEXIST|exist/i);
});

test('invalid report rendering happens before export directory creation', async () => {
  const root = await workspace(), output = join(root, 'invalid-report');
  const { exportMetrics } = await import('../src/metrics-export.mjs');
  await assert.rejects(exportMetrics({ schemaVersion: 1, unexpected: true }, output), /report|unknown|invalid/i);
  await assert.rejects(readFile(join(output, 'READY.json')), error => error.code === 'ENOENT');
});

test('offline report is escaped, fixture-labelled, explicit about partial data and exposes task by role tables', async () => {
  const { renderMetrics } = await import('../src/metrics-export.mjs');
  const report = { ...reportFixture(), sourceScope: { kind: 'recorded-state-snapshot', registryRefreshed: false, liveTelemetry: false } };
  const html = renderMetrics(report);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /离线历史快照/);
  assert.match(html, /模拟数据|fixture/);
  assert.match(html, /已知部分/);
  assert.match(html, /未知/);
  assert.match(html, /缺失 1 条/);
  assert.match(html, /记录态快照.*未刷新 Registry.*非实时遥测/s);
  assert.match(html, /sourceVersion/);
  assert.match(html, /<caption>任务 × 角色/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /class="table-scroll"[^>]*tabindex="0"/);
  assert.match(html, /href="report\.json"/);
  assert.ok(html.includes('&lt;script&gt;not-a-link&lt;/script&gt;'));
  assert.doesNotMatch(html, /<script|https?:\/\/|<link\b|<img\b/i);
  assert.doesNotMatch(html, /href="&lt;script|href="fixture:/i);
  assert.match(html, /@media\(max-width:520px\)/);
});

test('offline report accepts recorded host-observation business provenance', async () => {
  const { renderMetrics } = await import('../src/metrics-export.mjs');
  const report = reportFixture(); report.sourceKinds = ['codex-log', 'host-observation'];
  assert.match(renderMetrics(report), /host-observation/);
});

test('renderer rejects malformed attribution primitives and export fails before creating a directory', async () => {
  const { renderMetrics, exportMetrics } = await import('../src/metrics-export.mjs');
  const injection = '<img src=x onerror=alert(1)>';
  const malicious = reportFixture(); malicious.attribution.direct.records = injection;
  assert.throws(() => renderMetrics(malicious), error => /attribution/i.test(error.message) && !error.message.includes(injection));

  const badRatio = reportFixture(); badRatio.attribution.window.ratio = 1.1;
  assert.throws(() => renderMetrics(badRatio), /attribution/i);
  const badAssignment = reportFixture(); badAssignment.attribution.assignments[0].evidenceRef = { unsafe: true };
  assert.throws(() => renderMetrics(badAssignment), /assignment/i);

  const root = await workspace(), output = join(root, 'rejected-export');
  await assert.rejects(exportMetrics(malicious, output), /attribution/i);
  await assert.rejects(stat(output), error => error.code === 'ENOENT');
});

test('renderer strictly rejects abuse across every outer report collection before mkdir', async () => {
  const { renderMetrics, exportMetrics } = await import('../src/metrics-export.mjs');
  const mutations = [
    value => { value.byRole[0].role = { unsafe: true }; value.byRole[0].unexpected = true; },
    value => { value.byMember[0].memberId = 7; value.byMember[0].unexpected = true; },
    value => { value.byTask[0].submissions = -1; value.byTask[0].unexpected = true; },
    value => { value.byTask[0].byRole[0].role = 'Unknown'; },
    value => { value.byOperation[0].operation = 'execute-anything'; value.byOperation[0].unexpected = true; },
    value => { value.findings[0].evidenceIds = ['ok', { unsafe: true }]; value.findings[0].unexpected = true; },
    value => { value.limitations[0].records = -1; value.limitations[0].unexpected = true; },
    value => { value.totals.input.knownRecords += 1; },
    value => { value.attribution.direct.records += 1; },
    value => {
      value.attribution.direct.records -= 1; value.attribution.unknown.records += 1;
      value.attribution.direct.ratio = value.attribution.direct.records / value.attribution.observedRecords;
      value.attribution.unknown.ratio = value.attribution.unknown.records / value.attribution.observedRecords;
    }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const invalid = reportFixture(); mutate(invalid);
    assert.throws(() => renderMetrics(invalid), /invalid|unknown|report|metrics|count/i);
    const root = await workspace(), output = join(root, `strict-${index}`);
    await assert.rejects(exportMetrics(invalid, output), /invalid|unknown|report|metrics|count/i);
    await assert.rejects(stat(output), error => error.code === 'ENOENT');
  }
});
