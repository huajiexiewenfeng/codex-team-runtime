import { open, readFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateManifest, check, exact, hash } from './stats-contract.mjs';
import { validateActivity } from './stats-adapters.mjs';
import { atomicWrite } from './store.mjs';
import { withFileLocks } from './registry-projection.mjs';

// Optional explicit producer for declared work intervals. The host's execution
// timer and identity/dispatch protocols are untouched. Collection pairs phases.
export async function recordActivity(manifestPath,sourceId,event){
  manifestPath=resolve(manifestPath);const manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),dirname(manifestPath));
  const source=manifest.sources.find(s=>s.sourceId===sourceId);check(source?.kind==='activity-jsonl'&&source.mutationPolicy==='append-only','activity_source_not_append');
  validateActivity(event,source,manifest);check(event.at>=source.authorizedFrom&&event.at<=source.authorizedTo,'activity_out_of_scope');
  try{check(!(await lstat(source.path)).isSymbolicLink(),'activity_source_symlink');}catch(e){if(e.code!=='ENOENT')throw e;}
  return withFileLocks([source.path+'.activity.lock'],async()=>{const file=await open(source.path,'a'),text=JSON.stringify(event)+'\n';let offset;try{offset=(await file.stat()).size;await file.writeFile(text);await file.sync();}finally{await file.close();}
    return {schemaVersion:1,eventId:event.eventId,phase:event.phase,sourceId,assurance:event.assurance,recorded:true,completed:event.phase==='end',pairingVerified:false,offset,bytes:Buffer.byteLength(text)};});
}

