import {open,realpath,stat} from 'node:fs/promises';
import {basename,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {loadObject} from './dispatch-objects.mjs';
import {isDispatch} from './dispatch-contract.mjs';
import {deliveryState} from './delivery-state.mjs';
import {classifyWatchdogNativeUser} from './watchdog-native-user.mjs';

const version = '0.169.1';
const anchorBytes = 64 * 1024;
const prefixLimit = 8 * 1024 * 1024;
const checkedPrefixes = new Map();
const appendLimit = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const decode = bytes => new TextDecoder('utf-8', {fatal:true}).decode(bytes);
const millis = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value ? Date.parse(value) : NaN;
const identity = info => [info.dev, info.ino].join(':');
const signature = info => [identity(info), info.size, info.mtimeNs, info.ctimeNs].join(':');
const claimPath = (path, attempt) => path+'.dispatch-send-'+hash(JSON.stringify(attempt))+'.json';
const bound = (member, role) => member?.role === role && member.lifecycle === 'active'
  && member.binding.status === 'bound' && member.binding.hostId === 'local' && id(member.binding.threadId);

async function readAt(handle, size, offset) {
  const bytes = Buffer.alloc(size);
  for (let done=0; done<size;) {
    const result = await handle.read(bytes, done, size-done, offset+done);
    if (!result.bytesRead) throw new Error('Incomplete native evidence');
    done += result.bytesRead;
  }
  return bytes;
}

async function stableFile(path, read) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('Untrusted evidence path');
  const handle = await open(path,'r');
  try {
    const info = await handle.stat({bigint:true});
    if (!info.isFile() || info.ino === 0n || !Number.isSafeInteger(Number(info.size))) throw new Error('Unsupported file identity');
    const result = await read(handle, info);
    if (signature(info) !== signature(await handle.stat({bigint:true})) ||
        signature(info) !== signature(await stat(path,{bigint:true}))) throw new Error('Evidence changed during read');
    return result;
  } finally { await handle.close(); }
}

const jsonFile = path => stableFile(path, async (handle, info) => {
  if (info.size > 65536n) throw new Error('Evidence document too large');
  return JSON.parse(decode(await readAt(handle, Number(info.size), 0)));
});

async function registration(path,state) {
  // Explicit local operator registration, never populated from a task request.
  const row = await jsonFile(path+'.watchdog-execution-logs.json');
  if (!exact(row,['schemaVersion','kind','statePath','teamId','managerThreadId','workers'])
      || row.schemaVersion !== 1 || row.kind !== 'desktop-worker-rollouts'
      || row.statePath !== path || row.teamId !== state.team.id || !id(row.managerThreadId)
      || !Array.isArray(row.workers) || row.workers.length > 100) return null;
  const seen = new Set();
  for (const worker of row.workers) {
    if (!exact(worker,['workerId','threadId','path']) || !id(worker.workerId) || !id(worker.threadId)
        || seen.has(worker.workerId) || typeof worker.path !== 'string' || !isAbsolute(worker.path)
        || !basename(worker.path).endsWith('-'+worker.threadId+'.jsonl')) return null;
    seen.add(worker.workerId);
  }
  return row;
}

async function scope(path,state,task,executionId,attemptId) {
  if (state.schemaVersion !== 2 || state.registry.phase !== 'active'
      || state.team.source.kind === 'fixture' || state.events.some(event=>event.source.kind==='fixture')) return null;
  const round = state.rounds.find(row=>row.id===task.roundId && row.status==='open');
  const manager = state.members.find(row=>row.role==='Manager');
  const worker = state.members.find(row=>row.id===task.workerId);
  if (!round || !bound(manager,'Manager') || !bound(worker,'Worker')) return null;
  for (const member of [manager,worker]) {
    const historic = round.members.find(row=>row.id===member.id);
    if (!bound(historic,member.role) || !isDeepStrictEqual(member.binding,historic.binding)
        || !state.registry.readyMemberIds.includes(member.id)) return null;
  }
  const delivery = deliveryState(state,task);
  if (delivery.attemptId !== attemptId || !['unknown','delivered'].includes(delivery.status)) return null;
  if (state.events.some(event=>event.type==='dispatchConflict' && event.taskId===task.id)) return null;
  const event = state.events.find(row=>row.id===attemptId && row.id===executionId &&
    row.taskId===task.id && row.roundId===round.id && row.type==='startTask' && isDispatch(row));
  if (!event || state.events.findLast(row=>row.taskId===task.id && row.roundId===round.id &&
      ['assign','startTask','rework'].includes(row.type))?.id !== executionId) return null;
  const op = await loadObject(path,event.source.ref);
  const req = op.request;
  if (op.attemptId !== attemptId || req.action !== 'prepare' || req.team_id !== state.team.id
      || req.task_id !== task.id || req.round_id !== round.id || req.worker_id !== worker.id
      || req.actor_host_id !== 'local' || req.actor_thread_id !== manager.binding.threadId
      || req.admission?.native?.host_id !== 'local' || req.admission?.native?.thread_id !== worker.binding.threadId) return null;
  const brief = await loadObject(path,op.briefRef);
  if (brief.teamId !== state.team.id || brief.roundId !== round.id || brief.taskId !== task.id
      || brief.actor?.hostId !== 'local' || brief.actor?.threadId !== manager.binding.threadId) return null;
  const prompt = `[codex-team-runtime E04/v1]\nTeam: ${state.team.id}\nRound: ${round.id}\nTask: ${task.id}\nAttempt: ${attemptId}\n\n${brief.text}`;
  const bindingHash = hash(JSON.stringify([state.registry.registryId,manager.binding,worker.binding,event.source.ref,op.briefRef]));
  return {manager,worker,event,prompt,bindingHash};
}

