// Projects explicitly selected host items; never exports prompts, commands or outputs.
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
export function projectNativeTimeline(page,descriptor){
 for(const key of ['sourceRef','hostId','threadId','role','turnId'])if(!validId(descriptor[key]))throw new Error('Invalid native descriptor');
 if(page?.schemaVersion!==1||page.thread?.id!==descriptor.threadId||page.thread?.hostId!==descriptor.hostId)throw new Error('Native identity mismatch');
 const ids=descriptor.itemIds;
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(x=>!validId(x))||new Set(ids).size!==ids.length)throw new Error('Invalid native item selection');
 const turns=(page.turns??[]).filter(t=>t.id===descriptor.turnId);
 if(turns.length!==1||!Array.isArray(turns[0].items))throw new Error('Missing or ambiguous native turn');
 const items=ids.map(itemId=>{
  const matches=turns[0].items.filter(i=>i.id===itemId);
  if(matches.length!==1)throw new Error('Missing or ambiguous native item');
  const item=matches[0];
  if(!['commandExecution','mcpToolCall'].includes(item.type))throw new Error('Unsupported native item');
  return {itemId,turnId:descriptor.turnId,kind:item.type,tool:item.type==='commandExecution'?'exec_command':validId(item.tool)?item.tool:null,status:['completed','failed','inProgress'].includes(item.status)?item.status:'unknown',durationMs:Number.isSafeInteger(item.durationMs)&&item.durationMs>=0?item.durationMs:null,exitCode:Number.isSafeInteger(item.exitCode)?item.exitCode:null,startAt:null,endAt:null,timeBasis:'host-reported-duration'};
 });
 return {sourceRef:descriptor.sourceRef,hostId:descriptor.hostId,threadId:descriptor.threadId,role:descriptor.role,association:'analyst-selected-items',adapterVersion:'native-thread-items-v1',items};
}
