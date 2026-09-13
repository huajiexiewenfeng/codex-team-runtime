import { validate } from './runtime.mjs';
import { validateUsage } from './metrics-usage.mjs';
import { buildExplanation } from './metrics-explain.mjs';
import { metricNames, observed, rollup } from './metrics-rollup.mjs';

const operations = ['coordination', 'implementation', 'review', 'rework', 'recovery', 'reporting', 'unknown'];
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
function canonicalTime(value) { check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'asOf must be a canonical UTC ISO timestamp'); }
const sameIdentity = (record, member) => member.binding?.status === 'bound' && member.binding.hostId === record.hostId && member.binding.threadId === record.threadId;
function historicalMembers(state, record) {
  const relevantRounds = state.rounds.filter(round => record.at >= round.openedAt && (round.closedAt === null || record.at < round.closedAt));
  const unique = new Map();
  for (const member of relevantRounds.flatMap(round => round.members)) {
    if (sameIdentity(record, member)) unique.set(JSON.stringify([member.id, member.role, member.binding.hostId, member.binding.threadId]), member);
  }
  return [...unique.values()];
}
function taskWindow(state, record, asOf) {
  return state.tasks.filter(task => {
    if (task.assignedAt === null || record.at < task.assignedAt || record.at > asOf) return false;
    if (task.completedAt !== null && record.at >= task.completedAt) return false;
    const round = state.rounds.find(item => item.id === task.roundId), worker = round?.members.find(member => member.id === task.workerId);
    return worker?.role === 'Worker' && sameIdentity(record, worker);
  });
}
function rate(records, total) { return { records, ratio: total === 0 ? null : records / total }; }
function finding(id, code, severity, summary, evidenceIds) { return { id, ruleId: code, code, severity, summary, evidenceIds }; }

