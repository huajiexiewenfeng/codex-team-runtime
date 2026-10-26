// @exec: {"yield_time_ms": 1000, "max_output_tokens": 16000}
// Paste this entire source into ONE functions.exec. Fill only verified inputs.
// This is NOT a Node CLI. No imports, file access, timers or other host calls.
const request = {targets: [], timeoutMs: 0}; // 1..8 exact {hostId,threadId,afterCursor?}
// Optional trusted ledger input: [{hostId,threadId,submissionRef}]. Never native text.
const ledgerReferences = [];

async function filteredWait(request, ledgerReferences) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v)
    && !/^(client-|REPLACE)/i.test(v);
  const key = v => JSON.stringify([v.hostId, v.threadId]);
  const opaque = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048;
  // Conservative ASCII-escaped size also bounds UTF-8/token output expansion.
  const outputSize = v => JSON.stringify(v).replace(/[^\x00-\x7F]/g,'______').length;
  const unknown = (signal, targets = []) => ({
    signal, timedOut: null, wake: 'unknown', nativeErrors: 'unknown',
    targets: targets.map(t => ({hostId:t.hostId,threadId:t.threadId,
      threadStatus:'unknown',turn:null,cursor:null,revision:null,changed:null,
      error:signal,submissionRef:null}))
  });
  // Reject the whole input before a tool call. Never echo invalid input.
  if (!keys(request,['targets','timeoutMs']) || !Array.isArray(request.targets)
      || request.targets.length < 1 || request.targets.length > 8
      || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 0
      || request.timeoutMs > 60000 || !Array.isArray(ledgerReferences)
      || ledgerReferences.length > 8) return unknown('invalid_input');
  const seen = new Set();
  let cursorSize = 0;
  for (const t of request.targets) {
    if (!keys(t,['hostId','threadId','afterCursor']) || !id(t.hostId) || !id(t.threadId)
        || seen.has(key(t)) || ('afterCursor' in t && !opaque(t.afterCursor)))
      return unknown('invalid_input');
    seen.add(key(t));
    cursorSize += t.afterCursor?.length ?? 0;
  }
  if (cursorSize > 4096) return unknown('invalid_input');
  const refs = new Map();
  for (const r of ledgerReferences) {
    if (!keys(r,['hostId','threadId','submissionRef']) || !id(r.hostId) || !id(r.threadId)
        || !seen.has(key(r)) || refs.has(key(r)) || typeof r.submissionRef !== 'string'
        || r.submissionRef.trim().length === 0 || r.submissionRef.length > 256)
      return unknown('invalid_input');
    refs.set(key(r),r.submissionRef);
  }
  if (outputSize([...refs.values()]) > 4096) return unknown('invalid_input');
  const targets = request.targets.map(t => ({...t}));
  const fallback = signal => {
    const result = unknown(signal,targets);
    for (const row of result.targets) row.submissionRef = refs.get(key(row)) ?? null;
    return result;
  };
  let raw;
  try {
    raw = await tools.mcp__codex_app__wait_threads({targets,timeoutMs:request.timeoutMs});
  } catch { return fallback('host_exception'); } // error.message may contain private text.
  let value;
  try {
    if (!object(raw) || raw.isError === true) return fallback('host_error');
    if (object(raw.structuredContent)) value = raw.structuredContent;
    else {
      if (!Array.isArray(raw.content)) return fallback('unknown_envelope');
      const texts = raw.content.filter(b => b?.type === 'text');
      if (texts.length !== 1 || typeof texts[0].text !== 'string'
          || texts[0].text.length > 2000000) return fallback('unknown_envelope');
      value = JSON.parse(texts[0].text);
    }
    if (!object(value) || typeof value.timedOut !== 'boolean'
        || !Object.hasOwn(value,'wake') || !Array.isArray(value.polls)
        || value.polls.length > 8) return fallback('unknown_schema');
  } catch { return fallback('parse_error'); }
  const out = fallback('returned');
  out.timedOut = value.timedOut;
  out.wake = value.wake === null ? 'none' : 'unknown';
  out.nativeErrors = !Object.hasOwn(value,'errors') ? 'none'
    : Array.isArray(value.errors) && value.errors.length === 0 ? 'none' : 'present_unknown';
  const threadStates = ['active','idle','ended'];
  const turnStates = ['inProgress','completed','interrupted','failed'];
  let outputCursorSize = 0;
  for (const row of out.targets) {
    // Match by BOTH identities, including duplicate/conflicting observations.
    const exact = value.polls.filter(p => p?.thread?.id === row.threadId
      && p?.thread?.hostId === row.hostId);
    const conflict = value.polls.some(p => p?.thread?.id === row.threadId
      && !seen.has(key({hostId:p?.thread?.hostId,threadId:p?.thread?.id})));
    row.error = conflict ? 'identity_conflict' : exact.length > 1 ? 'duplicate_poll'
      : exact.length === 0 ? 'missing_poll' : null;
    if (row.error) continue;
    const p = exact[0];
    if (p.schemaVersion !== 1 || !object(p.thread.status)
        || !Array.isArray(p.thread.status.activeFlags)
        || !Number.isSafeInteger(p.revision) || p.revision < 0
        || typeof p.changed !== 'boolean') { row.error = 'unknown_poll'; continue; }
    row.threadStatus = threadStates.includes(p.thread.status.type)
      ? p.thread.status.type : 'unknown';
    row.revision = p.revision;
    row.changed = p.changed;
    if (p.latestTurn === null) row.turn = null;
    else if (object(p.latestTurn) && id(p.latestTurn.id)) {
      row.turn = {id:p.latestTurn.id,
        status:turnStates.includes(p.latestTurn.status) ? p.latestTurn.status : 'unknown',
        error:p.latestTurn.error === null ? 'none' : 'present_unknown'};
    } else row.error = 'unknown_turn';
    if (opaque(p.cursor) && outputCursorSize + p.cursor.length <= 4096) {
      row.cursor = p.cursor;
      outputCursorSize += p.cursor.length;
    } else row.error = 'unusable_cursor'; // Never emit a truncated cursor for reuse.
  }
  // Observed wake schema only. Validate against requested identity AND its poll;
  // wake alone never creates a completion status, submission or approval.
  const w = value.wake;
  if (keys(w,['reason','turnId','threadId','hostId']) && w.reason === 'turnCompleted'
      && id(w.hostId) && id(w.threadId) && id(w.turnId) && seen.has(key(w))
      && value.timedOut === false) {
    const row = out.targets.find(t => key(t) === key(w));
    if (row.error === null && row.threadStatus === 'idle'
        && row.turn?.id === w.turnId && row.turn.status === 'completed'
        && row.turn.error === 'none')
      out.wake = {reason:'turnCompleted',hostId:row.hostId,threadId:row.threadId,turnId:row.turn.id};
  }
  return outputSize(out) <= 14000 ? out : fallback('output_limit');
}

text(await filteredWait(request,ledgerReferences));
