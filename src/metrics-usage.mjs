import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const usageFields = ['input', 'cachedInput', 'output', 'reasoningOutput', 'total'];
const wireFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const operations = ['coordination', 'implementation', 'review', 'rework', 'recovery', 'reporting', 'unknown'];
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
function object(value, keys, required = keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  check(Object.keys(value).every(key => keys.includes(key)), 'Unknown field');
  check(required.every(key => Object.hasOwn(value, key)), 'Missing required field');
}
function identifier(value, label = 'identifier') {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value), `Invalid ${label}`);
}
function text(value, label = 'text', max = 4000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
}
function timestamp(value) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Expected canonical UTC ISO timestamp');
}
function numberOrNull(value, label) {
  check(value === null || (Number.isSafeInteger(value) && value >= 0), `${label} must be a non-negative safe integer or null`);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const canonicalText = value => JSON.stringify(canonical(value));

function validateUsageValues(value) {
  object(value, usageFields);
  for (const field of usageFields) numberOrNull(value[field], field);
  check(value.input === null || value.cachedInput === null || value.cachedInput <= value.input, 'cachedInput exceeds input');
  check(value.output === null || value.reasoningOutput === null || value.reasoningOutput <= value.output, 'reasoningOutput exceeds output');
  if (value.input !== null && value.cachedInput !== null && value.output !== null) {
    check(value.input - value.cachedInput <= Number.MAX_SAFE_INTEGER - value.output, 'Derived net exceeds safe integer range');
  }
  return value;
}
function validateRecord(value) {
  object(value, ['id', 'hostId', 'threadId', 'at', 'turnId', 'model', 'usage', 'source']);
  identifier(value.id, 'record id'); identifier(value.hostId, 'hostId'); identifier(value.threadId, 'threadId'); timestamp(value.at);
  check(value.turnId === null || (typeof value.turnId === 'string' && value.turnId.length > 0 && value.turnId.length <= 4000), 'Invalid turnId');
  check(value.model === null || (typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 4000), 'Invalid model');
  validateUsageValues(value.usage);
  object(value.source, ['kind', 'ref']); check(['fixture', 'codex-log'].includes(value.source.kind), 'Invalid source kind'); text(value.source.ref, 'source ref');
  return value;
}
function validateDiagnostic(value) {
  object(value, ['code', 'severity', 'sourceRef', 'line', 'recordId', 'message']);
  identifier(value.code, 'diagnostic code'); check(['info', 'warning'].includes(value.severity), 'Invalid diagnostic severity');
  text(value.sourceRef, 'diagnostic source ref'); check(value.line === null || (Number.isSafeInteger(value.line) && value.line > 0), 'Invalid diagnostic line');
  if (value.recordId !== null) identifier(value.recordId, 'diagnostic record id'); text(value.message, 'diagnostic message', 400);
  return value;
}
function validateLink(value) {
  object(value, ['recordId', 'roundId', 'taskId', 'memberId', 'operation', 'evidenceRef']);
  identifier(value.recordId, 'link record id'); identifier(value.roundId, 'link round id'); identifier(value.taskId, 'link task id'); identifier(value.memberId, 'link member id');
  check(operations.includes(value.operation), 'Invalid link operation');
  check(typeof value.evidenceRef === 'string' && value.evidenceRef.trim().length > 0 && value.evidenceRef.length <= 4000, 'Invalid evidenceRef');
  return value;
}

const observationKinds = ['tool_call', 'tool_result', 'context_compaction', 'user_message'];
function positiveInteger(value, label) {
  check(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}
function hashOrNull(value, label) {
  check(value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), `Invalid ${label}`);
}
function identifierOrNull(value, label) {
  if (value !== null) identifier(value, label);
}
function validateObservationEvent(value, observation) {
  object(value, ['kind', 'line', 'at', 'callId', 'tool', 'argumentsHash', 'contentHash', 'bytes']);
  check(observationKinds.includes(value.kind), 'Invalid observation kind');
  positiveInteger(value.line, 'observation event line');
  check(value.line >= observation.firstLine && value.line <= observation.usageLine, 'Observation event outside record window');
  if (value.at !== null) timestamp(value.at);
  identifierOrNull(value.callId, 'observation call id'); identifierOrNull(value.tool, 'observation tool');
  hashOrNull(value.argumentsHash, 'arguments hash'); hashOrNull(value.contentHash, 'content hash');
  numberOrNull(value.bytes, 'observation bytes');
  if (value.kind === 'tool_call') check(value.contentHash === null, 'Tool call cannot have content hash');
  if (value.kind === 'tool_result' || value.kind === 'user_message') check(value.argumentsHash === null, 'Content event cannot have arguments hash');
  if (value.kind === 'user_message') check(value.callId === null && value.tool === null, 'User message cannot identify a tool call');
  if (value.kind === 'context_compaction') {
    check(value.callId === null && value.tool === null && value.argumentsHash === null && value.contentHash === null && value.bytes === null,
      'Context compaction cannot carry content metadata');
  }
  return value;
}
function validateNativeResponse(value, observation) {
  if (value === null) return value;
  object(value, ['responseId', 'turnId', 'line', 'association']);
  identifier(value.responseId, 'native response id'); identifierOrNull(value.turnId, 'native turn id');
  positiveInteger(value.line, 'native response line');
  check(value.line >= observation.firstLine && value.line <= observation.usageLine, 'Native response outside record window');
  check(value.association === 'counter-match', 'Invalid native response association');
  return value;
}
function validateObservation(value, records) {
  object(value, ['recordId', 'sourceRef', 'firstLine', 'usageLine', 'nativeResponse', 'events']);
  identifier(value.recordId, 'observation record id'); text(value.sourceRef, 'observation source ref');
  positiveInteger(value.firstLine, 'observation first line'); positiveInteger(value.usageLine, 'observation usage line');
  check(value.firstLine <= value.usageLine, 'Invalid observation line range'); check(Array.isArray(value.events), 'Invalid observation events');
  const record = records.get(value.recordId);
  check(record !== undefined, 'Observation record is missing'); check(record.source.ref === value.sourceRef, 'Observation source mismatch');
  validateNativeResponse(value.nativeResponse, value);
  value.events.forEach(event => validateObservationEvent(event, value));
  return value;
}

export function validateUsage(ledger) {
  check(ledger !== null && typeof ledger === 'object' && !Array.isArray(ledger), 'Expected object');
  check(ledger.schemaVersion === 1 || ledger.schemaVersion === 2, 'Unsupported usage schema version');
  const ledgerFields = ledger.schemaVersion === 2
    ? ['schemaVersion', 'teamId', 'records', 'links', 'diagnostics', 'observations']
    : ['schemaVersion', 'teamId', 'records', 'links', 'diagnostics'];
  object(ledger, ledgerFields); identifier(ledger.teamId, 'team id');
  check(Array.isArray(ledger.records) && Array.isArray(ledger.links) && Array.isArray(ledger.diagnostics), 'Invalid usage collections');
  const records = new Map();
  for (const record of ledger.records) { validateRecord(record); check(!records.has(record.id), 'Duplicate record id'); records.set(record.id, record); }
  const mappings = new Map();
  for (const link of ledger.links) {
    validateLink(link); check(records.has(link.recordId), 'Mapping record is missing');
    if (mappings.has(link.recordId)) {
      check(isDeepStrictEqual(canonical(mappings.get(link.recordId)), canonical(link)), 'Conflicting mapping for record');
      fail('Duplicate mapping for record');
    }
    mappings.set(link.recordId, link);
  }
  ledger.diagnostics.forEach(validateDiagnostic);
  if (ledger.schemaVersion === 2) {
    check(Array.isArray(ledger.observations), 'Invalid observations');
    const observedRecords = new Set();
    for (const observation of ledger.observations) {
      validateObservation(observation, records);
      check(!observedRecords.has(observation.recordId), 'Duplicate observation for record');
      observedRecords.add(observation.recordId);
    }
  }
  return ledger;
}

function fromWire(value) {
  object(value, [...wireFields, 'cache_write_input_tokens'], []);
  if (Object.hasOwn(value, 'cache_write_input_tokens')) {
    check(Number.isSafeInteger(value.cache_write_input_tokens) && value.cache_write_input_tokens >= 0,
      'cache_write_input_tokens must be a non-negative safe integer');
  }
  const result = {
    input: value.input_tokens, cachedInput: value.cached_input_tokens, output: value.output_tokens,
    reasoningOutput: value.reasoning_output_tokens, total: value.total_tokens
  };
  for (const field of usageFields) if (result[field] === undefined) result[field] = null;
  return validateUsageValues(result);
}
function diagnostic(code, severity, sourceRef, line, recordId, message) { return { code, severity, sourceRef, line, recordId, message }; }
function isReset(before, after) {
  return usageFields.some(field => before[field] !== null && after[field] !== null && after[field] < before[field]);
}
function hasGap(before, after, last) {
  return usageFields.some(field => before[field] !== null && after[field] !== null && last[field] !== null && after[field] - before[field] !== last[field]);
}
const completeUsage = value => value !== null && usageFields.every(field => value[field] !== null);

export function createCodexUsageAccumulator(options, observer = null) {
  object(options, ['hostId', 'threadId', 'sourceRef']);
  identifier(options.hostId, 'hostId'); identifier(options.threadId, 'threadId'); text(options.sourceRef, 'sourceRef');
  const records = [], diagnostics = [];
  let sessionSeen = false, turnId = null, model = null, previousCumulative = null;
  let lineNumber = 0, sawContent = false, finished = false;
  function push(line) {
    check(!finished, 'Parser is already finished'); check(typeof line === 'string', 'Expected JSONL line');
    lineNumber += 1;
    if (line.trim() === '') return;
    sawContent = true;
    let entry;
    try { entry = JSON.parse(line); }
    catch { diagnostics.push(diagnostic('malformed_line', 'warning', options.sourceRef, lineNumber, null, 'Ignored malformed JSONL line')); return; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    observer?.observe(entry, lineNumber);
    if (entry.type === 'session_meta') {
      const observed = entry.payload?.id;
      check(typeof observed === 'string' && observed === options.threadId, 'Session identity mismatch'); sessionSeen = true; return;
    }
    if (entry.type === 'turn_context') {
      const observedTurn = entry.payload?.turn_id ?? null, observedModel = entry.payload?.model ?? null;
      turnId = typeof observedTurn === 'string' && observedTurn.length ? observedTurn : null;
      model = typeof observedModel === 'string' && observedModel.length ? observedModel : null;
      return;
    }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') return;
    check(sessionSeen, 'Token usage precedes session identity'); timestamp(entry.timestamp);
    const info = entry.payload?.info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      diagnostics.push(diagnostic('invalid_token_event', 'warning', options.sourceRef, lineNumber, null, 'Ignored token event without usage info')); return;
    }
    const lastWire = info.last_token_usage;
    if (!lastWire || typeof lastWire !== 'object' || Array.isArray(lastWire)) {
      diagnostics.push(diagnostic('missing_last_usage', 'warning', options.sourceRef, lineNumber, null, 'Ignored token event without directly observed last usage')); return;
    }
    const last = fromWire(lastWire);
    let cumulative = null;
    if (info.total_token_usage && typeof info.total_token_usage === 'object' && !Array.isArray(info.total_token_usage)) cumulative = fromWire(info.total_token_usage);
    const reliableCumulative = completeUsage(cumulative);
    if (reliableCumulative && previousCumulative !== null && isDeepStrictEqual(cumulative, previousCumulative)) {
      diagnostics.push(diagnostic('duplicate_cumulative', 'info', options.sourceRef, lineNumber, null, 'Ignored repeated cumulative usage notification')); return;
    }
    const idPayload = { hostId: options.hostId, threadId: options.threadId, sourceRef: options.sourceRef, line: lineNumber, at: entry.timestamp, turnId, model, usage: last };
    const id = `usage-${createHash('sha256').update(canonicalText(idPayload)).digest('hex')}`;
    const record = { id, hostId: options.hostId, threadId: options.threadId, at: entry.timestamp, turnId, model, usage: last, source: { kind: 'codex-log', ref: options.sourceRef } };
    records.push(record);
    observer?.accept(record, lineNumber);
    if (usageFields.some(field => last[field] === null)) diagnostics.push(diagnostic('usage_profile_gap', 'warning', options.sourceRef, lineNumber, id, 'Directly observed usage profile has missing fields'));
    if (cumulative === null) diagnostics.push(diagnostic('missing_cumulative', 'warning', options.sourceRef, lineNumber, id, 'Missing cumulative usage basis for deduplication'));
    else {
      if (usageFields.some(field => cumulative[field] === null)) diagnostics.push(diagnostic('counter_profile_gap', 'warning', options.sourceRef, lineNumber, id, 'Cumulative usage counter has missing fields'));
      if (reliableCumulative && previousCumulative !== null) {
        if (isReset(previousCumulative, cumulative)) diagnostics.push(diagnostic('counter_reset', 'warning', options.sourceRef, lineNumber, id, 'Cumulative usage counter reset observed'));
        else if (hasGap(previousCumulative, cumulative, last)) diagnostics.push(diagnostic('coverage_gap', 'warning', options.sourceRef, lineNumber, id, 'Cumulative counter advance differs from observed last usage'));
      }
    }
    if (last.input !== null && last.output !== null && last.total !== null && last.input + last.output !== last.total) {
      diagnostics.push(diagnostic('total_mismatch', 'warning', options.sourceRef, lineNumber, id, 'Source total differs from input plus output'));
    }
    previousCumulative = reliableCumulative ? cumulative : null;
  }
  function finish({ incompleteFinalLine = false } = {}) {
    check(!finished, 'Parser is already finished'); check(typeof incompleteFinalLine === 'boolean', 'Invalid incomplete final line flag');
    finished = true;
    if (incompleteFinalLine) {
      diagnostics.push(diagnostic('incomplete_line', 'warning', options.sourceRef, lineNumber + 1, null, 'Ignored incomplete final JSONL line'));
      sawContent = true;
    }
    if (!sessionSeen && sawContent) diagnostics.push(diagnostic('missing_session_meta', 'warning', options.sourceRef, null, null, 'No session identity record was observed'));
    return { records, diagnostics };
  }
  return { push, finish };
}

export function parseCodexUsageDetailed(textValue, options, observer = null) {
  check(typeof textValue === 'string', 'Expected JSONL text');
  const parser = createCodexUsageAccumulator(options, observer);
  const lines = textValue.split('\n');
  const incompleteFinalLine = !textValue.endsWith('\n') && lines.at(-1) !== '';
  if (incompleteFinalLine) lines.pop();
  else lines.pop();
  lines.forEach(line => parser.push(line));
  return parser.finish({ incompleteFinalLine });
}

export function parseCodexUsage(textValue, options) {
  return parseCodexUsageDetailed(textValue, options);
}

export function mergeUsage(ledger, records, diagnostics = [], observations) {
  validateUsage(ledger); check(Array.isArray(records), 'Expected records'); check(Array.isArray(diagnostics), 'Expected diagnostics');
  records.forEach(validateRecord); diagnostics.forEach(validateDiagnostic);
  const nextRecords = new Map(ledger.records.map(record => [record.id, structuredClone(record)]));
  for (const record of records) {
    const existing = nextRecords.get(record.id);
    if (existing) check(isDeepStrictEqual(canonical(existing), canonical(record)), 'Conflicting record id');
    else nextRecords.set(record.id, structuredClone(record));
  }
  const diagnosticMap = new Map();
  for (const item of [...ledger.diagnostics, ...diagnostics]) diagnosticMap.set(canonicalText(item), structuredClone(item));
  const useV2 = ledger.schemaVersion === 2 || observations !== undefined;
  const result = {
    schemaVersion: useV2 ? 2 : 1, teamId: ledger.teamId,
    records: [...nextRecords.values()].sort((a, b) => a.id.localeCompare(b.id)),
    links: structuredClone(ledger.links).sort((a, b) => a.recordId.localeCompare(b.recordId)),
    diagnostics: [...diagnosticMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
  };
  if (useV2) {
    check(observations === undefined || Array.isArray(observations), 'Expected observations');
    const nextObservations = new Map((ledger.observations ?? []).map(item => [item.recordId, structuredClone(item)]));
    const sourcePositions = new Map();
    for (const observation of ledger.observations ?? []) {
      const record = nextRecords.get(observation.recordId);
      sourcePositions.set(`${record.hostId}\u0000${record.threadId}\u0000${observation.sourceRef}\u0000${observation.usageLine}`, observation.recordId);
    }
    const incomingRecordIds = new Set();
    for (const observation of observations ?? []) {
      check(!incomingRecordIds.has(observation?.recordId), 'Duplicate observation for record');
      incomingRecordIds.add(observation?.recordId);
      validateObservation(observation, nextRecords);
      const record = nextRecords.get(observation.recordId);
      const position = `${record.hostId}\u0000${record.threadId}\u0000${observation.sourceRef}\u0000${observation.usageLine}`;
      const positionedRecordId = sourcePositions.get(position);
      check(positionedRecordId === undefined || positionedRecordId === observation.recordId, 'Conflicting observation source position');
      sourcePositions.set(position, observation.recordId);
      const existing = nextObservations.get(observation?.recordId);
      if (existing) check(isDeepStrictEqual(canonical(existing), canonical(observation)), 'Conflicting observation for record');
      else nextObservations.set(observation?.recordId, structuredClone(observation));
    }
    result.observations = [...nextObservations.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
  }
  return validateUsage(result);
}
