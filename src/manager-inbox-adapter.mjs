import {pathToFileURL} from 'node:url';
import {ownedLocks} from './notice-adapter.mjs';
import {inboxRuntime} from './manager-inbox.mjs';
import {parseInboxJson,exact,demand} from './manager-inbox-contract.mjs';

export async function main(){
 const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;demand(bytes<=1024*1024,'PAYLOAD_TOO_LARGE');chunks.push(chunk);}
 const envelope=parseInboxJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),1024*1024);exact(envelope,['statePath','registryPath','request','runtimeRevision','executionToken']);demand(/^[a-f0-9]{32}$/.test(envelope.executionToken));
 const result=await inboxRuntime({...envelope,options:{deadline:performance.now()+7000,exportTimeout:3000,lockRunner:ownedLocks(envelope.executionToken)}});process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stdout.write(JSON.stringify({status:'error',reasonCode:e.code??'INVALID_REQUEST',hostActionExecuted:false})+'\n');process.exitCode=1;});
