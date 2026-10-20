export function fieldError(field, message, example) {
  throw Object.assign(new Error(`${field}: ${message}`), {code:'FIELD_INVALID', field, example});
}
const text=(v,p)=>{if(typeof v!=='string'||!v.trim()||v.length>4000)fieldError(p,'required nonempty text (max 4000)','actual evidence reference');};
const object=(v,keys,p)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fieldError(p,'expected closed object',Object.fromEntries(keys.map(k=>[k,'required'])));};
const list=(v,p,fn)=>{if(!Array.isArray(v)||v.length>100)fieldError(p,'expected array (max 100)',[]);v.forEach((x,i)=>fn(x,`${p}[${i}]`));};
export function validateEvidence(v) {
  object(v,['taskId','summary','files','verification','artifacts','gaps'],'submission');
  text(v.taskId,'taskId');text(v.summary,'summary');
  list(v.files,'files',text);
  list(v.verification,'verification',(x,p)=>{object(x,['command','outcome','evidenceRef'],p);text(x.command,p+'.command');text(x.evidenceRef,p+'.evidenceRef');if(!['passed','failed','not-run'].includes(x.outcome))fieldError(p+'.outcome','expected passed, failed or not-run','passed');});
  list(v.artifacts,'artifacts',(x,p)=>{object(x,['path','sha256','verification','evidenceRef'],p);text(x.path,p+'.path');text(x.evidenceRef,p+'.evidenceRef');if(!/^[a-f0-9]{64}$/.test(x.sha256))fieldError(p+'.sha256','expected SHA-256 hex','a'.repeat(64));if(!['matched','mismatch','not-run'].includes(x.verification))fieldError(p+'.verification','expected matched, mismatch or not-run','matched');});
  list(v.gaps,'gaps',text);
  return v; // evidence is a declaration; no claim of independently checked files
}
export function validateBlocker(v) {object(v,['reason','who','needs','evidenceRef'], 'blocker');for(const k of ['reason','who','needs','evidenceRef'])text(v[k],'blocker.'+k);return v;}
