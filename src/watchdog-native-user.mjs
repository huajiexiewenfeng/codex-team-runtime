// Only provenance combinations observed in the controlled native log are known.
// No body-text heuristics; unknown kinds/metadata remain attribution blockers.
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export function classifyWatchdogNativeUser(payload){
 const m=payload?.internal_chat_message_metadata_passthrough,result={kind:'unknown',turnId:id(m?.turn_id)?m.turn_id:null,createTime:m?.create_time};
 if(payload?.type!=='message'||payload.role!=='user'||!exact(m,['turn_id','create_time','content_item_kinds','content_item_metadata'])||!id(m.turn_id)||!Number.isFinite(m.create_time)||m.create_time<0)return result;
 if(!Array.isArray(payload.content)||payload.content.length!==1||payload.content[0]?.type!=='input_text'||typeof payload.content[0].text!=='string'||!payload.content[0].text.isWellFormed())return result;
 if(!Array.isArray(m.content_item_kinds)||m.content_item_kinds.length!==1||!Array.isArray(m.content_item_metadata)||m.content_item_metadata.length!==1)return result;
 const item=m.content_item_metadata[0],p=item?.provenance;if(!exact(item,['provenance']))return result;
 if(m.content_item_kinds[0]==='user.text'&&exact(p,['type'])&&p.type==='user')return {...result,kind:'user-text'};
 if(m.content_item_kinds[0]==='environments.environment_context'&&exact(p,['type','hook'])&&p.type==='harness'&&p.hook===false)return {...result,kind:'known-environment'};
 return result;
}
