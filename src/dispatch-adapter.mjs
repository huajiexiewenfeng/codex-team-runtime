import {pathToFileURL} from 'node:url';
import {ownedLocks} from './notice-adapter.mjs';
import {parseNoticeJson} from './notice-json.mjs';
import {MAX_BYTES,demand,shape} from './dispatch-contract.mjs';
import {dispatchRuntime} from './dispatch-runtime.mjs';
export async function main(){
 let size=0;const chunks=[];for await(const chunk of process.stdin){size+=chunk.length;demand(size<=MAX_BYTES,'PAYLOAD_TOO_LARGE','Dispatch bridge request exceeds limit');chunks.push(chunk);}
 const e=parseNoticeJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 shape(e,['statePath','registryPath','request','runtimeRevision','executionToken']);demand(/^[a-f0-9]{32}$/.test(e.executionToken),'INVALID_REQUEST','Invalid execution token');
 const result=await dispatchRuntime({...e,options:{deadline:performance.now()+7000,exportTimeout:3000,...(e.request.action==='status'?{}:{lockRunner:ownedLocks(e.executionToken)})}});
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stdout.write(JSON.stringify({status:'error',reasonCode:e.code??'INVALID_REQUEST',message:e.message,hostActionExecuted:false})+'\n');process.exitCode=1;});
