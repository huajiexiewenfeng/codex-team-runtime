// @exec: {"yield_time_ms": 1000, "max_output_tokens": 1500}
// Manager only: paste this entire source into ONE functions.exec at the existing
// authorized pre-dispatch checkpoint. Fill only independently verified inputs.
// Set verifiedLocalHostId only when current Manager, exact target and focused
// desktop navigation are verified to use the same local host. No imports or I/O.
const request = {target: null, dispatchAuthorized: false, verifiedLocalHostId: null};

async function prepareThread(request) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v)
    && !/^(client-|REPLACE)/i.test(v);
  const terminal = ['completed','interrupted','failed'];
  const passive = ['idle','notLoaded','systemError','ended'];
  const flags = ['waitingOnApproval','waitingOnUserInput'];
  const decode = raw => {
    if (!object(raw) || raw.isError === true) return null;
    if (object(raw.structuredContent)) return raw.structuredContent;
    if (!Array.isArray(raw.content)) return null;
    const texts = raw.content.filter(b => b?.type === 'text');
    if (texts.length !== 1 || typeof texts[0].text !== 'string'
        || texts[0].text.length > 2000000) return null;
    return JSON.parse(texts[0].text);
  };
  let target = null;
  let before = null, after = null, navigation = 'not_attempted';
  const result = (state, reason) => ({state,reason,target,navigation,before,after});
  if (!keys(request,['target','dispatchAuthorized','verifiedLocalHostId'])
      || !keys(request.target,['hostId','threadId'])
      || !id(request.target.hostId) || !id(request.target.threadId)
      || typeof request.dispatchAuthorized !== 'boolean'
      || (request.verifiedLocalHostId !== null && !id(request.verifiedLocalHostId)))
    return result('hold','invalid_input');
  target = {hostId:request.target.hostId,threadId:request.target.threadId};
  if (!request.dispatchAuthorized) return result('hold','dispatch_not_authorized');

  const snapshot = async () => {
    let raw;
    try { raw = await tools.mcp__codex_app__wait_threads({targets:[target],timeoutMs:0}); }
    catch { return {error:'poll_exception'}; }
    let value;
    try { value = decode(raw); } catch { return {error:'poll_parse_error'}; }
    if (!object(value) || typeof value.timedOut !== 'boolean'
        || !Object.hasOwn(value,'wake') || !Array.isArray(value.polls))
      return {error:'invalid_poll_envelope'};
    if (Object.hasOwn(value,'errors') && (!Array.isArray(value.errors) || value.errors.length))
      return {error:'native_poll_error'};
    if (value.polls.length !== 1) return {error:'non_unique_poll'};
    const poll = value.polls[0];
    if (poll?.thread?.hostId !== target.hostId || poll?.thread?.id !== target.threadId)
      return {error:'identity_mismatch'};
    const status = poll.thread.status;
    if (poll.schemaVersion !== 1 || !object(status)
        || !Number.isSafeInteger(poll.revision) || poll.revision < 0
        || typeof poll.changed !== 'boolean'
        || typeof poll.cursor !== 'string' || !poll.cursor.trim() || poll.cursor.length > 2048)
      return {error:'invalid_poll_metadata'};
    const threadStatus = status.type;
    if (threadStatus === 'active' ? !(Array.isArray(status.activeFlags)
        && status.activeFlags.length <= flags.length
        && new Set(status.activeFlags).size === status.activeFlags.length
        && status.activeFlags.every(f => flags.includes(f)))
      : !passive.includes(threadStatus) || Object.hasOwn(status,'activeFlags'))
      return {error:'invalid_thread_status'};
    const latest = poll.latestTurn;
    let turn = null;
    if (latest !== null) {
      if (!object(latest) || !id(latest.id) || ![...terminal,'inProgress'].includes(latest.status)
          || !(latest.error === null || object(latest.error))
          || (latest.status === 'completed' && latest.error !== null))
        return {error:'invalid_turn_metadata'};
      turn = {id:latest.id,status:latest.status,error:latest.error === null ? 'none' : 'present_unknown'};
    }
    // The native wake corroborates the poll, not business success.
    const w = value.wake;
    if (w !== null) {
      const exact = object(w) && value.timedOut === false
        && w.hostId === target.hostId && w.threadId === target.threadId;
      const terminalWake = exact && keys(w,['reason','hostId','threadId','turnId'])
        && w.reason === 'turnCompleted' && threadStatus === 'idle'
        && turn && terminal.includes(turn.status) && w.turnId === turn.id;
      const inactiveWake = exact && keys(w,['reason','hostId','threadId'])
        && w.reason === 'inactiveStatus' && threadStatus === 'notLoaded'
        && turn?.status === 'completed' && turn.error === 'none';
      if (!terminalWake && !inactiveWake) return {error:'contradictory_wake'};
    }
    return {metadata:{threadStatus,turn,revision:poll.revision}};
  };

  const initial = await snapshot();
  if (initial.error) return result('hold',initial.error);
  before = initial.metadata;
  if (['idle','notLoaded'].includes(before.threadStatus) && before.turn?.status === 'inProgress')
    return result('hold','unfinished_turn');
  if (before.threadStatus === 'idle') return result('ready','already_idle');
  if (before.threadStatus !== 'notLoaded') return result('hold',before.threadStatus);
  // Navigation routes only by threadId. Never use it for a remote/unknown host,
  // even if that host's exact wait poll could be read successfully.
  if (target.hostId !== 'local' || request.verifiedLocalHostId !== target.hostId)
    return result('unsupported','same_local_host_not_verified');
  if (typeof tools.mcp__codex_app__navigate_to_codex_page !== 'function')
    return result('unsupported','navigation_unavailable');

  navigation = 'attempted';
  try {
    const nav = decode(await tools.mcp__codex_app__navigate_to_codex_page({threadId:target.threadId}));
    if (nav?.navigated !== true) return result('hold','navigation_not_acknowledged');
    if ((Object.hasOwn(nav,'threadId') && nav.threadId !== target.threadId)
        || (Object.hasOwn(nav,'hostId') && nav.hostId !== target.hostId))
      return result('hold','navigation_identity_mismatch');
    navigation = 'acknowledged';
  } catch { return result('hold','navigation_exception'); }

  const checked = await snapshot();
  if (checked.error) return result('hold',checked.error);
  after = checked.metadata;
  if (after.threadStatus !== 'idle') return result('hold',after.threadStatus);
  if (after.turn?.status === 'inProgress') return result('hold','unfinished_turn');
  if (after.revision < before.revision) return result('hold','revision_regressed');
  if (JSON.stringify(after.turn) !== JSON.stringify(before.turn))
    return result('hold','latest_turn_changed');
  return result('ready','idle_after_navigation');
}

text(await prepareThread(request));
