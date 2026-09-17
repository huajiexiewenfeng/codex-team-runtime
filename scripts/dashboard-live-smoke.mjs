// Isolated interactive browser fixture; never opens a real state/Registry or host task.
// Run explicitly, then send: update | grow | fail | recover | reads | stop on stdin.
import {createInterface} from 'node:readline';
import {demoState} from '../src/demo.mjs';
import {evolve} from '../src/runtime.mjs';
import {startDashboardServer} from '../src/dashboard-live.mjs';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDailyView} from '../src/metrics-daily-export.mjs';

let state=demoState(),broken=false,reads=0;
const metricsReportPath=join(await mkdtemp(join(tmpdir(),'portal-fixture-')),'report.json');
const report=buildDailyView(state,{schemaVersion:1,teamId:state.team.id,records:[{id:'fixture-usage',hostId:'fixture-host',threadId:'fixture-thread-manager',at:'2026-09-11T09:00:00.000Z',turnId:null,model:null,usage:{input:100,cachedInput:20,output:40,reasoningOutput:null,total:140},source:{kind:'fixture',ref:'portal-smoke'}}],links:[],diagnostics:[]},{asOf:'2026-09-11T10:00:00.000Z',from:'2026-09-11',to:'2026-09-11'});
await writeFile(metricsReportPath,JSON.stringify(report));
const service=await startDashboardServer({statePath:'fixture-not-a-real-state.json',metricsReportPath,port:0,cacheMs:0,read:async()=>{reads++;if(broken)throw new Error('Fixture source unavailable');return structuredClone(state);}});
console.log(JSON.stringify({fixture:true,url:service.url}));
const lines=createInterface({input:process.stdin,terminal:false});
for await(const line of lines){
 if(line==='stop'){await service.close();lines.close();break;}
 if(line==='fail')broken=true;
 else if(line==='recover')broken=false;
 else if(line==='update'||line==='grow'){
  const at=new Date().toISOString();
  state=evolve(state,{id:`browser-update-${state.version}`,type:'observe',actor:'worker-04',roundId:'round-demo',taskId:'T-4',at,observedAt:at,summary:`浏览器验收进展 ${state.version+1} · <安全转义>${line==='grow'?' · 用于检查上方卡片增高时阅读锚点保持'.repeat(60):''}`,progress:true,source:{kind:'fixture',ref:'local-browser-smoke'}},state.version);
 }
 console.log(JSON.stringify({fixture:true,version:state.version,broken,reads}));
}
await service.close();
