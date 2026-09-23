import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCompletionExit} from '../src/task-eval-completion.mjs';
const fact=value=>({value,evidence:['review:fixture']});
const sample=()=>({schemaVersion:1,sampleId:'fixture',submission:fact('recorded'),notification:fact('delivered'),attemptMatched:fact(true),resultRecorded:fact(true),explicitWait:fact(false),remainingWork:fact(false)});
test('E01 evaluates reviewed successful evidence without activating or releasing work',()=>{
 const s=sample(),before=JSON.stringify(s),r=evaluateCompletionExit(s);
 assert.equal(r.assessment,'eligible-for-trial-review');assert.equal(r.activeExperiment,null);
 assert.equal(r.authorizesExecution,false);assert.equal(r.releasesWorker,false);assert.equal(r.approvesTask,false);
 assert.equal(r.evidenceAssurance,'analyst-reviewed-assertions');assert.equal(JSON.stringify(s),before);
});
for(const [name,field,value,assessment] of [
 ['denied notification','notification','policy-denied','not-applicable'],
 ['unknown notification','notification','unknown','insufficient-evidence'],
 ['failed notification','notification','failed','not-applicable'],
 ['unsubmitted work','submission','not-recorded','not-applicable'],
 ['different attempt','attemptMatched',false,'not-applicable'],
 ['missing write receipt','resultRecorded',false,'insufficient-evidence'],
 ['explicit wait request','explicitWait',true,'not-applicable'],
 ['remaining work','remainingWork',true,'not-applicable'],
 ['unknown handoff','explicitWait',null,'insufficient-evidence']
])test(name,()=>{const s=sample();s[field]=fact(value);assert.equal(evaluateCompletionExit(s).assessment,assessment);});
test('positive assertion without evidence is insufficient, not a trusted grant',()=>{
 const s=sample();s.notification.evidence=[];assert.equal(evaluateCompletionExit(s).assessment,'insufficient-evidence');
});
test('unknown fields and malformed values reject instead of becoming instructions',()=>{
 assert.throws(()=>evaluateCompletionExit({...sample(),authorizeAll:true}),/Invalid/);
 const s=sample();s.explicitWait=fact('false');assert.throws(()=>evaluateCompletionExit(s),/Invalid/);
});
