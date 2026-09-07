import { open,readFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWrite,readState } from './store.mjs';
import { createReportingLedger,validateReportingLedger,evolveReporting } from './reporting.mjs';

export async function readReporting(path){return validateReportingLedger(JSON.parse(await readFile(path,'utf8')));}
async function locked(path,statePath,fn){
 if(resolve(path)===resolve(statePath))throw new Error('Reporting ledger must be separate from business state');
 const lock=`${path}.lock`,handle=await open(lock,'wx');
 try{return await fn();}finally{await handle.close();await unlink(lock);}
}
export async function initReporting(path,statePath,caller,at){
 return locked(path,statePath,async()=>{
  const ledger=createReportingLedger(await readState(statePath),caller,at);
  await atomicWrite(path,JSON.stringify(ledger,null,2)+'\n',true);return ledger;
 });
}
export async function transactReporting(path,statePath,caller,event,expectedVersion){
 return locked(path,statePath,async()=>{
  const previous=await readReporting(path);
  // Fresh business read under the ledger lock, not a cross-file transaction.
  // Business state may still change after this read. No network calls here.
  const state=await readState(statePath),next=evolveReporting(previous,state,caller,event,expectedVersion);
  await atomicWrite(path,JSON.stringify(next,null,2)+'\n');return next;
 });
}
