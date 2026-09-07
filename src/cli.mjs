import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createState, snapshot } from './runtime.mjs';
import { readState, initialize, transact, atomicWrite } from './store.mjs';
import { render } from './render.mjs';
import { demoState } from './demo.mjs';
import { start, attach, detach, resume, registerWorker } from './session.mjs';

const json=async path=>JSON.parse(await readFile(path,'utf8'));
async function exportView(state,directory,asOf,roundId) {
 const view=snapshot(state,asOf,roundId);
 // New directory only. READY is written last; incomplete exports never carry it.
 await mkdir(directory);
 await atomicWrite(join(directory,'snapshot.json'),JSON.stringify(view,null,2)+'\n',true);
 await atomicWrite(join(directory,'index.html'),render(view),true);
 await atomicWrite(join(directory,'READY.json'),JSON.stringify({snapshotId:view.snapshotId,sourceVersion:view.sourceVersion,asOf:view.asOf})+'\n',true);
 return view;
}
export async function run(args,output=console.log) {
 const [command,...a]=args;
 const now=()=>new Date().toISOString();
 switch(command) {
  case 'start': {if(a.length<2||a.length>3) throw new Error('start <request.json> <new-state.json> [at]'); const s=await start(a[1],await json(a[0]),a[2]??now()); output(`Started local role state version ${s.version}; host capabilities unknown`); break;}
  case 'attach': {if(a.length!==3||!/^\d+$/.test(a[2])) throw new Error('attach <state.json> <request.json> <expectedVersion>'); const s=await attach(a[0],await json(a[1]),Number(a[2])); output(`Recorded attachment version ${s.version}; no host actions`); break;}
  case 'detach': {if(a.length!==3||!/^\d+$/.test(a[2])) throw new Error('detach <state.json> <request.json> <expectedVersion>'); const s=await detach(a[0],await json(a[1]),Number(a[2])); output(`Detached Liaison at version ${s.version}; no host actions`); break;}
  case 'resume': {if(a.length<2||a.length>4) throw new Error('resume <state.json> <caller.json> [asOf] [roundId]'); output(JSON.stringify(await resume(a[0],await json(a[1]),a[2]??now(),a[3]??null),null,2)); break;}
  case 'register-worker': {if(a.length!==3||!/^\d+$/.test(a[2])) throw new Error('register-worker <state.json> <request.json> <expectedVersion>'); const s=await registerWorker(a[0],await json(a[1]),Number(a[2])); output(`Registered local Worker record version ${s.version}; no task created`); break;}
  case 'queue-task': case 'start-task': case 'cancel-queued': {
   if(a.length!==3||!/^\d+$/.test(a[2])||!Number.isSafeInteger(Number(a[2]))) throw new Error(`${command} <state.json> <request.json> <expectedVersion>`);
   const {queueTask,startTask,cancelQueuedTask}=await import('./scheduling.mjs');
   const s=await ({'queue-task':queueTask,'start-task':startTask,'cancel-queued':cancelQueuedTask}[command])(a[0],await json(a[1]),Number(a[2]));
   output(`Recorded ${command} at version ${s.version}; no host message sent`);break;
  }
  case 'dispatch-plan': {
   if(a.length!==3)throw new Error('dispatch-plan <state.json> <caller.json> <workerId>');
   const {planDispatch}=await import('./scheduling.mjs');output(JSON.stringify(planDispatch(await readState(a[0]),await json(a[1]),a[2]),null,2));break;
  }
  case 'delivery-check': case 'delivery-claim': {
   if(a.length!==3||!/^\d+$/.test(a[2])||!Number.isSafeInteger(Number(a[2])))throw new Error(`${command} <state.json> <request.json> <expectedVersion>`);
   const {checkDelivery,claimDelivery}=await import('./delivery.mjs');const s=await (command==='delivery-check'?checkDelivery:claimDelivery)(a[0],await json(a[1]),Number(a[2]));
   output(`Recorded ${command} at version ${s.version}; no host message sent`);break;
  }
  case 'delivery-plan': {
   if(a.length!==3)throw new Error('delivery-plan <state.json> <caller.json> <taskId>');const {planDelivery}=await import('./delivery.mjs');output(JSON.stringify(planDelivery(await readState(a[0]),await json(a[1]),a[2]),null,2));break;
  }
  case 'supervision-plan': {
   if(a.length<2||a.length>3) throw new Error('supervision-plan <state.json> <caller.json> [cursors.json]');
   const { planSupervision }=await import('./supervision.mjs');
   output(JSON.stringify(planSupervision(await readState(a[0]),await json(a[1]),a[2]?await json(a[2]):[]),null,2)); break;
  }
  case 'submission-notice': {
   if(a.length!==3) throw new Error('submission-notice <state.json> <worker-caller.json> <taskId>');
   const {prepareSubmissionNotice}=await import('./submission-notice.mjs');
   output(JSON.stringify(prepareSubmissionNotice(await readState(a[0]),await json(a[1]),a[2]),null,2));break;
  }
  case 'receive-submission': {
   if(a.length<5||a.length>6||!/^\d+$/.test(a[4])||!Number.isSafeInteger(Number(a[4]))) throw new Error('receive-submission <state.json> <manager-caller.json> <notice.json> <eventId> <expectedVersion> [at]');
   const {receiveSubmissionNotice}=await import('./submission-notice.mjs');
   output(JSON.stringify(await receiveSubmissionNotice({statePath:a[0],caller:await json(a[1]),notice:await json(a[2]),eventId:a[3],expectedVersion:Number(a[4]),at:a[5]??now()}),null,2));break;
  }
  case 'reporting-init': {
   if(a.length<3||a.length>4) throw new Error('reporting-init <state.json> <new-ledger.json> <caller.json> [at]');
   const {initReporting}=await import('./reporting-store.mjs');
   const ledger=await initReporting(a[1],a[0],await json(a[2]),a[3]??now());
   output(`Initialized local reporting ledger version ${ledger.version}; no automation created`);break;
  }
  case 'reporting-plan': {
   if(a.length!==3) throw new Error('reporting-plan <state.json> <ledger.json> <caller.json>');
   const {readReporting}=await import('./reporting-store.mjs'),{planReporting}=await import('./reporting.mjs');
   output(JSON.stringify(planReporting(await readState(a[0]),await readReporting(a[1]),await json(a[2])),null,2));break;
  }
  case 'reporting-apply': {
   if(a.length!==5||!/^\d+$/.test(a[4])) throw new Error('reporting-apply <state.json> <ledger.json> <caller.json> <event.json> <expectedVersion>');
   const {transactReporting}=await import('./reporting-store.mjs');
   const ledger=await transactReporting(a[1],a[0],await json(a[2]),await json(a[3]),Number(a[4]));
   output(`Recorded local reporting ledger version ${ledger.version}; host actions are separate`);break;
  }
  case 'reporting-tick': case 'reporting-progress': {
   if(a.length<4||a.length>5) throw new Error(`${command} <state.json> <ledger.json> <caller.json> <automationId> [asOf]`);
   const {readReporting}=await import('./reporting-store.mjs'),{planReportingTick}=await import('./reporting-tick.mjs');
   const plan=command==='reporting-progress'?(await import('./reporting-progress.mjs')).prepareProgressReport:planReportingTick;
   output(JSON.stringify(plan(await readState(a[0]),await readReporting(a[1]),await json(a[2]),a[3],a[4]??now()),null,2));break;
  }
  case 'init': { if(a.length<2||a.length>3) throw new Error('init <config.json> <state.json> [at]'); const s=createState(await json(a[0]),a[2]??now()); await initialize(a[1],s); output(`Initialized version ${s.version}`); break; }
  case 'apply': { if(a.length!==3||!/^\d+$/.test(a[2])) throw new Error('apply <state.json> <event.json> <expectedVersion>'); const s=await transact(a[0],Number(a[2]),await json(a[1])); output(`Applied version ${s.version}`); break; }
  case 'snapshot': case 'render': { if(a.length<2||a.length>4) throw new Error('snapshot|render <state.json> <new-output-directory> [asOf] [roundId]'); const v=await exportView(await readState(a[0]),resolve(a[1]),a[2]??now(),a[3]??null); output(`Read-only snapshot ${v.snapshotId}: ${resolve(a[1])}`); break; }
  case 'demo': { if(a.length!==1) throw new Error('demo <new-output-directory>'); const directory=resolve(a[0]); await mkdir(dirname(directory),{recursive:true}); await mkdir(directory); const s=demoState(); await initialize(join(directory,'state.json'),s); const v=await exportView(s,join(directory,'view'),'2026-09-05T01:00:00.000Z','round-demo'); output(`FIXTURE / 模拟来源: ${join(directory,'view','index.html')}\nSnapshot ${v.snapshotId}`); break; }
  default: throw new Error('Commands: start, attach, detach, resume, register-worker, queue-task, start-task, cancel-queued, dispatch-plan, delivery-plan, delivery-check, delivery-claim, supervision-plan, submission-notice, receive-submission, reporting-init, reporting-plan, reporting-apply, reporting-tick, reporting-progress, init, apply, snapshot, render, demo. See docs/runtime-usage.md');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2)).catch(error=>{console.error(`Error: ${error.message}`);process.exitCode=1;});