async function header(handle,size,threadId) {
  const bytes = await readAt(handle,Math.min(size,anchorBytes),0);
  const end = bytes.indexOf(10);
  if (end < 0) throw new Error('Incomplete Desktop header');
  const line = bytes.subarray(0,end+1);
  const meta = JSON.parse(decode(line));
  if (meta.type !== 'session_meta' || meta.payload?.id !== threadId || meta.payload.cli_version !== version
      || meta.payload.source !== 'vscode') throw new Error('Unsupported Desktop rollout');
  return hash(line);
}

async function boundary(handle, size) {
  const length = Math.min(size,anchorBytes);
  const bytes = await readAt(handle,length,size-length);
  if (bytes.at(-1) !== 10) throw new Error('Partial Desktop log line');
  const lines = bytes.subarray(0,bytes.length-1);
  const last = JSON.parse(decode(lines.subarray(lines.lastIndexOf(10)+1)));
  if (!Number.isSafeInteger(last.ordinal) || last.ordinal < 0) throw new Error('Unsupported native ordinal');
  return {anchorHash:hash(bytes),ordinal:last.ordinal};
}

export async function captureDispatchExecutionBoundary(path,state,prepared) {
  try {
    const attemptId = prepared.resultRequestBase.attempt_id;
    const task = state.tasks.find(row=>row.id===prepared.resultRequestBase.task_id);
    const ctx = task && await scope(path,state,task,attemptId,attemptId);
    if (!ctx) return null;
    const target = prepared.hostRequest.arguments;
    if (target.hostId !== 'local' || target.threadId !== ctx.worker.binding.threadId || target.prompt !== ctx.prompt) return null;
    const row = await registration(path,state);
    const worker = row?.workers.find(entry=>entry.workerId===task.workerId);
    if (row?.managerThreadId !== ctx.manager.binding.threadId || worker?.threadId !== target.threadId) return null;
    return await stableFile(worker.path,async (handle,info)=>{
      const size=Number(info.size);
      if (!size || size>prefixLimit) return null;
      const capturedAt=new Date().toISOString();
      if (millis(capturedAt)<millis(ctx.event.at) || millis(capturedAt)-millis(ctx.event.at)>180000) return null;
      return {schemaVersion:1,kind:'desktop-e04-boundary',logPath:worker.path,hostVersion:version,
        bindingHash:ctx.bindingHash,promptHash:hash(ctx.prompt),capturedAt,size,fileIdentity:identity(info),
        headerHash:await header(handle,size,worker.threadId),prefixHash:hash(await readAt(handle,size,0)),...await boundary(handle,size)};
    });
  } catch { return null; }
}

const callOutput = row => (row?.type==='function_call_output' || row?.type==='FunctionCallOutput')
  && row.name==='send_message_to_thread' && row.namespace==='codex_app';

