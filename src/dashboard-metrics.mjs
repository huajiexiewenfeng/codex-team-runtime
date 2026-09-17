import {open} from 'node:fs/promises';
import {renderDailyMetrics} from './metrics-daily-export.mjs';

// Operator-selected JSON only. Never accept a path or rendered HTML from HTTP.
export async function readDashboardMetrics(path,state) {
 if(!path)return {status:'not_configured',teamId:state.team.id};
 const file=await open(path,'r');
 let value;
 try {
  const info=await file.stat(),limit=16*1024*1024;
  if(!info.isFile()||info.size>limit)throw new Error('Invalid report size/type');
  const buffer=Buffer.alloc(limit+1);let length=0;
  while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  if(length>limit)throw new Error('Report too large');
  value=JSON.parse(buffer.subarray(0,length).toString('utf8'));
 }finally{await file.close();}
 const rendered=renderDailyMetrics(value); // Validates the complete report before rendering escaped data.
 if(value.daily.teamId!==state.team.id)throw new Error('Report team mismatch');
 const html=rendered.match(/<body>([\s\S]*)<script>/)?.[1];
 if(!html)throw new Error('Invalid metrics template');
 const observed=new Set(value.daily.days.flatMap(day=>day.byMember.filter(member=>member.metrics.total.knownRecords+member.metrics.total.missingRecords>0).map(member=>member.memberId)));
 const currentMembers=state.members.filter(member=>member.lifecycle==='active');
 return {status:'ready',teamId:state.team.id,asOf:value.daily.asOf,from:value.daily.from,to:value.daily.to,timeZone:value.daily.timeZone,
  currentMemberCount:currentMembers.length,observedCurrentMembers:currentMembers.filter(member=>observed.has(member.id)).length,
  missingMemberIds:currentMembers.filter(member=>!observed.has(member.id)).map(member=>member.id),html};
}