const CONTEXT_FIELDS=['teamId','memberId','hostId','threadId','bindingRevision','roleEpoch','role','taskId','roundId','stepId','assurance','evidenceRef'];
const RECEIPT_FIELDS=['schemaVersion','manifestPath','sourceId','sourceHash','beginEvent','endEvent','beginRecorded','endRecorded','beginOffset','beginBytes'];
async function sourceFor(manifestPath,sourceId){const manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),dirname(manifestPath)),source=manifest.sources.find(s=>s.sourceId===sourceId);check(source?.kind==='activity-jsonl'&&source.mutationPolicy==='append-only','activity_source_not_append');return {manifest,source};}
async function checkReceiptTarget(manifestPath,receiptPath){const manifest=validateManifest(JSON.parse(await readFile(manifestPath,'utf8')),dirname(manifestPath)),key=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),forbidden=new Set([manifestPath,manifestPath+'.lock',...manifest.sources.flatMap(s=>[s.path,s.path+'.activity.lock'])].map(key));check(!forbidden.has(key(receiptPath))&&!forbidden.has(key(receiptPath+'.lock')),'activity_receipt_path_collision');}
async function readReceipt(path){const info=await lstat(path);check(info.isFile()&&!info.isSymbolicLink()&&info.size<=65536,'activity_receipt_invalid');const receipt=JSON.parse(await readFile(path,'utf8'));exact(receipt,[...RECEIPT_FIELDS,'endOffset','endBytes'],RECEIPT_FIELDS);check(receipt.schemaVersion==='activity-receipt/v1'&&typeof receipt.beginRecorded==='boolean'&&typeof receipt.endRecorded==='boolean','activity_receipt_invalid');return receipt;}
function validateReceipt(receipt,manifestPath,sourceId,manifest,source){
  check(receipt.manifestPath===manifestPath&&receipt.sourceId===sourceId&&receipt.sourceHash===hash(source),'activity_receipt_scope_changed');validateActivity(receipt.beginEvent,source,manifest);check(receipt.beginEvent.phase==='begin','activity_receipt_invalid');
  if(receipt.endEvent){validateActivity(receipt.endEvent,source,manifest);check(receipt.endEvent.phase==='end'&&hash({...receipt.endEvent,phase:'begin',at:receipt.beginEvent.at})===hash(receipt.beginEvent)&&receipt.endEvent.at>=receipt.beginEvent.at,'activity_receipt_invalid');}
  check(!receipt.endRecorded||(receipt.beginRecorded&&receipt.endEvent),'activity_receipt_invalid');
}
async function verifyBeginEvidence(receipt,source){check(Number.isSafeInteger(receipt.beginOffset)&&receipt.beginOffset>=0&&Number.isSafeInteger(receipt.beginBytes)&&receipt.beginBytes>0&&receipt.beginBytes<=65536,'activity_receipt_invalid');const file=await open(source.path,'r');try{const buffer=Buffer.alloc(receipt.beginBytes),{bytesRead}=await file.read(buffer,0,buffer.length,receipt.beginOffset);check(bytesRead===buffer.length&&hash(JSON.parse(buffer.toString('utf8')))===hash(receipt.beginEvent),'activity_receipt_evidence_mismatch');}finally{await file.close();}}
async function verifyEndEvidence(receipt,source){check(Number.isSafeInteger(receipt.endOffset)&&receipt.endOffset>=0&&Number.isSafeInteger(receipt.endBytes)&&receipt.endBytes>0&&receipt.endBytes<=65536,'activity_end_evidence_unavailable');const file=await open(source.path,'r');try{const buffer=Buffer.alloc(receipt.endBytes),{bytesRead}=await file.read(buffer,0,buffer.length,receipt.endOffset);check(bytesRead===buffer.length&&hash(JSON.parse(buffer.toString('utf8')))===hash(receipt.endEvent),'activity_receipt_evidence_mismatch');}finally{await file.close();}}
// A durable intent precedes each append, so retry reuses the identical event and
// timestamp after a failed write. The collector dedupes a crash-after-append retry.
export async function beginActivity(manifestPath,sourceId,context,receiptPath,{now=()=>new Date().toISOString()}={}){
  manifestPath=resolve(manifestPath);receiptPath=resolve(receiptPath);exact(context,CONTEXT_FIELDS);await checkReceiptTarget(manifestPath,receiptPath);
  return withFileLocks([receiptPath+'.lock'],async()=>{
    await checkReceiptTarget(manifestPath,receiptPath);
    const {manifest,source}=await sourceFor(manifestPath,sourceId);let receipt;
    try{receipt=await readReceipt(receiptPath);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(receipt){validateReceipt(receipt,manifestPath,sourceId,manifest,source);const meta=Object.fromEntries(CONTEXT_FIELDS.map(k=>[k,receipt.beginEvent[k]]));check(hash(meta)===hash(context),'activity_receipt_context_mismatch');}
    else{const event={schemaVersion:'activity-sidecar/v1',eventId:randomUUID(),phase:'begin',...context,at:now(),sourceKind:'activity-sidecar'};validateActivity(event,source,manifest);check(event.at>=source.authorizedFrom&&event.at<=source.authorizedTo,'activity_out_of_scope');receipt={schemaVersion:'activity-receipt/v1',manifestPath,sourceId,sourceHash:hash(source),beginEvent:event,endEvent:null,beginRecorded:false,endRecorded:false,beginOffset:null,beginBytes:null};await atomicWrite(receiptPath,JSON.stringify(receipt),true);}
    if(!receipt.beginRecorded){const written=await recordActivity(manifestPath,sourceId,receipt.beginEvent);receipt.beginRecorded=true;receipt.beginOffset=written.offset;receipt.beginBytes=written.bytes;await atomicWrite(receiptPath,JSON.stringify(receipt));}else await verifyBeginEvidence(receipt,source);
    return {schemaVersion:1,eventId:receipt.beginEvent.eventId,sourceId,phase:'begin',recorded:true,assurance:receipt.beginEvent.assurance,pairingVerified:false,receiptPath};
  });
}
export async function endActivity(manifestPath,receiptPath,{now=()=>new Date().toISOString()}={}){
  manifestPath=resolve(manifestPath);receiptPath=resolve(receiptPath);await checkReceiptTarget(manifestPath,receiptPath);
  return withFileLocks([receiptPath+'.lock'],async()=>{
    await checkReceiptTarget(manifestPath,receiptPath);
    const receipt=await readReceipt(receiptPath),{manifest,source}=await sourceFor(manifestPath,receipt.sourceId);validateReceipt(receipt,manifestPath,receipt.sourceId,manifest,source);check(receipt.beginRecorded,'activity_begin_not_recorded');await verifyBeginEvidence(receipt,source);
    if(!receipt.endEvent){receipt.endEvent={...receipt.beginEvent,phase:'end',at:now()};validateActivity(receipt.endEvent,source,manifest);check(receipt.endEvent.at>=receipt.beginEvent.at,'activity_time_order');check(receipt.endEvent.at>=source.authorizedFrom&&receipt.endEvent.at<=source.authorizedTo,'activity_out_of_scope');await atomicWrite(receiptPath,JSON.stringify(receipt));}
    if(!receipt.endRecorded){const written=await recordActivity(manifestPath,receipt.sourceId,receipt.endEvent);receipt.endOffset=written.offset;receipt.endBytes=written.bytes;receipt.endRecorded=true;await atomicWrite(receiptPath,JSON.stringify(receipt));}else await verifyEndEvidence(receipt,source);
    return {schemaVersion:1,eventId:receipt.beginEvent.eventId,sourceId:receipt.sourceId,phase:'end',recorded:true,assurance:receipt.beginEvent.assurance,pairingVerified:false,receiptPath};
  });
}
