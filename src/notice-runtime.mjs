import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWrite, readRawState } from './store.mjs';
import { withStateGuard } from './registry-projection.mjs';
import { submissionContext, makeNotice, prepareSubmissionNotice } from './submission-notice.mjs';
import { validateResult, validateLedger, loadLedger, checkNotice, requireReady, decision, lastResult, timestamp } from './submission-recovery.mjs';

export const MAX_BYTES = 1024 * 1024;
const reasons = ['onboarding','resume','post_compaction','before_dispatch','before_delivery','before_review','identity_conflict','manual','unknown'];
const common = ['actor_host_id','actor_thread_id','team_id','task_id','submission_id','reason'];
const additions = { prepare:['operation_id','baseline'], result:['operation_id','attempt_id','result'], status:['prepare_operation_id','attempt_id','include_content'] };
const required = { prepare:['operation_id'], result:['operation_id','attempt_id','result'], status:[] };
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function demand(ok, code, message) { if (!ok) fail(code, message); }
const hash = s => createHash('sha256').update(s, 'utf8').digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function unicode(value) {
  if (typeof value === 'string') demand(value.isWellFormed(), 'INVALID_REQUEST', 'Invalid Unicode string');
  else if (typeof value === 'number') demand(Number.isFinite(value), 'INVALID_REQUEST', 'Invalid numeric value');
  else if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) { unicode(k); unicode(v); }
}
export function bounded(value, mcp = true) {
  unicode(value);
  const encoded = JSON.stringify(value);
  const wire = mcp ? JSON.stringify({content:[{type:'text',text:encoded}],isError:false}) : encoded;
  demand(Buffer.byteLength(wire,'utf8') + (mcp ? 256 : 0) <= MAX_BYTES, 'PAYLOAD_TOO_LARGE','E03 payload exceeds 1 MiB including wrapping');
  return value;
}
export function validateRequest(r) {
  demand(r && typeof r === 'object' && !Array.isArray(r) && Object.hasOwn(additions,r.action),'INVALID_REQUEST','Unknown notice action');
  const fields = [...common,'action',...additions[r.action]];
  demand(Object.keys(r).every(k => fields.includes(k)) && [...common,...required[r.action]].every(k => Object.hasOwn(r,k)), 'INVALID_REQUEST','Notice fields do not match action schema');
  for (const key of [...common,'attempt_id']) if (Object.hasOwn(r,key)) demand(typeof r[key] === 'string' && r[key].trim().length > 0 && r[key].length <= 256,'INVALID_REQUEST',`Invalid ${key}`);
  for (const key of ['operation_id','prepare_operation_id']) if (Object.hasOwn(r,key)) demand(typeof r[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r[key]),'INVALID_REQUEST',`Invalid ${key}`);
  demand(reasons.includes(r.reason),'INVALID_REQUEST','Unknown reason');
  if ('include_content' in r) demand(typeof r.include_content === 'boolean','INVALID_REQUEST','include_content must be boolean');
  if ('baseline' in r) { validateResult(r.baseline,true); demand(r.baseline.outcome === 'not-attempted' && r.baseline.evidence.kind === 'observation','INVALID_REQUEST','Baseline must be a verified not-attempted observation'); }
  if ('result' in r) validateResult(r.result);
  bounded(r, false);
  return r;
}
function operationMap(ledger) {
  const extension = ledger.e03 ?? { schemaVersion:1, operations:[] };
  demand(extension.schemaVersion === 1 && Array.isArray(extension.operations),'STORAGE_CORRUPT','Invalid E03 extension');
  const ids = new Set();
  for (const op of extension.operations) {
    demand(op && /^[A-Za-z0-9_-]{1,128}$/.test(op.id) && !ids.has(op.id) && ['prepare','result'].includes(op.action),'STORAGE_CORRUPT','Invalid operation identity');
    ids.add(op.id);
    demand(typeof op.input === 'string' && hash(op.input) === op.fingerprint,'STORAGE_CORRUPT','Invalid operation fingerprint');
    let request; try { request = validateRequest(JSON.parse(op.input)); } catch { fail('STORAGE_CORRUPT','Invalid stored operation request'); }
    demand(canonical(request) === op.input && request.team_id === ledger.teamId && request.operation_id === op.id && request.action === op.action,'STORAGE_CORRUPT','Invalid operation scope');
    const entry = ledger.entries.find(e => e.notice.notificationId === op.notificationId);
    const attempt = entry?.attempts.find(a => a.id === op.attemptId);
    demand(entry && attempt && entry.notice.taskId === request.task_id && entry.notice.submissionId === request.submission_id,'STORAGE_CORRUPT','Broken operation mapping');
    demand(Number.isSafeInteger(op.ledgerVersion) && op.ledgerVersion > 0 && op.ledgerVersion <= ledger.version && Number.isSafeInteger(op.sourceVersion),'STORAGE_CORRUPT','Invalid recorded version');
    if (op.action === 'result') {
      demand(request.attempt_id === attempt.id && Number.isSafeInteger(op.observationIndex) && op.observationIndex >= 0 && isDeepStrictEqual(attempt.observations[op.observationIndex]?.result,request.result),'STORAGE_CORRUPT','Broken result mapping');
      const response = op.response;
      demand(typeof response?.runtimeRevision === 'string' && response.runtimeRevision.length <= 512,'STORAGE_CORRUPT','Invalid recorded runtime revision');
      const expected = {teamId:ledger.teamId,taskId:request.task_id,submissionId:request.submission_id,
        notificationId:entry.notice.notificationId,sourceVersion:op.sourceVersion,ledgerVersion:op.ledgerVersion,
        runtimeRevision:response.runtimeRevision,contentSha256:hash(entry.notice.summary),readOnly:false,
        hostActionExecuted:false,identityAssurance:'caller-declared',evidenceAssurance:'caller-assessed',
        status:'recorded',reasonCode:'RESULT_RECORDED',operationId:op.id,attemptId:attempt.id,
        result:request.result,replayed:false};
      demand(isDeepStrictEqual(response,expected),'STORAGE_CORRUPT','Invalid recorded result response');
    }
  }
  return extension;
}
const reasonCodes = { untracked:'HISTORY_REQUIRED', unknown:'DELIVERY_UNKNOWN', accepted:'ACCEPTED', 'policy-denied':'POLICY_DENIED', 'attempt-limit':'ATTEMPT_LIMIT', cooldown:'COOLDOWN', 'already-reviewing':'ALREADY_REVIEWING', 'already-approved':'ALREADY_APPROVED', superseded:'SUBMISSION_CHANGED', 'round-closed':'ROUND_CLOSED', fixture:'FIXTURE', rework:'REWORK', blocked:'BLOCKED' };
function planned(plan) {
  return { status:plan.action === 'send' ? 'reconcile' : plan.action === 'stop' ? (plan.reason === 'accepted' ? 'already_accepted' : 'stopped') : plan.action,
    reasonCode:reasonCodes[plan.reason] ?? 'PREPARE_REQUIRED', ...(plan.retryAt ? {retryAt:plan.retryAt} : {}), nextAction:plan.action === 'send' ? 'prepare' : plan.action === 'reconcile' ? 'reconcile-evidence' : 'inspect-status' };
}
function errorCode(error) {
  if (error.code === 'EEXIST') return 'BUSY';
  if (['EACCES','EPERM','EIO','ENOSPC','EROFS'].includes(error.code)) return 'STORAGE_ERROR';
  if (error.code === 'ENOENT') return 'RUNTIME_UNAVAILABLE';
  if (error.code && !/^E[A-Z]+$/.test(error.code)) return error.code;
  if (/identity|caller|assigned Worker|Manager|revoked|historical|bound member/i.test(error.message)) return 'IDENTITY_CONFLICT';
  if (/not Registry ready/.test(error.message)) return 'TEAM_NOT_CONNECTED';
  if (/ledger|JSON|Unexpected token/i.test(error.message)) return 'STORAGE_CORRUPT';
  if (/exporter|Python|required.*path/i.test(error.message)) return 'RUNTIME_UNAVAILABLE';
  return 'INVALID_REQUEST';
}

