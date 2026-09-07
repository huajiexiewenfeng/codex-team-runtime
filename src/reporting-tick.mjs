import { validate,validateCaller,snapshot } from './runtime.mjs';
import { validateReportingLedger } from './reporting.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
const matches=(member,identity)=>member.id===identity.memberId&&member.binding.status==='bound'&&member.binding.hostId===identity.hostId&&member.binding.threadId===identity.threadId;

// A read-only decision over caller-supplied current records, not authentication,
// a scheduler operation, a sent report, or final-summary deduplication.
export function planReportingTick(state,ledger,caller,automationId,asOf){
 validate(state);validateReportingLedger(ledger);validateCaller(caller);
 const liaison=state.members.find(m=>m.role==='Liaison'),manager=state.members.find(m=>m.role==='Manager');
 check(state.team.id===ledger.teamId&&matches(liaison,ledger.owner)&&matches(manager,ledger.manager),'Tick team or role owner mismatch');
 check(caller.hostId===ledger.owner.hostId&&caller.threadId===ledger.owner.threadId,'Tick caller must be the bound Liaison');
 check(state.session?.invitation?.confirmedAt,'Tick requires confirmed Liaison pairing');
 check(typeof automationId==='string'&&automationId.length>0&&automationId===ledger.automationId,'Tick automation identity is unknown or mismatched');
 const view=snapshot(state,asOf);check(asOf>=ledger.updatedAt,'Tick predates ledger');
 const sources=[state.team.source.kind,...state.events.map(e=>e.source.kind),ledger.teamSourceKind,...ledger.events.map(e=>e.source.kind)];
 let reason='running',recommendedAction='none';
 if(sources.includes('fixture')){reason='fixture-source';recommendedAction='reconcile';}
 else if(manager.lifecycle!=='active'){reason='manager-exited';recommendedAction='pause-or-reconcile';}
 else if(liaison.lifecycle!=='active'){reason='liaison-exited';recommendedAction='pause-or-reconcile';}
 else if(!state.reporting.enabled){reason='reports-disabled';recommendedAction='pause-or-reconcile';}
 else if(!state.rounds.some(r=>r.status==='open')){reason='no-open-rounds';recommendedAction='pause-or-reconcile';}
 else if(state.reporting.desired!=='running'){reason='reporting-not-desired';recommendedAction='pause-or-reconcile';}
 else if(ledger.operations.some(op=>['DISPATCHED','UNKNOWN','FAILED'].includes(op.phase))){reason='operation-unresolved';recommendedAction='reconcile';}
 else if(ledger.observation?.outcome!=='running'||ledger.observation.automationId!==automationId){reason='running-not-observed';recommendedAction='reconcile';}
 return {allowProgressReport:reason==='running',reason,recommendedAction,sourceVersion:state.version,ledgerVersion:ledger.version,identityAssurance:'caller-declared',readOnly:true,hostActionExecuted:false,snapshot:view};
}
