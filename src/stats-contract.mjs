import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const RULES_VERSION = 'dashboard-stats-v3';
export const COLLECTOR_VERSION = 'bounded-metadata-v3';
export const LIMITS = Object.freeze({readBytes:8*1024*1024,chunkBytes:256*1024,wallMs:1500,lineBytes:64*1024*1024,
  metadataBytes:65536,depth:128,sources:1000,openCalls:4096,entries:10000,newFiles:256,cacheBytes:512*1024*1024,
  checkpointBytes:1024*1024,snapshotBytes:128*1024*1024,responseBytes:1024*1024,leaseMs:120000,leases:32});
export function check(ok, code='invalid_stats_input') { if(!ok) throw Object.assign(new Error(code),{code}); }
export function exact(v, keys, required=keys) {
  check(v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).every(k=>keys.includes(k)) && required.every(k=>Object.hasOwn(v,k)));
}
export function id(v) { check(typeof v==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v)); return v; }
export function time(v) { check(typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);return v; }
export function canonical(v) { if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v; }
export const hash = v => createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
export function bindingKey(teamId,b) { return hash([teamId,b.memberId,b.bindingRevision,b.hostId,b.threadId,b.roleEpoch]); }
export function validateManifest(value, directory) {
  exact(value,['schemaVersion','teamId','registryId','revision','authorizationRef','sources']);
  check(value.schemaVersion==='dashboard-sources/v1');id(value.teamId);id(value.registryId);
  check(Number.isSafeInteger(value.revision)&&value.revision>0);check(typeof value.authorizationRef==='string'&&value.authorizationRef.length>0&&value.authorizationRef.length<=4000);
  check(Array.isArray(value.sources)&&value.sources.length<=LIMITS.sources);
  const sourceIds=new Set(),paths=new Set();
  const sources=value.sources.map(s=>{
    exact(s,['sourceId','kind','path','adapterVersion','mutationPolicy','authorizedFrom','authorizedTo','coverageAssertions','evidenceRef','bindings','selection']);
    id(s.sourceId);check(!sourceIds.has(s.sourceId));sourceIds.add(s.sourceId);
    check(['codex-jsonl','activity-jsonl','team-context-root','team-context-event','recorded-state','usage-ledger','metrics-daily-report','native-items'].includes(s.kind));
    check(s.adapterVersion==='v1'&&['append-only','mutable','immutable'].includes(s.mutationPolicy));
    if(s.kind.endsWith('jsonl'))check(s.mutationPolicy!=='immutable');else check(s.mutationPolicy!=='append-only');
    check(typeof s.path==='string'&&s.path.length>0&&s.path.length<4096);const path=resolve(directory,s.path);check(isAbsolute(path));
    check(!paths.has(path.toLowerCase()),'duplicate_source_path');paths.add(path.toLowerCase());
    time(s.authorizedFrom);time(s.authorizedTo);check(s.authorizedFrom<=s.authorizedTo);
    check(typeof s.evidenceRef==='string'&&s.evidenceRef.length>0&&s.evidenceRef.length<=4000);
    exact(s.coverageAssertions,['status','evidenceRef']);check(['partial','unverified','complete'].includes(s.coverageAssertions.status));
    check(typeof s.coverageAssertions.evidenceRef==='string'&&s.coverageAssertions.evidenceRef.length<=4000);
    check(Array.isArray(s.bindings)&&s.bindings.length<=1000);
    const keys=new Set();const bindings=s.bindings.map(b=>{
      exact(b,['memberId','bindingRevision','hostId','threadId','role','roleEpoch','from','to','evidenceRef']);
      for(const k of ['memberId','hostId','threadId','roleEpoch'])id(b[k]);check(['Manager','Liaison','Worker'].includes(b.role));
      check(Number.isSafeInteger(b.bindingRevision)&&b.bindingRevision>0);time(b.from);time(b.to);check(b.from<=b.to);
      check(typeof b.evidenceRef==='string'&&b.evidenceRef.length>0&&b.evidenceRef.length<=4000);
      const key=bindingKey(value.teamId,b);check(!keys.has(key),'duplicate_binding_epoch');keys.add(key);return {...b,key};
    });
    exact(s.selection,['taskId','roundId','turnIds','itemIds']);
    for(const k of ['taskId','roundId'])if(s.selection[k]!==null)id(s.selection[k]);
    check((s.selection.taskId===null)===(s.selection.roundId===null));
    for(const k of ['turnIds','itemIds'])check(Array.isArray(s.selection[k])&&s.selection[k].length<=1000&&s.selection[k].every(v=>id(v))&&new Set(s.selection[k]).size===s.selection[k].length);
    if(s.kind==='codex-jsonl'||s.kind==='native-items')check(bindings.length>0&&new Set(bindings.map(b=>`${b.hostId}/${b.threadId}`)).size===1,'ambiguous_source_thread');
    return {...s,path,bindings};
  });
  return {...value,sources};
}
export function scopeRecord(record,source,manifest) {
  const at=record.startAt??record.at??record.endAt;
  if(!at || at<source.authorizedFrom||at>source.authorizedTo)return null;
  const candidates=record.kind==='stage'?[]:source.bindings.filter(b=>b.from<=at&&at<b.to&&(!record.hostId||b.hostId===record.hostId)&&(!record.threadId||b.threadId===record.threadId)&&(!record.memberId||b.memberId===record.memberId)&&(!record.role||b.role===record.role));
  const binding=candidates.length===1?candidates[0]:null;
  // Ambiguous epochs do not fall through to a current owner.
  const taskId=record.taskId??(source.selection.turnIds.includes(record.turnId)||source.selection.itemIds.includes(record.itemId)?source.selection.taskId:null);
  const attribution=record.taskId?'explicit':taskId?'selected-task':record.attributionHint==='team-shared'||binding&&['Manager','Liaison'].includes(binding.role)?'team-shared':'team-unassigned';
  return {...record,sourceId:source.sourceId,teamId:manifest.teamId,bindingKey:binding?.key??null,memberId:binding?.memberId??null,role:binding?.role??null,
    taskId,attribution,missing:[...(record.missing??[]),...(!binding?['missing-or-ambiguous-binding-epoch']:[])],
    authorizedFrom:source.authorizedFrom,authorizedTo:source.authorizedTo,epochEnd:binding?.to??null};
}
