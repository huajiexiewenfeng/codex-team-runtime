import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoState } from '../src/demo.mjs';
import { buildDailyView, renderDailyMetrics } from '../src/metrics-daily-export.mjs';

const ledger = { schemaVersion: 1, teamId: 'demo-team', records: [], links: [], diagnostics: [] };
const options = { from: '2026-09-13', to: '2026-09-13', asOf: '2026-09-13T12:00:00.000Z' };
const event = (overrides = {}) => ({ schemaVersion: 1, eventId: '00000000-0000-4000-8000-000000000001', startedAt: '2026-09-13T00:00:00.000Z', completedAt: '2026-09-13T00:00:00.010Z', durationMs: 10, tool: 'team_context.read', registryId: 'registry-demo', teamId: 'demo-team', memberId: 'worker-1', role: 'Worker', hostId: 'host-1', threadId: 'thread-1', memberStatus: 'active', identitySource: 'registry-at-call-start', reason: 'resume', reasonSource: 'agent-declared', outcome: 'matched', errorCode: null, policyRevision: 2, runtimeRevision: 'runtime-1', runtimeRevisionSource: 'operator-declared', ...overrides });
const input = records => ({ registryId: 'registry-demo', teamId: 'demo-team', sourceKind: 'fixture', records });

test('keeps the exact legacy view shape when server observations are omitted and emits version 2 when supplied', () => {
  const legacy = buildDailyView(demoState(), ledger, options);
  assert.deepEqual(Object.keys(legacy), ['daily', 'mcpCalls', 'sourceKinds', 'observationCoverage']);
  const enriched = buildDailyView(demoState(), ledger, options, input([{ event: event(), sourceRefs: ['fixture.json'] }]));
  assert.deepEqual(Object.keys(enriched), ['schemaVersion', 'daily', 'mcpCalls', 'sourceKinds', 'observationCoverage', 'serverMcp']);
  assert.equal(enriched.schemaVersion, 2); assert.equal(enriched.serverMcp.days[0].observedCalls, 1);
});

test('renders server and native sources separately with exact counts, metadata, fixture warning and escaped values', () => {
  const hostile = event({ runtimeRevision: '<img onerror=evil>' });
  const report = buildDailyView(demoState(), ledger, options, input([{ event: hostile, sourceRefs: ['C:\\evidence\\<bad>.json'] }]));
  const html = renderDailyMetrics(report);
  for (const label of ['独立导入的 MCP 服务端事件文件', '原生日志观测', 'registry-demo', 'demo-team', 'fixture', '服务端逐日导入计数', '服务端逐调用证据', '匹配（matched）', '恢复（resume）', 'agent-declared', 'identitySource=registry-at-call-start', '覆盖未核实', '两类来源可能重叠，不能相加', '有效召回未评估', 'matched 仅表示返回角色 capsule', '并非原生认证', '不证明后续遵守角色']) assert.match(html, new RegExp(label));
  assert.match(html, /<th scope="col" class="numeric">Manager<\/th>/);
  assert.match(html, /<td class="numeric">1<\/td>/);
  assert.ok(html.includes('&lt;img onerror=evil&gt;')); assert.ok(html.includes('&lt;bad&gt;.json'));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  assert.doesNotMatch(script, /onerror|<img|fetch\s*\(|innerHTML/i);
});

test('distinguishes missing server source from an explicitly empty imported set', () => {
  assert.match(renderDailyMetrics(buildDailyView(demoState(), ledger, options)), /服务端观测未导入/);
  const empty = renderDailyMetrics(buildDailyView(demoState(), ledger, options, input([])));
  assert.match(empty, /导入文件中未观测到服务端事件/); assert.match(empty, /覆盖未核实/);
});

test('renderer rejects tampered server counts before producing HTML', () => {
  const report = buildDailyView(demoState(), ledger, options, input([{ event: event(), sourceRefs: ['x'] }]));
  report.serverMcp.days[0].observedCalls = 9;
  assert.throws(() => renderDailyMetrics(report), /derived|count|consistent/i);
});
