// Incremental JSON grammar + allowlisted scalar projection. Skipped strings are
// validated without retaining them. No arguments, output, prompt or command body.
import { check, LIMITS } from './stats-contract.mjs';
import { projectNativeTiming } from './native-tool-timing.mjs';
const leaves=new Set(['type','timestamp','schemaVersion','eventId','id','teamId','registryId','memberId','hostId','threadId','role','bindingRevision','roleEpoch','taskId','roundId','stepId','phase','assurance','sourceKind','evidenceRef','startedAt','completedAt','durationMs','tool','outcome','reason','identitySource','memberStatus','policyRevision','runtimeRevision','runtimeRevisionSource','reasonSource','errorCode',
  'payload.id','payload.type','payload.call_id','payload.name','payload.turn_id','payload.thread_id','payload.response_id','payload.model',
  ...['last_token_usage','total_token_usage'].flatMap(k=>['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].map(f=>`payload.info.${k}.${f}`)),
  ...['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].map(f=>`payload.usage.${f}`),
  ...['dispatch','notice'].flatMap(k=>['action','taskId','submissionId','operationId','attemptId','reasonCode','sourceVersion','ledgerVersion','requestBytes','responseBytes'].map(f=>`${k}.${f}`))]);
const useful=path=>leaves.has(path);
leaves.add('at');
export class MetadataJsonParser {
  constructor({maxDepth=LIMITS.depth,maxMetadataBytes=LIMITS.metadataBytes,fields=null,observeNative=true}={}) {
    this.stack=[];this.rootState='value';this.mode=null;this.projected={};this.metadataBytes=0;this.maxDepth=maxDepth;this.maxMetadataBytes=maxMetadataBytes;
    this.fields=fields;this.observeNative=observeNative;
  }
  path() { const top=this.stack.at(-1);return top?`${top.path}${top.path?'.':''}${top.kind==='object'?top.key:'[]'}`:''; }
  state() { return this.stack.at(-1)?.state??this.rootState; }
  put(value,path) {
    if(!(this.fields?this.fields.has(path):useful(path)))return;
    this.metadataBytes+=Buffer.byteLength(JSON.stringify(value));check(this.metadataBytes<=this.maxMetadataBytes,'source_metadata_limit');
    const keys=path.split('.');let o=this.projected;for(const k of keys.slice(0,-1)){check(!['__proto__','prototype','constructor'].includes(k),'source_bad_json');o=o[k]??=(Object.create(null));}o[keys.at(-1)]=value;
  }
  valueDone() { const top=this.stack.at(-1);if(top)top.state='comma';else this.rootState='done'; }
  startString(key) {
    const path=this.path();this.mode='string';this.keyString=key;this.capture=key||(this.fields?this.fields.has(path):useful(path));this.token='';this.escape=false;this.unicode=0;this.unicodeValue='';this.pathValue=path;
    this.observer=!key&&this.observeNative&&['payload.output','payload.output.[].text','payload.arguments'].includes(path)?{prefix:'',parser:null,bad:false,path}:null;
  }
  observeChar(c){
    const o=this.observer;if(!o)return;
    if(o.prefix.length<512)o.prefix+=c;
    if(o.parser===null&&!o.bad&&c.trim()){if(c==='{')o.parser=new MetadataJsonParser({fields:new Set(o.path==='payload.arguments'?['session_id','cell_id','terminate']:['chunk_id','session_id','exit_code','wall_time_seconds']),observeNative:false});else o.bad=true;}
    if(o.parser&&!o.bad)try{o.parser.push(c);}catch{o.bad=true;o.parser=null;}
  }
  stringValue(c){if(this.capture)this.token+=c;this.observeChar(c);}
  finishObserver(){
    const o=this.observer;if(!o)return;
    let metadata={};if(o.parser&&!o.bad)try{metadata=o.parser.finish();}catch{/* Unknown body/JSON never proves completion. */}
    this.projected.payload??={};
    if(o.path==='payload.arguments')this.projected.payload.nativeArguments=metadata;
    else{
      const timing=projectNativeTiming(metadata,o.prefix);
      // Multiple output blocks are ambiguous; never choose a favorable block.
      if(this.projected.payload.nativeTiming)this.projected.payload.nativeTiming=projectNativeTiming();
      else this.projected.payload.nativeTiming=timing;
    }
    this.observer=null;
  }
  stringChar(c) {
    if(this.unicode) {
      check(/[0-9a-fA-F]/.test(c),'source_bad_json');this.unicodeValue+=c;
      if(--this.unicode===0){this.stringValue(String.fromCharCode(parseInt(this.unicodeValue,16)));this.unicodeValue='';}return;
    }
    if(this.escape) {
      this.escape=false;if(c==='u'){this.unicode=4;return;}
      const map={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};check(Object.hasOwn(map,c),'source_bad_json');this.stringValue(map[c]);return;
    }
    if(c==='\\'){this.escape=true;return;}
    if(c==='"') {
      this.mode=null;
      this.finishObserver();
      if(this.keyString){const top=this.stack.at(-1);check(!top.keys.has(this.token),'source_duplicate_key');check(top.keys.size<1024,'source_metadata_limit');this.metadataBytes+=Buffer.byteLength(this.token);check(this.metadataBytes<=this.maxMetadataBytes,'source_metadata_limit');top.keys.add(this.token);top.key=this.token;top.state='colon';if(this.stack.length===1)this.rootKeys=[...top.keys];}
      else {this.put(this.token,this.pathValue);this.valueDone();}this.token='';return;
    }
    check(c.charCodeAt(0)>=32,'source_bad_json');this.stringValue(c);if(this.capture)check(this.token.length<=(this.keyString?256:this.maxMetadataBytes),'source_metadata_limit');
  }
  push(text) {
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(this.mode==='string'){this.stringChar(c);check(this.token.length<=(this.keyString?256:this.maxMetadataBytes),'source_metadata_limit');continue;}
      if(this.mode==='atom') {
        if(!/[\s,\]}]/.test(c)){this.token+=c;check(this.token.length<=128,'source_bad_json');continue;}
        this.finishAtom();i--;continue;
      }
      if(/[\x20\t\r\n]/.test(c))continue;
      const state=this.state(),top=this.stack.at(-1);
      if(state==='colon'){check(c===':','source_bad_json');top.state='value';continue;}
      if(state==='comma') {
        if(c===(top?.kind==='object'?'}':']')){this.stack.pop();this.valueDone();continue;}
        check(c===','&&top,'source_bad_json');top.state=top.kind==='object'?'key':'value';continue;
      }
      if(state==='firstKey'||state==='key') {
        if(c==='}'&&state==='firstKey'){this.stack.pop();this.valueDone();continue;}
        check(c==='"','source_bad_json');this.startString(true);continue;
      }
      if(state==='firstValue'&&c===']'){this.stack.pop();this.valueDone();continue;}
      check(state==='value'||state==='firstValue','source_bad_json');
      const path=this.path();
      if(c==='{'||c==='['){check(this.stack.length<this.maxDepth,'source_depth_limit');this.stack.push({kind:c==='{'?'object':'array',path,state:c==='{'?'firstKey':'firstValue',key:null,keys:new Set()});continue;}
      if(c==='"'){this.startString(false);continue;}
      check(/[tfn0-9-]/.test(c),'source_bad_json');this.mode='atom';this.token=c;this.pathValue=path;
    }
  }
  finishAtom(){
    const s=this.token;check(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(s),'source_bad_json');
    const value=JSON.parse(s);check(typeof value!=='number'||Number.isFinite(value),'source_bad_json');this.put(value,this.pathValue);this.mode=null;this.token='';this.valueDone();
  }
  finish(){if(this.mode==='atom')this.finishAtom();check(this.mode===null&&this.stack.length===0&&this.rootState==='done','source_bad_json');return this.projected;}
}
