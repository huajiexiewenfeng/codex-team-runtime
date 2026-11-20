import {startWatchdogControlService} from './watchdog-background.mjs';
const [manifestPath,controlRoot,ownerNonce]=process.argv.slice(2);let service;
try{service=await startWatchdogControlService({manifestPath,controlRoot,ownerNonce});const stop=()=>{void service.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);}catch{process.exitCode=1;}
