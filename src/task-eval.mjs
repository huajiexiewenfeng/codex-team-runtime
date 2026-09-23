import {open,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
const duration=v=>v===null||(Number.isSafeInteger(v)&&v>=0);
const delta=(a,b)=>{
 const valid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
 return valid(a)&&valid(b)&&Date.parse(b)>=Date.parse(a)?Date.parse(b)-Date.parse(a):null;
};
export function evaluateTaskTimeline(r){
 if(r?.schemaVersion!==1||!['task-timeline-v2','task-timeline-v3'].includes(r.rulesVersion)||!id(r.teamId)||!id(r.taskId)||r.coverage?.status!=='partial'||!Array.isArray(r.events)||!Array.isArray(r.gaps))throw new Error('Unsupported timeline report');
 const events=new Map();
 for(const event of r.events){if(!id(event.eventId)||events.has(event.eventId))throw new Error('Invalid or duplicate evidence');events.set(event.eventId,event);}
 const observations=[];
 for(const [index,gap] of r.gaps.entries()){
  const a=events.get(gap.startEventId),b=events.get(gap.endEventId);
  if(!a||!b||a.sourceRef!==b.sourceRef||a.hostId!==b.hostId||a.threadId!==b.threadId)throw new Error('Invalid gap evidence');
  if(!duration(gap.durationMs)||gap.durationMs!==delta(a.observedAt,b.observedAt))throw new Error('Inconsistent gap duration');
  if(gap.durationMs>0)observations.push({kind:'gap',id:`gap-${index}`,durationMs:gap.durationMs,timeBasis:'observedAt',evidence:[a.eventId,b.eventId]});
 }
 if(r.businessTimeline){
  const business=r.businessTimeline;
  if(business.teamId!==r.teamId||business.taskId!==r.taskId||!Array.isArray(business.stages))throw new Error('Business identity mismatch');
  const seen=new Set();
  for(const stage of business.stages){
   if(!id(stage.stageId)||seen.has(stage.stageId))throw new Error('Invalid stage evidence');seen.add(stage.stageId);
   if(!['queued','executing','submitted','reviewing','rework','approved','cancelled','blocked'].includes(stage.status))throw new Error('Invalid stage status');
   if(stage.kind==='terminal-state')continue;
   if(stage.kind!=='declared-stage'||!duration(stage.durationMs)||stage.durationMs!==delta(stage.declaredStartAt,stage.declaredEndAt))throw new Error('Inconsistent stage duration');
   if(stage.durationMs>0)observations.push({kind:'stage',id:`stage-${seen.size}`,stage:stage.status,durationMs:stage.durationMs,timeBasis:'declaredAt',evidence:[stage.stageId]});
  }
 }
 if(!duration(r.endToEndMs)||!duration(r.observedToolUnionMs))throw new Error('Invalid timeline metrics');
 const request=events.get(r.milestones?.requestEventId),delivery=events.get(r.milestones?.deliveryEventId);
 if((r.milestones?.requestEventId&&!request)||(r.milestones?.deliveryEventId&&!delivery)||r.endToEndMs!==delta(request?.observedAt,delivery?.observedAt))throw new Error('Inconsistent milestone duration');
 if(!Array.isArray(r.coverage.missing)||r.coverage.missing.some(code=>!id(code)))throw new Error('Invalid coverage');
 const candidates=['stage','gap'].flatMap(kind=>observations.filter(o=>o.kind===kind).sort((a,b)=>b.durationMs-a.durationMs||a.id.localeCompare(b.id)).slice(0,3)).map(fact=>({
  id:fact.id,status:'needs-human-review',fact,
  hypothesis:fact.kind==='stage'?'该阶段可能包含可减少的协调等待；必要执行、用户等待与外部依赖尚未排除。':'相邻日志之间存在间隔；可能与工具执行、用户等待或未覆盖事件重叠，不能据此归因模型推理或流程浪费。',
  goal:{primaryMetric:fact.kind==='stage'?'同口径声明阶段历时':'补齐该间隔的归因证据',guardrails:['不得遗漏交付和通知','保留独立验收、忙碌保护与权限边界','不以降低质量换速度']},
  singleChange:{owner:'undetermined',proposal:'先复核引用证据和反例；确认原因后仅提出一项差异。',preserve:'模型、并发、验收标准与其他流程暂不改变。'},
  verification:{counterexample:'检查必要构建、等待授权或外部依赖是否足以解释该历时。',next:'补齐加载版本、任务规模、模型、缓存/网络条件；收集至少 3 个可比新任务并检查质量护栏。',decision:'通过需有可比改善且护栏无退化；出现护栏违例停止试用；缺证据继续观察。'},
  disposition:'暂缓行为修改；待人工复核。候选不是执行授权，也不是已经生效的实验。'
 }));
 return {schemaVersion:1,rulesVersion:'task-eval-v1',teamId:r.teamId,taskId:r.taskId,activeExperiment:null,sampleCount:1,
  metrics:{endToEndMs:r.endToEndMs,observedToolUnionMs:r.observedToolUnionMs},
  coverage:{status:'partial',sourceMissing:[...r.coverage.missing],hasBusinessTimeline:!!r.businessTimeline,unknownGapCount:r.gaps.filter(g=>g.durationMs===null).length,limits:['declared-time-is-not-execution','gaps-overlap-tools','no-token-or-quality-comparison','historical-loaded-version-unverified']},
  comparison:{status:'insufficient-evidence',estimatedSavingsMs:null,reason:'只有一个任务样本，没有已核实的可比试用样本。'},candidates};
}
export function renderTaskEvaluation(e){
 const fmt=ms=>ms===null?'未知':`${(ms/1000).toFixed(3)} 秒`;
 const lines=['# 任务半自动 Eval · 待人工复核','',`任务：${e.teamId} / ${e.taskId}`,'',`端到端：${fmt(e.metrics.endToEndMs)}。样本数：1；活动实验：无。`,'',
 '每类最多列出 3 项较长观察；排序不是浪费程度、根因或收益排序。缺少候选也不代表流程高效。阶段与间隔可能重叠，不可相加，不能据此归因。', '',`比较结论：${e.comparison.reason} 节省量：未知。`];
 for(const c of e.candidates){
  lines.push('',`## ${c.id} · ${c.fact.stage??'未归因日志间隔'}`,'',`事实：${fmt(c.fact.durationMs)}；口径 ${c.fact.timeBasis}；证据 ${c.fact.evidence.join('、')}。`,'',`假设：${c.hypothesis}`,'',`目标：${c.goal.primaryMetric}。护栏：${c.goal.guardrails.join('；')}。`,'',`单一差异：${c.singleChange.proposal}${c.singleChange.preserve}`,'',`验证：${c.verification.counterexample}${c.verification.next}${c.verification.decision}`,'',`处置：${c.disposition}`);
 }
 lines.push('',`源报告盲区：${e.coverage.sourceMissing.join('、')||'未列出（不代表完整覆盖）'}。`,'','本报告只提供确定性筛选和人工评估框架，不修改 Skill、Registry、任务或实验台账。',`来源 SHA256：${e.sourceSha256??'未附加文件摘要'}`,'');
 return lines.join('\n');
}
export async function exportTaskEvaluation(inputPath,directory){
 const file=await open(inputPath,'r');let bytes;
 try{
  const info=await file.stat();if(!info.isFile()||info.size>32*1024*1024)throw new Error('Invalid evaluation input file');
  bytes=Buffer.alloc(info.size);let offset=0;
  while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Evaluation input truncated');offset+=bytesRead;}
 }finally{await file.close();}
 const evaluation={...evaluateTaskTimeline(JSON.parse(bytes.toString('utf8'))),sourceSha256:createHash('sha256').update(bytes).digest('hex')};
 const json=JSON.stringify(evaluation,null,2)+'\n';
 await mkdir(directory);await writeFile(join(directory,'evaluation.json'),json,{flag:'wx'});
 await writeFile(join(directory,'evaluation.md'),renderTaskEvaluation(evaluation),{flag:'wx'});
 await writeFile(join(directory,'READY.json'),JSON.stringify({schemaVersion:1,evaluationSha256:createHash('sha256').update(json).digest('hex')})+'\n',{flag:'wx'});
 return evaluation;
}
