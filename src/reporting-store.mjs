import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWrite,readRawState } from './store.mjs';
import { withStateGuard } from './registry-projection.mjs';
import { createReportingLedger,validateReportingLedger,evolveReporting } from './reporting.mjs';

export async function readReporting(path){return validateReportingLedger(JSON.parse(await readFile(path,'utf8')));}
function assertLinkedReportingReady(state){
 if(state.schemaVersion!==2)return;
 const manager=state.members.find(member=>member.role==='Manager');
 if(!manager||!state.registry.readyMemberIds.includes(manager.id))throw new Error('Manager leader is not Registry ready');
}
export async function initReporting(path,statePath,caller,at,options={}){
 if(resolve(path)===resolve(statePath))throw new Error('Reporting ledger must be separate from business state');
 return withStateGuard(statePath,path,readRawState,async state=>{
  assertLinkedReportingReady(state);
  const ledger=createReportingLedger(state,caller,at);
  await atomicWrite(path,JSON.stringify(ledger,null,2)+'\n',true);return ledger;
 },options);
}
export async function transactReporting(path,statePath,caller,event,expectedVersion,options={}){
 if(resolve(path)===resolve(statePath))throw new Error('Reporting ledger must be separate from business state');
 return withStateGuard(statePath,path,readRawState,async state=>{
  assertLinkedReportingReady(state);
  const previous=await readReporting(path);
  const next=evolveReporting(previous,state,caller,event,expectedVersion);
  await atomicWrite(path,JSON.stringify(next,null,2)+'\n');return next;
 },options);
}
