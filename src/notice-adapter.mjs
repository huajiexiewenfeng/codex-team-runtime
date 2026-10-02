import { pathToFileURL } from 'node:url';
import { open, unlink } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { noticeRuntime, MAX_BYTES, fail } from './notice-runtime.mjs';
import { parseNoticeJson } from './notice-json.mjs';

// Ownership reports contain no submission content. The bridge retains them only
// for bounded cleanup of this invocation, never as notification evidence.
export function ownedLocks(token) {
  return async (paths, operation) => {
    const acquired = [];
    try {
      for (const path of paths) {
        const handle = await open(path,'wx');
        const owner = {token, nonce:randomUUID(),pid:process.pid,path};
        acquired.push({path,handle});
        await handle.writeFile(JSON.stringify(owner),'utf8');
        await handle.sync();
        writeSync(2,JSON.stringify({e03Lock:owner})+'\n');
      }
      return await operation();
    } finally {
      for (const {path,handle} of acquired.reverse()) {
        await handle.close();
        await unlink(path).catch(e => {if(e.code !== 'ENOENT') throw e;});
      }
    }
  };
}

export async function main() {
  let size=0; const parts=[];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if(size > MAX_BYTES) fail('PAYLOAD_TOO_LARGE','E03 bridge request exceeds 1 MiB');
    parts.push(chunk);
  }
  const envelope=parseNoticeJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  const fields=['statePath','registryPath','request','runtimeRevision','executionToken'];
  if(!envelope || Object.keys(envelope).length !== fields.length || !fields.every(k=>Object.hasOwn(envelope,k))) fail('INVALID_REQUEST','Invalid trusted adapter envelope');
  if(!/^[a-f0-9]{32}$/.test(envelope.executionToken)) fail('INVALID_REQUEST','Invalid execution token');
  const deadline=performance.now()+7000;
  const result=await noticeRuntime({...envelope,options:{deadline,exportTimeout:3000,
    ...(envelope.request.action === 'status' ? {} : {lockRunner:ownedLocks(envelope.executionToken)})}});
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{
  process.stdout.write(JSON.stringify({status:'error',reasonCode:e.code ?? 'INVALID_REQUEST',message:e.message,hostActionExecuted:false})+'\n');process.exitCode=1;
});
