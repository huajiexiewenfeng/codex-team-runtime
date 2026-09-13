import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportMetrics, renderMetrics } from '../src/metrics-export.mjs';
import { buildMetrics } from '../src/metrics.mjs';
import { demoState } from '../src/demo.mjs';
import { parseCodexUsageWithObservations } from '../src/metrics-observations.mjs';
import { mergeUsage } from '../src/metrics-usage.mjs';

const roots=[];
afterEach(async()=>{while(roots.length)await rm(roots.pop(),{recursive:true,force:true});});
const event=(kind,line,extra={})=>({kind,line,at:null,callId:null,tool:null,argumentsHash:null,contentHash:null,bytes:null,...extra});
function report() {
  const ledger={schemaVersion:2,teamId:'demo-team',links:[],diagnostics:[],records:[{
    id:'record-evil',hostId:'fixture-host',threadId:'fixture-worker-01',at:'2026-09-05T00:05:30.000Z',turnId:'turn-1',model:'gpt-test',
    usage:{input:20,cachedInput:5,output:3,reasoningOutput:1,total:23},source:{kind:'codex-log',ref:'<img src=x onerror=evil>'}
  },{
    id:'record-repeat',hostId:'fixture-host',threadId:'fixture-worker-01',at:'2026-09-05T00:05:40.000Z',turnId:'turn-2',model:null,
    usage:{input:10,cachedInput:0,output:2,reasoningOutput:0,total:12},source:{kind:'codex-log',ref:'<img src=x onerror=evil>'}
  }],observations:[{recordId:'record-evil',sourceRef:'<img src=x onerror=evil>',firstLine:1,usageLine:8,nativeResponse:{responseId:'response-1',turnId:'turn-1',line:6,association:'counter-match'},events:[
    event('tool_call',2,{callId:'call-1',tool:'exec',argumentsHash:'a'.repeat(64)}),event('tool_result',3,{callId:'call-1',tool:'exec',contentHash:'b'.repeat(64),bytes:17}),event('context_compaction',4)
  ]},{recordId:'record-repeat',sourceRef:'<img src=x onerror=evil>',firstLine:7,usageLine:12,nativeResponse:null,events:[
    event('tool_call',9,{callId:'call-2',tool:'exec',argumentsHash:'a'.repeat(64)}),event('tool_result',10,{callId:'call-2',tool:'exec',contentHash:'b'.repeat(64),bytes:19})
  ]}]};
  return {...buildMetrics(demoState(),ledger,'2026-09-05T01:00:00.000Z'),sourceScope:{kind:'recorded-state-snapshot',registryRefreshed:false,liveTelemetry:false}};
}

test('renders complete v2 cause cards and safe generated anchors without scripts or network',()=>{
  const html=renderMetrics(report());
  for(const value of ['成本驱动','显示 2 / 共 2','非缓存输入','源位置','第 1–8 行','usage 第 8 行','activity 截止第 6 行','native response','exec','第 2 行','17 bytes','observed','temporal','candidate','repeated_same_content','previous','current','不证明无效工作或浪费','日志序列化体积，不是模型输入 Token']) assert.match(html,new RegExp(value));
  assert.match(html,/href="#record-0"/); assert.match(html,/id="record-0"/);
  assert.ok(html.includes('&lt;img src=x onerror=evil&gt;'));
  assert.doesNotMatch(html,/<script|https?:\/\/|href="&lt;img|href="<img/i);
  assert.match(html,/2026-09-05T00:05:40\.000Z/);
  assert.match(html,/turn-2/);
  assert.match(html,/model[^<]*<span class="unknown">未知<\/span>/);
  assert.match(html,/fixture-host/);
  assert.match(html,/fixture-worker-01/);
  assert.match(html,/codex-log/);
});

test('v2 report json equals input and nested explanation abuse is rejected before mkdir',async()=>{
  const root=await mkdtemp(join(tmpdir(),'metrics-export-v2-'));roots.push(root);const output=join(root,'out'),value=report();
  await exportMetrics(value,output);assert.deepEqual(JSON.parse(await readFile(join(output,'report.json'),'utf8')),value);
  const invalid=structuredClone(value);invalid.explanation.cards[0].activity.toolResults.items[0].callLine=999;
  const rejected=join(root,'rejected');await assert.rejects(exportMetrics(invalid,rejected),/explanation|call|result|reference/i);await assert.rejects(stat(rejected),error=>error.code==='ENOENT');
});

test('v1 report remains renderable without explanation UI',()=>{
  const value=report();delete value.explanation;value.schemaVersion=1;
  const html=renderMetrics(value);assert.doesNotMatch(html,/成本驱动|record-0/);
});

test('parser through renderer preserves missing and illegal tool names as linked unknown evidence',()=>{
  const usage=(input,output,total)=>({input_tokens:input,cached_input_tokens:0,output_tokens:output,reasoning_output_tokens:0,total_tokens:total});
  const token=(at,last,total)=>({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:last,total_token_usage:total}}});
  const entries=[
    {type:'session_meta',payload:{id:'fixture-worker-01'}},
    {type:'response_item',payload:{type:'function_call',arguments:'{}',call_id:'missing-name'}},
    {type:'response_item',payload:{type:'function_call_output',output:'missing-result',call_id:'missing-name'}},
    token('2026-09-05T00:05:30.000Z',usage(10,2,12),usage(10,2,12)),
    {type:'response_item',payload:{type:'function_call',name:'illegal name!',arguments:'{}',call_id:'illegal-name'}},
    {type:'response_item',payload:{type:'function_call_output',output:'illegal-result',call_id:'illegal-name'}},
    token('2026-09-05T00:05:40.000Z',usage(11,2,13),usage(21,4,25))
  ];
  const parsed=parseCodexUsageWithObservations(entries.map(item=>JSON.stringify(item)).join('\n')+'\n',{
    hostId:'fixture-host',threadId:'fixture-worker-01',sourceRef:'unknown-tool-fixture'
  });
  const ledger=mergeUsage({schemaVersion:1,teamId:'demo-team',records:[],links:[],diagnostics:[]},parsed.records,parsed.diagnostics,parsed.observations);
  const value={...buildMetrics(demoState(),ledger,'2026-09-05T01:00:00.000Z'),sourceScope:{kind:'recorded-state-snapshot',registryRefreshed:false,liveTelemetry:false}};
  assert.equal(value.explanation.cards.length,2);
  assert.deepEqual(value.explanation.cards.map(card=>card.activity.toolCalls.items[0]),[{line:2,tool:null},{line:5,tool:null}]);
  assert.deepEqual(value.explanation.cards.map(card=>card.activity.toolResults.items[0]),[
    {line:3,bytes:14,callLine:2,tool:null},{line:6,bytes:14,callLine:5,tool:null}
  ]);
  const html=renderMetrics(value);
  assert.match(html,/tool 未知/);assert.match(html,/14 bytes/);assert.match(html,/call 第 2 行/);assert.match(html,/call 第 5 行/);
});
