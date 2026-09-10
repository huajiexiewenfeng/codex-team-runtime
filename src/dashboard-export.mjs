import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {snapshot} from './runtime.mjs';
import {render} from './render.mjs';
import {atomicWrite} from './store.mjs';

// Build all pages before creating the destination. Every page uses the same
// in-memory state and asOf; round IDs never become filesystem paths.
export async function exportDashboard(state,directory,asOf,{codexLinks=false}={}) {
 if(typeof codexLinks!=='boolean')throw new Error('Invalid codexLinks option');
 const renderOptions={codexLinks};
 const overview=snapshot(state,asOf);
 const views=[overview,...overview.rounds.map(r=>snapshot(state,asOf,r.id))];
 const pages=views.map((v,i)=>({roundId:v.roundId,title:i===0?'全部轮次':v.rounds[0].title,
  html:i===0?'index.html':`round-${i}.html`,json:i===0?'snapshot.json':`round-${i}.json`,snapshotId:v.snapshotId}));
 const files=views.flatMap((v,i)=>[
  {name:pages[i].html,content:render(v,{roundPages:pages,...renderOptions})},
  {name:pages[i].json,content:JSON.stringify(v,null,2)+'\n'}
 ]);
 const manifest={schemaVersion:1,kind:'dashboard-bundle',sourceVersion:overview.sourceVersion,asOf,pages,renderOptions,
  files:files.map(f=>({name:f.name,sha256:createHash('sha256').update(f.content).digest('hex')}))};
 await mkdir(directory); // Never overwrite or adopt an existing export.
 for(const f of files)await atomicWrite(join(directory,f.name),f.content,true);
 // The sole completeness marker is written only after every linked page exists.
 await atomicWrite(join(directory,'READY.json'),JSON.stringify(manifest,null,2)+'\n',true);
 return manifest;
}