export function buildMetrics(state, ledger, asOf) {
  validate(state); validateUsage(ledger); canonicalTime(asOf);
  check(asOf >= state.updatedAt, 'asOf precedes state update'); check(ledger.teamId === state.team.id, 'Usage ledger team mismatch');
  const recordById = new Map(ledger.records.map(record => [record.id, record]));
  const linkByRecord = new Map(ledger.links.map(link => [link.recordId, link]));
  for (const link of ledger.links) {
    const record = recordById.get(link.recordId), round = state.rounds.find(item => item.id === link.roundId), task = state.tasks.find(item => item.id === link.taskId && item.roundId === link.roundId);
    check(round && task, 'Explicit mapping task or round is missing');
    const member = round.members.find(item => item.id === link.memberId);
    check(member && sameIdentity(record, member), 'Explicit mapping identity mismatch');
    check(member.role !== 'Worker' || task.workerId === member.id, 'Explicit mapping Worker does not own task');
  }
  const future = ledger.records.filter(record => record.at > asOf), records = ledger.records.filter(record => record.at <= asOf);
  const assignments = [];
  for (const record of records) {
    const link = linkByRecord.get(record.id);
    if (link) {
      const member = state.rounds.find(round => round.id === link.roundId).members.find(item => item.id === link.memberId);
      assignments.push({ recordId: record.id, kind: 'explicit', roundId: link.roundId, taskId: link.taskId, memberId: link.memberId, role: member.role, operation: link.operation, evidenceRef: link.evidenceRef });
      continue;
    }
    const candidates = taskWindow(state, record, asOf), identities = historicalMembers(state, record);
    if (candidates.length === 1 && identities.length === 1) {
      const task = candidates[0], member = state.rounds.find(round => round.id === task.roundId).members.find(item => item.id === task.workerId);
      if (identities[0].id === member.id && identities[0].role === member.role) {
        assignments.push({ recordId: record.id, kind: 'window', roundId: task.roundId, taskId: task.id, memberId: member.id, role: member.role, operation: 'implementation', evidenceRef: null });
        continue;
      }
    }
    if (candidates.length === 0 && identities.length === 1 && ['Manager', 'Liaison'].includes(identities[0].role)) {
      const member = identities[0];
      assignments.push({ recordId: record.id, kind: 'shared', roundId: null, taskId: null, memberId: member.id, role: member.role, operation: 'unknown', evidenceRef: null });
    } else if (identities.length === 1) {
      const member = identities[0];
      assignments.push({ recordId: record.id, kind: 'unknown', roundId: null, taskId: null, memberId: member.id, role: member.role, operation: 'unknown', evidenceRef: null });
    } else assignments.push({ recordId: record.id, kind: 'unknown', roundId: null, taskId: null, memberId: null, role: 'Unknown', operation: 'unknown', evidenceRef: null });
  }
  const assignmentById = new Map(assignments.map(item => [item.recordId, item]));
  const selected = predicate => records.filter(record => predicate(assignmentById.get(record.id)));
  const count = kind => assignments.filter(item => item.kind === kind).length;
  const byRole = ['Manager', 'Liaison', 'Worker', 'Unknown'].map(role => ({ role, metrics: rollup(selected(item => item.role === role)) }));
  const memberGroups = new Map(state.members.map(member => [JSON.stringify([member.id, member.role]), { memberId: member.id, role: member.role }]));
  for (const item of assignments) if (item.memberId !== null && item.role !== 'Unknown') memberGroups.set(JSON.stringify([item.memberId, item.role]), { memberId: item.memberId, role: item.role });
  const byMember = [...memberGroups.values()].map(member => ({ ...member, metrics: rollup(selected(item => item.memberId === member.memberId && item.role === member.role)) }));
  const byTask = state.tasks.map(task => {
    const end = task.completedAt ?? asOf, elapsedMs = task.assignedAt === null ? null : Date.parse(end) - Date.parse(task.assignedAt);
    const reworkCount = state.events.filter(event => event.type === 'rework' && event.roundId === task.roundId && event.taskId === task.id).length;
    const taskRecords = selected(item => item.roundId === task.roundId && item.taskId === task.id);
    const byRole = ['Manager', 'Liaison', 'Worker'].map(role => ({ role, metrics: rollup(taskRecords.filter(record => assignmentById.get(record.id).role === role)) }));
    return { taskId: task.id, roundId: task.roundId, status: task.status, elapsedMs, submissions: task.submissions, reworkCount, metrics: rollup(taskRecords), byRole };
  });
  const byOperation = operations.map(operation => ({ operation, metrics: rollup(selected(item => item.operation === operation)) }));
  const findings = [];
  if (records.length === 0 || metricNames.some(name => rollup(records)[name].missingRecords > 0)) findings.push(finding('finding-usage-missing', 'usage_missing', 'warning', 'One or more usage values are unobserved; missing values are not treated as zero', records.map(record => record.id)));
  const mismatches = records.filter(record => record.usage.input !== null && record.usage.output !== null && record.usage.total !== null && record.usage.input + record.usage.output !== record.usage.total);
  if (mismatches.length) findings.push(finding('finding-total-mismatch', 'usage_total_mismatch', 'warning', 'Source totals differ from input plus output', mismatches.map(record => record.id)));
  if (records.length && count('explicit') / records.length < 0.5) findings.push(finding('finding-low-direct-attribution', 'low_direct_attribution', 'info', 'Fewer than half of observed records have explicit task links', assignments.filter(item => item.kind !== 'explicit').map(item => item.recordId)));
  const gapDiagnostics = ledger.diagnostics.filter(item => ['coverage_gap', 'counter_reset', 'counter_profile_gap', 'usage_profile_gap', 'malformed_line', 'incomplete_line', 'missing_cumulative', 'missing_last_usage', 'invalid_token_event', 'missing_session_meta'].includes(item.code));
  if (gapDiagnostics.length) findings.push(finding('finding-source-coverage-gap', 'source_coverage_gap', 'warning', 'Source diagnostics indicate incomplete or discontinuous coverage', gapDiagnostics.map(item => item.recordId ?? `${item.sourceRef}:${item.line ?? 'unknown'}`)));
  for (const task of state.tasks) {
    if (task.status === 'submitted') findings.push(finding(`finding-task-pending-review-${task.roundId}-${task.id}`, 'task_pending_review', 'info', 'Submitted task has not entered review', [`${task.roundId}:${task.id}`]));
    if (task.status === 'reviewing') findings.push(finding(`finding-task-review-open-${task.roundId}-${task.id}`, 'task_review_open', 'info', 'Task review is not yet closed', [`${task.roundId}:${task.id}`]));
    const row = byTask.find(item => item.roundId === task.roundId && item.taskId === task.id);
    if (row.reworkCount > 0) findings.push(finding(`finding-task-rework-${task.roundId}-${task.id}`, 'task_rework', 'info', 'Task has recorded rework', [`${task.roundId}:${task.id}`]));
  }
  const limitations = [
    { code: 'observed_records_only', summary: 'Metrics cover only imported observed usage records, not full lifecycle cost' },
    { code: 'elapsed_includes_waiting', summary: 'Task elapsed time includes waiting and is not Agent active time' },
    { code: 'causality_not_proven', summary: 'Explicit and window attribution do not prove token-level causality' },
    { code: 'advanced_rules_unassessed', summary: 'Role recall, repeated-query and busy-Worker rules lack sufficient v1 evidence and are not evaluated' }
  ];
  if (future.length) limitations.push({ code: 'future_records_excluded', summary: 'Usage records after asOf were excluded', records: future.length });
  const totals = rollup(records);
  const report = {
    schemaVersion: ledger.schemaVersion === 2 ? 2 : 1, rulesVersion: 1, teamId: state.team.id, sourceVersion: state.version, asOf,
    sourceKinds: [...new Set([state.team.source.kind, ...state.events.map(event => event.source.kind), ...records.map(record => record.source.kind)])].sort(), readOnly: true, totals,
    attribution: { observedRecords: records.length, direct: rate(count('explicit'), records.length), window: rate(count('window'), records.length), shared: rate(count('shared'), records.length), unknown: rate(count('unknown'), records.length), assignments },
    byRole, byMember, byTask, byOperation, findings, limitations
  };
  if (ledger.schemaVersion === 2) {
    const evidenceRecords = records.map(record => ({
      id: record.id, hostId: record.hostId, threadId: record.threadId, at: record.at, turnId: record.turnId,
      model: record.model, source: record.source, metrics: observed(record)
    }));
    report.explanation = buildExplanation(evidenceRecords, assignments, ledger.observations.filter(observation => recordById.get(observation.recordId)?.at <= asOf));
  }
  return report;
}
