// Offline candidate evaluation only; never authorizes sends, releases or execution.
const keys=['submission','notification','attemptMatched','resultRecorded','explicitWait','remainingWork'];
const values={submission:['recorded','not-recorded','unknown'],notification:['delivered','policy-denied','failed','unknown'],attemptMatched:[true,false,null],resultRecorded:[true,false,null],explicitWait:[true,false,null],remainingWork:[true,false,null]};
const reference=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
export function evaluateCompletionExit(sample){
 if(!sample||sample.schemaVersion!==1||!reference(sample.sampleId)||Object.keys(sample).some(k=>!['schemaVersion','sampleId',...keys].includes(k)))throw new Error('Invalid completion sample');
 for(const key of keys){
  const f=sample[key];
  if(!f||Object.keys(f).some(k=>!['value','evidence'].includes(k))||!values[key].includes(f.value)||!Array.isArray(f.evidence)||f.evidence.length>32||f.evidence.some(r=>!reference(r)))throw new Error('Invalid completion fact');
 }
 const exclusions=[];
 if(sample.submission.value==='not-recorded')exclusions.push('submission-not-recorded');
 if(['policy-denied','failed'].includes(sample.notification.value))exclusions.push('notification-not-delivered');
 if(sample.attemptMatched.value===false)exclusions.push('attempt-mismatch');
 if(sample.explicitWait.value===true)exclusions.push('explicit-wait-request');
 if(sample.remainingWork.value===true)exclusions.push('remaining-authorized-work');
 const missing=keys.filter(k=>!sample[k].evidence.length||sample[k].value===null||sample[k].value==='unknown');
 if(sample.resultRecorded.value===false)missing.push('result-write-receipt');
 const assessment=exclusions.length?'not-applicable':missing.length?'insufficient-evidence':'eligible-for-trial-review';
 return {schemaVersion:1,rulesVersion:'completion-exit-eval-v1',candidateId:'E01',sampleId:sample.sampleId,assessment,
  evidenceAssurance:'analyst-reviewed-assertions',evidence:keys.map(key=>({fact:key,references:[...sample[key].evidence]})),exclusions,missing,
  activeExperiment:null,authorizesExecution:false,releasesWorker:false,approvesTask:false,
  recommendation:assessment==='eligible-for-trial-review'?'可进入有限试用方案审查；不等于已激活或获准执行。':'不应用默认快速结束候选；先按原授权流程处理已有要求或证据缺口。',
  retainedBoundaries:['business-submitted-is-not-approved','worker-stays-occupied','no-denial-bypass','no-automatic-retry','no-production-mutation'],
  limits:['assertions-not-independently-verified','not-a-host-authorization-record','no-causal-or-savings-conclusion']};
}
