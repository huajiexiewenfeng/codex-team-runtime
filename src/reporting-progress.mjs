import { planReportingTick } from './reporting-tick.mjs';

const labels={cancelled:'已取消',queued:'排队中',executing:'执行中',submitted:'已提交，待验收',reviewing:'审查中，待验收',rework:'返工中',approved:'已验收',blocked:'阻塞'};
const duration=ms=>ms===null?'耗时未知':`${Math.floor(ms/60000)}分${Math.floor(ms%60000/1000)}秒`;
// Render titles as inert single-line text, never as Markdown controls or instructions.
const plain=value=>String(value).replace(/[\r\n\u0000-\u001f\u007f]/g,' ').replace(/[\\`*_{}\[\]()<>#+.!|~-]/g,'\\$&');

export function prepareProgressReport(state,ledger,caller,automationId,asOf){
 const gate=planReportingTick(state,ledger,caller,automationId,asOf);
 const result={gate,delivery:'not-sent',report:null,text:null};
 if(!gate.allowProgressReport)return result;
 const view=gate.snapshot,rounds=view.rounds.filter(r=>r.status==='open').map(r=>({id:r.id,title:r.title}));
 const open=new Set(rounds.map(r=>r.id));
 const tasks=view.tasks.filter(t=>open.has(t.roundId)).map(t=>({id:t.id,roundId:t.roundId,title:t.title,workerId:t.workerId,status:t.status,elapsedMs:t.elapsedMs,phaseElapsedMs:t.phaseElapsedMs,submissions:t.submissions,freshness:t.freshness,observedAt:t.latestObservation?.observedAt??null,blockReason:t.status==='blocked'?(view.events.findLast(e=>e.taskId===t.id&&e.type==='block')?.summary??null):null}));
 const counts={total:tasks.length,approved:tasks.filter(t=>t.status==='approved').length,awaitingReview:tasks.filter(t=>['submitted','reviewing'].includes(t.status)).length,blocked:tasks.filter(t=>t.status==='blocked').length,cancelled:tasks.filter(t=>t.status==='cancelled').length};
 const report={asOf:view.asOf,sourceVersion:view.sourceVersion,ledgerVersion:ledger.version,rounds,tasks,counts};
 const lines=[`团队进度（状态版本 ${report.sourceVersion}；截至 ${report.asOf}）`,`开放轮次 ${rounds.length}；任务 ${counts.total}；已验收 ${counts.approved}；待验收 ${counts.awaitingReview}；阻塞 ${counts.blocked}；已取消 ${counts.cancelled}。`];
 for(const t of tasks)lines.push(`${plain(t.title)}：${labels[t.status]}；总耗时 ${duration(t.elapsedMs)}；当前阶段 ${duration(t.phaseElapsedMs)}；观察${t.freshness==='unknown'?'未知':t.freshness==='stale'?'已陈旧':'已记录'}。${t.blockReason===null?'':` 阻塞原因：${plain(t.blockReason)}`}`);
 lines.push('耗时包含等待，不代表 Agent 持续计算时间。以上为本地记录，不代表实时宿主状态；报告尚未投递。');
 return {...result,report,text:lines.join('\n')};
}
