import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {readRawState,atomicWrite} from './store.mjs';
import {withStateGuard} from './registry-projection.mjs';
import {loadObject,saveObject,validateDispatchObjects} from './dispatch-objects.mjs';
import {hash,isDispatch} from './dispatch-contract.mjs';

// Explicit backup, not status. READY is last; never overwrite an earlier export.
export async function exportDispatchBundle(statePath,directory,options={}){
 return withStateGuard(statePath,null,readRawState,async state=>{
  const {operations}=await validateDispatchObjects(statePath,state),refs=new Set();
  for(const e of state.events){if(isDispatch(e))refs.add(e.source.ref);if(/^e04-brief:sha256:[a-f0-9]{64}$/.test(e.source.ref))refs.add(e.source.ref);}
  for(const op of operations.values())refs.add(op.briefRef);
  const objects=[];for(const ref of refs)objects.push([ref,await loadObject(statePath,ref)]);
  await mkdir(directory);const target=join(resolve(directory),'state.json'),raw=JSON.stringify(state,null,2)+'\n';
  for(const [ref,obj] of objects)await saveObject(target,ref.startsWith('e04-op:')?'op':'brief',obj);
  await atomicWrite(target,raw,true);await validateDispatchObjects(target,state);
  const manifest={schemaVersion:1,sourceVersion:state.version,stateSha256:hash(raw),objects:[...refs].sort(),registryIncluded:false};
  await atomicWrite(join(directory,'READY.json'),JSON.stringify(manifest,null,2)+'\n',true);return manifest;
 },options);
}
