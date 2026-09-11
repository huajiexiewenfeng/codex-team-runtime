import { createState, validate, validateCaller, snapshot } from './runtime.mjs';
import { initialize, readState, transact } from './store.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
function shape(value,keys) { check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)),'Unknown request field'); }
function memberFor(state,caller) {
 validateCaller(caller);
 const member=state.members.find(m=>m.binding.status==='bound'&&m.binding.hostId===caller.hostId&&m.binding.threadId===caller.threadId);
 check(member?.lifecycle==='active','Caller is not an active bound member');
 return member;
}

// Identity is injected by the caller. This module is not a host authenticator.
export async function start(path,request,at) {
 shape(request,['teamId','name','caller','source','managerMemberId','liaisonMemberId']); validateCaller(request.caller);
 const {managerMemberId='manager',liaisonMemberId='liaison'}=request;
 const state=createState({teamId:request.teamId,name:request.name,source:request.source,members:[
  {id:managerMemberId,name:'Manager',role:'Manager',lifecycle:'active',binding:{status:'bound',...request.caller}},
  {id:liaisonMemberId,name:'Liaison',role:'Liaison',lifecycle:'active',binding:{status:'unbound'}}
 ]},at);
 state.session={invitation:null};
 return initialize(path,validate(state));
}

export async function attach(path,request,expectedVersion) {
 shape(request,request?.mode==='invite'?['mode','id','caller','target','at','expiresAt','source']:['mode','id','caller','invitationId','invitationVersion','at','source']);
 check(['invite','confirm'].includes(request.mode),'attach mode must be invite or confirm'); validateCaller(request.caller);
 const state=await readState(path);
 let actor;
 if(request.mode==='invite') {actor=memberFor(state,request.caller);check(actor.role==='Manager','Only Manager can invite');}
 else actor=state.members.find(m=>m.role==='Liaison');
 const {mode,...payload}=request;
 // Runtime rechecks the identity, invitation and version under the existing lock.
 return transact(path,expectedVersion,{...payload,type:mode==='invite'?'attachInvite':'attachConfirm',actor:actor.id});
}

export async function resume(path,caller,asOf,roundId=null) {
 const state=await readState(path), member=memberFor(state,caller);
 if(member.role==='Liaison') check(state.session?.invitation?.confirmedAt!==null&&state.session?.invitation?.confirmedAt!==undefined,'Liaison pairing has not been confirmed');
 const view=snapshot(state,asOf,roundId), currentRounds=state.rounds.filter(r=>r.status==='open').map(r=>({id:r.id,title:r.title}));
 return {role:member.role,memberId:member.id,identityAssurance:'caller-declared',currentRounds,
  nextActions:member.role==='Liaison'?['Read snapshot; explain progress and decisions; do not command Workers']:member.role==='Manager'?(currentRounds.length?['Inspect active tasks and review submitted evidence','Keep independent new work in Manager queue; use dispatch-plan and verify native idle before explicit start-task; never send new work to a reserved Worker']:['Await explicit new work; no automatic round or task creation']):['Inspect assigned work; queued tasks are not dispatched and must not be started by Worker; submit only your own authorized executing or rework task'],
  hostCapabilities:{identityAdapter:'unknown',heartbeat:'unknown',navigation:'unknown',sessionHook:'unknown'},snapshot:view};
}

export async function registerWorker(path,request,expectedVersion) {
 shape(request,['id','caller','memberId','name','binding','at','source']);
 const state=await readState(path), actor=memberFor(state,request.caller);
 check(actor.role==='Manager','Only Manager can register Worker');
 return transact(path,expectedVersion,{...request,type:'registerWorker',actor:actor.id});
}

export async function detach(path,request,expectedVersion) {
 shape(request,['id','caller','invitationId','invitationVersion','at','summary','source']);
 const state=await readState(path), actor=memberFor(state,request.caller);
 check(actor.role==='Manager','Only Manager can detach Liaison');
 return transact(path,expectedVersion,{...request,type:'detachLiaison',actor:actor.id});
}
