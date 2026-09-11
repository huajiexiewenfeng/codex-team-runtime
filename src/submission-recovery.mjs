import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, readRawState } from './store.mjs';
import { withStateGuard } from './registry-projection.mjs';
import { validateCaller } from './runtime.mjs';
import { prepareSubmissionNotice, planSubmissionReview } from './submission-notice.mjs';
export { pendingSubmissions } from './submission-notice.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const baselineOutcomes = ['not-attempted', 'unknown', 'accepted', 'policy-denied'];
const resultOutcomes = ['unknown', 'accepted', 'policy-denied', 'transient-not-delivered'];
const cooldown = count => count === 1 ? 5000 : 15000;
function timestamp(value) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value, 'Invalid canonical UTC time');
  return Date.parse(value);
}
function validateResult(value, baseline = false) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, 'evidence') &&
    (baseline ? baselineOutcomes : resultOutcomes).includes(value.outcome), 'Invalid notice result');
  const e = value.evidence;
  check(e && text(e.ref) && text(e.detail) && ['host-result', 'observation', 'terminal-nonreceipt'].includes(e.kind), 'Notice evidence required');
  if (value.outcome === 'transient-not-delivered') {
    check(e.kind === 'terminal-nonreceipt' && e.notReceived === true && e.cannotArrive === true && e.temporary === true,
      'Verified terminal nonreceipt, no late delivery and transient cause required');
  }
  if (['accepted', 'policy-denied'].includes(value.outcome)) check(e.kind === 'host-result', 'Exact host result required');
  // These fields retain an external evidence assessment, not authenticated proof or approval.
}
const lastResult = attempt => attempt.observations.at(-1)?.result.outcome ?? 'unknown';
const lastTime = attempt => attempt.observations.at(-1)?.at ?? attempt.claimedAt;

function validateLedger(ledger, statePath, teamId) {
  check(ledger?.schemaVersion === 1 && ledger.statePath === statePath && ledger.teamId === teamId &&
    integer(ledger.version) && Array.isArray(ledger.entries), 'Invalid notice ledger binding or schema');
  const ids = new Set(), attempts = new Set();
  let version = 0;
  for (const entry of ledger.entries) {
    check(text(entry.notice?.notificationId) && !ids.has(entry.notice.notificationId), 'Invalid or duplicate notification');
    ids.add(entry.notice.notificationId);
    validateResult(entry.baseline, true);
    let previousAt = timestamp(entry.trackedAt);
    check(Array.isArray(entry.attempts) && entry.attempts.length <= 3, 'Invalid notice attempts');
    check(entry.baseline.outcome === 'not-attempted' || entry.attempts.length === 0, 'Legacy notice cannot reset attempts');
    version++;
    for (let i = 0; i < entry.attempts.length; i++) {
      const attempt = entry.attempts[i];
      check(text(attempt.id) && !attempts.has(attempt.id) && Array.isArray(attempt.observations), 'Invalid notice attempt');
      attempts.add(attempt.id);
      const claimedAt = timestamp(attempt.claimedAt);
      check(claimedAt >= previousAt, 'Notice time moved backwards');
      if (i > 0) {
        check(lastResult(entry.attempts[i - 1]) === 'transient-not-delivered', 'Retry after unresolved or terminal attempt');
        check(claimedAt >= previousAt + cooldown(i), 'Retry violated cooldown');
      }
      previousAt = claimedAt;
      let outcome = 'unknown';
      version++;
      for (const observation of attempt.observations) {
        check(outcome === 'unknown', 'Terminal result cannot be rewritten');
        validateResult(observation.result);
        check(timestamp(observation.at) >= previousAt, 'Notice time moved backwards');
        previousAt = timestamp(observation.at);
        outcome = observation.result.outcome;
        version++;
      }
    }
  }
  check(ledger.version === version, 'Notice ledger audit/version mismatch');
  return ledger;
}

async function loadLedger(path, statePath, teamId) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 1, statePath, teamId, version: 0, entries: [] };
  }
  return validateLedger(JSON.parse(raw), statePath, teamId);
}

function checkNotice(state, caller, notice, workerOnly) {
  validateCaller(caller);
  check(notice && (isDeepStrictEqual(caller, notice.worker) ||
    (!workerOnly && isDeepStrictEqual(caller, notice.manager))), workerOnly ? 'Only assigned Worker may claim or track' : 'Notice owner required');
  // Reuse the durable audit, exact identity and current/historical assignment gate.
  return planSubmissionReview(state, notice.manager, notice);
}
function requireReady(state, notice) {
  if (state.schemaVersion !== 2) return;
  for (const who of [notice.worker, notice.manager]) {
    const member = state.members.find(m => m.binding.hostId === who.hostId && m.binding.threadId === who.threadId);
    check(member && state.registry.readyMemberIds.includes(member.id), 'Notice member is not Registry ready');
  }
}

