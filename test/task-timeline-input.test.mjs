import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,appendFile,truncate,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readTimelineSource,collectTaskTimeline,exportTaskTimeline} from '../src/task-timeline-input.mjs';
import {run} from '../src/cli.mjs';
import {demoState} from '../src/demo.mjs';
import {renderTimelineMarkdown} from '../src/task-timeline.mjs';
const source={sourceRef:'s',hostId:'local',threadId:'t',role:'Worker',from:'2026-09-18T00:00:00.000Z',to:'2026-09-19T00:00:00.000Z'};
const rows=[{type:'session_meta',payload:{id:'t'}},{timestamp:source.from,type:'response_item',payload:{type:'message',role:'user',content:'秘密 SECRET'}}];
const body=rows.map(JSON.stringify).join('\r\n')+'\r\n';
async function fixture(t) {const dir=await mkdtemp(join(tmpdir(),'timeline-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'source.jsonl');await writeFile(path,body);return{dir,path};}
test('native item file is explicit, scoped, hashed and never exports command content',async t=>{
 const {dir,path}=await fixture(t);
 const page={schemaVersion:1,thread:{id:'t',hostId:'local'},turns:[{id:'turn',items:[{id:'build',type:'commandExecution',durationMs:484805,exitCode:0,status:'completed',command:'SECRET'}]}]};
 const nativePath=join(dir,'native.json');const bytes=JSON.stringify(page);await writeFile(nativePath,bytes);
 const native={path:nativePath,sourceRef:'native',hostId:'local',threadId:'t',role:'Worker',turnId:'turn',itemIds:['build']};
 const manifest={teamId:'team',taskId:'task',sources:[{...source,path}],nativeSources:[native]};
 const r=await collectTaskTimeline(manifest,dir);
 assert.equal(r.nativeObservations[0].items[0].durationMs,484805);assert.match(r.nativeObservations[0].sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(r).includes('SECRET'),false);assert.equal(await readFile(nativePath,'utf8'),bytes);
 assert.match(renderTimelineMarkdown(r),/484\.805 秒/);
 await assert.rejects(collectTaskTimeline({...manifest,nativeSources:[native,native]},dir),/Duplicate/);
});
test('fixed byte boundary, UTF8 chunking and incomplete tail',async t=>{
 const {path}=await fixture(t);await appendFile(path,'{"unfinished":');
 const before=await readFile(path);
 const a=await readTimelineSource(path,source,{chunkSize:3});
 assert.equal(a.events.length,1);assert.equal(a.source.incompleteFinalLine,true);
 assert.equal(a.source.byteBoundary,before.length);assert.match(a.source.sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(await readFile(path),before);
 assert.equal(JSON.stringify(a).includes('SECRET'),false);
});
test('append after boundary is excluded; truncation fails',async t=>{
 const {path}=await fixture(t);
 const a=await readTimelineSource(path,source,{afterBoundary:()=>appendFile(path,body)});
 assert.equal(a.events.length,1);
 await assert.rejects(readTimelineSource(path,source,{afterBoundary:()=>truncate(path,1)}),/truncated/);
});
test('explicit manifest only; export cannot overwrite a previous report',async t=>{
 const {dir,path}=await fixture(t);
 const manifest={teamId:'team',taskId:'task',sources:[{...source,path}]};
 const r=await collectTaskTimeline(manifest,dir);
 const dest=join(dir,'out');await exportTaskTimeline(r,dest);
 assert.equal(JSON.parse(await readFile(join(dest,'report.json'),'utf8')).events.length,1);
 assert.equal(JSON.parse(await readFile(join(dest,'READY.json'),'utf8')).schemaVersion,1);
 await assert.rejects(exportTaskTimeline(r,dest),/EEXIST/);
 await assert.rejects(collectTaskTimeline({...manifest,scanDirectory:dir},dir),/Unknown/);
 await assert.rejects(readTimelineSource(dir,source),/regular file/);
});
test('CLI exports named sources relative to manifest, rejects bad arguments',async t=>{
 const {dir}=await fixture(t),manifest=join(dir,'manifest.json'),output=[];
 await writeFile(manifest,JSON.stringify({teamId:'team',taskId:'task',sources:[{...source,path:'source.jsonl'}]}));
 await run(['task-timeline',manifest,join(dir,'cli-out')],s=>output.push(s));
 assert.match(output[0],/Read-only/);
 await assert.rejects(run(['task-timeline',manifest]),/task-timeline <manifest/);
});
test('optional recorded state is scoped, immutable and shown separately',async t=>{
 const {dir,path}=await fixture(t),statePath=join(dir,'state.json');
 const bytes=JSON.stringify(demoState());await writeFile(statePath,bytes);
 const manifest={teamId:'demo-team',taskId:'T-1',sources:[{...source,path}],stateSource:{path:'state.json',roundId:'round-demo'}};
 const r=await collectTaskTimeline(manifest,dir);
 assert.equal(r.businessTimeline.taskId,'T-1');
 assert.equal(r.endToEndMs,null);
 assert.equal(r.coverage.missing.includes('business-state-events'),false);
 assert.match(r.businessTimeline.sourceSha256,/^[a-f0-9]{64}$/);
 assert.match(renderTimelineMarkdown(r),/业务声明阶段/);
 assert.equal(await readFile(statePath,'utf8'),bytes);
 await assert.rejects(collectTaskTimeline({...manifest,teamId:'wrong'},dir),/team mismatch/);
 await assert.rejects(collectTaskTimeline({...manifest,stateSource:{...manifest.stateSource,scan:true}},dir),/Unknown/);
});
