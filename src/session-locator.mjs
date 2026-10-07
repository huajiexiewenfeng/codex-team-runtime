import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {TextDecoder} from 'node:util';
import {MetadataJsonParser} from './stats-json-stream.mjs';
import {check,id,hash} from './stats-contract.mjs';

export const localPath=p=>resolve(process.platform==='win32'?p.replace(/^\\\\\?\\/,''):p);
const key=p=>process.platform==='win32'?localPath(p).toLowerCase():localPath(p);
export async function locateSessions(indexPath,threadIds){
  check(threadIds.length<=200&&new Set(threadIds).size===threadIds.length,'managed_thread_limit');threadIds.forEach(id);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(localPath(indexPath),{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500');const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(r=>r.name));check(['id','rollout_path','created_at'].every(k=>columns.has(k)),'managed_index_schema');
    const created=columns.has('created_at_ms')?'COALESCE(created_at_ms,created_at*1000)':'created_at*1000',updated=columns.has('updated_at_ms')?'COALESCE(updated_at_ms,updated_at*1000)':'updated_at*1000',query=db.prepare(`SELECT id,rollout_path,${created} AS created_ms,${updated} AS updated_ms FROM threads WHERE id=?`);
    return threadIds.map(threadId=>{const row=query.get(threadId);return row?{threadId,path:row.rollout_path,createdAt:new Date(row.created_ms).toISOString(),updatedAt:new Date(row.updated_ms).toISOString()}:{threadId,path:null};});
  }finally{db.close();}
}
export async function verifySessionCandidate(candidate,roots){
  check(candidate.path&&typeof candidate.path==='string','managed_index_missing');const path=localPath(candidate.path),info=await lstat(path);check(info.isFile()&&!info.isSymbolicLink(),'managed_candidate_not_regular');
  for(let p=dirname(path);dirname(p)!==p;p=dirname(p))check(!(await lstat(p)).isSymbolicLink(),'managed_candidate_symlink');
  const canonical=await realpath(path),approved=await Promise.all(roots.map(async r=>{try{return await realpath(localPath(r));}catch(e){if(e.code==='ENOENT')return localPath(r);throw e;}}));
  check(approved.some(root=>{const rel=relative(key(root),key(canonical));return rel!==''&&!isAbsolute(rel)&&!rel.startsWith('..');}),'managed_candidate_out_of_scope');
  const file=await open(canonical,'r');try{const parser=new MetadataJsonParser({fields:new Set(['type','payload.id']),observeNative:false}),decoder=new TextDecoder('utf-8',{fatal:true});let readBytes=0;
    while(readBytes<262144){const buffer=Buffer.alloc(Math.min(4096,262144-readBytes)),read=await file.read(buffer,0,buffer.length,readBytes);if(!read.bytesRead)break;readBytes+=read.bytesRead;
      // Never retain or project prompt text: only allowlisted identity leaves
      // survive. Collection subsequently validates the entire bounded line.
      const newline=buffer.subarray(0,read.bytesRead).indexOf(10),piece=buffer.subarray(0,newline<0?read.bytesRead:newline);parser.push(decoder.decode(piece,{stream:true}));
      if(parser.projected.type==='session_meta'&&parser.projected.payload?.id){check(parser.projected.payload.id===candidate.threadId,'managed_candidate_identity_mismatch');return {...candidate,path:canonical,identity:hash([info.dev,info.ino,info.birthtimeMs]),headerIdentityHash:hash(parser.projected),readBytes,identityBasis:'bounded session identity prefix; full line validated by collector'};}
      if(newline>=0)break;
    }check(false,'managed_candidate_identity_unavailable');
  }finally{await file.close();}
}
