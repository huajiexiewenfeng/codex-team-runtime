import { localDate } from './metrics-daily.mjs';

const fields = ['schemaVersion', 'eventId', 'startedAt', 'completedAt', 'durationMs', 'tool', 'registryId', 'teamId', 'memberId', 'role', 'hostId', 'threadId', 'memberStatus', 'identitySource', 'reason', 'reasonSource', 'outcome', 'errorCode', 'policyRevision', 'runtimeRevision', 'runtimeRevisionSource'];
const roles = ['Manager', 'Liaison', 'Worker'];
const reasons = ['onboarding', 'resume', 'post_compaction', 'before_dispatch', 'before_delivery', 'before_review', 'identity_conflict', 'manual', 'unknown'];
const outcomes = ['matched', 'inactive', 'unmatched', 'success', 'error', 'unexpected_error'];
const tools = ['team_context.read', 'team_context.manage', 'team_context.startup'];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errorPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, expected, label) => check(isObject(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), `Invalid ${label} fields`);
const identifier = (value, label) => check(typeof value === 'string' && idPattern.test(value), `Invalid ${label}`);
const timestamp = (value, label) => check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `Invalid ${label}`);
const safeCount = (value, label, minimum = 0) => check(Number.isSafeInteger(value) && value >= minimum, `Invalid ${label}`);

