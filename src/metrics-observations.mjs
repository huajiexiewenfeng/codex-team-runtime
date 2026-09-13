import { createHash } from 'node:crypto';
import { createCodexUsageAccumulator } from './metrics-usage.mjs';

const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : null;
const canonicalTimestamp = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  const normalized = new Date(value).toISOString();
  return normalized === value ? value : null;
};
const contentEvidence = value => {
  if (typeof value === 'string') return { hash: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) };
  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    return { hash: createHash('sha256').update(`array-json-v1\0${serialized}`).digest('hex'), bytes: Buffer.byteLength(serialized) };
  }
  return { hash: null, bytes: null };
};
const baseEvent = (kind, entry, line) => ({
  kind, line, at: canonicalTimestamp(entry.timestamp), callId: null, tool: null,
  argumentsHash: null, contentHash: null, bytes: null
});

function nativeCandidate(entry, line, threadId) {
  if (entry.type !== 'token_usage_record' || entry.payload?.thread_id !== threadId) return null;
  const payload = entry.payload, wire = payload.usage;
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const responseId = safeIdentifier(payload.response_id), turnId = safeIdentifier(payload.turn_id);
  if (responseId === null || turnId === null) return null;
  const usage = {
    input: wire.input_tokens, cachedInput: wire.cached_input_tokens, output: wire.output_tokens,
    reasoningOutput: wire.reasoning_output_tokens, total: wire.total_tokens
  };
  if (Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  return { responseId, turnId, line, usage };
}
const sameUsage = (left, right) => ['input', 'cachedInput', 'output', 'reasoningOutput', 'total'].every(field => left[field] === right[field]);
const maxPendingCallIds = 4096;

function createObservationCollector(options) {
  let pending = [], boundaryLine = 0, nativeCandidates = [];
  let callAssociationOverflowed = false;
  const callTools = new Map();
  return {
    observe(entry, line) {
      const candidate = nativeCandidate(entry, line, options.threadId);
      if (candidate !== null) nativeCandidates.push(candidate);
      let event = null;
      if (entry.type === 'response_item' && (entry.payload?.type === 'function_call' || entry.payload?.type === 'custom_tool_call')) {
        const payload = entry.payload;
        const callId = safeIdentifier(payload.call_id), tool = safeIdentifier(payload.name);
        const raw = payload.type === 'function_call' ? payload.arguments : payload.input;
        const evidence = contentEvidence(raw);
        event = { ...baseEvent('tool_call', entry, line), callId, tool, argumentsHash: evidence.hash, bytes: evidence.bytes };
        if (callId !== null && !callAssociationOverflowed) {
          if (!callTools.has(callId)) {
            if (callTools.size >= maxPendingCallIds) {
              callTools.clear();
              callAssociationOverflowed = true;
            } else callTools.set(callId, { tool, line, ambiguous: false });
          }
          else callTools.set(callId, { tool: null, line: Math.min(callTools.get(callId).line, line), ambiguous: true });
        }
      } else if (entry.type === 'response_item' && (entry.payload?.type === 'function_call_output' || entry.payload?.type === 'custom_tool_call_output')) {
        const payload = entry.payload;
        const callId = safeIdentifier(payload.call_id), evidence = contentEvidence(payload.output);
        const linked = callId !== null && !callAssociationOverflowed ? callTools.get(callId) : null;
        const linkedTool = linked && !linked.ambiguous ? linked.tool : null;
        event = { ...baseEvent('tool_result', entry, line), callId, tool: linkedTool, contentHash: evidence.hash, bytes: evidence.bytes };
        if (callId !== null && linked && !linked.ambiguous) callTools.delete(callId);
      } else if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const evidence = contentEvidence(entry.payload.message);
        event = { ...baseEvent('user_message', entry, line), contentHash: evidence.hash, bytes: evidence.bytes };
      } else if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
        const content = Array.isArray(entry.payload.content) ? JSON.stringify(entry.payload.content) : null;
        const evidence = contentEvidence(content);
        event = { ...baseEvent('user_message', entry, line), contentHash: evidence.hash, bytes: evidence.bytes };
      } else if (entry.type === 'compacted' || (entry.type === 'event_msg' && entry.payload?.type === 'context_compacted')) {
        event = baseEvent('context_compaction', entry, line);
      }
      if (event !== null) pending.push(event);
    },
    accept(record, usageLine) {
      const matches = nativeCandidates.filter(candidate => candidate.line <= usageLine &&
        sameUsage(candidate.usage, record.usage) && (record.turnId === null || candidate.turnId === record.turnId));
      const matched = matches.length === 1 ? matches[0] : null;
      const endLine = matched?.line ?? usageLine;
      const events = pending.filter(event => event.line > boundaryLine && event.line <= endLine);
      const nativeResponse = matched === null ? null : {
        responseId: matched.responseId, turnId: matched.turnId, line: matched.line, association: 'counter-match'
      };
      const observation = {
        recordId: record.id, sourceRef: options.sourceRef, firstLine: boundaryLine + 1, usageLine, nativeResponse, events
      };
      pending = pending.filter(event => event.line > endLine);
      nativeCandidates = nativeCandidates.filter(candidate => candidate.line > endLine);
      boundaryLine = endLine;
      return observation;
    },
    finish() { pending = []; nativeCandidates = []; callTools.clear(); }
  };
}

export function createCodexUsageParser(options, { observations = false } = {}) {
  if (typeof observations !== 'boolean') throw new Error('Invalid observations flag');
  const collected = [], collector = observations ? createObservationCollector(options) : null;
  if (collector !== null) {
    const accept = collector.accept.bind(collector);
    collector.accept = (record, usageLine) => collected.push(accept(record, usageLine));
  }
  const parser = createCodexUsageAccumulator(options, collector);
  return {
    push(line) { parser.push(line); },
    finish(finishOptions) {
      const result = parser.finish(finishOptions);
      collector?.finish();
      return observations ? { ...result, observations: collected } : result;
    }
  };
}

export function parseCodexUsageWithObservations(text, options) {
  if (typeof text !== 'string') throw new Error('Expected JSONL text');
  const parser = createCodexUsageParser(options, { observations: true });
  const lines = text.split('\n');
  const incompleteFinalLine = !text.endsWith('\n') && lines.at(-1) !== '';
  lines.pop();
  lines.forEach(line => parser.push(line));
  return parser.finish({ incompleteFinalLine });
}
