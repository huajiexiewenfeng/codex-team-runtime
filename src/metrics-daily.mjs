import { buildMetrics } from './metrics.mjs';
import { rollup } from './metrics-rollup.mjs';

const roles = ['Manager', 'Liaison', 'Worker', 'Unknown'];
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const shanghaiDate = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
  timeZone: 'Asia/Shanghai', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit'
});

function canonicalTime(value) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'asOf must be a canonical UTC ISO timestamp');
}

function parseDate(value, label) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), `${label} must be a real YYYY-MM-DD date`);
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  check(month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1], `${label} must be a real YYYY-MM-DD date`);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function localDate(timestamp) {
  const parts = Object.fromEntries(shanghaiDate.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function dates(fromTime, toTime) {
  const result = [];
  for (let time = fromTime; time <= toTime; time += 24 * 60 * 60 * 1000) {
    result.push(new Date(time).toISOString().slice(0, 10));
  }
  return result;
}

export function buildDailyMetrics(state, ledger, options) {
  check(options !== null && typeof options === 'object' && !Array.isArray(options), 'options must be an object');
  check(Object.keys(options).every(key => ['from', 'to', 'asOf', 'timeZone'].includes(key)), 'Unknown daily metrics option');
  const { from, to, asOf } = options;
  const timeZone = options.timeZone ?? 'Asia/Shanghai';
  check(timeZone === 'Asia/Shanghai', 'timeZone must be Asia/Shanghai');
  canonicalTime(asOf);
  const fromTime = parseDate(from, 'from');
  const toTime = parseDate(to, 'to');
  check(fromTime <= toTime, 'from must be on or before to');
  const dayCount = (toTime - fromTime) / (24 * 60 * 60 * 1000) + 1;
  check(dayCount <= 366, 'Date range may contain at most 366 days');
  check(to <= localDate(asOf), 'Date range cannot include a future day after asOf');

  const aggregate = buildMetrics(state, ledger, asOf);
  const assignmentByRecord = new Map(aggregate.attribution.assignments.map(item => [item.recordId, item]));
  const memberGroups = new Map(state.members.map(member => [JSON.stringify([member.id, member.role]), { memberId: member.id, role: member.role }]));
  for (const assignment of aggregate.attribution.assignments) {
    if (assignment.memberId !== null) {
      memberGroups.set(JSON.stringify([assignment.memberId, assignment.role]), { memberId: assignment.memberId, role: assignment.role });
    }
  }

  const recordsByDate = new Map();
  for (const record of ledger.records) {
    if (record.at > asOf) continue;
    const date = localDate(record.at);
    if (date < from || date > to) continue;
    if (!recordsByDate.has(date)) recordsByDate.set(date, []);
    recordsByDate.get(date).push(record);
  }

  const approvalsByDate = new Map();
  for (const event of state.events) {
    if (event.type !== 'approve' || event.at > asOf) continue;
    const date = localDate(event.at);
    if (date >= from && date <= to) approvalsByDate.set(date, (approvalsByDate.get(date) ?? 0) + 1);
  }

  const days = dates(fromTime, toTime).map(date => {
    const records = recordsByDate.get(date) ?? [];
    const selected = predicate => records.filter(record => predicate(assignmentByRecord.get(record.id)));
    const byRole = roles.map(role => ({ role, metrics: rollup(selected(assignment => assignment.role === role)) }));
    const byMember = [...memberGroups.values()].map(member => ({
      ...member,
      metrics: rollup(selected(assignment => assignment.memberId === member.memberId && assignment.role === member.role))
    }));
    const models = new Map();
    for (const record of records) {
      const model = record.model;
      if (!models.has(model)) models.set(model, []);
      models.get(model).push(record);
    }
    const byModel = [...models].map(([model, modelRecords]) => ({ model, metrics: rollup(modelRecords) }));
    const observedMembers = new Set(records.flatMap(record => {
      const assignment = assignmentByRecord.get(record.id);
      return assignment?.memberId === null || assignment === undefined ? [] : [JSON.stringify([assignment.memberId, assignment.role])];
    })).size;
    return {
      date,
      records: records.length,
      totals: rollup(records),
      byRole,
      byMember,
      byModel,
      approvedTasks: approvalsByDate.get(date) ?? 0,
      coverage: { status: 'unverified', expectedMembers: null, observedMembers, ratio: null }
    };
  });

  return {
    schemaVersion: 1,
    rulesVersion: 1,
    teamId: state.team.id,
    asOf,
    timeZone,
    from,
    to,
    sourceVersion: state.version,
    runtimeVersion: 'unknown',
    days,
    limitations: [
      { code: 'observed_records_only', summary: 'Daily metrics cover only imported observed usage records, not full team activity' },
      { code: 'coverage_unverified', summary: 'Observed members and records do not establish complete team coverage' },
      { code: 'runtime_version_unknown', summary: 'Historical runtime version is not available from the supplied state and ledger' }
    ]
  };
}
