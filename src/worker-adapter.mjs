import {pathToFileURL} from 'node:url';
import {workerRuntime} from './worker-runtime.mjs';
import {parseNoticeJson} from './notice-json.mjs';
import {ownedLocks} from './notice-adapter.mjs';
export async function main(){let size=0;const parts=[];for await(const part of process.stdin){size+=part.length;if(size>1024*1024)throw Error('Request too large');parts.push(part);}
  const e=parseNoticeJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  const fields=['statePath','registryPath','request','runtimeRevision','executionToken'];
  if(!e||Object.keys(e).length!==fields.length||!fields.every(k=>Object.hasOwn(e,k))||!/^[a-f0-9]{32}$/.test(e.executionToken))throw Error('Invalid trusted envelope');
  process.stdout.write(JSON.stringify(await workerRuntime({...e,options:{lockRunner:ownedLocks(e.executionToken)}}))+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stdout.write(JSON.stringify({status:'error',reasonCode:'INVALID_REQUEST',message:e.message,hostActionExecuted:false})+'\n');process.exitCode=1;});
