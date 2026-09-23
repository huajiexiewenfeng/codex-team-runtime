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
  case 'queue-task': case 'start-task': case 'cancel-queued': case 'cancel-stopped': {
   if(a.length!==3||!/^\d+$/.test(a[2])||!Number.isSafeInteger(Number(a[2]))) throw new Error(`${command} <state.json> <request.json> <expectedVersion>`);
   const {queueTask,startTask,cancelQueuedTask,cancelStoppedTask}=await import('./scheduling.mjs');
   const s=await ({'queue-task':queueTask,'start-task':startTask,'cancel-queued':cancelQueuedTask,'cancel-stopped':cancelStoppedTask}[command])(a[0],await json(a[1]),Number(a[2]));
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
   const notifications=a.at(-1)==='--notifications';
   const inputs=notifications?a.slice(0,-1):a;
   if(inputs.length<2||inputs.length>3||inputs.some(v=>v.startsWith('--'))) throw new Error('supervision-plan <state.json> <caller.json> [cursors.json] [--notifications]');
   const { readSupervisionPlan }=await import('./supervision.mjs');
   output(JSON.stringify(await readSupervisionPlan(inputs[0],await json(inputs[1]),inputs[2]?await json(inputs[2]):[],{notifications}),null,2)); break;
  }
  case 'submission-notice': {
   if(a.length!==3&&!(a.length===5&&a[3]==='--notice-out'&&a[4])) throw new Error('submission-notice <state.json> <worker-caller.json> <taskId> [--notice-out <new-notice.json>]');
   const {prepareSubmissionNotice}=await import('./submission-notice.mjs');
   const prepared=prepareSubmissionNotice(await readState(a[0]),await json(a[1]),a[2]);
   // Keep protocol dates as JSON strings; shell DateTime roundtrips can change them.
   if(a.length===5)await atomicWrite(resolve(a[4]),JSON.stringify(prepared.notice,null,2)+'\n',true);
   output(JSON.stringify(prepared,null,2));break;
  }
  case 'notice-request': {
   if(a.length!==3)throw new Error('notice-request <notice.json> <fields.json> <new-request.json>');
   const notice=await json(a[0]),fields=await json(a[1]);
   const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
   if(!object(notice))throw new Error('Invalid notice object');
   const allowed=['caller','expectedVersion','expectedLedgerVersion','baseline','attemptId','result','at'];
   if(!object(fields)||Object.keys(fields).some(key=>!allowed.includes(key)))throw new Error('Invalid notice request fields');
   // A serialization helper, not state validation, result evidence or authorization.
   // Operation-specific validation remains in notice-track/claim/result.
   await atomicWrite(resolve(a[2]),JSON.stringify({...fields,notice},null,2)+'\n',true);
   output('Prepared new notice request; no state change or host message');break;
  }
  case 'receive-submission': {
   if(a.length<5||a.length>6||!/^\d+$/.test(a[4])||!Number.isSafeInteger(Number(a[4]))) throw new Error('receive-submission <state.json> <manager-caller.json> <notice.json> <eventId> <expectedVersion> [at]');
   const {receiveSubmissionNotice}=await import('./submission-notice.mjs');
   output(JSON.stringify(await receiveSubmissionNotice({statePath:a[0],caller:await json(a[1]),notice:await json(a[2]),eventId:a[3],expectedVersion:Number(a[4]),at:a[5]??now()}),null,2));break;
  }
  case 'pending-submissions': {
   if(a.length!==2) throw new Error('pending-submissions <state.json> <manager-caller.json>');
   const {pendingSubmissions}=await import('./submission-notice.mjs');
   output(JSON.stringify(pendingSubmissions(await readState(a[0]),await json(a[1])),null,2));break;
  }
  case 'notice-plan': {
   if(a.length<3||a.length>4) throw new Error('notice-plan <state.json> <caller.json> <notice.json> [at]');
   const {planNoticeDelivery}=await import('./submission-recovery.mjs');
   output(JSON.stringify(await planNoticeDelivery({statePath:a[0],caller:await json(a[1]),notice:await json(a[2]),at:a[3]??now()}),null,2));break;
  }
  case 'notice-track': case 'notice-claim': case 'notice-result': {
   if(a.length!==2) throw new Error(`${command} <state.json> <request.json>`);
   const {trackSubmissionNotice,claimNoticeDelivery,recordNoticeResult}=await import('./submission-recovery.mjs');
   const operation={'notice-track':trackSubmissionNotice,'notice-claim':claimNoticeDelivery,'notice-result':recordNoticeResult}[command];
   const request=await json(a[1]);
   // Never accept executable projection/transport options or a path override from JSON.
   const {caller,notice,expectedVersion,expectedLedgerVersion,baseline,attemptId,result,at}=request;
   output(JSON.stringify(await operation({statePath:a[0],caller,notice,expectedVersion,expectedLedgerVersion,baseline,attemptId,result,at:at??now()}),null,2));break;
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
  case 'task-timeline': {
   if(a.length!==2)throw new Error('task-timeline <manifest.json> <new-output-directory>');
   const {collectTaskTimeline,exportTaskTimeline}=await import('./task-timeline-input.mjs');
   const report=await collectTaskTimeline(await json(a[0]),dirname(resolve(a[0])));
   await exportTaskTimeline(report,resolve(a[1]));
   output(`Read-only partial task timeline: ${resolve(a[1],'timeline.md')}`);break;
  }
  case 'task-eval': {
   if(a.length!==2)throw new Error('task-eval <timeline-report.json> <new-output-directory>');
   const {exportTaskEvaluation}=await import('./task-eval.mjs');
   await exportTaskEvaluation(resolve(a[0]),resolve(a[1]));
   output(`Read-only evaluation candidates: ${resolve(a[1],'evaluation.md')}`);break;
  }
  case 'metrics-import': {
   if(a.length!==3)throw new Error('metrics-import <ledger.json> <source.json> <new-ledger.json>');
   const {validateUsage,mergeUsage}=await import('./metrics-usage.mjs');
   const ledger=validateUsage(await json(a[0])),descriptor=await json(a[1]),fields=['path','hostId','threadId','sourceRef'];
   if(!descriptor||typeof descriptor!=='object'||Array.isArray(descriptor)||Object.keys(descriptor).length!==fields.length||!Object.keys(descriptor).every(key=>fields.includes(key)))throw new Error('Unknown field or invalid source descriptor');
   if(typeof descriptor.path!=='string'||descriptor.path.trim()===''||typeof descriptor.sourceRef!=='string'||descriptor.sourceRef.trim()==='')throw new Error('Invalid source descriptor');
   for(const key of ['hostId','threadId'])if(typeof descriptor[key]!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(descriptor[key]))throw new Error(`Invalid ${key}`);
   const sourcePath=resolve(dirname(resolve(a[1])),descriptor.path),{readCodexUsageSource}=await import('./metrics-input.mjs');
   const parsed=await readCodexUsageSource(sourcePath,{hostId:descriptor.hostId,threadId:descriptor.threadId,sourceRef:descriptor.sourceRef});
   const merged=mergeUsage(ledger,parsed.records,parsed.diagnostics,parsed.observations),{atomicWrite}=await import('./store.mjs');
   await atomicWrite(resolve(a[2]),JSON.stringify(merged,null,2)+'\n',true);
   output(`Imported ${parsed.records.length} observed usage record(s) into a new ledger; no directory scan`);break;
  }
  case 'metrics': case 'metrics-export': {
   const usage=command==='metrics'?'metrics <state.json> <ledger.json> [asOf]':'metrics-export <state.json> <ledger.json> <new-output-directory> [asOf]';
   if((command==='metrics'&&(a.length<2||a.length>3))||(command==='metrics-export'&&(a.length<3||a.length>4)))throw new Error(usage);
   const {readRawState}=await import('./store.mjs'),{buildMetrics}=await import('./metrics.mjs');
   const report={...buildMetrics(await readRawState(a[0]),await json(a[1]),a[command==='metrics'?2:3]??now()),sourceScope:{kind:'recorded-state-snapshot',registryRefreshed:false,liveTelemetry:false}};
   if(command==='metrics'){output(JSON.stringify(report,null,2));break;}
   const {exportMetrics}=await import('./metrics-export.mjs');await exportMetrics(report,resolve(a[2]));
   output(`Offline historical metrics snapshot: ${resolve(a[2],'index.html')}`);break;
  }
  case 'metrics-daily': case 'metrics-daily-export': {
   const usage=command==='metrics-daily'?'metrics-daily <state.json> <ledger.json> <options.json>':'metrics-daily-export <state.json> <ledger.json> <options.json> <new-output-directory>';
   if((command==='metrics-daily'&&a.length!==3)||(command==='metrics-daily-export'&&a.length!==4))throw new Error(usage);
   const {readRawState}=await import('./store.mjs'),{buildDailyView,exportDailyMetrics}=await import('./metrics-daily-export.mjs');
   const rawOptions=await json(a[2]),hasMcp=rawOptions!==null&&typeof rawOptions==='object'&&!Array.isArray(rawOptions)&&Object.hasOwn(rawOptions,'mcpObservations');
   const {mcpObservations,...dailyOptions}=hasMcp?rawOptions:{mcpObservations:null,...rawOptions};
   let serverInput=null;
   if(hasMcp){const {readMcpObservationManifest}=await import('./metrics-mcp-input.mjs');serverInput=await readMcpObservationManifest(mcpObservations,dirname(resolve(a[2])));}
   const view=buildDailyView(await readRawState(a[0]),await json(a[1]),dailyOptions,serverInput);
   if(command==='metrics-daily'){output(JSON.stringify(view,null,2));break;}
   await exportDailyMetrics(view,resolve(a[3]));output(`Offline daily metrics snapshot: ${resolve(a[3],'index.html')}`);break;
  }
  case 'init': { if(a.length<2||a.length>3) throw new Error('init <config.json> <state.json> [at]'); const s=createState(await json(a[0]),a[2]??now()); await initialize(a[1],s); output(`Initialized version ${s.version}`); break; }
  case 'apply': { if(a.length!==3||!/^\d+$/.test(a[2])) throw new Error('apply <state.json> <event.json> <expectedVersion>'); const s=await transact(a[0],Number(a[2]),await json(a[1])); output(`Applied version ${s.version}`); break; }
  case 'dashboard': {
   const codexLinks=a.at(-1)==='--codex-links',values=codexLinks?a.slice(0,-1):a;
   if(values.length<2||values.length>3||values.slice(2).some(x=>x.startsWith('--')))throw new Error('dashboard <state.json> <new-output-directory> [asOf] [--codex-links]');
   const {exportDashboard}=await import('./dashboard-export.mjs');
   const manifest=await exportDashboard(await readState(values[0]),resolve(values[1]),values[2]??now(),{codexLinks});
   output(`Read-only dashboard v${manifest.sourceVersion}: ${resolve(a[1],'index.html')} (${manifest.pages.length} pages)`);break;
  }
  case 'dashboard-serve': {
   const usage='dashboard-serve <state.json> [--port <0..65535>] [--codex-links] [--metrics-report <report.json>] [--timeline-report <report.json> | --timeline-index <index.json>]';
   if(!a[0]||a[0].startsWith('--'))throw new Error(usage);
   let port=4319,codexLinks=false,seenPort=false,metricsReportPath=null,timelineReportPath=null,timelineIndexPath=null;
   for(let i=1;i<a.length;i++){
    if(a[i]==='--codex-links'&&!codexLinks){codexLinks=true;continue;}
    if(a[i]==='--metrics-report'&&metricsReportPath===null&&a[i+1]&&!a[i+1].startsWith('--')){metricsReportPath=a[++i];continue;}
    if(a[i]==='--timeline-report'&&a[i+1]&&!a[i+1].startsWith('--')){timelineReportPath??=[];timelineReportPath.push(a[++i]);continue;}
    if(a[i]==='--timeline-index'&&timelineIndexPath===null&&a[i+1]&&!a[i+1].startsWith('--')){timelineIndexPath=a[++i];continue;}
    if(a[i]==='--port'&&!seenPort&&/^\d+$/.test(a[i+1]??'')){seenPort=true;port=Number(a[++i]);continue;}
    throw new Error(usage);
   }
   const {startDashboardServer}=await import('./dashboard-live.mjs');
   const service=await startDashboardServer({statePath:a[0],port,codexLinks,metricsReportPath,timelineReportPath,timelineIndexPath});
   output(`Read-only Team Dashboard · 任务进度 / 指标统计: ${service.url}\nVisible work tab checks every 5 seconds; metrics reads a bound report on demand, without collection. No Agent wakeups. Ctrl+C stops this local service.`);
   return service;
  }
  case 'snapshot': case 'render': { if(a.length<2||a.length>4) throw new Error('snapshot|render <state.json> <new-output-directory> [asOf] [roundId]'); const v=await exportView(await readState(a[0]),resolve(a[1]),a[2]??now(),a[3]??null); output(`Read-only snapshot ${v.snapshotId}: ${resolve(a[1])}`); break; }
  case 'demo': { if(a.length!==1) throw new Error('demo <new-output-directory>'); const directory=resolve(a[0]); await mkdir(dirname(directory),{recursive:true}); await mkdir(directory); const s=demoState(); await initialize(join(directory,'state.json'),s); const v=await exportView(s,join(directory,'view'),'2026-09-05T01:00:00.000Z','round-demo'); output(`FIXTURE / 模拟来源: ${join(directory,'view','index.html')}\nSnapshot ${v.snapshotId}`); break; }
  default: throw new Error('Commands: start, attach, detach, resume, register-worker, queue-task, start-task, cancel-queued, cancel-stopped, dispatch-plan, delivery-plan, delivery-check, delivery-claim, supervision-plan, submission-notice, notice-request, receive-submission, pending-submissions, notice-track, notice-plan, notice-claim, notice-result, reporting-init, reporting-plan, reporting-apply, reporting-tick, reporting-progress, metrics-import, metrics, metrics-export, metrics-daily, metrics-daily-export, init, apply, snapshot, render, dashboard, dashboard-serve, demo. See docs/runtime-usage.md');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) run(process.argv.slice(2)).then(service=>{
 if(!service?.close)return;
 const stop=()=>{void service.close().catch(error=>{console.error(`Error: ${error.message}`);process.exitCode=1;});};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
}).catch(error=>{console.error(`Error: ${error.message}`);process.exitCode=1;});