// Only an identical native delegation payload counts. No XML normalization,
// substring/nonce search, timestamp-based selection or use of assistant text.
export function correlateDesktopExecutionAppend(bytes,{managerThreadId,threadId,prompt,ordinal,capturedAt,at}) {
  if (!bytes.length || bytes.length>appendLimit || bytes.at(-1)!==10) return null;
  const expected = `<codex_delegation>\n  <source_thread_id>${managerThreadId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
  const rows = decode(bytes).slice(0,-1).split('\n').map(line=>JSON.parse(line));
  let previous=ordinal;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal!==previous+1 || !row.payload
        || row.type==='session_meta' || !Number.isFinite(millis(row.timestamp)) || millis(row.timestamp)>millis(at)) return null;
    previous=row.ordinal;
  }
  const exactResponses = rows.filter(row=>row.type==='response_item' && callOutput(row.payload) && row.payload.output===expected);
  const exactItems = rows.filter(row=>row.type==='event_msg' && row.payload.type==='item_completed'
    && callOutput(row.payload.item) && row.payload.item.output===expected);
  if (exactResponses.length!==1 || exactItems.length!==1) return null;
  const [response]=exactResponses,[item]=exactItems;
  const turnId=response.payload.internal_chat_message_metadata_passthrough?.turn_id, envelopeId=response.payload.id;
  if (!id(turnId) || !id(envelopeId) || response.metadata?.client_authored!==false
      || item.payload.thread_id!==threadId || item.payload.turn_id!==turnId || item.payload.item.id!==envelopeId
      || item.ordinal<=response.ordinal) return null;
  const events=rows.filter(row=>row.type==='event_msg' && row.payload.turn_id===turnId);
  const starts=events.filter(row=>row.payload.type==='task_started');
  const ends=events.filter(row=>['task_complete','turn_aborted','task_interrupted','task_aborted'].includes(row.payload.type));
  if (starts.length!==1 || ends.length!==1 || ends[0].payload.type!=='task_complete') return null;
  const [start]=starts,[end]=ends;
  if (start.payload.turn_attribution?.turn_id!==turnId || start.payload.turn_attribution.turn_trigger!=='app_tool_send_message'
      || start.ordinal>=response.ordinal || end.ordinal<=item.ordinal || millis(start.timestamp)<millis(capturedAt)
      || millis(start.timestamp)>millis(response.timestamp) || millis(response.timestamp)>millis(item.timestamp)
      || millis(item.timestamp)>millis(end.timestamp) || !Number.isSafeInteger(start.payload.started_at)
      || start.payload.started_at!==end.payload.started_at || !Number.isSafeInteger(end.payload.completed_at)
      || end.payload.completed_at<start.payload.started_at
      || Math.abs(millis(start.timestamp)-start.payload.started_at*1000)>=1000
      || Math.abs(millis(end.timestamp)-end.payload.completed_at*1000)>=1000) return null;
  // Distinct item representations count once. Additional delegations, user
  // messages or unattributed input in the candidate segment make it ambiguous.
  let environments=0;
  for (const row of rows) {
    const p=row.payload;
    if (row!==response && row.type==='response_item' && callOutput(p)
        && (!p.internal_chat_message_metadata_passthrough?.turn_id || p.internal_chat_message_metadata_passthrough.turn_id===turnId || p.id===envelopeId)) return null;
    if (row!==item && row.type==='event_msg' && p.type==='item_completed' && callOutput(p.item)
        && (!p.turn_id || p.turn_id===turnId || p.item.id===envelopeId)) return null;
    if (row.type==='response_item' && p.type==='message' && p.role==='user') {
      const user=classifyWatchdogNativeUser(p);
      if (!user.turnId || user.turnId===turnId && (user.kind!=='known-environment' || ++environments>1)) return null;
    }
  }
  return {turnId,envelopeId,startedAt:start.timestamp,completedAt:end.timestamp};
}

export async function readDispatchExecutionEnd(path,state,task,executionId,at) {
  try {
    const row=await registration(path,state);
    if (!row) return null;
    const ctx=await scope(path,state,task,executionId,executionId);
    if (!ctx) return null;
    const worker=row?.workers.find(entry=>entry.workerId===task.workerId);
    if (row?.managerThreadId!==ctx.manager.binding.threadId || worker?.threadId!==ctx.worker.binding.threadId) return null;
    const claim=await jsonFile(claimPath(path,executionId)), seal=claim.executionBoundary;
    if (claim.attemptId!==executionId || !hex(claim.inputFingerprint) || !exact(seal,
      ['schemaVersion','kind','logPath','hostVersion','bindingHash','promptHash','capturedAt','size','fileIdentity','headerHash','prefixHash','anchorHash','ordinal'])
        || seal.schemaVersion!==1 || seal.kind!=='desktop-e04-boundary' || seal.logPath!==worker.path || seal.hostVersion!==version
        || seal.bindingHash!==ctx.bindingHash || seal.promptHash!==hash(ctx.prompt) || !Number.isSafeInteger(seal.size)
        || seal.size<=0 || seal.size>prefixLimit || !hex(seal.prefixHash) || !Number.isSafeInteger(seal.ordinal) || !Number.isFinite(millis(seal.capturedAt))
        || millis(seal.capturedAt)<millis(ctx.event.at) || millis(seal.capturedAt)>millis(at)
        || millis(at)-millis(seal.capturedAt)>7*86400000) return null;
    return await stableFile(worker.path,async (handle,info)=>{
      const size=Number(info.size), delta=size-seal.size;
      if (identity(info)!==seal.fileIdentity || delta<=0 || delta>appendLimit
          || await header(handle,size,worker.threadId)!==seal.headerHash) return null;
      const memoKey=JSON.stringify([worker.path,seal.fileIdentity,seal.size,seal.prefixHash]);
      const fileSignature=signature(info);
      if (checkedPrefixes.get(memoKey)!==fileSignature) {
        if (hash(await readAt(handle,seal.size,0))!==seal.prefixHash) return null;
        if (checkedPrefixes.size>=128) checkedPrefixes.delete(checkedPrefixes.keys().next().value);
        checkedPrefixes.set(memoKey,fileSignature);
      }
      const prior=await boundary(handle,seal.size);
      if (prior.anchorHash!==seal.anchorHash || prior.ordinal!==seal.ordinal) return null;
      const evidence=correlateDesktopExecutionAppend(await readAt(handle,delta,seal.size),{
        managerThreadId:row.managerThreadId,threadId:worker.threadId,prompt:ctx.prompt,
        ordinal:seal.ordinal,capturedAt:seal.capturedAt,at
      });
      return evidence && {...evidence,ref:'desktop-envelope:'+evidence.envelopeId};
    });
  } catch { return null; }
}
