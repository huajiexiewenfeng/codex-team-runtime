// Per-team deadlines: one active/faulting team never changes another team's pace.
export const watchdogIntervals=Object.freeze({activeMs:60_000,sleepMs:300_000,maxBackoffMs:900_000,heartbeatMs:30_000,heartbeatFreshMs:120_000});
export function nextWatchdogDelay(state,intervals=watchdogIntervals) {
 if(state.phase==='fault')return Math.min(intervals.maxBackoffMs,intervals.activeMs*2**Math.min(10,state.failures));
 return ['watching','reconciling'].includes(state.phase)?intervals.activeMs:intervals.sleepMs;
}
export function createWatchdogSchedule(ids,now) {
 const deadlines=new Map(ids.map(id=>[id,{at:now,generation:0}]));
 return {
  due:now=>[...deadlines].filter(([,v])=>v.at<=now).map(([id,v])=>({id,generation:v.generation})),
  wake(id,now){const v=deadlines.get(id);if(v){v.at=Math.min(v.at,now);v.generation++;}},
  finish(id,generation,now,delay){const v=deadlines.get(id);v.at=v.generation===generation?now+delay:Math.min(v.at,now);},
  delay(now){return Math.max(0,Math.min(...[...deadlines.values()].map(v=>v.at))-now);},
 };
}
