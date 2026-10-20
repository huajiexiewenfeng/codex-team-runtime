const brief=e=>e?{id:e.id,type:e.type,at:e.at,actor:e.actor,summary:e.summary??null,source:e.source}:null;
export function taskProgress(state,task) {
  const events=state.events.filter(e=>e.taskId===task.id&&e.roundId===task.roundId);
  const blocker=events.filter(e=>['reportBlocker','unblock','submit','rework','approve','cancelQueued','cancelStopped','cancelUndelivered'].includes(e.type)).at(-1);
  const managerBlock=events.filter(e=>e.type==='block').at(-1);
  return {taskId:task.id,workerId:task.workerId,status:task.status,enteredAt:task.stages.at(-1)?.startedAt??null,
    recentActivity:brief(events.at(-1)),activityScope:'ledger-only',agentWork:{status:'unknown',at:null,source:null},
    latestSubmission:brief(events.filter(e=>e.type==='submit').at(-1)),
    latestReview:brief(events.filter(e=>['review','rework','approve'].includes(e.type)).at(-1)),
    latestBlockerReport:brief(events.filter(e=>e.type==='reportBlocker').at(-1)),
    managerBlocker:task.status==='blocked'?{who:'unknown',reason:managerBlock?.summary??'unknown',needs:'unknown',at:managerBlock?.at??null,source:managerBlock?.source??null,scope:'manager-state'}:null,
    blocker:blocker?.type==='reportBlocker'?{...blocker.blocker,reportedBy:blocker.actor,at:blocker.at,source:blocker.source,scope:'worker-report'}:
      task.status==='blocked'?{who:'unknown',needs:managerBlock?.summary??'unknown',reportedBy:managerBlock?.actor??null,at:managerBlock?.at??null,source:managerBlock?.source??null,scope:'manager-state'}:null};
}
export function progressSummary(state,taskId=null) {if(taskId!==null&&!state.tasks.some(t=>t.id===taskId))throw Error('Unknown summary task_id');return {status:'ok',schemaVersion:1,teamId:state.team.id,sourceVersion:state.version,sourceUpdatedAt:state.updatedAt,readOnly:true,hostActionExecuted:false,scope:taskId===null?'all-recorded-team-tasks':'exact-task',taskId,activityScope:'ledger-only',tasks:state.tasks.filter(t=>taskId===null||t.id===taskId).map(t=>taskProgress(state,t))};}