// statePath/registryPath/options are trusted adapter inputs, never MCP arguments.
export async function noticeRuntime({ statePath, registryPath, request, runtimeRevision='unversioned', options={} }) {
  let mutationUnknown = false;
  try {
    const r = validateRequest(request);
    const path = await realpath(statePath), ledgerPath = path+'.submission-notices.json';
    const caller = {hostId:r.actor_host_id,threadId:r.actor_thread_id};
    const checkDeadline = () => demand(!options.deadline || performance.now() < options.deadline,'BRIDGE_TIMEOUT','Notice execution deadline reached');
    checkDeadline();
    return await withStateGuard(path,ledgerPath,readRawState,async state => {
      checkDeadline();
      demand(state.schemaVersion === 2 && state.registry.phase === 'active','TEAM_NOT_CONNECTED','E03 requires linked active state');
      demand(resolve(state.registry.registryPath) === resolve(registryPath) && state.team.id === r.team_id,'IDENTITY_CONFLICT','Trusted Registry/team binding mismatch');
      const ctx = submissionContext(state,r.task_id);
      const sub = ctx.submissions.find(s => s.event.id === r.submission_id);
      demand(sub,'SUBMISSION_CHANGED','Specified durable submission not found');
      const notice = makeNotice(state,ctx,sub);
      unicode(notice);
      const review = checkNotice(state,caller,notice,r.action === 'prepare');
      requireReady(state,notice);
      const ledger = await loadLedger(ledgerPath,path,state.team.id);
      const extension = operationMap(ledger);
      let entry = ledger.entries.find(e => e.notice.notificationId === notice.notificationId);
      if (entry) demand(isDeepStrictEqual(entry.notice,notice),'STORAGE_CORRUPT','Stored notice differs');
      const at = options.at ?? new Date().toISOString(); timestamp(at);
      const base = {teamId:r.team_id,taskId:r.task_id,submissionId:r.submission_id,notificationId:notice.notificationId,sourceVersion:state.version,ledgerVersion:ledger.version,runtimeRevision,contentSha256:hash(notice.summary),readOnly:true,hostActionExecuted:false,identityAssurance:'caller-declared',evidenceAssurance:'caller-assessed'};
      const snapshot = () => ({...base,...planned(decision(state,ledger,entry,review,at))});
      const queryAttempt = attempt => {
        const prepare = extension.operations.find(o => o.action === 'prepare' && o.attemptId === attempt.id);
        return {attemptId:attempt.id,...(prepare ? {prepareOperationId:prepare.id} : {operationMappingAvailable:false}),notificationOutcome:lastResult(attempt),observationCount:attempt.observations.length,claimedAt:attempt.claimedAt,evidenceRefs:attempt.observations.map(o => o.result.evidence.ref)};
      };
      if (r.action === 'status') {
        let attempt;
        if (r.prepare_operation_id) {
          const op = extension.operations.find(o => o.id === r.prepare_operation_id);
          if (!op) return bounded({...base,status:'reconcile',reasonCode:'OPERATION_NOT_FOUND',nextAction:'verify-execution-ended'});
          demand(op.action === 'prepare' && op.notificationId === notice.notificationId,'INVALID_REQUEST','Operation selector scope mismatch');
          attempt = entry?.attempts.find(a => a.id === op.attemptId);
        }
        if (r.attempt_id) {
          const selected = entry?.attempts.find(a => a.id === r.attempt_id);
          if (!selected) return bounded({...base,status:'reconcile',reasonCode:'ATTEMPT_NOT_FOUND'});
          demand(!attempt || attempt.id === selected.id,'INVALID_REQUEST','Selectors disagree'); attempt = selected;
        }
        let result = snapshot();
        if (attempt) result = {...result,...queryAttempt(attempt)};
        else { const latest = entry?.attempts.at(-1); result = {...result,hasAttempts:!!latest,...(latest ? {latestAttemptId:latest.id,latestOutcome:lastResult(latest),claimedAt:latest.claimedAt,correlationVerified:false} : {})}; }
        if (r.include_content) result.notice = notice;
        return bounded(result);
      }
      const input = canonical(r), fingerprint = hash(input);
      const previous = extension.operations.find(o => o.id === r.operation_id);
      if (previous) {
        demand(previous.fingerprint === fingerprint && previous.input === input,'OPERATION_CONFLICT','Operation ID reused with different input');
        if (r.action === 'result') return bounded({...base,...previous.response,readOnly:true,replayed:true});
        return bounded({...snapshot(),operationId:previous.id,...queryAttempt(entry.attempts.find(a => a.id === previous.attemptId)),replayed:true});
      }
      if (r.action === 'prepare') {
        demand(sub === ctx.submissions.at(-1),'SUBMISSION_CHANGED','Specified submission is no longer current');
        if (!entry && !r.baseline) return bounded({...base,status:'reconcile',reasonCode:'HISTORY_REQUIRED',requiredInput:{baseline:{outcome:'not-attempted',evidence:{kind:'observation',ref:'verified context reference',detail:'verified no native send'}}},nextAction:'verify-baseline'});
        if (review.action !== 'review') return bounded(snapshot());
        const prepared = prepareSubmissionNotice(state,caller,r.task_id);
        demand(prepared.notice.submissionId === r.submission_id,'SUBMISSION_CHANGED','Submission changed');
        if (!entry) {
          demand(timestamp(at) >= timestamp(notice.submittedAt),'INVALID_REQUEST','Notice time precedes submission');
          entry = {notice,hostRequest:prepared.hostRequest,trackedAt:at,baseline:structuredClone(r.baseline),attempts:[]};
          ledger.entries.push(entry); ledger.version++;
        }
        const plan = decision(state,ledger,entry,review,at);
        if (plan.action !== 'send') return bounded({...base,...planned(plan)});
        demand(isDeepStrictEqual(entry.hostRequest,prepared.hostRequest),'WRAPPER_INCOMPATIBLE','Stored host request changed; reconcile without sending');
        const attempt = {id:randomUUID(),claimedAt:at,observations:[]};
        entry.attempts.push(attempt); ledger.version++;
        const response = bounded({...base,status:'ready_to_send',reasonCode:'PREPARED',operationId:r.operation_id,attemptId:attempt.id,ledgerVersion:ledger.version,readOnly:false,sendNow:true,hostRequest:entry.hostRequest});
        extension.operations.push({id:r.operation_id,action:r.action,input,fingerprint,notificationId:notice.notificationId,attemptId:attempt.id,sourceVersion:state.version,ledgerVersion:ledger.version});
        ledger.e03 = extension; validateLedger(ledger,path,state.team.id); operationMap(ledger);
        checkDeadline(); mutationUnknown = true; await (options.writeLedger ?? atomicWrite)(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
        return response;
      }
      demand(entry,'ATTEMPT_NOT_FOUND','No notification record');
      const attempt = entry.attempts.find(a => a.id === r.attempt_id);
      demand(attempt,'ATTEMPT_NOT_FOUND','Unknown attempt');
      if (lastResult(attempt) !== 'unknown') {
        demand(isDeepStrictEqual(attempt.observations.at(-1).result,r.result),'RESULT_CONFLICT','Terminal result cannot be rewritten');
        return bounded({...base,status:'recorded',reasonCode:'RESULT_RECORDED',attemptId:attempt.id,result:attempt.observations.at(-1).result,alreadyRecorded:true,operationRecorded:false});
      }
      demand(attempt === entry.attempts.at(-1),'RESULT_CONFLICT','Only latest unresolved attempt may be reconciled');
      demand(timestamp(at) >= timestamp(attempt.observations.at(-1)?.at ?? attempt.claimedAt),'INVALID_REQUEST','Notice time moved backwards');
      attempt.observations.push({at,caller,result:structuredClone(r.result)}); ledger.version++;
      const response = bounded({...base,status:'recorded',reasonCode:'RESULT_RECORDED',operationId:r.operation_id,attemptId:attempt.id,result:r.result,ledgerVersion:ledger.version,readOnly:false,replayed:false});
      extension.operations.push({id:r.operation_id,action:r.action,input,fingerprint,notificationId:notice.notificationId,attemptId:attempt.id,sourceVersion:state.version,ledgerVersion:ledger.version,observationIndex:attempt.observations.length-1,response});
      ledger.e03 = extension; validateLedger(ledger,path,state.team.id); operationMap(ledger);
      checkDeadline(); mutationUnknown = true; await (options.writeLedger ?? atomicWrite)(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
      return response;
    },options);
  } catch(error) {
    return {status:'error',reasonCode:errorCode(error),message:String(error.message).slice(0,1000),readOnly:!mutationUnknown,mutationUnknown,hostActionExecuted:false,nextAction:mutationUnknown ? 'notice_status' : 'inspect-error'};
  }
}
