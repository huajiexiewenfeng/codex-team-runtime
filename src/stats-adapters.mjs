import { createCodexUsageAccumulator, validateUsage } from './metrics-usage.mjs';
import { validateServerMcpEvent } from './metrics-mcp-events.mjs';
import { buildStateTimelines } from './task-timeline-state.mjs';
import { projectNativeTimeline } from './task-timeline-native.mjs';
import { projectNativeTiming, projectNativeContinuation } from './native-tool-timing.mjs';
import { check, exact, id, time, hash, bindingKey, scopeRecord, LIMITS } from './stats-contract.mjs';

export const ACTIVITY_FIELDS=['schemaVersion','eventId','phase','teamId','memberId','hostId','threadId','bindingRevision','roleEpoch','role','taskId','roundId','stepId','at','assurance','sourceKind','evidenceRef'];
export function validateActivity(event,source,manifest) {
  exact(event,ACTIVITY_FIELDS);check(event.schemaVersion==='activity-sidecar/v1');
  for(const key of ['eventId','teamId','memberId','hostId','threadId','roleEpoch','taskId','roundId','stepId'])id(event[key]);
  time(event.at);check(['begin','end'].includes(event.phase));
  check(['worker-declared','operator-declared'].includes(event.assurance)&&event.sourceKind==='activity-sidecar');
  check(event.teamId===manifest.teamId,'activity_team_mismatch');
  check(source.selection.taskId===event.taskId&&source.selection.roundId===event.roundId,'activity_task_scope_mismatch');
  const matches=source.bindings.filter(b=>b.key===bindingKey(manifest.teamId,event)&&b.role===event.role&&b.from<=event.at&&event.at<b.to);
  check(matches.length===1,'activity_binding_mismatch');
  check(typeof event.evidenceRef==='string'&&event.evidenceRef.length>0&&event.evidenceRef.length<=4000);
  return event;
}
export function createJsonlAdapter(source,manifest,checkpoint={}) {
  const state=structuredClone(checkpoint);
  state.openCalls??={};state.line??=0;
  state.activitySeen??={};
  state.nativeRoots??={};
  const binding=source.bindings[0];
  const usage=source.kind==='codex-jsonl'?createCodexUsageAccumulator({hostId:binding.hostId,threadId:binding.threadId,sourceRef:source.sourceId},null,state.usage??null):null;
  const projected=r=>scopeRecord(r,source,manifest);
  return {
    push(entry,offset,rootKeys){
      state.line++;const rows=[],diagnostics=[];
      if(usage){
        // Native UTC wire timestamps may omit trailing fractional zeroes.
        // Canonicalize only this known format; event/receipt schemas stay strict.
        if(typeof entry.timestamp==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(entry.timestamp)&&Number.isFinite(Date.parse(entry.timestamp)))entry={...entry,timestamp:new Date(entry.timestamp).toISOString()};
        usage.push(JSON.stringify(entry));const result=usage.drain();state.usage=usage.checkpoint();
        diagnostics.push(...result.diagnostics.map(d=>({code:d.code,offset})));
        for(const r of result.records)rows.push(projected({id:r.id,kind:'token',at:r.at,hostId:r.hostId,threadId:r.threadId,turnId:r.turnId,usage:r.usage,stableIdentity:false,missing:['rotation-dedup-not-proven']}));
        const p=entry.payload??{};
        if(entry.type==='response_item'&&['function_call','custom_tool_call','function_call_output','custom_tool_call_output'].includes(p.type)){
          // Some resumed/new-thread histories carry inherited tool outputs
          // without a call identity. They cannot be paired or counted, but do
          // not invalidate independently identified later usage records.
          if(p.call_id===undefined||p.call_id===null){diagnostics.push({code:'native_call_identity_missing',offset});return {rows:rows.filter(Boolean),diagnostics};}
          check(state.usage.sessionSeen,'native_identity_missing');const callId=id(p.call_id),at=time(entry.timestamp);
          if(p.type.endsWith('output')){
            const start=state.openCalls[callId];
            const timing=p.nativeTiming??projectNativeTiming();
            if(start){
              check(at>=start.startAt,'native_time_order');
              const row={...start,at,responseAt:at,endAt:timing.completionKnown?at:null,completedAt:timing.completionKnown?at:null,completionKnown:timing.completionKnown,
                firstYieldAt:!timing.completionKnown&&timing.kind!=='unknown'?at:null,status:timing.completionKnown?'completed':timing.kind==='unknown'?'completion-unknown':'yielded',
                completionEvidence:timing.evidence,reportedDurationMs:timing.reportedDurationMs,missing:timing.completionKnown?[]:['execution-completion-unproven']};
              rows.push(projected(row));delete state.openCalls[callId];
              const continuation=start.continuation,rootKey=continuation?`${continuation.kind}:${continuation.id}`:null,root=rootKey?state.nativeRoots[rootKey]:null;
              if(root&&timing.completionKnown&&timing.kind===continuation.kind&&(timing.sessionId===null||timing.sessionId===continuation.id)){
                const scoped=projected(row);
                if(scoped?.bindingKey&&scoped.bindingKey===root.bindingKey&&scoped.taskId===root.taskId&&at>=root.row.firstYieldAt){
                  rows.push(projected({...root.row,at,endAt:at,completedAt:at,completionKnown:true,status:'completed',completionEvidence:`${timing.evidence};explicit-continuation`,completionCallId:callId,missing:[]}));delete state.nativeRoots[rootKey];
                }else diagnostics.push({code:'native_continuation_scope_mismatch',offset});
              }
              const processRoot=/^(?:(?:functions|tools)\.)?exec_command$/.test(start.tool??'')&&timing.kind==='process';
              const scriptRoot=/^(?:functions\.)?exec$/.test(start.tool??'')&&timing.kind==='script';
              const handle=processRoot?timing.sessionId:scriptRoot?timing.cellId:null;
              if(!timing.completionKnown&&handle!==null){
                const key=`${timing.kind}:${handle}`,scoped=projected(row);
                check(Object.keys(state.nativeRoots).length<LIMITS.openCalls,'source_open_call_limit');
                if(Object.hasOwn(state.nativeRoots,key)){state.nativeRoots[key]=null;diagnostics.push({code:'native_continuation_identity_conflict',offset});}
                else state.nativeRoots[key]={row,bindingKey:scoped?.bindingKey??null,taskId:scoped?.taskId??null};
              }
            }else rows.push(projected({id:`call-${hash([source.sourceId,callId])}`,kind:'interval',series:'native',assurance:'machine-source-reported',at,startAt:null,endAt:timing.completionKnown?at:null,responseAt:at,completedAt:timing.completionKnown?at:null,completionKnown:timing.completionKnown,status:timing.completionKnown?'completed':'completion-unknown',completionEvidence:timing.evidence,tool:null,hostId:binding.hostId,threadId:binding.threadId,missing:['missing-start',...(!timing.completionKnown?['execution-completion-unproven']:[])]}));
          }else{
            check(!Object.hasOwn(state.openCalls,callId),'native_duplicate_open_call');check(Object.keys(state.openCalls).length<LIMITS.openCalls,'source_open_call_limit');
            const row={id:`call-${hash([source.sourceId,callId])}`,kind:'interval',series:'native',assurance:'machine-source-reported',at,startAt:at,endAt:null,responseAt:null,completedAt:null,firstYieldAt:null,completionKnown:false,status:'pending',completionEvidence:'completion-unproven',tool:typeof p.name==='string'?p.name:null,hostId:binding.hostId,threadId:binding.threadId,turnId:state.usage.turnId,continuation:projectNativeContinuation(p.name,p.nativeArguments),missing:['missing-response','execution-completion-unproven']};
            state.openCalls[callId]=row;rows.push(projected(row));
          }
        }
      }else{
        check(rootKeys.length===ACTIVITY_FIELDS.length&&rootKeys.every(k=>ACTIVITY_FIELDS.includes(k)),'activity_unknown_field');
        validateActivity(entry,source,manifest);
        check(entry.at>=source.authorizedFrom&&entry.at<=source.authorizedTo,'activity_out_of_scope');
        const seenKey=`${entry.eventId}:${entry.phase}`,fingerprint=hash(entry);
        if(Object.hasOwn(state.activitySeen,seenKey)){check(state.activitySeen[seenKey]===fingerprint,'activity_event_conflict');return {rows:[],diagnostics:[]};}
        check(Object.keys(state.activitySeen).length<8192,'source_activity_identity_limit');state.activitySeen[seenKey]=fingerprint;
        const key=entry.eventId,link={memberId:entry.memberId,role:entry.role,hostId:entry.hostId,threadId:entry.threadId,taskId:entry.taskId,roundId:entry.roundId,stepId:entry.stepId,roleEpoch:entry.roleEpoch,bindingRevision:entry.bindingRevision,assurance:entry.assurance};
        if(entry.phase==='begin') {
          check(!Object.hasOwn(state.openCalls,key),'activity_duplicate_begin');check(Object.keys(state.openCalls).length<LIMITS.openCalls,'source_open_call_limit');
          const row={...link,id:key,kind:'interval',series:'activity-sidecar',at:entry.at,startAt:entry.at,endAt:null,completionKnown:false,status:'pending',tool:null,evidenceId:hash(entry.evidenceRef),missing:['missing-end']};
          state.openCalls[key]=row;rows.push(projected(row));
        }else{
          const start=state.openCalls[key];
          check(start,'activity_missing_begin');check(Object.keys(link).every(k=>start[k]===link[k]),'activity_cross_binding_or_task');check(entry.at>=start.startAt,'activity_time_order');
          rows.push(projected({...start,at:entry.at,endAt:entry.at,completedAt:entry.at,completionKnown:true,status:'declared-completed',completionEvidence:'validated-declared-begin-end',associationSource:entry.assurance,missing:[]}));delete state.openCalls[key];
        }
      }
      return {rows:rows.filter(Boolean),diagnostics};
    },skipLine(){state.line++;if(usage){usage.push('');state.usage=usage.checkpoint();}},checkpoint(){return structuredClone(state);}
  };
}
export function serverRow(event,source,manifest) {
  validateServerMcpEvent(event,{registryId:manifest.registryId,teamId:manifest.teamId});
  const context=event.workContext;
  return scopeRecord({id:event.eventId,kind:'interval',series:'team-context',assurance:'machine-source-reported',
    at:event.completedAt,startAt:event.startedAt,endAt:event.completedAt,completedAt:event.completedAt,completionKnown:true,status:'server-completed',completionEvidence:'validated-server-event',reportedDurationMs:event.durationMs,tool:event.tool,
    hostId:event.hostId,threadId:event.threadId,memberId:event.memberId,role:event.role,taskId:context?.scope==='task'?context.taskId:event.notice?.taskId??event.dispatch?.taskId??null,roundId:context?.roundId??null,stepId:context?.stepId??null,attributionHint:context?.scope==='team'?'team-shared':null,associationSource:context?.associationSource??(event.notice?.taskId||event.dispatch?.taskId?'runtime-request':null),contextValidation:context?.validation??null},source,manifest);
}
export function projectDocument(document,source,manifest) {
  const rows=[],metadata={};const add=r=>{const p=scopeRecord(r,source,manifest);if(p)rows.push(p);};
  if(source.kind==='team-context-event'){
    const row=serverRow(document,source,manifest);if(row)rows.push(row);metadata.asOf=document.completedAt;
  }else if(source.kind==='usage-ledger'){
    validateUsage(document);check(document.teamId===manifest.teamId,'source_team_mismatch');
    const links=new Map(document.links.map(l=>[l.recordId,l]));
    for(const r of document.records){const link=links.get(r.id);add({id:r.id,kind:'token',at:r.at,hostId:r.hostId,threadId:r.threadId,turnId:r.turnId,usage:r.usage,...(link?{taskId:link.taskId,memberId:link.memberId,roundId:link.roundId}:{})});}
  }else if(source.kind==='recorded-state'){
    check(document.team.id===manifest.teamId,'source_team_mismatch');
    metadata.sourceVersion=document.version;metadata.asOf=document.updatedAt;
    metadata.roster=document.members.map(m=>({memberId:m.id,name:m.name,role:m.role,lifecycle:m.lifecycle}));
    const timelines=buildStateTimelines(document,manifest.teamId);
    for(const [position,task] of document.tasks.entries()){
      const timeline=timelines[position];
      metadata.tasks??=[];metadata.tasks.push({taskId:task.id,roundId:task.roundId,title:task.title,status:task.status,ownerId:task.workerId,assignedAt:task.assignedAt,completedAt:task.completedAt,updatedAt:task.stages.at(-1)?.startedAt??document.updatedAt});
      for(const stage of timeline.stages)add({id:`stage-${task.id}-${stage.stageId}`,kind:'stage',at:stage.declaredStartAt,startAt:stage.declaredStartAt,endAt:stage.declaredEndAt,taskId:task.id,roundId:task.roundId,status:stage.status,terminal:stage.kind==='terminal-state',assurance:'task-declared',missing:['stage-owner-not-recorded',...(stage.declaredEndAt===null?['missing-end']:[])]});
    }
  }else if(source.kind==='metrics-daily-report'){
    const daily=document.daily;check([1,2].includes(document.schemaVersion)&&daily?.schemaVersion===1&&daily.teamId===manifest.teamId,'invalid_daily_report');
    time(daily.asOf);metadata.asOf=daily.asOf;metadata.from=daily.from;metadata.to=daily.to;
    // Aggregated history is a separate series, never added to raw token records.
    const metrics=value=>{check(value&&typeof value==='object','invalid_daily_metrics');const result={};for(const k of ['input','cachedInput','nonCachedInput','output','reasoningOutput','net','total']){const v=value[k];exact(v,['known','knownRecords','missingRecords']);check(v.known===null||Number.isSafeInteger(v.known)&&v.known>=0,'invalid_daily_metrics');for(const n of ['knownRecords','missingRecords'])check(Number.isSafeInteger(v[n])&&v[n]>=0,'invalid_daily_metrics');result[k]=v;}return result;};
    metadata.daily=daily.days.map(day=>({date:day.date,metrics:metrics(day.totals),byMember:day.byMember.map(v=>({memberId:id(v.memberId),role:v.role,metrics:metrics(v.metrics)})),byRole:day.byRole.map(v=>({role:v.role,metrics:metrics(v.metrics)}))}));
    if(document.serverMcp){check(document.serverMcp.teamId===manifest.teamId,'source_team_mismatch');for(const r of document.serverMcp.events){const row=serverRow(r.event,source,manifest);if(row)rows.push({...row,series:'team-context-report'});}}
    metadata.nativeMcpCoverage=(document.mcpCalls??[]).length?'report-only':'not-observed-input';
  }else if(source.kind==='native-items'){
    const b=source.bindings[0];check(source.selection.turnIds.length===1&&source.selection.taskId,'native_selection_missing');
    const projected=projectNativeTimeline(document,{sourceRef:source.sourceId,hostId:b.hostId,threadId:b.threadId,role:b.role,turnId:source.selection.turnIds[0],itemIds:source.selection.itemIds});
    const turn=document.turns.find(t=>t.id===source.selection.turnIds[0]);
    // Reported duration has no absolute boundaries. Turn start is not item start.
    const turnAt=typeof turn.startedAt==='number'?new Date(turn.startedAt*1000).toISOString():turn.startedAt;
    for(const item of projected.items)add({id:item.itemId,kind:'reported-step',series:'native',itemId:item.itemId,turnId:item.turnId,at:turnAt,startAt:null,endAt:null,completedAt:null,completionKnown:false,status:'duration-only',hostReportedStatus:item.status,reportedDurationMs:item.durationMs,tool:item.tool,hostId:b.hostId,threadId:b.threadId,assurance:'host-reported-duration',missing:['absolute-step-boundaries-unavailable','absolute-completion-time-unavailable']});
  }else check(false,'unsupported_document_adapter');
  return {rows,metadata};
}
