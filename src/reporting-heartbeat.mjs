import { validateCaller } from './runtime.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Pure translation only. Call from an authorized host adapter AFTER the executor
// has claimed DISPATCHED. This helper cannot authenticate a host or inspect a ledger.
export function buildReportingHeartbeatCreate(operation, config) {
  check(object(operation) && operation.kind === 'CREATE' && operation.automationId === null
    && operation.desired === 'running', 'Only CREATE with no existing automation and running intent is supported');
  check(nonempty(operation.teamId) && nonempty(operation.operationId)
    && Number.isSafeInteger(operation.bindingEpoch) && operation.bindingEpoch >= 1
    && Number.isSafeInteger(operation.intentVersion) && operation.intentVersion >= 0,
  'Complete operation identity and versions are required');
  check(object(operation.owner) && ['memberId', 'hostId', 'threadId'].every(key => nonempty(operation.owner[key])), 'Complete Liaison identity is required');
  validateCaller({ hostId: operation.owner.hostId, threadId: operation.owner.threadId });
  check(object(config) && Object.keys(config).every(key => ['hostId', 'name', 'prompt', 'intervalMinutes', 'notificationPolicy'].includes(key)), 'Unsupported heartbeat configuration field');
  check(nonempty(config.hostId) && config.hostId === operation.owner.hostId, 'Execution host must match the Liaison host');
  check(nonempty(config.name) && nonempty(config.prompt), 'Explicit name and authorized prompt are required');
  check(Number.isSafeInteger(config.intervalMinutes) && config.intervalMinutes > 0, 'Interval must be a positive integer in minutes');
  const args = { mode: 'create', kind: 'heartbeat', destination: 'thread', name: config.name,
    prompt: config.prompt, rrule: `FREQ=MINUTELY;INTERVAL=${config.intervalMinutes}`,
    status: 'ACTIVE', targetThreadId: operation.owner.threadId };
  if (Object.hasOwn(config, 'notificationPolicy')) {
    check(config.notificationPolicy === null || config.notificationPolicy === 'failed_runs_only', 'Unsupported notification policy');
    args.notificationPolicy = config.notificationPolicy;
  }
  return { operationId: operation.operationId, hostId: config.hostId,
    arguments: args, hostActionExecuted: false };
}

// Accept a parsed, read-only automation.toml observation, not a UI card. Exact
// comparison deliberately does not interpret RRULE equivalence or infer delivery.
export function inspectReportingHeartbeatConfiguration(request, configuration, evidence) {
  check(object(request) && object(request.arguments) && request.arguments.mode === 'create'
    && request.arguments.kind === 'heartbeat' && request.arguments.destination === 'thread'
    && request.arguments.status === 'ACTIVE' && nonempty(request.arguments.targetThreadId)
    && nonempty(request.hostId), 'A heartbeat CREATE request is required');
  check(object(evidence) && nonempty(evidence.automationId) && evidence.hostId === request.hostId,
    'Exact automation ID and matching observation host are required');
  check(typeof evidence.observedAt === 'string' && Number.isFinite(Date.parse(evidence.observedAt))
    && new Date(evidence.observedAt).toISOString() === evidence.observedAt, 'A canonical UTC observation timestamp is required');
  check(object(evidence.source) && ['manual', 'fixture', 'host-observation'].includes(evidence.source.kind)
    && nonempty(evidence.source.evidenceRef), 'Observation provenance is required');
  const args = request.arguments;
  const expected = { id: evidence.automationId, kind: args.kind, status: args.status,
    target_thread_id: args.targetThreadId, name: args.name, prompt: args.prompt, rrule: args.rrule };
  const value = object(configuration) ? configuration : {};
  const missingFields = [], mismatchedFields = [];
  // The create API exposes this setting, but its persistence mapping has not
  // been verified. Do not invent a TOML field or silently consider it checked.
  if (Object.hasOwn(args, 'notificationPolicy')) missingFields.push('notificationPolicy:host-mapping-unverified');
  for (const [key, wanted] of Object.entries(expected)) {
    if (!Object.hasOwn(value, key)) missingFields.push(key);
    else if (value[key] !== wanted) mismatchedFields.push(key);
  }
  return { operationId: request.operationId, automationId: evidence.automationId,
    configurationMatches: mismatchedFields.length ? false : missingFields.length ? null : true,
    missingFields, mismatchedFields,
    configuredStatus: ['ACTIVE', 'PAUSED'].includes(value.status) ? value.status : null,
    observedAt: evidence.observedAt, source: structuredClone(evidence.source),
    executionStatus: 'unknown', delivery: 'unknown', hostActionExecuted: false,
    identityAssurance: 'caller-declared; configuration observations are not authenticated' };
}
