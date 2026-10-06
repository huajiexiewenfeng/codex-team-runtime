// Common bounded host-envelope rules. Arbitrary tool text is not proof that a
// process/script has finished. Returned metadata never contains the body.
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
export function projectNativeTiming(metadata={},prefix='') {
  metadata??={};
  const sessionId=Number.isSafeInteger(metadata.session_id)&&metadata.session_id>=0?metadata.session_id:null;
  const exitCode=Number.isSafeInteger(metadata.exit_code)?metadata.exit_code:null;
  const wall=typeof metadata.wall_time_seconds==='number'&&Number.isFinite(metadata.wall_time_seconds)&&metadata.wall_time_seconds>=0?Math.round(metadata.wall_time_seconds*1000):null;
  if(identifier(metadata.chunk_id)&&Number.isSafeInteger(wall)&&(sessionId!==null||exitCode!==null))return {completionKnown:exitCode!==null,kind:'process',sessionId,exitCode,cellId:null,reportedDurationMs:wall,evidence:'structured-native-envelope'};
  const running=/^Process running with session ID (\d+)(?:\r?\n|$)/.exec(prefix);
  if(running&&Number.isSafeInteger(Number(running[1])))return {completionKnown:false,kind:'process',sessionId:Number(running[1]),exitCode:null,cellId:null,reportedDurationMs:null,evidence:'native-running-header'};
  const exited=/^(?:Chunk ID: [a-zA-Z0-9_.:-]+\r?\nWall time: [\d.]+ seconds\r?\n)?Process exited with code (-?\d+)(?:\r?\n|$)/.exec(prefix);
  if(exited&&Number.isSafeInteger(Number(exited[1])))return {completionKnown:true,kind:'process',sessionId:null,exitCode:Number(exited[1]),cellId:null,reportedDurationMs:null,evidence:'native-exit-header'};
  const yielded=/^Script running with cell ID ([a-zA-Z0-9_-]+)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n/.exec(prefix);
  if(yielded)return {completionKnown:false,kind:'script',sessionId:null,exitCode:null,cellId:yielded[1],reportedDurationMs:null,evidence:'native-script-yield-header'};
  if(/^Script completed\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n/.test(prefix))return {completionKnown:true,kind:'script',sessionId:null,exitCode:null,cellId:null,reportedDurationMs:null,evidence:'native-script-completed-header'};
  return {completionKnown:false,kind:'unknown',sessionId:null,exitCode:null,cellId:null,reportedDurationMs:null,evidence:'completion-unproven'};
}
export function projectNativeContinuation(tool,args={}) {
  if(/^(?:(?:functions|tools)\.)?write_stdin$/.test(tool??'')&&Number.isSafeInteger(args.session_id)&&args.session_id>=0)return {kind:'process',id:args.session_id};
  if(/^(?:functions\.)?wait$/.test(tool??'')&&identifier(args.cell_id)&&(args.terminate===undefined||args.terminate===false))return {kind:'script',id:args.cell_id};
  return null;
}
