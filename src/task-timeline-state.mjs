import {validate} from './runtime.mjs';

// Recorded business history only. Never projects or refreshes the live Registry.
export function buildStateTimeline(state,{teamId,roundId,taskId}) {
  validate(state);
  if(state.team.id!==teamId)throw new Error('Timeline state team mismatch');
  const round=state.rounds.find(r=>r.id===roundId);
  const task=state.tasks.find(t=>t.id===taskId&&t.roundId===roundId);
  if(!round||!task)throw new Error('Timeline state round/task missing');
  const stages=task.stages.map((stage,index)=>({
    stageId:`state-stage:${index}`,status:stage.status,
    kind:['approved','cancelled'].includes(stage.status)?'terminal-state':'declared-stage',
    declaredStartAt:stage.startedAt,declaredEndAt:stage.endedAt,
    durationMs:stage.startedAt!==null&&stage.endedAt!==null?Date.parse(stage.endedAt)-Date.parse(stage.startedAt):null,
    timeBasis:'declaredAt',evidenceIndex:index
  }));
  const events=state.events.filter(e=>e.roundId===roundId&&e.taskId===taskId).map(e=>({
    eventId:`state-event:${e.id}`,kind:e.type,declaredAt:e.at,observedAt:null,
    actorId:e.actor,role:round.members.find(m=>m.id===e.actor)?.role??'Unknown',
    association:'explicit-state-task',timeBasis:'declaredAt'
  }));
  return {teamId,roundId,taskId,sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,
    status:task.status,association:'explicit-state-task',events,stages};
}
