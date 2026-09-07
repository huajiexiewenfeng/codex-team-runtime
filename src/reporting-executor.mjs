import { readState } from './store.mjs';
import { readReporting, transactReporting } from './reporting-store.mjs';
import { planReporting, evolveReporting } from './reporting.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const errorInfo = error => ({ name: error?.name ?? 'HostError', message: error?.message ?? String(error) });

// Execute one already-prepared operation. The embedding host owns permission checks,
// native API translation and truthful receipt normalization. No scheduler or retries.
export async function executeReportingOperation({
  statePath, ledgerPath, caller, operationId, expectedVersion,
  dispatchEventId, recordEventId, source, host, timeoutMs = 30000, now = () => new Date().toISOString()
}) {
  check(host && ['native', 'fixture'].includes(host.kind) && typeof host.execute === 'function', 'A native or fixture host adapter is required');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, 'Host timeout must be 1-60000 milliseconds');
  const hostKind = host.kind, executeHost = host.execute.bind(host);
  check(typeof now === 'function', 'A clock function is required');
  check(source && ['manual', 'fixture'].includes(source.kind), 'Execution trace source must be manual or fixture');
  const [state, ledger] = await Promise.all([readState(statePath), readReporting(ledgerPath)]);
  const at = now(), plan = planReporting(state, ledger, caller, at);
  check(plan.kind === 'DISPATCH' && plan.operationId === operationId, 'An exact current PREPARED operation is required; otherwise reconcile or prepare separately');
  const fixture = [state.team.source.kind, ...state.events.map(e => e.source.kind), ...ledger.events.map(e => e.source.kind), source.kind].includes('fixture');
  check(!fixture || hostKind === 'fixture', 'Fixture data requires a fixture adapter');
  check(dispatchEventId !== recordEventId, 'Dispatch and record event IDs must differ');
  const dispatch = { id: dispatchEventId, type: 'dispatch', operationId, at, source };
  const preview = evolveReporting(ledger, state, caller, dispatch, expectedVersion);
  const unknownRecord = stamp => ({
    id: recordEventId, type: 'record', operationId, at: stamp, observedAt: stamp,
    owner: structuredClone(ledger.owner), automationId: ledger.automationId, outcome: 'unknown',
    source: { kind: hostKind === 'fixture' ? 'fixture' : 'manual', evidenceRef: source.evidenceRef }
  });
  // Validate both event IDs and the fallback receipt before any persistent change.
  evolveReporting(preview, state, caller, unknownRecord(at), preview.version);

  // CAS + exclusive lock claims this operation. The store rereads business intent.
  // After this succeeds, even a process crash must lead to reconciliation, not replay.
  const dispatched = await transactReporting(ledgerPath, statePath, caller, dispatch, expectedVersion);
  const op = dispatched.operations.at(-1);
  const request = {
    teamId: dispatched.teamId, operationId: op.id, kind: op.kind,
    owner: structuredClone(dispatched.owner), automationId: op.automationId,
    bindingEpoch: op.bindingEpoch, intentVersion: op.intentVersion, desired: op.desired
  };
  let receipt = null, hostError = null, timer;
  try {
    receipt = await Promise.race([
      Promise.resolve().then(() => executeHost(structuredClone(request))),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Host result timed out; the operation may still complete and must be reconciled');
          error.name = 'ReportingHostTimeout';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } catch (error) { hostError = errorInfo(error); }
  finally { clearTimeout(timer); }

  const result = {
    operationId, request, hostActionInvoked: true, receipt, hostError,
    ledgerRecorded: false, phase: 'DISPATCHED', requiresReconciliation: true,
    identityAssurance: 'caller-declared; adapter receipts are not authenticated',
    crossFileAtomic: false
  };
  try {
    const stamp = now(), currentState = await readState(statePath);
    let record = unknownRecord(stamp);
    if (!hostError) {
      try {
        check(receipt && typeof receipt === 'object' && !Array.isArray(receipt)
          && Object.keys(receipt).every(key => ['owner', 'automationId', 'outcome', 'observedAt', 'source'].includes(key)), 'Invalid normalized host receipt');
        record = { ...receipt, id: recordEventId, type: 'record', operationId, at: stamp };
        if (hostKind === 'fixture') record.source = { kind: 'fixture', evidenceRef: receipt.source?.evidenceRef ?? source.evidenceRef };
        evolveReporting(dispatched, currentState, caller, record, dispatched.version);
      } catch (error) {
        result.receiptError = errorInfo(error);
        record = unknownRecord(stamp);
      }
    }
    // Do not retry a failed/uncertain write. Preserve the raw receipt for reconciliation.
    const recorded = await transactReporting(ledgerPath, statePath, caller, record, dispatched.version);
    result.ledgerRecorded = true;
    result.phase = recorded.operations.at(-1).phase;
    result.requiresReconciliation = result.phase !== 'CONFIRMED';
    result.ledgerVersion = recorded.version;
  } catch (error) { result.recordError = errorInfo(error); }
  // CONFIRMED describes this operation only. A new intent may already need coordination.
  return result;
}
