import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './store.mjs';
import { buildMetrics } from './metrics.mjs';
import { buildDailyMetrics, localDate } from './metrics-daily.mjs';
import { dailyTabsScript } from './metrics-daily-tabs.mjs';
import { buildServerMcpReport, validateServerMcpReport } from './metrics-mcp-events.mjs';

const metricFields = ['input', 'cachedInput', 'nonCachedInput', 'output', 'reasoningOutput', 'net', 'total'];
const roles = ['Manager', 'Liaison', 'Worker', 'Unknown'];
const sourceKindValues = ['fixture', 'manual', 'host-observation', 'codex-log'];
const directTeamContextTools = new Set([
  'team_context.read', 'team_context.manage', 'team_context.startup',
  'mcp__team_context__team_context_read', 'mcp__team_context__team_context_manage', 'mcp__team_context__team_context_startup'
]);
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const object = (value, label) => { check(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`); return value; };
const exact = (value, fields, label) => { object(value, label); check(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), `Invalid ${label} fields`); };
const text = (value, label) => check(typeof value === 'string' && value.length > 0, `Invalid ${label}`);
const nullableText = (value, label) => check(value === null || typeof value === 'string', `Invalid ${label}`);
const count = (value, label) => check(Number.isSafeInteger(value) && value >= 0, `Invalid ${label}`);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function validateMetricSet(metrics, label) {
  exact(metrics, metricFields, label);
  for (const field of metricFields) {
    exact(metrics[field], ['known', 'knownRecords', 'missingRecords'], `${label}.${field}`);
    const value = metrics[field];
    check(value.known === null || (Number.isSafeInteger(value.known) && value.known >= 0), `Invalid ${label}.${field}.known`);
    count(value.knownRecords, `${label}.${field}.knownRecords`); count(value.missingRecords, `${label}.${field}.missingRecords`);
    check((value.knownRecords === 0) === (value.known === null), `Invalid ${label}.${field} known state`);
  }
}

function validateGroup(row, kind, label) {
  const fields = kind === 'member' ? ['memberId', 'role', 'metrics'] : [kind, 'metrics'];
  exact(row, fields, label);
  if (kind === 'role') check(roles.includes(row.role), `Invalid ${label} role`);
  if (kind === 'member') { text(row.memberId, `${label} memberId`); check(roles.slice(0, 3).includes(row.role), `Invalid ${label} role`); }
  if (kind === 'model') nullableText(row.model, `${label} model`);
  validateMetricSet(row.metrics, `${label} metrics`);
}

function validateDaily(daily) {
  exact(daily, ['schemaVersion', 'rulesVersion', 'teamId', 'asOf', 'timeZone', 'from', 'to', 'sourceVersion', 'runtimeVersion', 'days', 'limitations'], 'daily report');
  check(daily.schemaVersion === 1 && daily.rulesVersion === 1 && daily.timeZone === 'Asia/Shanghai' && daily.runtimeVersion === 'unknown', 'Invalid daily report version');
  text(daily.teamId, 'daily teamId'); text(daily.asOf, 'daily asOf'); text(daily.from, 'daily from'); text(daily.to, 'daily to'); count(daily.sourceVersion, 'daily sourceVersion');
  check(new Date(daily.asOf).toISOString() === daily.asOf && /^\d{4}-\d{2}-\d{2}$/.test(daily.from) && /^\d{4}-\d{2}-\d{2}$/.test(daily.to), 'Invalid daily dates');
  check(Array.isArray(daily.days) && Array.isArray(daily.limitations), 'Invalid daily collections');
  for (const limitation of daily.limitations) { exact(limitation, ['code', 'summary'], 'daily limitation'); text(limitation.code, 'limitation code'); text(limitation.summary, 'limitation summary'); }
  for (const day of daily.days) {
    exact(day, ['date', 'records', 'totals', 'byRole', 'byMember', 'byModel', 'approvedTasks', 'coverage'], 'daily day');
    check(/^\d{4}-\d{2}-\d{2}$/.test(day.date), 'Invalid daily day date'); count(day.records, 'daily records'); count(day.approvedTasks, 'daily approvedTasks'); validateMetricSet(day.totals, 'daily totals');
    check(Array.isArray(day.byRole) && day.byRole.length === 4 && Array.isArray(day.byMember) && Array.isArray(day.byModel), 'Invalid daily groups');
    day.byRole.forEach(row => validateGroup(row, 'role', 'daily role')); day.byMember.forEach(row => validateGroup(row, 'member', 'daily member')); day.byModel.forEach(row => validateGroup(row, 'model', 'daily model'));
    exact(day.coverage, ['status', 'expectedMembers', 'observedMembers', 'ratio'], 'daily coverage');
    check(day.coverage.status === 'unverified' && day.coverage.expectedMembers === null && day.coverage.ratio === null, 'Invalid daily coverage state'); count(day.coverage.observedMembers, 'daily observedMembers');
  }
}

function validateView(view) {
  const enriched = isEnrichedView(view);
  exact(view, enriched ? ['schemaVersion', 'daily', 'mcpCalls', 'sourceKinds', 'observationCoverage', 'serverMcp'] : ['daily', 'mcpCalls', 'observationCoverage', 'sourceKinds'], 'daily view');
  if (enriched) check(view.schemaVersion === 2, 'Invalid daily view schemaVersion');
  validateDaily(view.daily);
  check(Array.isArray(view.sourceKinds) && view.sourceKinds.length > 0 && view.sourceKinds.every(kind => sourceKindValues.includes(kind)), 'Invalid sourceKinds');
  check(new Set(view.sourceKinds).size === view.sourceKinds.length && view.sourceKinds.every((kind, index) => index === 0 || view.sourceKinds[index - 1].localeCompare(kind) < 0), 'Invalid sourceKinds order');
  check(Array.isArray(view.mcpCalls), 'Invalid MCP calls');
  for (const call of view.mcpCalls) {
    exact(call, ['date', 'at', 'hostId', 'threadId', 'memberId', 'role', 'roleSource', 'tool', 'callId', 'sourceRef', 'line', 'recordId', 'reason', 'reasonSource', 'result', 'behavior'], 'MCP call');
    check(call.date === null || /^\d{4}-\d{2}-\d{2}$/.test(call.date), 'Invalid MCP date'); nullableText(call.at, 'MCP at');
    if (call.at !== null) check(new Date(call.at).toISOString() === call.at && call.date === localDate(call.at), 'Invalid MCP at');
    text(call.hostId, 'MCP hostId'); text(call.threadId, 'MCP threadId'); nullableText(call.memberId, 'MCP memberId'); check(roles.includes(call.role), 'Invalid MCP role');
    check(call.roleSource === 'usage-record-attribution' && directTeamContextTools.has(call.tool), 'Invalid MCP attribution or tool'); nullableText(call.callId, 'MCP callId'); text(call.sourceRef, 'MCP sourceRef'); count(call.line, 'MCP line'); check(call.line > 0, 'Invalid MCP line'); text(call.recordId, 'MCP recordId');
    check(call.reason === 'unknown' && call.reasonSource === 'unknown' && call.result === 'unknown' && call.behavior === 'unassessed', 'Invalid MCP assessment');
  }
  exact(view.observationCoverage, ['usageRecords', 'recordsWithObservation', 'ratio', 'label', 'collectionStatus'], 'observation coverage');
  const coverage = view.observationCoverage; count(coverage.usageRecords, 'coverage usageRecords'); count(coverage.recordsWithObservation, 'coverage recordsWithObservation');
  check(coverage.recordsWithObservation <= coverage.usageRecords && coverage.label === '用量记录附带观察比例' && ['collected', 'not-collected'].includes(coverage.collectionStatus), 'Invalid observation coverage');
  check(coverage.ratio === (coverage.usageRecords === 0 ? null : coverage.recordsWithObservation / coverage.usageRecords), 'Invalid observation coverage ratio');
  if (enriched) validateServerMcpReport(view.serverMcp, view.daily);
  return view;
}

function isEnrichedView(view) {
  return view !== null && typeof view === 'object' && (Object.hasOwn(view, 'schemaVersion') || Object.hasOwn(view, 'serverMcp'));
}

export function buildDailyView(state, ledger, options, serverInput = null) {
  const daily = buildDailyMetrics(state, ledger, options);
  const aggregate = buildMetrics(state, ledger, options.asOf);
  const assignmentByRecord = new Map(aggregate.attribution.assignments.map(assignment => [assignment.recordId, assignment]));
  const recordById = new Map(ledger.records.map(record => [record.id, record]));
  const scopedRecords = ledger.records.filter(record => record.at <= options.asOf && localDate(record.at) >= options.from && localDate(record.at) <= options.to);
  const observedIds = new Set((ledger.observations ?? []).map(observation => observation.recordId));
  const mcpCalls = [];
  for (const observation of ledger.observations ?? []) {
    const record = recordById.get(observation.recordId);
    if (!record || record.at > options.asOf) continue;
    const assignment = assignmentByRecord.get(record.id);
    for (const item of observation.events) {
      if (item.kind !== 'tool_call' || !directTeamContextTools.has(item.tool)) continue;
      const date = item.at === null ? null : localDate(item.at);
      if (item.at !== null && (item.at > options.asOf || date < options.from || date > options.to)) continue;
      mcpCalls.push({
        date, at: item.at, hostId: record.hostId, threadId: record.threadId,
        memberId: assignment?.memberId ?? null, role: assignment?.role ?? 'Unknown', roleSource: 'usage-record-attribution',
        tool: item.tool, callId: item.callId, sourceRef: observation.sourceRef, line: item.line, recordId: record.id,
        reason: 'unknown', reasonSource: 'unknown', result: 'unknown', behavior: 'unassessed'
      });
    }
  }
  mcpCalls.sort((left, right) => left.at === null ? (right.at === null ? left.line - right.line : 1) : right.at === null ? -1 : left.at.localeCompare(right.at) || left.line - right.line);
  const sourceKinds = [...new Set([state.team.source.kind, ...ledger.records.map(record => record.source.kind)])].sort();
  const legacy = {
    daily, mcpCalls, sourceKinds,
    observationCoverage: {
      usageRecords: scopedRecords.length,
      recordsWithObservation: scopedRecords.filter(record => observedIds.has(record.id)).length,
      ratio: scopedRecords.length === 0 ? null : scopedRecords.filter(record => observedIds.has(record.id)).length / scopedRecords.length,
      label: '用量记录附带观察比例', collectionStatus: ledger.schemaVersion === 1 ? 'not-collected' : 'collected'
    }
  };
  if (serverInput === null) return validateView(legacy);
  return validateView({ schemaVersion: 2, ...legacy, serverMcp: buildServerMcpReport(serverInput, daily) });
}

const known = metric => metric.known === null ? '<span class="unknown">未知</span>' : `<span class="number">${escape(metric.known.toLocaleString('zh-CN'))}</span>`;
const missing = metric => metric.missingRecords === 0 ? '无' : `${escape(metric.missingRecords)} 条`;
const cell = metric => `<td class="numeric">${known(metric)}</td>`;
function metricRows(rows, kind) {
  return rows.map(row => `<tr><th scope="row" class="wrap">${escape(kind === 'member' ? `${row.memberId} · ${row.role}` : kind === 'model' ? (row.model === null ? '未知模型' : row.model) : row.role)}</th>${cell(row.metrics.input)}${cell(row.metrics.cachedInput)}${cell(row.metrics.output)}${cell(row.metrics.total)}<td class="numeric">${missing(row.metrics.total)}</td></tr>`).join('');
}
function metricTable(caption, rows, kind) {
  return `<div class="table-scroll" tabindex="0"><table class="metric-table"><colgroup><col class="label-col"><col class="numeric-col" span="5"></colgroup><caption>${escape(caption)}</caption><thead><tr><th scope="col">分组</th><th scope="col" class="numeric">输入</th><th scope="col" class="numeric">缓存输入</th><th scope="col" class="numeric">输出</th><th scope="col" class="numeric">总量</th><th scope="col" class="numeric">总量缺失记录</th></tr></thead><tbody>${metricRows(rows, kind) || '<tr><td colspan="6" class="unknown">未采集</td></tr>'}</tbody></table></div>`;
}

const reasonLabels = { onboarding: '入组', resume: '恢复', post_compaction: '压缩后', before_dispatch: '派工前', before_delivery: '交付前', before_review: '评审前', identity_conflict: '身份冲突', manual: '手动', unknown: '未知' };
const outcomeLabels = { matched: '匹配', inactive: '非活跃', unmatched: '未匹配', success: '成功', error: '错误', unexpected_error: '意外错误' };
const labelledEnum = (labels, value) => `${labels[value]}（${value}）`;

function serverMcpSection(server) {
  if (server === null) return '<section aria-labelledby="server-mcp"><h2 id="server-mcp">独立导入的 MCP 服务端事件文件</h2><p class="unknown">服务端观测未导入；这不表示服务端调用为零。</p></section>';
  const dailyRows = server.days.map(day => {
    const errors = day.byOutcome.error + day.byOutcome.unexpected_error;
    return `<tr><th scope="row">${escape(day.date)}</th><td class="numeric">${escape(day.byRole.Manager)}</td><td class="numeric">${escape(day.byRole.Liaison)}</td><td class="numeric">${escape(day.byRole.Worker)}</td><td class="numeric">${escape(day.observedCalls)}</td><td class="numeric">${escape(day.byOutcome.matched)}</td><td class="numeric">${escape(day.byOutcome.inactive)}</td><td class="numeric">${escape(day.byOutcome.unmatched)}</td><td class="numeric">${escape(errors)}</td></tr>`;
  }).join('');
  const eventRows = server.events.map(record => {
    const event = record.event, runtime = event.runtimeRevision === null ? '未知' : event.runtimeRevision;
    const metadata = `eventId=${event.eventId} · hostId=${event.hostId} · threadId=${event.threadId} · memberStatus=${event.memberStatus} · identitySource=${event.identitySource} · policyRevision=${event.policyRevision} · runtimeRevision=${runtime} · runtimeRevisionSource=${event.runtimeRevisionSource}`;
    return `<tr><td class="wrap">${escape(event.completedAt)}</td><td class="wrap">${escape(event.memberId)} · 角色 (role) ${escape(event.role)}</td><td class="mono wrap">${escape(event.tool)}</td><td class="wrap">${escape(labelledEnum(reasonLabels, event.reason))} · 来源 (reasonSource) ${escape(event.reasonSource)}</td><td class="wrap">${escape(labelledEnum(outcomeLabels, event.outcome))}${event.errorCode === null ? '' : ` · ${escape(event.errorCode)}`}</td><td class="numeric">${escape(event.durationMs)} ms</td><td class="wrap">${record.sourceRefs.map(escape).join('<br>')}<details><summary>事件元数据</summary><span class="mono wrap">${escape(metadata)}</span></details></td></tr>`;
  }).join('');
  const empty = server.events.length === 0 ? '<p class="unknown">导入文件中未观测到服务端事件；覆盖未核实，这不证明真实调用为零。</p>' : '';
  return `<section aria-labelledby="server-mcp"><h2 id="server-mcp">独立导入的 MCP 服务端事件文件</h2><p>所选 registryId：<span class="mono">${escape(server.registryId)}</span> · teamId：<span class="mono">${escape(server.teamId)}</span> · sourceKind：<span class="mono">${escape(server.sourceKind)}</span> · coverage：覆盖未核实 (unverified)。</p><p class="meta">matched 仅表示返回角色 capsule；身份是 registry-at-call-start，基于调用者声明 host/thread 的 Registry 匹配，并非原生认证，也不证明后续遵守角色。</p>${empty}<div class="table-scroll" tabindex="0"><table><caption>服务端逐日导入计数</caption><thead><tr><th scope="col">日期</th><th scope="col" class="numeric">Manager</th><th scope="col" class="numeric">Liaison</th><th scope="col" class="numeric">Worker</th><th scope="col" class="numeric">总计</th><th scope="col" class="numeric">read matched</th><th scope="col" class="numeric">inactive</th><th scope="col" class="numeric">unmatched</th><th scope="col" class="numeric">错误</th></tr></thead><tbody>${dailyRows}</tbody></table></div><div class="table-scroll" tabindex="0"><table><caption>服务端逐调用证据</caption><thead><tr><th scope="col">完成时间</th><th scope="col">成员与角色</th><th scope="col">工具</th><th scope="col">原因</th><th scope="col">结果</th><th scope="col" class="numeric">耗时</th><th scope="col">证据与元数据</th></tr></thead><tbody>${eventRows || '<tr><td colspan="7" class="unknown">无导入事件</td></tr>'}</tbody></table></div></section>`;
}

export const dailyMetricsStyles = `:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#172033;background:#f5f7fa}*{box-sizing:border-box}body{margin:0;overflow-x:hidden}main{max-width:1180px;min-width:0;margin:auto;padding:24px}h1{font-size:1.65rem}h2{margin-top:32px}.banner,section,details{background:#fff;border:1px solid #d9e0e8;border-radius:10px;padding:16px;margin:14px 0}.fixture{border-left:5px solid #b45309;background:#fff8eb}.notice{border-left:5px solid #2563eb}.meta{color:#516075}.tabs{display:flex;gap:6px;border-bottom:1px solid #cbd5e1;margin-top:20px}.tabs [role="tab"]{appearance:none;border:0;border-bottom:3px solid transparent;background:transparent;color:#475569;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer}.tabs [role="tab"][aria-selected="true"]{color:#1d4ed8;border-bottom-color:#2563eb}.tabs [role="tab"]:focus-visible{outline:3px solid #2563eb;outline-offset:2px}.table-scroll{overflow-x:auto;max-width:100%;outline-offset:3px}.table-scroll:focus{outline:3px solid #2563eb}table{border-collapse:collapse;width:100%;min-width:760px;font-variant-numeric:tabular-nums}caption{text-align:left;font-weight:700;padding:12px 0}th,td{border-bottom:1px solid #e2e8f0;padding:10px;text-align:left;vertical-align:top}.metric-table{table-layout:fixed;min-width:calc(140ch + 120px);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.metric-table .label-col{width:calc(20ch + 20px)}.metric-table .numeric-col{width:calc(24ch + 20px)}.numeric{text-align:right;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.wrap{overflow-wrap:anywhere;word-break:break-word;white-space:normal}.unknown{color:#6b7280}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}a{color:#1d4ed8}summary{cursor:pointer;font-weight:700}[hidden]{display:none!important}@media(max-width:520px){main{padding:12px}h1{font-size:1.35rem}}`;

export function renderDailyMetrics(value) {
  const view = validateView(value), { daily } = view;
  const server = isEnrichedView(view) ? view.serverMcp : null;
  const fixture = view.sourceKinds.includes('fixture') || server?.sourceKind === 'fixture';
  const trendRows = daily.days.map(day => {
    const role = name => day.byRole.find(row => row.role === name).metrics.total;
    return `<tr><th scope="row"><a href="#day-${escape(day.date)}">${escape(day.date)}</a></th>${roles.map(name => cell(role(name))).join('')}${cell(day.totals.total)}<td class="numeric">${escape(day.approvedTasks)}</td><td class="unknown">费用未配置</td><td class="unknown">覆盖未核实</td></tr>`;
  }).join('');
  const details = daily.days.map(day => `<details id="day-${escape(day.date)}"><summary>${escape(day.date)} · ${day.records ? `${escape(day.records)} 条用量记录` : '未采集用量记录'}</summary>${metricTable(`${day.date} 角色明细`, day.byRole, 'role')}${metricTable(`${day.date} 成员明细`, day.byMember, 'member')}${metricTable(`${day.date} 模型明细`, day.byModel, 'model')}</details>`).join('');
  const callRows = calls => calls.map(call => `<tr><td>${call.at === null ? '<span class="unknown">未知时间</span>' : escape(call.at)}</td><td>${escape(call.memberId === null ? '未知成员' : call.memberId)} · ${escape(call.role)}</td><td class="mono wrap">${escape(call.tool)}</td><td class="unknown">原因未知</td><td class="unknown">返回结果未知</td><td class="wrap">${escape(call.sourceRef)} · 第 ${escape(call.line)} 行 · ${escape(call.recordId)}</td></tr>`).join('');
  const selectedCalls = view.mcpCalls.filter(call => call.date !== null), unknownTimeCalls = view.mcpCalls.filter(call => call.date === null);
  const callsTable = (caption, calls, empty) => `<div class="table-scroll" tabindex="0"><table><caption>${caption}</caption><thead><tr><th scope="col">准确时间</th><th scope="col">成员与继承角色</th><th scope="col">工具</th><th scope="col">原因</th><th scope="col">结果</th><th scope="col">位置</th></tr></thead><tbody>${callRows(calls) || `<tr><td colspan="6" class="unknown">${empty}</td></tr>`}</tbody></table></div>`;
  const ratio = view.observationCoverage.ratio === null ? '未知' : `${(view.observationCoverage.ratio * 100).toFixed(1)}%（${view.observationCoverage.recordsWithObservation}/${view.observationCoverage.usageRecords}）`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team 每日观测 · 离线快照</title><style>
${dailyMetricsStyles}
</style></head><body><main><h1>Team 每日观测 · 离线快照</h1><div class="banner notice"><strong>页面不会自动更新</strong><p class="meta">数据截至 ${escape(daily.asOf)} · ${escape(daily.timeZone)} · 统计规则版本 ${escape(daily.rulesVersion)} · 历史 Runtime 版本未知 · sourceKinds ${escape(view.sourceKinds.join(', '))}</p></div>${fixture ? '<div class="banner fixture"><strong>含模拟身份/数据，请勿当作真实团队完整成本</strong></div>' : ''}
<div class="tabs" role="tablist" aria-label="日报视图"><button type="button" id="token-tab" role="tab" aria-selected="true" aria-controls="token-panel" tabindex="0">Token 使用量</button><button type="button" id="mcp-tab" role="tab" aria-selected="false" aria-controls="mcp-panel" tabindex="-1">MCP 调用情况</button></div>
<section role="tabpanel" id="token-panel" aria-labelledby="token-tab"><nav aria-label="日期目录">${daily.days.map(day => `<a href="#day-${escape(day.date)}">${escape(day.date)}</a>`).join(' · ')}</nav>
<section aria-labelledby="trend"><h2 id="trend">每日趋势</h2><div class="table-scroll" tabindex="0"><table><caption>逐日已观测 Token 与验收事实</caption><thead><tr><th scope="col">日期</th><th scope="col" class="numeric">Manager Token</th><th scope="col" class="numeric">Liaison Token</th><th scope="col" class="numeric">Worker Token</th><th scope="col" class="numeric">Unknown Token</th><th scope="col" class="numeric">已观测总量</th><th scope="col" class="numeric">当日验收数</th><th scope="col">费用</th><th scope="col">覆盖</th></tr></thead><tbody>${trendRows}</tbody></table></div></section>
<section aria-labelledby="detail"><h2 id="detail">每日明细</h2>${details}</section>
</section><section role="tabpanel" id="mcp-panel" aria-labelledby="mcp-tab">${serverMcpSection(server)}<p class="banner notice">服务端导入事件与原生日志观测是独立证据；两类来源可能重叠，不能相加。</p><section aria-labelledby="mcp"><h2 id="mcp">原生日志观测 · MCP 调用事实</h2><p>仅统计可识别的直接 Team Context MCP 调用；封装调用可能缺失。数字是已观测下界，不代表所有真实触发次数。</p><p>${selectedCalls.length ? `所选日期内已观测 ${selectedCalls.length} 次直接调用` : '所选日期内未观测到直接调用'}。${escape(view.observationCoverage.label)}：${view.observationCoverage.collectionStatus === 'not-collected' ? '未采集（schema1）' : ratio}。</p>${callsTable('所选日期内可识别的直接调用', selectedCalls, '所选日期内未观测到直接调用')}<p>未知时间调用（不计入所选日期）：${unknownTimeCalls.length} 次。</p>${callsTable('未知时间调用（不计入所选日期）', unknownTimeCalls, '未观测到未知时间调用')}<p class="meta">角色来自关联用量记录归因（usage-record-attribution），不是工具事件时刻独立验证的身份。</p></section>
<section aria-labelledby="recall"><h2 id="recall">长期角色召回效果</h2><div class="table-scroll" tabindex="0"><table><caption>当前证据状态</caption><thead><tr><th scope="col">分母</th><th scope="col">有效召回</th><th scope="col">行为</th><th scope="col">比率</th></tr></thead><tbody><tr><td class="unknown">分母未采集</td><td class="unknown">有效召回未评估</td><td class="unknown">行为未评估</td><td class="unknown">未知</td></tr></tbody></table></div></section>
</section></main><script>${dailyTabsScript}</script></body></html>`;
}

export async function exportDailyMetrics(view, directory) {
  const html = renderDailyMetrics(view);
  await mkdir(directory);
  await atomicWrite(join(directory, 'report.json'), JSON.stringify(view, null, 2) + '\n', true);
  await atomicWrite(join(directory, 'index.html'), html, true);
  await atomicWrite(join(directory, 'READY.json'), JSON.stringify({ schemaVersion: 1, teamId: view.daily.teamId, sourceVersion: view.daily.sourceVersion, asOf: view.daily.asOf, files: ['report.json', 'index.html'] }) + '\n', true);
}
