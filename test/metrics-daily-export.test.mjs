import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoState } from '../src/demo.mjs';
import { buildDailyView, exportDailyMetrics, renderDailyMetrics } from '../src/metrics-daily-export.mjs';

const roots = [];
afterEach(async () => { while (roots.length) await rm(roots.pop(), { recursive: true, force: true }); });
const event = (kind, line, extra = {}) => ({ kind, line, at: null, callId: null, tool: null, argumentsHash: null, contentHash: null, bytes: null, ...extra });
const record = (id, threadId, at, sourceRef = id, model = null, usage = {}) => ({
  id, hostId: 'fixture-host', threadId, at, turnId: null, model,
  usage: { input: null, cachedInput: null, output: null, reasoningOutput: null, total: null, ...usage },
  source: { kind: 'fixture', ref: sourceRef }
});
const observation = (recordId, sourceRef, events) => ({ recordId, sourceRef, firstLine: 1, usageLine: 20, nativeResponse: null, events });
const options = { from: '2026-09-05', to: '2026-09-06', asOf: '2026-09-06T20:00:00.000Z' };

function fixture() {
  const records = [
    record('prior-record', 'fixture-worker-01', '2026-09-04T15:50:00.000Z', 'prior', null, { total: 2 }),
    record('day-record', 'fixture-worker-01', '2026-09-05T15:59:00.000Z', 'day', 'unknown', { input: 12, cachedInput: 5, output: 3, reasoningOutput: 1, total: 15 }),
    record('plain-record', 'unbound', '2026-09-06T03:00:00.000Z', 'plain', null, { total: null })
  ];
  return {
    schemaVersion: 2, teamId: 'demo-team', records, links: [], diagnostics: [], observations: [
      observation('prior-record', 'prior', [
        event('tool_call', 2, { at: '2026-09-04T16:00:00.000Z', callId: 'cross-midnight', tool: 'team_context.read', argumentsHash: 'a'.repeat(64) }),
        event('tool_call', 3, { at: null, callId: 'prior-unknown-time', tool: 'team_context.manage', argumentsHash: 'f'.repeat(64) })
      ]),
      observation('day-record', 'day', [
        event('tool_call', 2, { at: '2026-09-05T16:01:00.000Z', callId: 'normalized', tool: 'mcp__team_context__team_context_manage', argumentsHash: 'b'.repeat(64) }),
        event('tool_call', 3, { at: null, callId: 'unknown-time', tool: 'team_context.startup', argumentsHash: 'c'.repeat(64) }),
        event('tool_call', 4, { at: '2026-09-06T03:00:00.000Z', callId: 'ordinary', tool: 'exec', argumentsHash: 'd'.repeat(64) }),
        event('tool_call', 5, { at: '2026-09-06T20:00:00.001Z', callId: 'future', tool: 'team_context.manage', argumentsHash: 'e'.repeat(64) })
      ])
    ]
  };
}

test('builds MCP facts from exact direct calls, event dates and inherited usage attribution', () => {
  const view = buildDailyView(demoState(), fixture(), options);
  assert.deepEqual(view.sourceKinds, ['fixture']);
  assert.deepEqual(view.mcpCalls.map(call => [call.date, call.callId, call.role, call.roleSource]), [
    ['2026-09-05', 'cross-midnight', 'Unknown', 'usage-record-attribution'],
    ['2026-09-06', 'normalized', 'Worker', 'usage-record-attribution'],
    [null, 'prior-unknown-time', 'Unknown', 'usage-record-attribution'],
    [null, 'unknown-time', 'Worker', 'usage-record-attribution']
  ]);
  assert.ok(view.mcpCalls.every(call => call.reason === 'unknown' && call.reasonSource === 'unknown' && call.result === 'unknown' && call.behavior === 'unassessed'));
  assert.deepEqual(view.observationCoverage, { usageRecords: 2, recordsWithObservation: 1, ratio: 0.5, label: '用量记录附带观察比例', collectionStatus: 'collected' });
});

test('schema1 marks observations uncollected and blank days remain unknown', () => {
  const ledger = { schemaVersion: 1, teamId: 'demo-team', records: [], links: [], diagnostics: [] };
  const view = buildDailyView(demoState(), ledger, options);
  assert.deepEqual(view.observationCoverage, { usageRecords: 0, recordsWithObservation: 0, ratio: null, label: '用量记录附带观察比例', collectionStatus: 'not-collected' });
  assert.equal(view.daily.days[0].totals.total.known, null);
  const html = renderDailyMetrics(view);
  assert.match(html, /未采集/);
  assert.match(html, /未观测到直接调用/);
});

