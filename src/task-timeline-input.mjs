import {open,stat,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createTimelineParser,buildTaskTimeline,renderTimelineMarkdown} from './task-timeline.mjs';
import {buildStateTimeline} from './task-timeline-state.mjs';
import {projectNativeTimeline} from './task-timeline-native.mjs';

export async function readTimelineSource(path,descriptor,{chunkSize=1024*1024,afterBoundary}={}) {
  if(!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>1024*1024)throw new Error('Invalid chunk size');
  if(!(await stat(path)).isFile())throw new Error('Timeline source must be a regular file');
  const parser=createTimelineParser(descriptor),handle=await open(path,'r');
  try {
    const info=await handle.stat();
    if(!info.isFile())throw new Error('Timeline source must be a regular file');
    const boundary=info.size,hash=createHash('sha256');
    await afterBoundary?.();
    let position=0,pending=[],pendingBytes=0;
    while(position<boundary) {
      const buffer=Buffer.allocUnsafe(Math.min(chunkSize,boundary-position));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,position);
      if(!bytesRead)throw new Error('Timeline source truncated before opened boundary');
      position+=bytesRead;hash.update(buffer.subarray(0,bytesRead));
      let start=0;
      for(let i=0;i<bytesRead;i++)if(buffer[i]===10) {
        const part=buffer.subarray(start,i);
        if(pendingBytes+part.length>64*1024*1024)throw new Error('Timeline line exceeds 64 MiB');
        parser.push(Buffer.concat([...pending,part],pendingBytes+part.length).toString('utf8'));
        pending=[];pendingBytes=0;start=i+1;
      }
      if(start<bytesRead){pending.push(buffer.subarray(start,bytesRead));pendingBytes+=bytesRead-start;}
      if(pendingBytes>64*1024*1024)throw new Error('Timeline line exceeds 64 MiB');
    }
    const parsed=parser.finish({incompleteFinalLine:pendingBytes>0});
    return {...parsed,source:{...parsed.source,byteBoundary:boundary,sha256:hash.digest('hex'),adapterVersion:'codex-jsonl-timeline-v1'}};
  } finally {await handle.close();}
}

const fields=(value,allowed)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('Unknown or invalid timeline manifest field');
};
export async function collectTaskTimeline(manifest,baseDirectory) {
  fields(manifest,['teamId','taskId','timeZone','sources','milestones','stateSource','nativeSources']);
  if(!Array.isArray(manifest.sources)||manifest.sources.length===0||manifest.sources.length>32)throw new Error('Expected 1..32 explicit timeline sources');
  if(manifest.milestones!==undefined){
    fields(manifest.milestones,['request','delivery']);
    for(const ref of Object.values(manifest.milestones)) {
      fields(ref,['sourceRef','line']);
      if(typeof ref.sourceRef!=='string'||!Number.isSafeInteger(ref.line)||ref.line<1)throw new Error('Invalid milestone reference');
    }
  }
  const seen=new Set(),inputs=[];
  for(const source of manifest.sources) {
    fields(source,['path','sourceRef','hostId','threadId','role','from','to']);
    if(typeof source.path!=='string'||!source.path.trim())throw new Error('Expected explicit source path');
    if(seen.has(source.sourceRef))throw new Error('Duplicate sourceRef');
    seen.add(source.sourceRef);
    inputs.push(await readTimelineSource(resolve(baseDirectory,source.path),source));
  }
  const report=buildTaskTimeline(manifest,inputs);
  if(manifest.nativeSources!==undefined){
    if(!Array.isArray(manifest.nativeSources)||manifest.nativeSources.length>32)throw new Error('Invalid native sources');
    report.nativeObservations=[];const selected=new Set();
    for(const descriptor of manifest.nativeSources){
      fields(descriptor,['path','sourceRef','hostId','threadId','role','turnId','itemIds']);
      if(typeof descriptor.path!=='string'||!descriptor.path.trim())throw new Error('Expected explicit native path');
      if(seen.has(descriptor.sourceRef))throw new Error('Duplicate sourceRef');seen.add(descriptor.sourceRef);
      if(!manifest.sources.some(s=>s.hostId===descriptor.hostId&&s.threadId===descriptor.threadId&&s.role===descriptor.role))throw new Error('Native source not associated with a selected log identity');
      const file=await open(resolve(baseDirectory,descriptor.path),'r');
      try{
        const info=await file.stat();if(!info.isFile()||info.size>16*1024*1024)throw new Error('Invalid native source file');
        const bytes=Buffer.alloc(info.size);let offset=0;
        while(offset<bytes.length){const {bytesRead}=await file.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Native source truncated');offset+=bytesRead;}
        const observation=projectNativeTimeline(JSON.parse(bytes.toString('utf8')),descriptor);
        for(const item of observation.items){const key=JSON.stringify([descriptor.hostId,descriptor.threadId,item.turnId,item.itemId]);if(selected.has(key))throw new Error('Duplicate native item');selected.add(key);}
        report.nativeObservations.push({...observation,byteBoundary:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
      }finally{await file.close();}
    }
  }
  if(manifest.stateSource!==undefined) {
    const descriptor=manifest.stateSource;
    fields(descriptor,['path','roundId']);
    if(typeof descriptor.path!=='string'||!descriptor.path.trim()||typeof descriptor.roundId!=='string')throw new Error('Invalid timeline state source');
    const path=resolve(baseDirectory,descriptor.path);
    if(!(await stat(path)).isFile())throw new Error('Timeline state must be a regular file');
    const handle=await open(path,'r');
    try {
      const info=await handle.stat();
      if(!info.isFile()||info.size>16*1024*1024)throw new Error('Timeline state must be a regular file within 16 MiB');
      const bytes=Buffer.alloc(info.size);let offset=0;
      while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Timeline state truncated');offset+=bytesRead;}
      report.businessTimeline={...buildStateTimeline(JSON.parse(bytes.toString('utf8')),{teamId:manifest.teamId,taskId:manifest.taskId,roundId:descriptor.roundId}),sourceByteBoundary:bytes.length,sourceSha256:createHash('sha256').update(bytes).digest('hex')};
      report.rulesVersion='task-timeline-v3';
      report.coverage.missing=report.coverage.missing.filter(value=>value!=='business-state-events');
    } finally {await handle.close();}
  }
  return report;
}

export async function exportTaskTimeline(report,directory) {
  // Exclusive directory + READY last: incomplete exports are never marked ready.
  const json=JSON.stringify(report,null,2)+'\n',markdown=renderTimelineMarkdown(report);
  await mkdir(directory);
  await writeFile(join(directory,'report.json'),json,{flag:'wx'});
  await writeFile(join(directory,'timeline.md'),markdown,{flag:'wx'});
  await writeFile(join(directory,'READY.json'),JSON.stringify({schemaVersion:1,reportSha256:createHash('sha256').update(json).digest('hex')})+'\n',{flag:'wx'});
}
