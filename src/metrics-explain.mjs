const metricNames = ['input', 'cachedInput', 'nonCachedInput', 'output', 'reasoningOutput', 'net', 'total'];
const rankingNames = ['input', 'nonCachedInput', 'output', 'net'];
const attributionKinds = ['explicit', 'window', 'shared', 'unknown'];
const roles = ['Manager', 'Liaison', 'Worker', 'Unknown'];
const operations = ['coordination', 'implementation', 'review', 'rework', 'recovery', 'reporting', 'unknown'];
const evidenceLevels = ['observed', 'temporal', 'candidate'];
const globalLimitations = [
  'observed_records_only', 'wrapper_opacity', 'bytes_are_log_volume_not_input_tokens',
  'temporal_correlation_not_causality', 'overlapping_labels_not_additive', 'advanced_role_recall_and_busy_worker_unassessed'
];
const globalSuggestions = ['inspect_original_source_locally', 'check_truncation_and_input_visibility', 'compare_code_config_version_and_reason'];
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
function object(value, keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  check(Object.keys(value).every(key => keys.includes(key)), 'Unknown explanation field');
  check(keys.every(key => Object.hasOwn(value, key)), 'Missing explanation field');
}
function id(value, label = 'identifier') { check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value), `Invalid ${label}`); }
function text(value, label = 'text') { check(typeof value === 'string' && value.trim() && value.length <= 4000, `Invalid ${label}`); }
function integerOrNull(value, label) { check(value === null || (Number.isSafeInteger(value) && value >= 0), `Invalid ${label}`); }
function positiveOrNull(value, label) { check(value === null || (Number.isSafeInteger(value) && value > 0), `Invalid ${label}`); }
function safeAdd(a, b) { const result = a + b; check(Number.isSafeInteger(result), 'Explanation value exceeds safe integer range'); return result; }
const position = (recordId, sourceRef, callLine, resultLine) => ({ recordId, sourceRef, callLine, resultLine });

function observedEvents(records, observations) {
  const recordById = new Map(records.map(record => [record.id, record])), items = [];
  for (const observation of observations) {
    const record = recordById.get(observation.recordId);
    if (!record) continue;
    const cutoff = observation.nativeResponse?.line ?? observation.usageLine;
    for (const event of observation.events.filter(item => item.line <= cutoff)) items.push({ record, observation, event });
  }
  return items;
}
const scopeKey = item => `${item.record.hostId}\u0000${item.record.threadId}\u0000${item.observation.sourceRef}`;
function resultLinks(items) {
  const callIds = new Map();
  for (const item of items.filter(item => item.event.callId !== null)) {
    const key = `${scopeKey(item)}\u0000${item.event.callId}`;
    if (!callIds.has(key)) callIds.set(key, { calls: [], results: [] });
    callIds.get(key)[item.event.kind === 'tool_call' ? 'calls' : 'results'].push(item);
  }
  const links = new Map();
  for (const group of callIds.values()) if (group.calls.length === 1 && group.results.length === 1) links.set(group.results[0].event, group.calls[0]);
  return links;
}

function activity(observation, links) {
  if (!observation) return {
    availability: 'unavailable', toolCalls: { count: null, items: [] },
    toolResults: { count: null, utf8BytesKnown: null, bytesMissing: null, items: [] },
    compactions: { count: null, lines: [] }, userMessages: { count: null, lines: [] }
  };
  const cutoff = observation.nativeResponse?.line ?? observation.usageLine;
  const events = observation.events.filter(event => event.line <= cutoff);
  const calls = events.filter(event => event.kind === 'tool_call');
  const results = events.filter(event => event.kind === 'tool_result');
  const compactions = events.filter(event => event.kind === 'context_compaction');
  const messages = events.filter(event => event.kind === 'user_message');
  const byteValues = results.filter(event => event.bytes !== null).map(event => event.bytes);
  const knownBytes = byteValues.length ? byteValues.reduce((sum, value) => safeAdd(sum, value), 0) : (results.length ? null : 0);
  return {
    availability: 'observed', toolCalls: { count: calls.length, items: calls.map(event => ({ line: event.line, tool: event.tool })) },
    toolResults: {
      count: results.length, utf8BytesKnown: knownBytes, bytesMissing: results.filter(event => event.bytes === null).length,
      items: results.map(event => {
        const linked = links.get(event);
        return { line: event.line, bytes: event.bytes, callLine: linked?.event.line ?? null, tool: linked?.event.tool ?? event.tool };
      })
    },
    compactions: { count: compactions.length, lines: compactions.map(event => event.line) },
    userMessages: { count: messages.length, lines: messages.map(event => event.line) }
  };
}

