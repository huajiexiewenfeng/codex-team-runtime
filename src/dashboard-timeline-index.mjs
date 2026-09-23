import {dirname,resolve} from 'node:path';
import {readTimelineJson,loadDashboardTimelineReport,presentDashboardTimeline} from './dashboard-timeline.mjs';
import {buildTaskTimeline} from './task-timeline.mjs';
import {buildStateTimeline} from './task-timeline-state.mjs';

// Index is trusted local launch configuration, never a path accepted from HTTP.
export async function readTimelineIndex(indexPath,teamId){
 if(!indexPath)return new Map();
 const index=await readTimelineJson(indexPath,4*1024*1024);
 if(!index||index.schemaVersion!==1||index.teamId!==teamId||!Array.isArray(index.reports)||index.reports.length>10000)throw Error('Invalid timeline index');
 const reports=new Map();
 for(const entry of index.reports){
  if(!entry||typeof entry.taskId!=='string'||!entry.taskId.trim()||entry.taskId.length>128||typeof entry.path!=='string'||!entry.path.trim()||entry.path.includes('\0'))throw Error('Invalid timeline index entry');
  if(reports.has(entry.taskId))throw Error('Duplicate timeline index task');
  reports.set(entry.taskId,resolve(dirname(indexPath),entry.path));
 }
 return reports;
}

export async function readIndexedTimeline(indexPath,state,selectedTaskId=null,{refreshState=false,checkedAt=new Date().toISOString(),bindings=null}={}){
 const index=bindings??await readTimelineIndex(indexPath,state.team.id);
 const tasks=state.tasks.map(task=>({id:task.id,title:task.title,reportConfigured:index.has(task.id),available:index.has(task.id),stageRefreshAvailable:true}));
 const taskId=selectedTaskId??tasks.find(task=>task.reportConfigured)?.id??tasks[0]?.id??null;
 const task=state.tasks.find(task=>task.id===taskId);
 if(selectedTaskId!==null&&!task)throw Error('Unknown task');
 let report=null,unavailableReports=0;
 const path=index.get(taskId);
 if(path)try{report=await loadDashboardTimelineReport(path,state,taskId);}catch{unavailableReports=1;}
 const common={teamId:state.team.id,taskId,tasks,checkedAt,unavailableReports,checkedReports:path?1:0,reportStatus:path?(report?'ready':'unavailable'):'not_configured'};
 if(refreshState&&task){
  report??=buildTaskTimeline({teamId:state.team.id,taskId},[]);
  report={...report,businessTimeline:buildStateTimeline(state,{teamId:state.team.id,taskId,roundId:task.roundId}),coverage:{...report.coverage,missing:(report.coverage.missing??[]).filter(value=>value!=='business-state-events')}};
  if(!report.sources.length&&!report.events.length&&!(report.nativeObservations??[]).length)report.coverage.missing.push(unavailableReports?'bound-report-unavailable':'native-logs-not-collected');
 }
 if(!report)return {...common,status:unavailableReports?'report_unavailable':indexPath||index.size?'task_not_configured':'not_configured'};
 return {...presentDashboardTimeline(report,state,{stageMode:refreshState?'refreshed-state':'report-snapshot',checkedAt}),...common};
}
