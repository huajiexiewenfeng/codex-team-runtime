import {readFile,stat} from 'node:fs/promises';import {atomicWrite} from './store.mjs';import {digest,timestamp} from './watchdog-checker.mjs';
const projection=events=>events.map(e=>[e.id,e.type,e.roundId??null,e.taskId??null]);
const taskKey=t=>JSON.stringify([t.roundId,t.id]);
export async function applyWatchdogCutover(statePath,state,inspection,at){
 timestamp(at);const path=statePath+'.watchdog/cutover.json';let baseline;
 try{if((await stat(path)).size>8*1024*1024)throw new Error('Cutover size exceeded');baseline=JSON.parse(await readFile(path,'utf8'));}
 catch(e){if(e.code!=='ENOENT')throw e;
  if(state.tasks.length>10000||state.events.length>100000)throw new Error('Cutover capacity exceeded');
  baseline={schemaVersion:1,kind:'watchdog-newtasks-only-cutover',statePath,teamId:state.team.id,createdAt:at,sourceVersion:state.version,eventCount:state.events.length,eventPrefixSha256:digest(projection(state.events)),existingTasks:state.tasks.map(t=>[t.roundId,t.id])};await atomicWrite(path,JSON.stringify(baseline,null,2)+'\n',true);
 }
 const keys=['schemaVersion','kind','statePath','teamId','createdAt','sourceVersion','eventCount','eventPrefixSha256','existingTasks'];
 if(!baseline||Object.keys(baseline).length!==keys.length||!keys.every(k=>Object.hasOwn(baseline,k))||baseline.schemaVersion!==1||baseline.kind!=='watchdog-newtasks-only-cutover'||baseline.statePath!==statePath||baseline.teamId!==state.team.id||!Number.isSafeInteger(baseline.eventCount)||baseline.eventCount<0||baseline.eventCount>state.events.length||!Array.isArray(baseline.existingTasks)||baseline.existingTasks.length>10000||baseline.existingTasks.some(x=>!Array.isArray(x)||x.length!==2||x.some(v=>typeof v!=='string')))throw new Error('Cutover binding invalid');
 timestamp(baseline.createdAt);
 if(digest(projection(state.events.slice(0,baseline.eventCount)))!==baseline.eventPrefixSha256)throw new Error('Cutover event prefix changed; explicit reconciliation required');
 const old=new Set(baseline.existingTasks.map(x=>JSON.stringify(x))),newKeys=new Set();
 for(const t of state.tasks){if(old.has(taskKey(t)))continue;const creation=state.events.findIndex(e=>e.taskId===t.id&&e.roundId===t.roundId&&['assign','enqueue','startTask'].includes(e.type));if(creation>=baseline.eventCount)newKeys.add(taskKey(t));}
 const eligibleTaskIds=new Set(state.tasks.filter(t=>newKeys.has(taskKey(t))).map(t=>t.id));
 const anomalies=inspection.anomalies.filter(a=>eligibleTaskIds.has(a.taskId));
 return {inspection:{...inspection,anomalies,hasWork:state.tasks.some(t=>eligibleTaskIds.has(t.id)&&!['approved','cancelled'].includes(t.status))},eligibleTaskIds,summary:{policy:'newtasks-only',createdAt:baseline.createdAt,sourceVersion:baseline.sourceVersion,eventCount:baseline.eventCount,excludedExistingTasks:baseline.existingTasks.length,newEligibleTasks:eligibleTaskIds.size}};
}
