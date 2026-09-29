import {isDeepStrictEqual} from 'node:util';
import {withStateGuard} from './registry-projection.mjs';
import {readRawState,atomicWrite} from './store.mjs';
import {evolve,validateCaller} from './runtime.mjs';
// Each operation uses the normal Registry/state lock order. Retrying the exact
// saved request is idempotent even if the following Registry exit was interrupted.
export async function writeRevocation(path,request,expectedVersion,type,options={}){
 if(!['revokeWorker','resolveRevocation'].includes(type))throw Error('Invalid revocation operation');
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw Error('Invalid expectedVersion');
 return withStateGuard(path,null,readRawState,async state=>{
  if(state.schemaVersion!==2||state.registry.phase!=='active')throw Error('Active Registry-linked team required');
  validateCaller(request.caller);
  const m=state.members.find(m=>m.role==='Manager'&&m.lifecycle==='active'&&m.binding.status==='bound'&&m.binding.hostId===request.caller.hostId&&m.binding.threadId===request.caller.threadId);
  if(!m)throw Error('Current Manager required');
  if(Object.hasOwn(request,'actor')||Object.hasOwn(request,'type'))throw Error('Command derives actor and type');
  const event={...request,type,actor:m.id},prior=state.events.find(e=>e.id===event.id);
  if(prior){if(!isDeepStrictEqual(prior,event))throw Error('Operation ID conflict');return {version:state.version,replayed:true};}
  const next=evolve(state,event,expectedVersion);
  await atomicWrite(path,JSON.stringify(next,null,2)+'\n');
  return {version:next.version,replayed:false};
 },options);
}
