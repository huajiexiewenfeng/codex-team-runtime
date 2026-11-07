import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createState,evolve} from '../src/runtime.mjs';

const execute=promisify(execFile);
export async function linkedShellFixture(t,{pythonExecutable,nodeExecutable=process.execPath,runtimeRoot=fileURLToPath(new URL('..',import.meta.url))}) {
  assert.ok(pythonExecutable,'explicit verified installed exporter required');
  const root=await realpath(await mkdtemp(join(tmpdir(),'manager-operations-shell-')));
  t.after(async()=>{assert.ok(root.startsWith(await realpath(tmpdir())+sep));await rm(root,{recursive:true,force:true,maxRetries:3});});
  const statePath=join(root,'state.json'),registryPath=join(root,'registry.json'),requestFile=join(root,"dispatch ' 中文.json"),setupPath=join(root,'setup.py');
  const at='2026-10-28T00:00:00.000Z',source={kind:'manual',ref:'synthetic offline shell bridge fixture; fake host only'},caller={hostId:'offline-shell',threadId:'shell-manager'};
  const member=(id,role,binding)=>({id,name:id,role,lifecycle:'active',binding});
  let state=createState({teamId:'shell-team',name:'Synthetic shell fixture',source,members:[
    member('m','Manager',{status:'bound',...caller}),member('l','Liaison',{status:'unbound'}),
    member('w','Worker',{status:'bound',hostId:'offline-shell',threadId:'shell-worker'})]},at);
  for(const e of [{id:'invite',type:'attachInvite',caller,target:{hostId:'offline-shell',threadId:'shell-liaison'},expiresAt:'2026-10-28T00:10:00.000Z'},
    {id:'confirm',type:'attachConfirm',actor:'l',caller:{hostId:'offline-shell',threadId:'shell-liaison'},invitationId:'invite',invitationVersion:1},
    {id:'open',type:'openRound',roundId:'r',title:'Offline shell round'}])state=evolve(state,{actor:'m',at,source,...e},state.version);
  await writeFile(statePath,JSON.stringify(state)+'\n');
  // Use the installed package's REAL validation, adoption, onboarding and
  // exporter. Every path and membership below belongs only to this temp root.
  const setup=`import sys,json,hashlib\nfrom pathlib import Path\nfrom codex_team_context.team_registry import TeamRegistry,initialize_registry\nfrom codex_team_context.runtime_link import export_registry\nregistry_path,state_path,node,root=map(Path,sys.argv[1:])\ninitialize_registry(registry_path)\nraw=state_path.read_bytes();s=json.loads(raw)\nstore=TeamRegistry(registry_path=registry_path,node_executable=node,runtime_root=root)\nrequest={'action':'adopt_legacy','operation_id':'shell-migration','team_id':s['team']['id'],'team_name':s['team']['name'],'member_id':'m','state_path':str(state_path),'expected_state_version':s['version'],'expected_state_sha256':hashlib.sha256(raw).hexdigest(),'members':s['members'],'authorization_ref':'synthetic fixture setup only','consent_ref':'synthetic existing confirmed liaison'}\nstore.manage('offline-shell','shell-manager',request)\nfor member in s['members']:\n capsule=store.read(member['binding']['hostId'],member['binding']['threadId'])\n manager=store.read('offline-shell','shell-manager')\n store.manage('offline-shell','shell-manager',{'action':'confirm_ready','operation_id':'ready-'+member['id'],'team_id':s['team']['id'],'expected_revision':manager['team']['revision'],'member_id':member['id'],'receipt':capsule['onboardingReceipt'],'evidence_ref':'synthetic offline onboarding receipt'})\nprojection=export_registry(registry_path,s['team']['id'])\nassert set(projection['readyMemberIds'])=={'m','l','w'}\nprint(json.dumps({'registryValidated':True,'readyMemberIds':projection['readyMemberIds'],'teamRevision':projection['teamRevision']}))\n`;
  await writeFile(setupPath,setup);
  const setupResult=await execute(pythonExecutable,['-I','-X','utf8',setupPath,registryPath,statePath,nodeExecutable,resolve(runtimeRoot)],{windowsHide:true,encoding:'utf8',timeout:30000});
  state=JSON.parse(await readFile(statePath,'utf8'));
  const input={statePath,enqueueInput:{schemaVersion:1,action:'enqueue',operationId:'shell-enqueue',caller,teamId:'shell-team',roundId:'r',taskId:'shell-task',workerId:'w',expectedVersion:state.version,mode:'legacy',reason:'before_dispatch',title:'Synthetic shell bridge task',required:true},
    brief:{schemaVersion:1,teamId:'shell-team',roundId:'r',taskId:'shell-task',actor:caller,text:'原始 brief\r\nPowerShell + Node + installed Python exporter; FAKE HOST ONLY',scope:'synthetic fixture only',materialRefs:['fixture:material'],authorizationRef:'fixture:explicit fake-host authorization',dependencyRef:'fixture:prerequisites'},
    prepareInput:{operation_id:'shell-prepare',reason:'before_dispatch',admission:{native:{host_id:'offline-shell',thread_id:'shell-worker',status:'idle',evidence_ref:'fixture:idle'}},baseline:{outcome:'not-attempted',evidence_ref:'fixture:no-send'}},hostEvidencePath:join(root,'native-result.json')};
  await writeFile(requestFile,JSON.stringify(input));
  return {root,statePath,registryPath,requestFile,input,setup:JSON.parse(setupResult.stdout),pythonExecutable,nodeExecutable,runtimeRoot:resolve(runtimeRoot)};
}

export async function realPowerShellTool(cmd,{workdir,pythonExecutableToRemove=true}={}) {
  const env={...process.env};if(pythonExecutableToRemove)delete env.CODEX_TEAM_CONTEXT_PYTHON;
  // Actual shell process and Node/Python descendants; NO cmd parser or direct
  // JS bridge invocation. Only the native sender is supplied by the test.
  try {const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{cwd:workdir,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});return {output:result.stdout,exit_code:0};}
  catch(error){if(typeof error.code==='number')return {output:error.stdout??'',stderr:error.stderr??'',exit_code:error.code};throw error;}
}
