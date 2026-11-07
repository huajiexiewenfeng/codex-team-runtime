// Explicit isolated benchmark: raw timings, no Token estimates or latency claims.
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {createState,evolve} from '../src/runtime.mjs';
import {prepareSubmissionNotice,receiveSubmissionNotice,planSubmissionReview} from '../src/submission-notice.mjs';
import {managerRequest} from '../src/manager-operations.mjs';
import {atomicWrite} from '../src/store.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'manager-operations-bench-'))),at='2026-10-01T00:00:00.000Z';
const source={kind:'fixture',ref:'isolated benchmark'},caller={hostId:'fake',threadId:'manager'};
let s=createState({teamId:'bench',name:'Offline benchmark',source,members:[{id:'m',role:'Manager',name:'m',lifecycle:'active',binding:{status:'bound',...caller}},{id:'l',role:'Liaison',name:'l',lifecycle:'active',binding:{status:'bound',hostId:'fake',threadId:'liaison'}},{id:'w',role:'Worker',name:'w',lifecycle:'active',binding:{status:'bound',hostId:'fake',threadId:'worker'}}]},at);
for(const e of [{id:'open',type:'openRound',roundId:'r',title:'Round'},
  {id:'assign',type:'assign',roundId:'r',taskId:'t',title:'Task',workerId:'w',required:true,assignedAt:at},
  {id:'submit',type:'submit',roundId:'r',taskId:'t',summary:'中文\r\n'.repeat(250),actor:'w'}])s=evolve(s,{actor:'m',at,source,...e},s.version);
const notice=prepareSubmissionNotice(s,{hostId:'fake',threadId:'worker'},'t').notice,bytes=Buffer.byteLength(JSON.stringify(s));
const time=async fn=>{const start=performance.now();await fn();return performance.now()-start;},samples=[];
try {
  for(let i=0;i<17;i++) {
    const a=join(root,'legacy-'+i+'.json'),b=join(root,'candidate-'+i+'.json'),io=join(root,'io-'+i+'.json');
    await writeFile(a,JSON.stringify(s));await writeFile(b,JSON.stringify(s));await writeFile(io,JSON.stringify(s));
    const request={schemaVersion:1,action:'receive',operationId:'bench-'+i,caller,teamId:'bench',roundId:'r',taskId:'t',workerId:'w',expectedVersion:s.version,mode:'legacy',reason:'before_review',submissionId:'submit',notice};
    const row={iteration:i,warmup:i<2,stateBytes:bytes,corePlanMs:await time(()=>planSubmissionReview(s,caller,notice)),readIoMs:await time(()=>readFile(io)),
      atomicWriteIoMs:await time(()=>atomicWrite(io,JSON.stringify(s)+'\n'))};
    const baseline=async()=>{row.legacyReceiveMs=await time(()=>receiveSubmissionNotice({statePath:a,caller,notice,eventId:'baseline-'+i,expectedVersion:s.version,at}));};
    const candidate=async()=>{row.candidateReceiveMs=await time(async()=>{const r=await managerRequest({statePath:b,request,options:{at}});assert.equal(r.status,'recorded',JSON.stringify(r));});};
    if(i%2){await candidate();await baseline();}else{await baseline();await candidate();}samples.push(row);
  }
  const median=key=>{const a=samples.filter(x=>!x.warmup).map(x=>x[key]).sort((a,b)=>a-b);return a[Math.floor(a.length/2)];};
  console.log(JSON.stringify({environment:{node:process.version,platform:process.platform,arch:process.arch},mode:'legacy schema1, equal submitted state, alternating order',warmups:2,samples,
    medians:Object.fromEntries(['corePlanMs','readIoMs','atomicWriteIoMs','legacyReceiveMs','candidateReceiveMs'].map(k=>[k,median(k)])),
    limitations:['15 measured samples; no stable p95','I/O measurements are separate, not subtracted from total','linked Registry/E05 and host/model/network timings not measured','no Token or fee conversion']},null,2));
} finally {assert.ok(root.startsWith(await realpath(tmpdir())+sep));await rm(root,{recursive:true,force:true,maxRetries:3});}