function validateEvent(event, scope) {
  exact(event, fields, 'MCP event');
  check(event.schemaVersion === 1, 'Invalid MCP event schemaVersion');
  check(typeof event.eventId === 'string' && uuidPattern.test(event.eventId), 'Invalid eventId');
  timestamp(event.startedAt, 'startedAt'); timestamp(event.completedAt, 'completedAt');
  safeCount(event.durationMs, 'durationMs'); safeCount(event.policyRevision, 'policyRevision', 1);
  check(tools.includes(event.tool), 'Invalid tool');
  for (const key of ['registryId', 'teamId', 'memberId', 'hostId', 'threadId']) identifier(event[key], key);
  check(event.registryId === scope.registryId, 'MCP event registryId mismatch');
  check(event.teamId === scope.teamId, 'MCP event teamId mismatch');
  check(roles.includes(event.role), 'Invalid role');
  check(['active', 'exited'].includes(event.memberStatus), 'Invalid memberStatus');
  check(event.identitySource === 'registry-at-call-start', 'Invalid identitySource');
  check(reasons.includes(event.reason), 'Invalid reason');
  check(event.reasonSource === (event.reason === 'unknown' ? 'unknown' : 'agent-declared'), 'Invalid reasonSource relationship');
  check(outcomes.includes(event.outcome), 'Invalid outcome');
  const allowedOutcomes = event.tool === 'team_context.read'
    ? ['matched', 'inactive', 'unmatched', 'error', 'unexpected_error']
    : ['success', 'error', 'unexpected_error'];
  check(allowedOutcomes.includes(event.outcome), 'Invalid tool outcome relationship');
  if (event.outcome === 'error') check(typeof event.errorCode === 'string' && errorPattern.test(event.errorCode), 'Invalid errorCode');
  else check(event.errorCode === null, 'Invalid errorCode relationship');
  if (event.runtimeRevision === null) check(event.runtimeRevisionSource === 'unknown', 'Invalid runtimeRevisionSource relationship');
  else {
    const characters = typeof event.runtimeRevision === 'string' ? [...event.runtimeRevision] : [];
    check(characters.length > 0 && event.runtimeRevision.trim().length > 0 && characters.length <= 512 && characters.every(character => character.codePointAt(0) >= 32 && !(character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff)), 'Invalid runtimeRevision');
    check(event.runtimeRevisionSource === 'operator-declared', 'Invalid runtimeRevisionSource relationship');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function zeroes(values) { return Object.fromEntries(values.map(value => [value, 0])); }
function emptyDay(date) {
  return { date, observedCalls: 0, byRole: zeroes(roles), byReason: zeroes(reasons), byOutcome: zeroes(outcomes) };
}

function derivedDays(events, daily) {
  const byDate = new Map(daily.days.map(day => [day.date, emptyDay(day.date)]));
  for (const record of events) {
    const event = record.event, date = localDate(event.completedAt), day = byDate.get(date);
    if (!day) continue;
    day.observedCalls += 1;
    day.byRole[event.role] += 1;
    day.byReason[event.reason] = (day.byReason[event.reason] ?? 0) + 1;
    day.byOutcome[event.outcome] = (day.byOutcome[event.outcome] ?? 0) + 1;
  }
  return [...byDate.values()];
}

function validateInput(input, daily) {
  exact(input, ['registryId', 'teamId', 'sourceKind', 'records'], 'MCP input');
  identifier(input.registryId, 'registryId'); identifier(input.teamId, 'teamId');
  check(input.teamId === daily.teamId, 'MCP input teamId mismatch');
  check(['fixture', 'mcp-server'].includes(input.sourceKind), 'Invalid sourceKind');
  check(Array.isArray(input.records), 'Invalid MCP records');
  for (const record of input.records) {
    exact(record, ['event', 'sourceRefs'], 'MCP input record');
    check(Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0 && record.sourceRefs.every(value => typeof value === 'string' && value.length > 0), 'Invalid sourceRefs');
    validateEvent(record.event, input);
  }
}

export function buildServerMcpReport(input, daily) {
  validateInput(input, daily);
  const byId = new Map();
  for (const record of input.records) {
    const fingerprint = canonical(record.event), previous = byId.get(record.event.eventId);
    if (previous) {
      check(previous.fingerprint === fingerprint, `Conflicting MCP eventId ${record.event.eventId}`);
      previous.sourceRefs.push(...record.sourceRefs);
    } else byId.set(record.event.eventId, { fingerprint, event: structuredClone(record.event), sourceRefs: [...record.sourceRefs] });
  }
  const all = [...byId.values()].map(({ event, sourceRefs }) => ({ event, sourceRefs: [...new Set(sourceRefs)].sort(compareText) }));
  const selected = all.filter(record => record.event.completedAt <= daily.asOf && localDate(record.event.completedAt) >= daily.from && localDate(record.event.completedAt) <= daily.to)
    .sort((left, right) => compareText(left.event.completedAt, right.event.completedAt) || compareText(left.event.eventId, right.event.eventId));
  const report = { schemaVersion: 1, registryId: input.registryId, teamId: input.teamId, sourceKind: input.sourceKind, events: selected, days: derivedDays(selected, daily), coverage: 'unverified' };
  return validateServerMcpReport(report, daily);
}

export function validateServerMcpReport(report, daily) {
  exact(report, ['schemaVersion', 'registryId', 'teamId', 'sourceKind', 'events', 'days', 'coverage'], 'server MCP report');
  check(report.schemaVersion === 1 && report.coverage === 'unverified', 'Invalid server MCP report version or coverage');
  validateInput({ registryId: report.registryId, teamId: report.teamId, sourceKind: report.sourceKind, records: report.events }, daily);
  const ids = new Set();
  for (const record of report.events) {
    check(record.event.completedAt <= daily.asOf, 'Server MCP event exceeds daily cutoff');
    const date = localDate(record.event.completedAt);
    check(date >= daily.from && date <= daily.to, 'Server MCP event is outside daily date range');
    check(!ids.has(record.event.eventId), 'Duplicate server MCP eventId'); ids.add(record.event.eventId);
  }
  check(report.events.every((record, index) => index === 0 || compareText(report.events[index - 1].event.completedAt, record.event.completedAt) < 0 || (report.events[index - 1].event.completedAt === record.event.completedAt && compareText(report.events[index - 1].event.eventId, record.event.eventId) < 0)), 'Invalid server MCP event order');
  for (const record of report.events) check(new Set(record.sourceRefs).size === record.sourceRefs.length && record.sourceRefs.every((value, index) => index === 0 || compareText(record.sourceRefs[index - 1], value) < 0), 'Invalid sourceRefs order');
  check(canonical(report.days) === canonical(derivedDays(report.events, daily)), 'Invalid derived daily counts');
  return report;
}
