import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './store.mjs';
import { validateExplanation } from './metrics-explain.mjs';

const topFields = ['schemaVersion', 'rulesVersion', 'teamId', 'sourceVersion', 'asOf', 'sourceKinds', 'readOnly', 'totals', 'attribution', 'byRole', 'byMember', 'byTask', 'byOperation', 'findings', 'limitations', 'sourceScope', 'explanation'];
const metricFields = ['input', 'cachedInput', 'nonCachedInput', 'output', 'reasoningOutput', 'net', 'total'];
const metricLabels = { input: '输入 Token', cachedInput: '缓存输入', nonCachedInput: '非缓存输入', output: '输出 Token', reasoningOutput: '推理输出', net: '净计量', total: '源总量' };
const roleLabels = { Manager: 'Manager', Liaison: 'Liaison', Worker: 'Worker', Unknown: '未知角色' };
const operationLabels = { coordination: '协调', implementation: '实现', review: '审查', rework: '返工', recovery: '恢复', reporting: '汇报', unknown: '未知操作' };
const attributionKinds = ['explicit', 'window', 'shared', 'unknown'];
const taskStatuses = ['queued', 'executing', 'submitted', 'reviewing', 'rework', 'blocked', 'approved', 'cancelled'];
const findingLabels = {
  usage_missing: '部分用量字段未观测，缺失值没有按零处理', usage_total_mismatch: '来源总量与输入加输出不一致',
  low_direct_attribution: '显式任务关联覆盖率低于一半', source_coverage_gap: '来源诊断显示覆盖不完整或不连续',
  task_pending_review: '任务已提交但尚未进入审查', task_review_open: '任务审查尚未收口', task_rework: '任务存在已记录返工'
};
const limitationLabels = {
  observed_records_only: '仅覆盖已导入的观测记录，不代表完整生命周期成本', elapsed_includes_waiting: '任务历时包含等待，不是 Agent 活跃计算时间',
  causality_not_proven: '显式关联和时间窗归因都不证明 Token 级因果关系', advanced_rules_unassessed: '角色召回、重复查询和忙碌 Worker 规则在 v1 中证据不足，未评估',
  future_records_excluded: '晚于 asOf 的用量记录已排除',
  bytes_are_log_volume_not_input_tokens: '结果 bytes 是日志序列化体积，不是模型输入 Token',
  temporal_correlation_not_causality: '时间邻近只提供时序线索，不证明因果',
  repetition_does_not_prove_waste: '重复候选不证明无效工作或浪费',
  record_only_evidence: '该历史记录缺少 observation，活动证据未知'
};
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const object = (value, label) => { check(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`); return value; };
const exact = (value, fields, label) => { object(value, label); check(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), `Invalid ${label} fields`); };
const requiredText = (value, label) => check(typeof value === 'string' && value.length > 0, `Invalid ${label}`);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function validateMetrics(metrics, label) {
  object(metrics, label); check(Object.keys(metrics).length === metricFields.length && metricFields.every(field => Object.hasOwn(metrics, field)), `Invalid ${label}`);
  for (const field of metricFields) {
    const value = object(metrics[field], `${label}.${field}`);
    check(Object.keys(value).length === 3 && ['known', 'knownRecords', 'missingRecords'].every(key => Object.hasOwn(value, key)), `Invalid ${label}.${field}`);
    check(value.known === null || (Number.isSafeInteger(value.known) && value.known >= 0), `Invalid ${label}.${field}.known`);
    check(Number.isSafeInteger(value.knownRecords) && value.knownRecords >= 0 && Number.isSafeInteger(value.missingRecords) && value.missingRecords >= 0, `Invalid ${label}.${field} counts`);
    check((value.knownRecords === 0) === (value.known === null), `Invalid ${label}.${field} known count`);
  }
  const counts = metricFields.map(field => metrics[field].knownRecords + metrics[field].missingRecords);
  check(counts.every(value => value === counts[0]), `Invalid ${label} record counts`);
  return counts[0];
}
const metricRecordCount = metrics => metrics.input.knownRecords + metrics.input.missingRecords;
function safeCount(value, label) { check(Number.isSafeInteger(value) && value >= 0, `Invalid ${label}`); }
function nullableText(value, label) { check(value === null || typeof value === 'string', `Invalid ${label}`); }
function validateRate(value, label) {
  object(value, label); check(Object.keys(value).length === 2 && Object.hasOwn(value, 'records') && Object.hasOwn(value, 'ratio'), `Invalid ${label}`);
  safeCount(value.records, `${label}.records`);
  check(value.ratio === null || (typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1), `Invalid ${label}.ratio`);
}
function validateAssignment(value) {
  object(value, 'attribution assignment');
  const fields = ['recordId', 'kind', 'roundId', 'taskId', 'memberId', 'role', 'operation', 'evidenceRef'];
  check(Object.keys(value).length === fields.length && Object.keys(value).every(field => fields.includes(field)), 'Invalid attribution assignment');
  check(typeof value.recordId === 'string' && value.recordId.length > 0, 'Invalid attribution assignment recordId');
  check(attributionKinds.includes(value.kind), 'Invalid attribution assignment kind');
  for (const field of ['roundId', 'taskId', 'memberId', 'evidenceRef']) nullableText(value[field], `attribution assignment ${field}`);
  check(Object.hasOwn(roleLabels, value.role), 'Invalid attribution assignment role');
  check(Object.hasOwn(operationLabels, value.operation), 'Invalid attribution assignment operation');
}
function validateReport(report) {
  object(report, 'metrics report'); check(Object.keys(report).every(field => topFields.includes(field)), 'Unknown metrics report field');
  for (const field of topFields.filter(field => !['sourceScope','explanation'].includes(field))) check(Object.hasOwn(report, field), `Missing metrics report field: ${field}`);
  check((report.schemaVersion === 1 || report.schemaVersion === 2) && report.rulesVersion === 1 && report.readOnly === true, 'Invalid metrics report version or mode');
  if (report.schemaVersion === 1) check(!Object.hasOwn(report, 'explanation'), 'Invalid v1 metrics report explanation');
  else { check(Object.hasOwn(report, 'explanation'), 'Missing v2 metrics report explanation'); validateExplanation(report.explanation); }
  check(typeof report.teamId === 'string' && report.teamId.length > 0 && Number.isSafeInteger(report.sourceVersion), 'Invalid metrics report identity');
  check(typeof report.asOf === 'string' && new Date(report.asOf).toISOString() === report.asOf, 'Invalid metrics report asOf');
  check(Array.isArray(report.sourceKinds) && report.sourceKinds.every(kind => ['fixture', 'codex-log', 'manual', 'host-observation'].includes(kind)), 'Invalid metrics report sourceKinds');
  check(new Set(report.sourceKinds).size === report.sourceKinds.length && report.sourceKinds.every((kind,index) => index === 0 || report.sourceKinds[index - 1].localeCompare(kind) < 0), 'Invalid metrics report sourceKinds order');
  const totalRecords = validateMetrics(report.totals, 'totals');
  for (const field of ['byRole', 'byMember', 'byTask', 'byOperation', 'findings', 'limitations']) check(Array.isArray(report[field]), `Invalid metrics report ${field}`);
  const roleSet = Object.keys(roleLabels);
  check(report.byRole.length === roleSet.length, 'Invalid byRole rows');
  const seenRoles = new Set(); let roleRecords = 0;
  for (const row of report.byRole) { exact(row, ['role','metrics'], 'byRole row'); check(roleSet.includes(row.role) && !seenRoles.has(row.role), 'Invalid byRole role'); seenRoles.add(row.role); roleRecords += validateMetrics(row.metrics, 'byRole metrics'); }
  const memberKeys = new Set();
  for (const row of report.byMember) { exact(row, ['memberId','role','metrics'], 'byMember row'); requiredText(row.memberId, 'byMember memberId'); check(['Manager','Liaison','Worker'].includes(row.role), 'Invalid byMember role'); const key=`${row.memberId}\0${row.role}`; check(!memberKeys.has(key), 'Invalid duplicate byMember row'); memberKeys.add(key); validateMetrics(row.metrics, 'byMember metrics'); }
  const operationSet = Object.keys(operationLabels), seenOperations = new Set(); let operationRecords = 0;
  check(report.byOperation.length === operationSet.length, 'Invalid byOperation rows');
  for (const row of report.byOperation) { exact(row, ['operation','metrics'], 'byOperation row'); check(operationSet.includes(row.operation) && !seenOperations.has(row.operation), 'Invalid byOperation operation'); seenOperations.add(row.operation); operationRecords += validateMetrics(row.metrics, 'byOperation metrics'); }
  const taskKeys = new Set();
  for (const task of report.byTask) {
    exact(task, ['taskId','roundId','status','elapsedMs','submissions','reworkCount','metrics','byRole'], 'byTask row');
    requiredText(task.taskId, 'byTask taskId'); requiredText(task.roundId, 'byTask roundId'); check(taskStatuses.includes(task.status), 'Invalid byTask status');
    check(task.elapsedMs === null || (Number.isSafeInteger(task.elapsedMs) && task.elapsedMs >= 0), 'Invalid byTask elapsedMs'); safeCount(task.submissions, 'byTask submissions'); safeCount(task.reworkCount, 'byTask reworkCount');
    const taskKey=`${task.roundId}\0${task.taskId}`; check(!taskKeys.has(taskKey), 'Invalid duplicate byTask row'); taskKeys.add(taskKey);
    const taskRecords=validateMetrics(task.metrics, 'byTask metrics'); check(Array.isArray(task.byRole) && task.byRole.length === 3, 'Invalid task byRole');
    const taskRoles=new Set(); let taskRoleRecords=0;
    for (const row of task.byRole) { exact(row, ['role','metrics'], 'task role row'); check(['Manager','Liaison','Worker'].includes(row.role) && !taskRoles.has(row.role), 'Invalid task role'); taskRoles.add(row.role); taskRoleRecords += validateMetrics(row.metrics, 'task role metrics'); }
    check(taskRoleRecords === taskRecords, 'Invalid task role record counts');
  }
  const findingIds=new Set();
  for (const item of report.findings) {
    exact(item, ['id','ruleId','code','severity','summary','evidenceIds'], 'finding'); requiredText(item.id, 'finding id'); requiredText(item.summary, 'finding summary');
    check(!findingIds.has(item.id), 'Invalid duplicate finding id'); findingIds.add(item.id);
    check(Object.hasOwn(findingLabels,item.code) && item.ruleId === item.code && ['info','warning'].includes(item.severity), 'Invalid finding classification');
    check(Array.isArray(item.evidenceIds) && item.evidenceIds.every(value => typeof value === 'string' && value.length > 0), 'Invalid finding evidenceIds');
  }
  const limitationCodes=new Set();
  for (const item of report.limitations) {
    const fields=item.code === 'future_records_excluded'?['code','summary','records']:['code','summary']; exact(item,fields,'limitation');
    check(Object.hasOwn(limitationLabels,item.code) && !limitationCodes.has(item.code), 'Invalid limitation code'); limitationCodes.add(item.code); requiredText(item.summary,'limitation summary'); if(Object.hasOwn(item,'records'))safeCount(item.records,'limitation records');
  }
  const attribution = object(report.attribution, 'attribution');
  for (const field of ['observedRecords', 'direct', 'window', 'shared', 'unknown', 'assignments']) check(Object.hasOwn(attribution, field), `Invalid attribution ${field}`);
  check(Object.keys(attribution).length === 6, 'Invalid attribution fields');
  safeCount(attribution.observedRecords, 'attribution observedRecords');
  for (const field of ['direct', 'window', 'shared', 'unknown']) validateRate(attribution[field], `attribution ${field}`);
  const attributed=['direct','window','shared','unknown'].reduce((sum,field)=>sum+attribution[field].records,0);
  check(totalRecords === attribution.observedRecords && roleRecords === totalRecords && operationRecords === totalRecords && attributed === totalRecords, 'Invalid report cross counts');
  for(const field of ['direct','window','shared','unknown'])check(attribution[field].ratio === (totalRecords===0?null:attribution[field].records/totalRecords),`Invalid attribution ${field} ratio`);
  check(Array.isArray(attribution.assignments) && attribution.assignments.length === totalRecords, 'Invalid attribution assignments'); attribution.assignments.forEach(validateAssignment);
  check(new Set(attribution.assignments.map(item=>item.recordId)).size === attribution.assignments.length, 'Invalid duplicate attribution assignment');
  const assignmentCount = predicate => attribution.assignments.filter(predicate).length;
  const kindField = { explicit:'direct', window:'window', shared:'shared', unknown:'unknown' };
  for (const [kind,field] of Object.entries(kindField)) check(attribution[field].records === assignmentCount(item=>item.kind===kind), `Invalid attribution ${field} assignment count`);
  for (const row of report.byRole) check(metricRecordCount(row.metrics) === assignmentCount(item=>item.role===row.role), 'Invalid byRole assignment count');
  for (const row of report.byMember) check(metricRecordCount(row.metrics) === assignmentCount(item=>item.memberId===row.memberId&&item.role===row.role), 'Invalid byMember assignment count');
  for (const row of report.byOperation) check(metricRecordCount(row.metrics) === assignmentCount(item=>item.operation===row.operation), 'Invalid byOperation assignment count');
  for (const task of report.byTask) {
    check(metricRecordCount(task.metrics) === assignmentCount(item=>item.roundId===task.roundId&&item.taskId===task.taskId), 'Invalid byTask assignment count');
    for (const row of task.byRole) check(metricRecordCount(row.metrics) === assignmentCount(item=>item.roundId===task.roundId&&item.taskId===task.taskId&&item.role===row.role), 'Invalid task role assignment count');
  }
  if (report.sourceScope !== undefined) {
    const scope = object(report.sourceScope, 'sourceScope');
    check(scope.kind === 'recorded-state-snapshot' && scope.registryRefreshed === false && scope.liveTelemetry === false && Object.keys(scope).length === 3, 'Invalid sourceScope');
  }
  return report;
}
function metricValue(value) {
  if (value.known === null) return `<span class="unknown">未知</span><small>无已知记录；缺失 ${value.missingRecords} 条</small>`;
  const qualifier = value.missingRecords > 0 ? ` <span class="partial">已知部分</span>` : '';
  return `<span class="number">${escape(value.known)}</span>${qualifier}<small>已知 ${value.knownRecords} 条${value.missingRecords ? `；缺失 ${value.missingRecords} 条` : ''}</small>`;
}
function metricCells(metrics) { return metricFields.map(field => `<td>${metricValue(metrics[field])}</td>`).join(''); }
function table(caption, firstHeading, rows) {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${escape(caption)}，可横向滚动"><table><caption>${escape(caption)}</caption><thead><tr><th scope="col">${escape(firstHeading)}</th>${metricFields.map(field => `<th scope="col">${escape(metricLabels[field])}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><th scope="row">暂无记录</th><td colspan="7" class="unknown">未知</td></tr>`}</tbody></table></div>`;
}
function rate(value) { return value.ratio === null ? `${escape(value.records)} 条（比例未知）` : `${escape(value.records)} 条（${escape((value.ratio * 100).toFixed(1))}%）`; }
function duration(value) { if (value === null) return '未知'; const minutes = Math.floor(value / 60000); return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`; }
function taskRoleRows(tasks) {
  return tasks.flatMap(task => task.byRole.map(row => `<tr><th scope="row"><span class="mono">${escape(task.roundId)} / ${escape(task.taskId)}</span><small>${escape(task.status)} · ${escape(roleLabels[row.role] ?? row.role)}</small></th>${metricCells(row.metrics)}</tr>`));
}
function evidence(items) { return items.length ? `<ul>${items.map(item => `<li class="mono">${escape(item)}</li>`).join('')}</ul>` : '<span class="unknown">无证据索引</span>'; }
function assignmentRows(assignments) {
  return assignments.map(item => `<tr><th scope="row" class="mono">${escape(item.recordId)}</th><td>${escape(item.kind)}</td><td>${escape(item.roundId ?? '未知')}</td><td>${escape(item.taskId ?? '未知')}</td><td>${escape(roleLabels[item.role] ?? item.role)}</td><td>${escape(operationLabels[item.operation] ?? item.operation)}</td><td class="mono">${item.evidenceRef === null ? '<span class="unknown">无</span>' : escape(item.evidenceRef)}</td></tr>`).join('');
}

const scalar = value => value === null ? '<span class="unknown">未知</span>' : `<span class="number">${escape(value)}</span>`;
const optionalText = value => value === null ? '<span class="unknown">未知</span>' : `<span class="mono wrap">${escape(value)}</span>`;
const location = card => card.source.firstLine === null ? '<span class="unknown">来源位置未知</span>' : `第 ${escape(card.source.firstLine)}–${escape(card.source.lastLine)} 行 · usage 第 ${escape(card.source.usageLine)} 行 · activity 截止第 ${escape(card.source.activityLastLine)} 行`;
const activityItems = (items, kind) => items.length ? `<ul>${items.map(item => `<li>第 ${escape(item.line)} 行 · ${kind === 'call' ? `tool <span class="mono">${escape(item.tool ?? '未知')}</span>` : `${item.tool === null ? 'tool 未知' : `tool <span class="mono">${escape(item.tool)}</span>`} · ${item.bytes === null ? '<span class="unknown">bytes 未知</span>' : `${escape(item.bytes)} bytes`} · ${item.callLine === null ? 'call 位置未知' : `call 第 ${escape(item.callLine)} 行`}`}</li>`).join('')}</ul>` : '<p class="muted">已观测窗口内无事件。</p>';
function ranking(explanation, field, label) {
  const rows=explanation.rankings[field].rows, shown=rows.slice(0,10);
  return `<section class="driver"><h3>${escape(label)}</h3><p class="muted">显示 ${shown.length} / 共 ${rows.length}；未知 ${escape(explanation.rankings[field].missingRecords)} 条</p><ol>${shown.map(row=>`<li><a href="#record-${escape(explanation.cards.findIndex(card=>card.recordId===row.recordId))}"><span class="mono wrap">${escape(row.recordId)}</span></a> · ${escape(row.value)}</li>`).join('')||'<li class="unknown">无已知值</li>'}</ol></section>`;
}
function explanationView(explanation) {
  const cards=explanation.cards.map((card,index)=>`<details class="evidence-card" id="record-${index}"><summary><span class="mono wrap">${escape(card.recordId)}</span> · ${escape(card.attribution.role)} / ${escape(card.attribution.operation)}</summary><div class="card-body">
<p><strong>记录上下文：</strong>time <time datetime="${escape(card.time)}">${escape(card.time)}</time>；turnId ${optionalText(card.turnId)}；model：${optionalText(card.model)}；hostId <span class="mono wrap">${escape(card.identity.hostId)}</span>；threadId <span class="mono wrap">${escape(card.identity.threadId)}</span></p>
<p><strong>数值构成：</strong>input ${scalar(card.metrics.input)}；cached ${scalar(card.metrics.cachedInput)}；nonCached ${scalar(card.metrics.nonCachedInput)}；output ${scalar(card.metrics.output)}；reasoning ${scalar(card.metrics.reasoningOutput)}；net ${scalar(card.metrics.net)}；total ${scalar(card.metrics.total)}</p>
<p><strong>源位置：</strong>kind <span class="mono">${escape(card.source.kind)}</span> · ref <span class="mono wrap">${escape(card.source.ref)}</span> · ${location(card)}</p>
<p><strong>native response：</strong>${card.nativeResponse===null?'<span class="unknown">未知 / 无唯一 counter-match</span>':`<span class="mono wrap">${escape(card.nativeResponse.responseId)}</span> · turn ${escape(card.nativeResponse.turnId)} · 第 ${escape(card.nativeResponse.line)} 行 · counter-match`}</p>
<p><strong>归因：</strong>${escape(card.attribution.kind)} · ${escape(card.attribution.roundId??'未知')} / ${escape(card.attribution.taskId??'未知')} · ${escape(card.attribution.memberId??'未知')} · evidenceRef <span class="mono wrap">${escape(card.attribution.evidenceRef??'无')}</span></p>
<h4>工具调用（${scalar(card.activity.toolCalls.count)}）</h4>${card.activity.availability==='unavailable'?'<p class="unknown">observation 历史不可用；未知，不是零。</p>':activityItems(card.activity.toolCalls.items,'call')}
<h4>工具结果（${scalar(card.activity.toolResults.count)}）</h4>${card.activity.availability==='unavailable'?'<p class="unknown">observation 历史不可用；未知，不是零。</p>':activityItems(card.activity.toolResults.items,'result')}
<p><strong>压缩：</strong>${card.activity.compactions.count===null?'<span class="unknown">未知</span>':`${escape(card.activity.compactions.count)} 次 · 行 ${escape(card.activity.compactions.lines.join(', ')||'无')}`}；<strong>用户消息事件：</strong>${card.activity.userMessages.count===null?'<span class="unknown">未知</span>':escape(card.activity.userMessages.count)}</p>
<p><strong>证据级别：</strong>${card.evidence.map(item=>`<span class="pill">${escape(item.level)} · ${escape(item.code)}${item.lines.length?`（行 ${escape(item.lines.join(', '))}）`:''}</span>`).join(' ')||'<span class="unknown">无额外事件证据</span>'}</p>
<p class="muted">限制：${card.limitations.map(code=>escape(limitationLabels[code]??code)).join('；')}。建议：${card.suggestions.map(escape).join('；')}。</p></div></details>`).join('');
  const candidates=explanation.repetitionCandidates.map((item,index)=>`<li><strong>${escape(item.kind)}</strong> <span class="pill">candidate</span> · tool <span class="mono">${escape(item.tool)}</span> · previous <a href="#record-${escape(explanation.cards.findIndex(card=>card.recordId===item.previous.recordId))}">${escape(item.previous.recordId)}</a> call/result ${escape(item.previous.callLine)}/${escape(item.previous.resultLine??'未知')} · current <a href="#record-${escape(explanation.cards.findIndex(card=>card.recordId===item.current.recordId))}">${escape(item.current.recordId)}</a> call/result ${escape(item.current.callLine)}/${escape(item.current.resultLine??'未知')} · ${escape(limitationLabels.repetition_does_not_prove_waste)}</li>`).join('');
  return `<section aria-labelledby="drivers"><h2 id="drivers">成本驱动原因下钻</h2><p class="muted">排名分别按 input、nonCachedInput、output、net 展示；这些维度有重叠，不能相加。Token event count 不等于 request/tool call count；结果 bytes 是日志序列化体积，不是模型输入 Token。证据级别：observed（直接观测）、temporal（时序邻近）、candidate（待人工核对）。</p><div class="drivers">${ranking(explanation,'input','输入 Token')}${ranking(explanation,'nonCachedInput','非缓存输入')}${ranking(explanation,'output','输出 Token')}${ranking(explanation,'net','净计量')}</div><h3>逐记录证据卡（完整 ${escape(explanation.cards.length)} 条）</h3>${cards||'<p class="unknown">暂无记录。</p>'}<h3>重复候选（${escape(explanation.repetitionCandidates.length)}）</h3><ul>${candidates||'<li>无候选；理由未知时不判断浪费。</li>'}</ul><div class="notes"><h3>共同限制</h3><ul>${explanation.limitations.map(code=>`<li><code>${escape(code)}</code> — ${escape(limitationLabels[code]??code)}</li>`).join('')}</ul></div></section>`;
}

export function renderMetrics(report) {
  validateReport(report);
  const fixture = report.sourceKinds.includes('fixture');
  const roleRows = report.byRole.map(row => `<tr><th scope="row">${escape(roleLabels[row.role] ?? row.role)}</th>${metricCells(row.metrics)}</tr>`);
  const memberRows = report.byMember.map(row => `<tr><th scope="row"><span class="mono">${escape(row.memberId)}</span><small>${escape(roleLabels[row.role] ?? row.role)}</small></th>${metricCells(row.metrics)}</tr>`);
  const operationRows = report.byOperation.map(row => `<tr><th scope="row">${escape(operationLabels[row.operation] ?? row.operation)}</th>${metricCells(row.metrics)}</tr>`);
  const taskRows = report.byTask.map(task => `<tr><th scope="row"><span class="mono">${escape(task.roundId)} / ${escape(task.taskId)}</span><small>${escape(task.status)} · 历时 ${duration(task.elapsedMs)} · 提交 ${escape(task.submissions)} · 返工 ${escape(task.reworkCount)}</small></th>${metricCells(task.metrics)}</tr>`);
  const findings = report.findings.map(item => `<article class="finding"><div><span class="pill ${escape(item.severity)}">${escape(item.severity)}</span> <code>${escape(item.code)}</code></div><h3>${escape(findingLabels[item.code] ?? item.summary)}</h3>${evidence(item.evidenceIds)}</article>`).join('');
  const limitations = report.limitations.map(item => `<li><code>${escape(item.code)}</code> — ${escape(limitationLabels[item.code] ?? item.summary)}${item.records === undefined ? '' : `（${escape(item.records)} 条）`}</li>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team Metrics · 离线历史快照</title><style>
:root{color-scheme:light;--bg:#f6f7fa;--surface:#fff;--ink:#202a3b;--muted:#586579;--line:#dde3ec;--accent:#284fa5;--accent-soft:#edf2ff;--green:#226347;--green-soft:#eaf5ef;--amber:#855015;--amber-soft:#fff6e8;--radius:14px}*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}header,main{max-width:1440px;margin:auto}header{padding:28px 32px 12px}main{padding:0 32px 48px}h1{font-size:30px;margin:0}h2{font-size:19px;margin:32px 0 12px}h3{font-size:15px;margin:8px 0}p{margin:7px 0}.muted,small{display:block;color:var(--muted);font-size:12px}.mono,code,.number{font-family:Consolas,"Courier New",monospace;font-variant-numeric:tabular-nums}.wrap{overflow-wrap:anywhere}.source-banner,.fixture-banner,.summary,.finding,.notes,.evidence-card,.driver{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;margin:12px 0}.source-banner{border-left:3px solid var(--accent)}.fixture-banner{background:var(--amber-soft);border-color:#e8d5b4;color:var(--amber);font-weight:600}.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.summary strong{display:block;font-size:18px}.drivers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.driver{min-width:0}.driver ol{padding-left:22px}.evidence-card summary{cursor:pointer;font-weight:700;overflow-wrap:anywhere}.evidence-card summary:focus-visible,a:focus-visible,.table-scroll:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.card-body{padding-top:10px}.pill{display:inline-block;border-radius:6px;padding:2px 8px;background:var(--accent-soft);color:var(--accent);font-size:12px}.pill.warning,.partial{background:var(--amber-soft);color:var(--amber)}.partial{border-radius:4px;padding:2px 5px;font-size:12px}.unknown{color:var(--muted);font-weight:600}.table-scroll{max-width:100%;overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overscroll-behavior-inline:contain}table{width:100%;min-width:940px;border-collapse:collapse}caption{text-align:left;font-weight:700;padding:14px 16px;border-bottom:1px solid var(--line)}th,td{text-align:left;vertical-align:top;padding:12px 14px;border-bottom:1px solid var(--line)}thead th{background:var(--accent-soft);font-size:12px}tbody th{min-width:180px}td{min-width:112px}.finding code,.notes code{overflow-wrap:anywhere}.finding ul,.notes ul{margin:8px 0}.report-link{display:inline-flex;min-height:44px;align-items:center;color:var(--accent);text-underline-offset:4px}@media(max-width:760px){header,main{padding-left:16px;padding-right:16px}.summary,.drivers{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:25px}}@media(max-width:520px){.summary,.drivers{grid-template-columns:1fr}.source-banner,.fixture-banner,.summary,.finding,.notes,.evidence-card,.driver{padding:14px}.table-scroll{border-radius:8px}}
</style></head><body><header><p class="mono muted">TEAM METRICS / OFFLINE</p><h1>离线历史快照</h1><p>截至 <time datetime="${escape(report.asOf)}">${escape(report.asOf)}</time> 的确定性观测报告。</p></header><main>
<div class="source-banner"><strong>来源范围：记录态快照</strong><p>读取已记录业务 state，未刷新 Registry；这是非实时遥测，不是现有 live workbench。sourceVersion <span class="mono">${escape(report.sourceVersion)}</span> · sourceKinds <span class="mono">${escape(report.sourceKinds.join(', '))}</span></p><a class="report-link" href="report.json">查看机器可读 report.json</a></div>
${fixture ? '<div class="fixture-banner" role="note">模拟数据 / FIXTURE：本报告包含 fixture 来源，不能当作真实团队效果证据。</div>' : ''}
<section aria-labelledby="overview"><h2 id="overview">观测与归因</h2><div class="summary"><div><span class="muted">已观测记录</span><strong>${escape(report.attribution.observedRecords)}</strong></div><div><span class="muted">显式关联</span><strong>${rate(report.attribution.direct)}</strong></div><div><span class="muted">Worker 时间窗</span><strong>${rate(report.attribution.window)}</strong></div><div><span class="muted">共享</span><strong>${rate(report.attribution.shared)}</strong></div><div><span class="muted">未知</span><strong>${rate(report.attribution.unknown)}</strong></div></div><p class="muted">各视角是同一批记录的不同分组，不能相加成团队总量。缓存输入和推理输出分别是输入/输出的子集；net 为非缓存输入加输出，不是费用。</p></section>
${report.schemaVersion===2?explanationView(report.explanation):''}
<section><h2>团队总量</h2>${table('团队总量', '范围', [`<tr><th scope="row">全部已观测记录</th>${metricCells(report.totals)}</tr>`])}</section>
<section><h2>角色与成员</h2>${table('按角色', '角色', roleRows)}${table('按历史成员身份', '成员 / 角色', memberRows)}</section>
<section><h2>任务视角</h2><p class="muted">共享和未知用量不会摊入任务；任务历时包含等待。</p>${table('按任务', '轮次 / 任务', taskRows)}${table('任务 × 角色', '轮次 / 任务 / 角色', taskRoleRows(report.byTask))}</section>
<section><h2>操作视角</h2>${table('按操作', '操作', operationRows)}</section>
<section><h2>归因记录与证据索引</h2><div class="table-scroll" tabindex="0" role="region" aria-label="归因记录与证据索引，可横向滚动"><table><caption>归因记录与证据索引</caption><thead><tr><th scope="col">recordId</th><th scope="col">归因类型</th><th scope="col">轮次</th><th scope="col">任务</th><th scope="col">角色</th><th scope="col">操作</th><th scope="col">evidenceRef</th></tr></thead><tbody>${assignmentRows(report.attribution.assignments) || '<tr><th scope="row">暂无记录</th><td colspan="6" class="unknown">未知</td></tr>'}</tbody></table></div><p class="muted">evidenceRef 仅按不可点击文本索引展示，不读取或执行其目标。</p></section>
<section><h2>规则发现</h2>${findings || '<p class="notes">截至该快照没有规则发现。</p>'}<div class="notes"><h3>边界与未评估项</h3><ul>${limitations}</ul></div></section>
</main></body></html>`;
}

export async function exportMetrics(report, directory) {
  validateReport(report);
  const json = JSON.stringify(report, null, 2) + '\n';
  const html = renderMetrics(report);
  const ready = JSON.stringify({ schemaVersion: 1, teamId: report.teamId, sourceVersion: report.sourceVersion, asOf: report.asOf, files: ['report.json', 'index.html'] }) + '\n';
  await mkdir(directory);
  await atomicWrite(join(directory, 'report.json'), json, true);
  await atomicWrite(join(directory, 'index.html'), html, true);
  await atomicWrite(join(directory, 'READY.json'), ready, true);
  return JSON.parse(ready);
}
