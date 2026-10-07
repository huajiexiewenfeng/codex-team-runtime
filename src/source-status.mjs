import {hash} from './stats-contract.mjs';

export const memberBindingHash=m=>m.binding?.status==='bound'?hash([m.id,m.role,m.binding.hostId,m.binding.threadId]):m.bindingHash??null;
const bindingHash=b=>hash([b.memberId,b.role,b.hostId,b.threadId]);
const capabilities={token:new Set(['codex-jsonl','usage-ledger']),mcp:new Set(['codex-jsonl','team-context-root','team-context-event','metrics-daily-report']),time:new Set(['codex-jsonl','activity-jsonl','team-context-root','team-context-event','native-items','metrics-daily-report'])};
const recordMetric=(r,metric)=>metric==='token'?r.kind==='token':metric==='time'?['interval','reported-step'].includes(r.kind):['team-context','team-context-report'].includes(r.series)||r.kind==='interval'&&/^(?:mcp[_.]|team_context\.)/.test(r.tool??'');
function covers(spans,start,end){let cursor=start;for(const [a,b] of spans.sort((x,y)=>x[0].localeCompare(y[0]))){if(a>cursor)return false;if(b>cursor)cursor=b;if(cursor>=end)return true;}return cursor>=end;}
// Configuration, observations and problems are independent facts. No path,
// free-form error message or evidenceRef is ever returned by this projection.
export function sourceStatus(index,roster,records,window,contains){
  const bindings=new Map(index.bindings.map(b=>[b.key,b])),sources=new Map(index.sources.map(s=>[s.sourceId,s])),configured=new Map(),observed=new Map();
  for(const scope of index.sourceScopes??[]){for(const b of scope.bindings){if(!bindings.has(b.key))continue;const fp=b.identityHash;if(!configured.has(fp))configured.set(fp,[]);configured.get(fp).push({scope,b,source:sources.get(scope.sourceId)});}}
  for(const row of records){if(!bindings.has(row.bindingKey)||!contains(row,window))continue;const fp=hash([row.memberId,row.role,row.hostId,row.threadId]);if(!observed.has(fp))observed.set(fp,[]);observed.get(fp).push(row);}
  return roster.filter(m=>m.lifecycle==='active').map(m=>{const fp=memberBindingHash(m),descriptors=configured.get(fp)??[],rows=observed.get(fp)??[],metrics={};
    for(const metric of ['token','mcp','time']){
      const candidates=descriptors.filter(d=>capabilities[metric].has(d.scope.kind)),sourceIds=[...new Set(candidates.map(d=>d.scope.sourceId))],seen=rows.filter(r=>recordMetric(r,metric)),problems=new Set(),evidence=[];
      if(index.managedPolicy&&index.managedPolicy.status!=='active')problems.add('policy-'+index.managedPolicy.status);
      for(const issue of index.managedPolicy?.issues??[])if(!issue.memberId||issue.memberId===(m.id??m.memberId))problems.add(issue.code);
      for(const {scope,b,source} of candidates){
        const from=scope.authorizedFrom>b.from?scope.authorizedFrom:b.from,to=scope.authorizedTo<b.to?scope.authorizedTo:b.to;
        if(to<window.cutoffAtInclusive)problems.add('authorization-expired');
        if(source?.status==='error'||source?.status.startsWith('source_'))problems.add('read-error');
        else if(source?.status&&source.status!=='fresh')problems.add('reading-incomplete');
        else if(!source?.lastCheckedAt)problems.add('not-read');
        if(source?.diagnostics.some(d=>['source_generation_reset','coverage_gap','counter_reset'].includes(d.code)))problems.add('continuity-unproven');
        evidence.push({sourceId:scope.sourceId,sourceKind:scope.kind,bindingKey:b.key,authorizedFrom:from,authorizedTo:to,status:source?.status??'not-read',checkedAt:source?.lastCheckedAt??source?.failedCheckedAt??null,diagnosticCodes:[...new Set((source?.diagnostics??[]).map(d=>/^[a-zA-Z0-9_-]{1,128}$/.test(d.code)?d.code:'source_validation_failed'))].slice(-8)});
      }
      if(candidates.length&&!covers(evidence.map(e=>[e.authorizedFrom,e.authorizedTo]),window.startAt,window.cutoffAtInclusive))problems.add('range-limited');
      if(metric==='token'&&seen.some(r=>['input','cachedInput','output','reasoningOutput','total'].some(k=>r.usage?.[k]===null)))problems.add('profile-incomplete');
      if(metric!=='token'&&seen.some(r=>!r.startAt||!r.endAt))problems.add('missing-endpoints');
      const configuration=!index.sourceScopes?'unverified':!fp?'unbound':candidates.length?'configured':'not-configured';
      const collection=seen.length?'observed':candidates.length?'no-records':'not-observed';
      const series=new Map();for(const row of seen){const kind=row.series??row.kind;series.set(kind,(series.get(kind)??0)+1);}
      metrics[metric]={configuration,collection,observedRecords:seen.length,observedBySeries:[...series].map(([sourceKind,records])=>({sourceKind,records})),countBasis:'source records in separate series; not additive MCP call total',completedRecords:seen.filter(r=>metric==='token'?r.usage?.total!=null:r.completionKnown===true).length,sourceIds,problems:[...problems],evidence,action:index.managedPolicy&&index.managedPolicy.status!=='active'?'inspect-managed-policy':configuration==='unverified'?'refresh-approved-sources':configuration==='not-configured'?'provide-explicit-candidate':problems.has('read-error')?'inspect-source-diagnostics':problems.has('authorization-expired')?'review-authorized-window':!seen.length?'check-approved-input-and-refresh':'partial-observation-only'};
    }
    return {memberId:m.id??m.memberId,name:m.name??null,bindingHash:fp,bindingKeys:[...new Set(descriptors.map(d=>d.b.key))],identityBasis:'current-state-binding-tuple; approved historical epochs retained separately',metrics};
  });
}