test('renders accessible two-tab offline tables, safe anchors and escaped text', () => {
  const input = fixture(); input.records[1].model = '<img src=x onerror=evil>';
  const html = renderDailyMetrics(buildDailyView(demoState(), input, options));
  for (const text of ['每日趋势', '每日明细', 'MCP 调用事实', '长期角色召回效果', '离线快照', 'Asia/Shanghai', '历史 Runtime 版本未知', '含模拟身份/数据，请勿当作真实团队完整成本', '仅统计可识别的直接 Team Context MCP 调用；封装调用可能缺失', '分母未采集', '行为未评估', '费用未配置', '覆盖未核实', '未知时间']) assert.match(html, new RegExp(text));
  assert.match(html, /href="#day-2026-09-05"/);
  assert.match(html, /id="day-2026-09-05"/);
  assert.match(html, /未知模型/);
  assert.match(html, /<details/);
  assert.match(html, /<caption>/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /class="table-scroll"[^>]*tabindex="0"/);
  assert.ok(html.includes('&lt;img src=x onerror=evil&gt;'));
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*aria-controls="token-panel"[^>]*tabindex="0"/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*aria-controls="mcp-panel"[^>]*tabindex="-1"/);
  assert.match(html, /role="tabpanel"[^>]*id="token-panel"[^>]*aria-labelledby="token-tab"/);
  assert.match(html, /role="tabpanel"[^>]*id="mcp-panel"[^>]*aria-labelledby="mcp-tab"/);
  assert.doesNotMatch(html, /<section[^>]+role="tabpanel"[^>]+hidden/i);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotMatch(script, /<img|onerror|innerHTML|https?:\/\/|fetch\s*\(|XMLHttpRequest|WebSocket/i);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|<img\b/i);
});

test('aligns numeric headers with cells and gives every detail table the same fixed columns', () => {
  const html = renderDailyMetrics(buildDailyView(demoState(), fixture(), options));
  for (const heading of ['Manager Token', 'Liaison Token', 'Worker Token', 'Unknown Token', '已观测总量', '当日验收数', '输入', '缓存输入', '输出', '总量', '总量缺失记录']) {
    assert.match(html, new RegExp(`<th scope="col" class="numeric">${heading}<\\/th>`));
  }
  const definition = '<colgroup><col class="label-col"><col class="numeric-col" span="5"></colgroup>';
  assert.equal(html.split(definition).length - 1, 6);
  assert.match(html, /\.metric-table\{[^}]*table-layout:fixed/);
  // 16 digits + 5 separators (MAX_SAFE_INTEGER), padding and a safety margin.
  assert.match(html, /\.metric-table\{[^}]*min-width:calc\(140ch \+ 120px\)/);
  assert.match(html, /\.metric-table \.numeric-col\{width:calc\(24ch \+ 20px\)\}/);
  assert.match(html, /\.numeric\{[^}]*text-align:right[^}]*white-space:nowrap/);
  assert.match(html, /\.wrap\{[^}]*overflow-wrap:anywhere/);
});

test('keeps unknown-time calls outside the selected-date count and table even when their usage record is outside the range', () => {
  const html = renderDailyMetrics(buildDailyView(demoState(), fixture(), options));
  assert.match(html, /所选日期内已观测 2 次直接调用/);
  assert.match(html, /未知时间调用（不计入所选日期）[^<]*2 次/);
  const selected = html.match(/<table><caption>所选日期内可识别的直接调用<\/caption>.*?<\/table>/s)?.[0];
  const unknown = html.match(/<table><caption>未知时间调用（不计入所选日期）<\/caption>.*?<\/table>/s)?.[0];
  assert.ok(selected); assert.ok(unknown);
  assert.doesNotMatch(selected, /未知时间/);
  assert.match(unknown, /未知时间/);
  assert.match(unknown, /prior/);
});

test('validates nested view data before rendering or creating an export directory', async () => {
  const view = buildDailyView(demoState(), fixture(), options);
  const invalid = structuredClone(view); invalid.mcpCalls[0].line = '<svg onload=evil>';
  assert.throws(() => renderDailyMetrics(invalid), /invalid|MCP|line/i);
  const root = await mkdtemp(join(tmpdir(), 'daily-invalid-')); roots.push(root);
  const output = join(root, 'out');
  await assert.rejects(exportDailyMetrics(invalid, output), /invalid|MCP|line/i);
  await assert.rejects(stat(output), error => error.code === 'ENOENT');
});

test('exports JSON and HTML, writes READY last, and preserves an existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daily-export-')); roots.push(root);
  const output = join(root, 'out'), view = buildDailyView(demoState(), fixture(), options);
  await exportDailyMetrics(view, output);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'report.json'), 'utf8')), view);
  assert.match(await readFile(join(output, 'index.html'), 'utf8'), /每日趋势/);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'READY.json'), 'utf8')), { schemaVersion: 1, teamId: 'demo-team', sourceVersion: view.daily.sourceVersion, asOf: options.asOf, files: ['report.json', 'index.html'] });
  const marker = join(output, 'keep.txt'); await writeFile(marker, 'keep');
  await assert.rejects(exportDailyMetrics(view, output), /EEXIST|exist/i);
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});
