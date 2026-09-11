import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPoller, captureReadingPosition, restoreReadingPosition} from '../src/dashboard-client.mjs';

function setup(options={}) {
 const timers=new Map(),statuses=[],data=[];let id=0,visible=true;
 const poller=createPoller({request:async()=>({version:1}),onData:value=>{data.push(value);},onStatus:value=>statuses.push(value),visible:()=>visible,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:key=>timers.delete(key),...options});
 return {poller,timers,statuses,data,hide:()=>{visible=false;poller.visibilityChanged();},show:()=>{visible=true;return poller.visibilityChanged();}};
}
test('poller starts immediately, schedules after completion only, and pauses/resumes',async()=>{
 const s=setup();await s.poller.start();assert.equal(s.data.length,1);assert.equal(s.timers.size,1);assert.equal([...s.timers.values()][0].ms,5000);
 s.poller.pause();assert.equal(s.timers.size,0);assert.equal(s.statuses.at(-1),'paused');await s.poller.resume();assert.equal(s.data.length,2);s.poller.stop();assert.equal(s.timers.size,0);
});
test('hidden pages cancel requests and do not apply late data; visibility resumes',async()=>{
 let finish,signal;const s=setup({request:args=>{signal=args.signal;return new Promise(resolve=>finish=resolve);}});
 const pending=s.poller.start();s.hide();assert.ok(signal.aborted);finish({version:1});await pending;assert.equal(s.data.length,0);assert.equal(s.timers.size,0);assert.equal(s.statuses.at(-1),'hidden');
 const resumed=s.show();finish({version:2});await resumed;assert.equal(s.data[0].version,2);s.poller.stop();
});
test('manual refresh does not overlap an in-flight request; replace aborts old scope',async()=>{
 const pending=[];const s=setup({request:({signal})=>new Promise(resolve=>pending.push({signal,resolve}))});
 const first=s.poller.start();s.poller.refresh();assert.equal(pending.length,1);
 const replaced=s.poller.refresh({replace:true});assert.ok(pending[0].signal.aborted);assert.equal(pending.length,2);
 pending[0].resolve({round:'old'});pending[1].resolve({round:'new'});await Promise.all([first,replaced]);assert.deepEqual(s.data,[{round:'new'}]);s.poller.stop();
});
test('failures retain displayed data, back off and recover; 401 stops automatic retries',async()=>{
 let error=null;const s=setup({request:async()=>{if(error)throw error;return {version:1};}});
 await s.poller.start();error=new Error('disconnected');await s.poller.refresh();assert.equal(s.data.length,1);assert.equal(s.statuses.at(-1),'unavailable');assert.equal([...s.timers.values()][0].ms,10000);
 error=null;await s.poller.refresh();assert.equal(s.data.length,2);assert.equal([...s.timers.values()][0].ms,5000);
 error=Object.assign(new Error('no authorization'),{status:401});await s.poller.refresh();assert.equal(s.statuses.at(-1),'unauthorized');assert.equal(s.timers.size,0);s.poller.stop();
});
test('timeout aborts a stalled request and exposes retryable failure',async()=>{
 const s=setup({request:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
 const pending=s.poller.start();const timeout=[...s.timers.values()].find(x=>x.ms===15000);assert.ok(timeout);timeout.fn();await pending;assert.equal(s.statuses.at(-1),'unavailable');assert.equal([...s.timers.values()][0].ms,10000);s.poller.stop();
});
test('a selected-text deferral is distinct from applied data and retries without losing updates',async()=>{
 const s=setup({onData:()=>false});await s.poller.start();assert.equal(s.statuses.at(-1),'deferred');assert.equal(s.timers.size,1);s.poller.stop();
});
test('manual refresh is allowed while paused but does not resume automatic requests',async()=>{
 const s=setup();await s.poller.start();s.poller.pause();await s.poller.refresh();assert.equal(s.data.length,2);assert.equal(s.statuses.at(-1),'paused');assert.equal(s.timers.size,0);s.poller.stop();
});
test('page-cache restart retains pause and invalid-credential boundaries',async()=>{
 const s=setup();await s.poller.start();s.poller.pause();s.poller.stop();await s.poller.start();
 assert.equal(s.data.length,1);assert.equal(s.timers.size,0);await s.poller.resume();assert.equal(s.data.length,2);s.poller.stop();
 let reads=0;const denied=setup({request:async()=>{reads++;throw Object.assign(new Error('unauthorized'),{status:401});}});
 await denied.poller.start();denied.poller.stop();await denied.poller.start();assert.equal(reads,1);assert.equal(denied.timers.size,0);denied.poller.stop();
});
test('reading anchor follows activity/member/footer geometry when no task card is visible',()=>{
 // Geometry seam only; real DOM/filter/focus behavior is checked in the browser smoke.
 let scroll;
 const win={scrollX:0,scrollY:2400,innerHeight:800,scrollTo:(x,y)=>{scroll={x,y};}};
 const element=(id,top,height=300,liveKey=undefined)=>({id,dataset:{liveKey},getBoundingClientRect:()=>({top,bottom:top+height,height})});
 const container=elements=>({ownerDocument:{defaultView:win},querySelectorAll:()=>elements});
 for(const [id,key] of [['activity',undefined],['','member-worker-01'],['snapshot',undefined]]){
  const before=container([element('overview',-2200,150),element(id,24,500,key)]);
  const captured=captureReadingPosition(before);
  restoreReadingPosition(container([element(id,324,500,key)]),captured);
  assert.deepEqual(scroll,{x:0,y:2700});
 }
});
test('reading anchor falls back to another retained visible block, then absolute scroll',()=>{
 const calls=[],win={scrollX:2,scrollY:100,innerHeight:800,scrollTo:(...args)=>calls.push(args)};
 const item=(id,top,height=100)=>({id,dataset:{},getBoundingClientRect:()=>({top,bottom:top+height,height})});
 const container=items=>({ownerDocument:{defaultView:win},querySelectorAll:()=>items});
 const captured=captureReadingPosition(container([item('removed',10),item('kept',150)]));
 restoreReadingPosition(container([item('kept',200)]),captured);assert.deepEqual(calls.pop(),[2,150]);
 restoreReadingPosition(container([]),captured);assert.deepEqual(calls.pop(),[2,100]);
});
test('reading offset accounts for any browser scroll adjustment during DOM replacement',()=>{
 let result;const win={scrollX:0,scrollY:100,innerHeight:800,scrollTo:(_,y)=>result=y};
 const item=top=>({id:'activity',dataset:{},getBoundingClientRect:()=>({top,bottom:top+200,height:200})});
 const container=top=>({ownerDocument:{defaultView:win},querySelectorAll:()=>[item(top)]});
 const before=captureReadingPosition(container(20));win.scrollY=250;
 restoreReadingPosition(container(70),before);assert.equal(result,300);
});
test('a navigation target outranks a nearer unrelated sidebar anchor',()=>{
 let targetY;const win={scrollX:0,scrollY:2000,innerHeight:800,location:{hash:'#activity'},scrollTo:(_,y)=>targetY=y};
 const activity={id:'activity',dataset:{},getBoundingClientRect:()=>({top:24,bottom:600,height:576})};
 const sidebar={id:'',dataset:{liveKey:'member-worker'},getBoundingClientRect:()=>({top:2,bottom:102,height:100})};
 const doc={defaultView:win,getElementById:id=>id==='activity'?activity:null};
 const before=captureReadingPosition({ownerDocument:doc,querySelectorAll:()=>[activity,sidebar]});
 activity.getBoundingClientRect=()=>({top:474,bottom:1050,height:576});
 restoreReadingPosition({ownerDocument:doc,querySelectorAll:()=>[activity,sidebar]},before);
 assert.equal(targetY,2450);
});
