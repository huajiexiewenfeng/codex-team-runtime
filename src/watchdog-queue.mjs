import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
const exec=promisify(execFile);
// Deployment approval belongs to reviewed integration code, never an incoming
// observation, manifest flag or arbitrary fixture. No production build approved.
const deployments=Object.freeze([]);
export function queueReminderRequest(state, items) {
 const manager=state.members.find(m=>m.role==='Manager'&&m.lifecycle==='active'&&m.binding.status==='bound');
 if(!manager)throw new Error('Current bound Manager unavailable');
 if(!Array.isArray(items)||items.length<1||items.length>20)throw new Error('Expected 1..20 reminders');
 const text=JSON.stringify({kind:'watchdog-reminder',teamId:state.team.id,items:items.map(a=>({taskId:a.taskId,executionId:a.executionId,type:a.type,evidence:a.evidence})),instruction:'Recheck current task/execution, enabled state and anomaly validity before deciding; do not automatically dispatch or repair.'});
 if(Buffer.byteLength(text,'utf8')>12000)throw new Error('Compact reminder exceeds safe candidate bound');
 return {hostId:manager.binding.hostId,threadId:manager.binding.threadId,args:['queue','--thread',manager.binding.threadId,'--message',text]};
}
// Read-only probe, explicit exact binary. Does not attach a server, load a chat,
// invoke queue, enable --resume or create a daemon. CLI help is NOT safety proof.
export async function probeWatchdogQueue(executable,{runner=exec}={}) {
 if(typeof executable!=='string'||!isAbsolute(executable))throw new Error('Explicit absolute CLI path required');
 const path=await realpath(executable),sha256=createHash('sha256').update(await readFile(path)).digest('hex');
 const options={encoding:'utf8',windowsHide:true,shell:false,timeout:10000,maxBuffer:65536};
 const version=(await runner(path,['--version'],options)).stdout.trim();
 const help=(await runner(path,['queue','--help'],options)).stdout;
 const supported=/Usage:\s*codex queue/.test(help)&&help.includes('--thread')&&help.includes('--message');
 return {path,sha256,version,commandAvailable:supported,nonInterruptingSemantics:'unknown',consumption:'unknown',notLoadedWakeup:'unknown',productionApproved:deployments.some(d=>d.sha256===sha256&&d.version===version)};
}
// Concrete transport kept behind an audited deployment allowlist. It deliberately
// never upgrades a zero exit code into delivery/consumption/wakeup evidence.
export async function enqueueWatchdogQueue(probe, request,{runner=exec}={}) {
 if(!deployments.some(d=>d.sha256===probe.sha256&&d.version===probe.version&&d.hostId===request.hostId))throw new Error('WATCHDOG_QUEUE_PENDING_HOST_VALIDATION');
 const current=createHash('sha256').update(await readFile(probe.path)).digest('hex');
 if(current!==probe.sha256)throw new Error('CLI changed since validation');
 try {await runner(probe.path,request.args,{encoding:'utf8',windowsHide:true,shell:false,timeout:10000,maxBuffer:65536});return {outcome:'unknown',transport:'command-returned',consumption:'unknown'};}
 catch{return {outcome:'unknown',transport:'command-error',consumption:'unknown'};}
}
