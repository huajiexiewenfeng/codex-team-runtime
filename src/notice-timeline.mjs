import { validateLedger } from './submission-recovery.mjs';
import { planSubmissionReview } from './submission-notice.mjs';

// Explicitly supplied snapshots only; no log discovery or live mutation.
export function buildNoticeTimeline(state, ledger, {statePath, taskId, ledgerBytes}) {
  validateLedger(ledger,statePath,state.team.id);
  const task=state.tasks.find(t=>t.id===taskId);
  if(!task)throw new Error('Unknown notice timeline task');
  const manager=state.members.find(m=>m.role==='Manager');
  const caller={hostId:manager.binding.hostId,threadId:manager.binding.threadId};
  const entries=ledger.entries.filter(e=>e.notice.taskId===taskId);
  const intervals=[];
  function interval(kind,startAt,endAt,submissionId,attemptId) {
    const elapsed=Date.parse(endAt)-Date.parse(startAt);
    intervals.push({kind,startAt,endAt,submissionId,attemptId,durationMs:elapsed>=0?elapsed:null,
      clockRegression:elapsed<0,timeBasis:kind==='submit-to-claim'?'declared-submit-to-runtime-claim':'runtime-claim-to-observation',
      includesAgentScheduling:kind==='claim-to-result'});
  }
  for(const entry of entries) {
    planSubmissionReview(state,caller,entry.notice);
    for(const attempt of entry.attempts) {
      interval('submit-to-claim',entry.notice.submittedAt,attempt.claimedAt,entry.notice.submissionId,attempt.id);
      for(const observation of attempt.observations)
        interval('claim-to-result',attempt.claimedAt,observation.at,entry.notice.submissionId,attempt.id);
    }
  }
  return {schemaVersion:1,teamId:state.team.id,taskId,ledgerVersion:ledger.version,ledgerBytes,
    trackedSubmissions:entries.length,attemptCount:entries.reduce((n,e)=>n+e.attempts.length,0),intervals,
    hostSendDurationMs:null,noticeMismatchCount:null,coverage:'ledger-snapshot',
    limitations:['Claim-to-result includes scheduling, native send and result recording; it is not network time.',
      'No native receive/send coverage is implied by this ledger snapshot. Missing metrics stay null.',
      'Ledger bytes are a whole-team snapshot size, not a per-task growth delta.']};
}

// Native receive observations must be explicitly selected/attributed by the
// existing host observation workflow. Never inspect arbitrary messages/text.
export function noticeMismatchObservation(item) {
  if(item?.type!=='commandExecution'||!Number.isInteger(item.exitCode)||item.exitCode===0||
     typeof item.command!=='string'||!/(?:^|\s)receive-submission(?:\s|$)/.test(item.command)||
     typeof item.aggregatedOutput!=='string')return null;
  try {
    const value=JSON.parse(item.aggregatedOutput.trim());
    return Object.keys(value).length===2&&value.code==='NOTICE_MISMATCH'&&
      value.message==='Notice does not match durable submission'?'NOTICE_MISMATCH':null;
  }catch{return null;}
}
