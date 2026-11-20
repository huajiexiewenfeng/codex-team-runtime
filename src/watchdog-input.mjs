import { readState, readRawState } from './store.mjs';
import { projectRegistryState } from './registry-projection.mjs';
import { stat } from 'node:fs/promises';
import { loadLedger } from './submission-recovery.mjs';
import {validateDispatchObjects} from './dispatch-objects.mjs';
async function signature(path) {
 try{const s=await stat(path,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}catch(e){if(e.code==='ENOENT')return 'missing';throw e;}
}
// In-memory parse reuse only. Projection and pre-send fresh reads are never skipped.
// Cache belongs to the foreground service; there is no untrusted snapshot input.
export function createWatchdogInputReader() {
 const cached=new Map();
 return async function readInputs(statePath,readOptions={}) {
  const stateSignature=await signature(statePath),noticePath=statePath+'.submission-notices.json',noticeSignature=await signature(noticePath);
  let entry=cached.get(statePath);
  if(!entry||entry.stateSignature!==stateSignature) {
   const raw=await readRawState(statePath);
   entry={stateSignature,raw};cached.set(statePath,entry);
  } else await validateDispatchObjects(statePath,entry.raw);
  const state=await projectRegistryState(entry.raw,statePath,readOptions);
  if(entry.noticeSignature!==noticeSignature){entry.notices=await loadLedger(noticePath,statePath,state.team.id);entry.noticeSignature=noticeSignature;}
  // Return isolated objects so the checker cannot mutate its parse cache.
  return {state:structuredClone(state),notices:structuredClone(entry.notices)};
 };
}
export async function readWatchdogInputs(statePath,readOptions={}) {
 const state=await readState(statePath,readOptions);
 return {state,notices:await loadLedger(statePath+'.submission-notices.json',statePath,state.team.id)};
}
