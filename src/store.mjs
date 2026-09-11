import { open, readFile, rename, unlink, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validate, evolve } from './runtime.mjs';
import { projectRegistryState, withFileLocks, withStateGuard } from './registry-projection.mjs';

export async function readRawState(path) { return validate(JSON.parse(await readFile(path,'utf8'))); }
export async function readState(path,options={}) { return projectRegistryState(await readRawState(path),resolve(path),options); }
async function replace(temp,path) {
 // Windows readers/scanners can briefly deny replacement. Retry only this
 // same rename under the caller's existing lock, never delete the destination.
 // At most 20 delays (2 seconds); persistent denials still fail unchanged.
 for(let attempt=0;;attempt++) {
  try { await rename(temp,path); return; }
  catch(error) {
   if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(error.code)||attempt>=20) throw error;
   await delay(100);
  }
 }
}
// Same-directory temporary file: readers see either the old or the complete new file.
export async function atomicWrite(path, content, exclusive=false) {
 const temp=`${path}.${randomUUID()}.tmp`; let handle;
 try { handle=await open(temp,'wx'); await handle.writeFile(content,'utf8'); await handle.sync(); await handle.close(); handle=null;
  if(exclusive) await link(temp,path); else await replace(temp,path);
 } finally { if(handle) await handle.close(); await unlink(temp).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
}
async function locked(path,fn) {
 return withFileLocks([`${path}.lock`],fn);
}
export async function initialize(path,state) { validate(state); return locked(path,async()=>{await atomicWrite(path,JSON.stringify(state,null,2)+'\n',true); return state;}); }
export async function transact(path,expectedVersion,event,options={}) {
 return withStateGuard(path,null,readRawState,async state=>{const next=evolve(state,event,expectedVersion);await atomicWrite(path,JSON.stringify(next,null,2)+'\n');return next;},options);
}