function evidence(observation, projectedActivity) {
  if (!observation) return [];
  const items = [];
  if (projectedActivity.toolCalls.count) items.push({ level: 'observed', code: 'tool_calls_observed', lines: projectedActivity.toolCalls.items.map(item => item.line) });
  if (projectedActivity.toolResults.count) items.push({ level: 'observed', code: 'tool_results_observed', lines: projectedActivity.toolResults.items.map(item => item.line) });
  if (projectedActivity.toolResults.utf8BytesKnown !== null && projectedActivity.toolResults.count) items.push({ level: 'observed', code: 'tool_result_bytes_observed', lines: projectedActivity.toolResults.items.filter(item => item.bytes !== null).map(item => item.line) });
  if (projectedActivity.compactions.count) items.push({ level: 'temporal', code: 'nearby_compaction', lines: projectedActivity.compactions.lines });
  if (observation.nativeResponse) items.push({ level: 'temporal', code: 'native_response_counter_match', lines: [observation.nativeResponse.line] });
  return items;
}

function repetitions(records, observations) {
  const items = observedEvents(records, observations), links = resultLinks(items);
  const resultsByCall = new Map([...links].map(([result, call]) => [call.event, items.find(item => item.event === result)]));
  const groups = new Map();
  for (const item of items.filter(item => item.event.kind === 'tool_call' && item.event.tool !== null && item.event.argumentsHash !== null)) {
    const key = `${scopeKey(item)}\u0000${item.event.tool}\u0000${item.event.argumentsHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const output = [];
  for (const calls of groups.values()) {
    calls.sort((a, b) => a.event.line - b.event.line || a.record.id.localeCompare(b.record.id));
    for (let index = 1; index < calls.length; index += 1) {
      const previous = calls[index - 1], current = calls[index];
      const previousResult = resultsByCall.get(previous.event) ?? null, currentResult = resultsByCall.get(current.event) ?? null;
      const sameContent = previousResult !== null && currentResult !== null
        && previousResult.event.contentHash !== null && currentResult.event.contentHash !== null
        && previousResult.event.contentHash === currentResult.event.contentHash;
      output.push({
        kind: sameContent ? 'repeated_same_content' : 'repeated_call', level: 'candidate', tool: current.event.tool,
        previous: position(previous.record.id, previous.observation.sourceRef, previous.event.line, previousResult?.event.line ?? null),
        current: position(current.record.id, current.observation.sourceRef, current.event.line, currentResult?.event.line ?? null),
        limitations: ['repetition_does_not_prove_waste'], suggestions: ['inspect_original_source_locally', 'compare_code_config_version_and_reason']
      });
    }
  }
  return output.sort((a, b) => a.current.sourceRef.localeCompare(b.current.sourceRef) || a.current.callLine - b.current.callLine || a.current.recordId.localeCompare(b.current.recordId));
}

export function buildExplanation(records, assignments, observations) {
  check(Array.isArray(records) && Array.isArray(assignments) && Array.isArray(observations), 'Expected explanation inputs');
  const assignmentById = new Map(assignments.map(item => [item.recordId, item]));
  const observationById = new Map(observations.map(item => [item.recordId, item]));
  const links = resultLinks(observedEvents(records, observations));
  const cards = records.map(record => {
    const observation = observationById.get(record.id), projectedActivity = activity(observation, links);
    const limitations = ['overlapping_labels_not_additive'];
    if (!observation) limitations.push('record_only_evidence');
    if (projectedActivity.toolResults.count > 0) limitations.push('bytes_are_log_volume_not_input_tokens');
    if (observation?.nativeResponse) limitations.push('temporal_correlation_not_causality');
    return {
      recordId: record.id, time: record.at, turnId: record.turnId, model: record.model,
      identity: { hostId: record.hostId, threadId: record.threadId }, attribution: structuredClone(assignmentById.get(record.id)),
      metrics: structuredClone(record.metrics), source: {
        kind: record.source.kind, ref: record.source.ref, firstLine: observation?.firstLine ?? null,
        lastLine: observation?.usageLine ?? null, usageLine: observation?.usageLine ?? null,
        activityLastLine: observation ? (observation.nativeResponse?.line ?? observation.usageLine) : null
      },
      nativeResponse: observation?.nativeResponse ? structuredClone(observation.nativeResponse) : null,
      activity: projectedActivity, evidence: evidence(observation, projectedActivity), limitations,
      suggestions: observation ? ['inspect_original_source_locally', 'check_truncation_and_input_visibility'] : ['check_truncation_and_input_visibility']
    };
  });
  const rankings = Object.fromEntries(rankingNames.map(metric => {
    const rows = cards.filter(card => card.metrics[metric] !== null).map(card => ({ recordId: card.recordId, value: card.metrics[metric] }))
      .sort((a, b) => b.value - a.value || a.recordId.localeCompare(b.recordId));
    return [metric, { metric, rows, missingRecords: cards.length - rows.length }];
  }));
  const explanation = {
    schemaVersion: 1,
    coverage: { records: cards.length, observedWindows: cards.filter(card => card.activity.availability === 'observed').length, unavailableRecords: cards.filter(card => card.activity.availability === 'unavailable').length },
    rankings, cards, repetitionCandidates: repetitions(records, observations),
    limitations: globalLimitations, suggestions: globalSuggestions
  };
  return validateExplanation(explanation);
}

function validateMetricSet(value) {
  object(value, metricNames);
  for (const name of metricNames) integerOrNull(value[name], `metric ${name}`);
  check(value.input === null || value.cachedInput === null || value.cachedInput <= value.input, 'cached input exceeds input');
  check(value.output === null || value.reasoningOutput === null || value.reasoningOutput <= value.output, 'reasoning output exceeds output');
  check(value.nonCachedInput === (value.input === null || value.cachedInput === null ? null : value.input - value.cachedInput), 'Conflicting noncached input');
  check(value.net === (value.nonCachedInput === null || value.output === null ? null : value.nonCachedInput + value.output), 'Conflicting net metric');
}
function validateStringArray(value, allowed, label) { check(Array.isArray(value) && value.every(item => allowed.includes(item)), `Invalid ${label}`); check(new Set(value).size === value.length, `Duplicate ${label}`); }
function validateLines(value, label) { check(Array.isArray(value) && value.every(line => Number.isSafeInteger(line) && line > 0), `Invalid ${label} lines`); }
function validateCountLines(value, label, unavailable) {
  object(value, ['count', 'lines']); integerOrNull(value.count, `${label} count`); validateLines(value.lines, label);
  check(unavailable ? value.count === null && value.lines.length === 0 : value.count === value.lines.length, `Conflicting ${label} count`);
}
function validateToolCalls(value, unavailable) {
  object(value, ['count', 'items']); integerOrNull(value.count, 'tool call count'); check(Array.isArray(value.items), 'Invalid tool call items');
  for (const item of value.items) { object(item, ['line', 'tool']); positiveOrNull(item.line, 'tool call line'); check(item.line !== null, 'Missing tool call line'); if (item.tool !== null) id(item.tool, 'tool'); }
  check(unavailable ? value.count === null && value.items.length === 0 : value.count === value.items.length, 'Conflicting tool call count');
}
function validateToolResults(value, unavailable) {
  object(value, ['count', 'utf8BytesKnown', 'bytesMissing', 'items']); integerOrNull(value.count, 'tool result count'); integerOrNull(value.utf8BytesKnown, 'tool result bytes'); integerOrNull(value.bytesMissing, 'missing tool result bytes'); check(Array.isArray(value.items), 'Invalid tool result items');
  for (const item of value.items) {
    object(item, ['line', 'bytes', 'callLine', 'tool']); positiveOrNull(item.line, 'tool result line'); check(item.line !== null, 'Missing tool result line'); integerOrNull(item.bytes, 'tool result item bytes'); positiveOrNull(item.callLine, 'linked call line'); if (item.tool !== null) id(item.tool, 'tool');
  }
  if (unavailable) { check(value.count === null && value.utf8BytesKnown === null && value.bytesMissing === null && value.items.length === 0, 'Conflicting unavailable tool results'); return; }
  const known = value.items.filter(item => item.bytes !== null).map(item => item.bytes), missing = value.items.length - known.length;
  const sum = known.length ? known.reduce((total, bytes) => safeAdd(total, bytes), 0) : (value.items.length ? null : 0);
  check(value.count === value.items.length && value.bytesMissing === missing && value.utf8BytesKnown === sum, 'Conflicting tool result activity');
}
function validateAttribution(value, recordId) {
  object(value, ['recordId', 'kind', 'roundId', 'taskId', 'memberId', 'role', 'operation', 'evidenceRef']);
  check(value.recordId === recordId, 'Attribution record mismatch'); check(attributionKinds.includes(value.kind), 'Invalid attribution kind');
  for (const [key, item] of Object.entries({ roundId: value.roundId, taskId: value.taskId, memberId: value.memberId })) if (item !== null) id(item, key);
  check(roles.includes(value.role) && operations.includes(value.operation), 'Invalid attribution label');
  check(value.evidenceRef === null || (typeof value.evidenceRef === 'string' && value.evidenceRef.trim() && value.evidenceRef.length <= 4000), 'Invalid attribution evidence');
}
function validateNative(value, source) {
  if (value === null) return;
  object(value, ['responseId', 'turnId', 'line', 'association']); id(value.responseId, 'response id'); if (value.turnId !== null) id(value.turnId, 'native turn id');
  positiveOrNull(value.line, 'native response line'); check(value.association === 'counter-match', 'Invalid native association');
  check(source.firstLine !== null && value.line >= source.firstLine && value.line <= source.lastLine, 'Native response outside source range');
}
function sameScope(left, right) { return left.source.ref === right.source.ref && left.identity.hostId === right.identity.hostId && left.identity.threadId === right.identity.threadId; }
function findCall(cards, owner, line, tool) {
  return [...cards.values()].filter(card => sameScope(card, owner) && card.activity.availability === 'observed')
    .flatMap(card => card.activity.toolCalls.items).filter(item => item.line === line && item.tool === tool);
}
function findResult(cards, owner, line, callLine, tool) {
  return [...cards.values()].filter(card => sameScope(card, owner) && card.activity.availability === 'observed')
    .flatMap(card => card.activity.toolResults.items).filter(item => item.line === line && item.callLine === callLine && item.tool === tool);
}
function validatePosition(value, cards, label, tool) {
  object(value, ['recordId', 'sourceRef', 'callLine', 'resultLine']); id(value.recordId, `${label} record id`); text(value.sourceRef, `${label} source ref`);
  positiveOrNull(value.callLine, `${label} call line`); positiveOrNull(value.resultLine, `${label} result line`); check(value.callLine !== null, 'Missing candidate call line');
  const card = cards.get(value.recordId); check(card && card.source.ref === value.sourceRef, 'Candidate source reference mismatch');
  check(findCall(cards, card, value.callLine, tool).length === 1, 'Candidate call does not reference an observed call');
  if (value.resultLine !== null) check(findResult(cards, card, value.resultLine, value.callLine, tool).length === 1, 'Candidate result does not reference an observed result');
}

export function validateExplanation(explanation) {
  object(explanation, ['schemaVersion', 'coverage', 'rankings', 'cards', 'repetitionCandidates', 'limitations', 'suggestions']);
  check(explanation.schemaVersion === 1, 'Unsupported explanation schema version');
  object(explanation.coverage, ['records', 'observedWindows', 'unavailableRecords']);
  for (const key of ['records', 'observedWindows', 'unavailableRecords']) integerOrNull(explanation.coverage[key], `coverage ${key}`);
  check(Array.isArray(explanation.cards) && Array.isArray(explanation.repetitionCandidates), 'Invalid explanation collections');
  const cards = new Map();
  for (const card of explanation.cards) {
    object(card, ['recordId', 'time', 'turnId', 'model', 'identity', 'attribution', 'metrics', 'source', 'nativeResponse', 'activity', 'evidence', 'limitations', 'suggestions']);
    id(card.recordId, 'card record id'); check(!cards.has(card.recordId), 'Duplicate explanation card');
    check(typeof card.time === 'string' && new Date(card.time).toISOString() === card.time, 'Invalid card time');
    check(card.turnId === null || (typeof card.turnId === 'string' && card.turnId.length <= 4000 && card.turnId.length > 0), 'Invalid turn id');
    check(card.model === null || (typeof card.model === 'string' && card.model.length <= 4000 && card.model.length > 0), 'Invalid model');
    object(card.identity, ['hostId', 'threadId']); id(card.identity.hostId, 'host id'); id(card.identity.threadId, 'thread id'); validateAttribution(card.attribution, card.recordId); validateMetricSet(card.metrics);
    object(card.source, ['kind', 'ref', 'firstLine', 'lastLine', 'usageLine', 'activityLastLine']); check(['fixture', 'codex-log'].includes(card.source.kind), 'Invalid source kind'); text(card.source.ref, 'source ref');
    for (const field of ['firstLine', 'lastLine', 'usageLine', 'activityLastLine']) positiveOrNull(card.source[field], field);
    const noSource = card.source.firstLine === null;
    check(['lastLine', 'usageLine', 'activityLastLine'].every(field => (card.source[field] === null) === noSource), 'Conflicting source range');
    if (!noSource) check(card.source.firstLine <= card.source.activityLastLine && card.source.activityLastLine <= card.source.usageLine && card.source.lastLine === card.source.usageLine, 'Invalid source range');
    validateNative(card.nativeResponse, card.source);
    object(card.activity, ['availability', 'toolCalls', 'toolResults', 'compactions', 'userMessages']); check(['observed', 'unavailable'].includes(card.activity.availability), 'Invalid activity availability');
    const unavailable = card.activity.availability === 'unavailable'; validateToolCalls(card.activity.toolCalls, unavailable); validateToolResults(card.activity.toolResults, unavailable); validateCountLines(card.activity.compactions, 'compactions', unavailable); validateCountLines(card.activity.userMessages, 'user messages', unavailable);
    check(unavailable === (card.source.firstLine === null), 'Activity availability conflicts with source range');
    if (!unavailable) {
      const activityLines = [
        ...card.activity.toolCalls.items.map(item => item.line), ...card.activity.toolResults.items.map(item => item.line),
        ...card.activity.compactions.lines, ...card.activity.userMessages.lines
      ];
      check(activityLines.every(line => line >= card.source.firstLine && line <= card.source.activityLastLine), 'Activity line outside activity window');
      check(card.nativeResponse === null ? card.source.activityLastLine === card.source.usageLine : card.nativeResponse.line === card.source.activityLastLine, 'Activity cutoff conflicts with native response');
    }
    check(Array.isArray(card.evidence), 'Invalid evidence'); for (const item of card.evidence) { object(item, ['level', 'code', 'lines']); check(evidenceLevels.includes(item.level), 'Invalid evidence level'); id(item.code, 'evidence code'); validateLines(item.lines, 'evidence'); check(!unavailable, 'Unavailable card cannot have observed evidence'); check(item.lines.every(line => line >= card.source.firstLine && line <= card.source.activityLastLine), 'Evidence line outside activity window'); }
    validateStringArray(card.limitations, [...globalLimitations, 'record_only_evidence'], 'card limitations'); validateStringArray(card.suggestions, globalSuggestions, 'card suggestions'); cards.set(card.recordId, card);
  }
  check(explanation.coverage.records === cards.size && explanation.coverage.observedWindows + explanation.coverage.unavailableRecords === cards.size, 'Conflicting explanation coverage');
  check(explanation.coverage.observedWindows === [...cards.values()].filter(card => card.activity.availability === 'observed').length, 'Conflicting observed coverage');
  for (const card of cards.values()) for (const result of card.activity.toolResults.items) {
    if (result.callLine !== null) check(findCall(cards, card, result.callLine, result.tool).length === 1, 'Tool result link does not reference one observed call');
  }
  object(explanation.rankings, rankingNames);
  for (const name of rankingNames) {
    const ranking = explanation.rankings[name]; object(ranking, ['metric', 'rows', 'missingRecords']); check(ranking.metric === name && Array.isArray(ranking.rows), 'Invalid ranking'); integerOrNull(ranking.missingRecords, 'ranking missing records');
    const expected = [...cards.values()].filter(card => card.metrics[name] !== null).map(card => ({ recordId: card.recordId, value: card.metrics[name] })).sort((a, b) => b.value - a.value || a.recordId.localeCompare(b.recordId));
    for (const row of ranking.rows) { object(row, ['recordId', 'value']); id(row.recordId, 'ranking record id'); integerOrNull(row.value, 'ranking value'); }
    check(JSON.stringify(ranking.rows) === JSON.stringify(expected) && ranking.missingRecords === cards.size - expected.length, 'Conflicting or incomplete ranking');
  }
  for (const candidate of explanation.repetitionCandidates) {
    object(candidate, ['kind', 'level', 'tool', 'previous', 'current', 'limitations', 'suggestions']); check(['repeated_call', 'repeated_same_content'].includes(candidate.kind) && candidate.level === 'candidate', 'Invalid repetition candidate'); id(candidate.tool, 'candidate tool');
    validatePosition(candidate.previous, cards, 'previous', candidate.tool); validatePosition(candidate.current, cards, 'current', candidate.tool); check(candidate.previous.recordId !== candidate.current.recordId || candidate.previous.callLine !== candidate.current.callLine, 'Candidate self reference');
    const previousCard = cards.get(candidate.previous.recordId), currentCard = cards.get(candidate.current.recordId);
    check(candidate.previous.sourceRef === candidate.current.sourceRef && previousCard.identity.hostId === currentCard.identity.hostId && previousCard.identity.threadId === currentCard.identity.threadId, 'Candidate scope mismatch');
    check(candidate.kind !== 'repeated_same_content' || (candidate.previous.resultLine !== null && candidate.current.resultLine !== null), 'Same-content candidate lacks result links');
    validateStringArray(candidate.limitations, ['repetition_does_not_prove_waste'], 'candidate limitations'); validateStringArray(candidate.suggestions, globalSuggestions, 'candidate suggestions');
  }
  validateStringArray(explanation.limitations, globalLimitations, 'global limitations'); validateStringArray(explanation.suggestions, globalSuggestions, 'global suggestions');
  return explanation;
}