function decision(state, ledger, entry, review, at) {
  const base = { sourceVersion: state.version, ledgerVersion: ledger.version,
    notificationId: review.notificationId, readOnly: true, hostActionExecuted: false,
    identityAssurance: 'caller-declared', evidenceAssurance: 'caller-assessed',
    attemptCount: entry?.attempts.length ?? 0,
    baseline: entry?.baseline ?? null, attempts: structuredClone(entry?.attempts ?? []) };
  const result = (action, reason, extra = {}) => ({ ...base, action, reason, ...extra });
  if (review.action !== 'review') return result('stop', review.reason);
  if (!entry) return result('reconcile', 'untracked');
  requireReady(state, entry.notice);
  if (entry.hostRequest === null) return result('stop', 'fixture');
  const currentTime = timestamp(at);
  check(currentTime >= timestamp(entry.trackedAt), 'Notice time moved backwards');
  const previous = entry.attempts.at(-1);
  const outcome = previous ? lastResult(previous) : entry.baseline.outcome;
  if (['accepted', 'policy-denied'].includes(outcome)) return result('stop', outcome);
  if (outcome === 'unknown') return result('reconcile', 'unknown');
  if (entry.attempts.length >= 3) return result('stop', 'attempt-limit');
  if (previous) {
    const retryAt = timestamp(lastTime(previous)) + cooldown(entry.attempts.length);
    if (currentTime < retryAt) return result('wait', 'cooldown', { retryAt: new Date(retryAt).toISOString() });
  }
  return result('send', previous ? 'confirmed-transient-nonreceipt' : 'verified-first-attempt');
}

async function access(args, mode) {
  const { caller, notice, expectedVersion, expectedLedgerVersion, options = {} } = args;
  const at = args.at ?? new Date().toISOString();
  timestamp(at);
  // One canonical sidecar per state; aliases must not create separate retry budgets.
  const statePath = await realpath(args.statePath), ledgerPath = statePath + '.submission-notices.json';
  return withStateGuard(statePath, ledgerPath, readRawState, async state => {
    const review = checkNotice(state, caller, notice, ['track', 'claim'].includes(mode));
    const ledger = await loadLedger(ledgerPath, statePath, state.team.id);
    const entry = ledger.entries.find(e => e.notice.notificationId === notice.notificationId);
    if (entry) check(isDeepStrictEqual(entry.notice, notice), 'Ledger notice mismatch');
    if (mode === 'plan') return decision(state, ledger, entry, review, at);
    check(integer(expectedVersion) && state.version === expectedVersion, 'Version conflict');
    check(integer(expectedLedgerVersion) && ledger.version === expectedLedgerVersion, 'Ledger version conflict');
    let extra = {};
    if (mode === 'track') {
      check(!entry, 'Notice already tracked');
      check(review.action === 'review', `Notice stopped: ${review.reason}`);
      validateResult(args.baseline, true);
      const prepared = prepareSubmissionNotice(state, caller, notice.taskId);
      check(timestamp(at) >= timestamp(notice.submittedAt), 'Notice time precedes submission');
      ledger.entries.push({ notice: structuredClone(notice), hostRequest: prepared.hostRequest,
        trackedAt: at, baseline: structuredClone(args.baseline), attempts: [] });
    } else if (mode === 'claim') {
      const plan = decision(state, ledger, entry, review, at);
      check(plan.action === 'send', `Notice cannot send: ${plan.reason}`);
      const prepared = prepareSubmissionNotice(state, caller, notice.taskId);
      check(isDeepStrictEqual(entry.hostRequest, prepared.hostRequest), 'Stored host request changed; reconcile without sending');
      const attempt = { id: randomUUID(), claimedAt: at, observations: [] };
      entry.attempts.push(attempt);
      // Persist before exposing one potential send. A crash consumes a slot as unknown.
      extra = { attemptId: attempt.id, hostRequest: structuredClone(entry.hostRequest), delivery: 'unknown',
        attemptCount: entry.attempts.length };
    } else {
      check(entry, 'Notice is untracked');
      const attempt = entry.attempts.find(a => a.id === args.attemptId);
      check(attempt, 'Unknown notice attempt');
      check(lastResult(attempt) === 'unknown', 'Terminal result cannot be rewritten');
      check(attempt === entry.attempts.at(-1), 'Only latest unresolved attempt can be reconciled');
      check(timestamp(at) >= timestamp(lastTime(attempt)), 'Notice time moved backwards');
      validateResult(args.result);
      attempt.observations.push({ at, caller: structuredClone(caller), result: structuredClone(args.result) });
    }
    ledger.version++;
    validateLedger(ledger, statePath, state.team.id);
    await atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
    return { sourceVersion: state.version, ledgerVersion: ledger.version, notificationId: notice.notificationId,
      ledgerPath, readOnly: false, hostActionExecuted: false, identityAssurance: 'caller-declared',
      evidenceAssurance: 'caller-assessed', ...extra };
  }, options);
}

export const trackSubmissionNotice = args => access(args, 'track');
export const planNoticeDelivery = args => access(args, 'plan');
export const claimNoticeDelivery = args => access(args, 'claim');
export const recordNoticeResult = args => access(args, 'result');
