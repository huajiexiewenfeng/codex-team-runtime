import {inboxReasons, jsonBoundary, parseInboxJson, digest} from './manager-inbox-contract.mjs';

const string = (maxLength=128) => ({type:'string',minLength:1,maxLength});
const identifier = {...string(),pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'};
const integer = {type:'integer',minimum:0};
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const caller = object({hostId:identifier,threadId:identifier});
const claim = object({runId:identifier,generation:integer,claimId:identifier,itemId:identifier});
const common = {schemaVersion:{const:1},action:{enum:['enqueue','receive','record_decision','status']},
  operationId:identifier,caller,teamId:identifier,roundId:identifier,taskId:identifier,workerId:identifier,
  expectedVersion:integer,mode:{enum:['legacy','observe','queue_first']},reason:{enum:inboxReasons}};
const notice = object({schemaVersion:{const:1},teamId:identifier,roundId:identifier,taskId:identifier,
  submissionId:identifier,submissionVersion:integer,submittedAt:string(32),worker:caller,manager:caller,
  summary:string(4000),notificationId:{...string(64),pattern:'^[a-f0-9]{64}$'}});
const actions = {
  enqueue:{title:string(4000),required:{type:'boolean'},briefRef:{...string(128),pattern:'^e04-brief:sha256:[a-f0-9]{64}$'}},
  receive:{submissionId:identifier,notice,claim},
  record_decision:{submissionId:identifier,reviewEventId:identifier,decision:{enum:['approve','rework']},
    summary:string(4000),evidence:{type:'array',items:string(4000),maxItems:16},claim},
  status:{requestFingerprint:{...string(64),pattern:'^[a-f0-9]{64}$'},submissionId:identifier}
};
export const managerOperationsSchema = Object.freeze({$schema:'https://json-schema.org/draft/2020-12/schema',
  oneOf:Object.entries(actions).flatMap(([action,extra])=>common.mode.enum.flatMap(mode=>
    (action==='record_decision'?['approve','rework']:[null]).map(decision=>{
      const properties={...common,action:{const:action},mode:{const:mode},...extra};
      if(action==='receive')delete properties[mode==='queue_first'?'notice':'claim'];
      if(action==='record_decision') {
        if(mode!=='queue_first')delete properties.claim;
        properties.decision={const:decision};
        properties.evidence={...extra.evidence,minItems:decision==='approve'?1:0,maxItems:decision==='approve'?16:0};
      }
      const schema=object(properties);
      if(action==='status')schema.required=schema.required.filter(k=>k!=='submissionId');
      return schema;
    }))) });

export function fail(code,field,legal,message=code) {
  throw Object.assign(new Error(message),{code,field,legal});
}
function validate(v,s,path) {
  const bad=()=>fail('INVALID_REQUEST',path,s.enum??(Object.hasOwn(s,'const')?[s.const]:s.pattern??s.type??'schema'));
  if(Object.hasOwn(s,'const')&&v!==s.const)bad();
  if(s.enum&&!s.enum.includes(v))bad();
  if(s.type==='object') {
    if(!v||typeof v!=='object'||Array.isArray(v))bad();
    for(const k of Object.keys(v))if(!Object.hasOwn(s.properties,k))fail('INVALID_REQUEST',path+'.'+k.slice(0,80),'remove unknown field');
    for(const k of s.required)if(!Object.hasOwn(v,k))fail('INVALID_REQUEST',path+'.'+k,'required');
    for(const [k,x] of Object.entries(v))validate(x,s.properties[k],path+'.'+k);
  } else if(s.type==='string') {
    if(typeof v!=='string'||!v.trim()||v.length<s.minLength||v.length>s.maxLength||s.pattern&&!new RegExp(s.pattern).test(v))bad();
  } else if(s.type==='integer') {if(!Number.isSafeInteger(v)||v<s.minimum)bad();}
  else if(s.type==='boolean') {if(typeof v!=='boolean')bad();}
  else if(s.type==='array') {if(!Array.isArray(v)||v.length>s.maxItems||v.length<(s.minItems??0))bad();v.forEach((x,i)=>validate(x,s.items,path+'['+i+']'));}
}
export function validateManagerRequest(input) {
  const r=typeof input==='string'?parseInboxJson(input):jsonBoundary(input,65536);
  if(!Object.hasOwn(actions,r?.action??''))fail('INVALID_REQUEST','$.action',Object.keys(actions));
  if(!common.mode.enum.includes(r.mode))fail('MODE_UNKNOWN','$.mode',common.mode.enum);
  if(r.action==='record_decision'&&!['approve','rework'].includes(r.decision))fail('INVALID_REQUEST','$.decision',['approve','rework']);
  const schema=managerOperationsSchema.oneOf.find(s=>s.properties.action.const===r.action&&s.properties.mode.const===r.mode&&
    (r.action!=='record_decision'||s.properties.decision.const===r.decision));
  validate(r,schema,'$');
  return r;
}
export const fingerprint = digest;
// IDs remain valid in the unchanged event and E05 operation schemas. The 192-bit
// operation key locates replays; the full SHA256 binds the complete closed input.
export const operationPrefix = r=>'mo-'+digest([r.teamId,r.operationId]).slice(0,48)+'-';
export const operationEventId = r=>operationPrefix(r)+digest(r);
