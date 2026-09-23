// Read-only observations. No business state, role registry or workflow mutations.
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : null;
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const delta = (a,b) => a && b && Date.parse(b)>=Date.parse(a) ? Date.parse(b)-Date.parse(a) : null;

export function createTimelineParser(input) {
  const source = {};
  for(const key of ['sourceRef','hostId','threadId','role']) {
    if(!id(input[key]))throw new Error(`Invalid timeline ${key}`);
    source[key]=input[key];
  }
  source.from=time(input.from);source.to=time(input.to);
  if(!source.from||!source.to||delta(source.from,source.to)===null)throw new Error('Invalid explicit timeline window');
  source.association='analyst-scoped';
  const events=[],diagnostics=[];
  let line=0,identitySeen=false,previousAt=null;
  function push(text) {
    line++;
    let item;
    try{item=JSON.parse(text);}catch{diagnostics.push({code:'malformed-json',sourceRef:source.sourceRef,line});return;}
    const p=item?.payload??{};
    if(item?.type==='session_meta') {
      if(p.id!==source.threadId)throw new Error('Timeline source identity mismatch');
      identitySeen=true;return;
    }
    let kind=null;
    if(item?.type==='compacted'||(item?.type==='event_msg'&&p.type==='context_compacted'))kind='compaction';
    if(item?.type==='response_item') {
      if(['function_call','custom_tool_call'].includes(p.type))kind='tool-call';
      if(['function_call_output','custom_tool_call_output'].includes(p.type))kind='tool-result';
      if(p.type==='message'&&['user','assistant'].includes(p.role))kind=`${p.role}-message`;
    }
    if(!kind)return;
    const observedAt=time(item.timestamp);
    if(!observedAt){diagnostics.push({code:'missing-time',sourceRef:source.sourceRef,line});return;}
    if(observedAt<source.from||observedAt>source.to)return;
    if(previousAt&&observedAt<previousAt)diagnostics.push({code:'clock-regression',sourceRef:source.sourceRef,line});
    previousAt=observedAt;
    const event={eventId:`${source.sourceRef}:${line}`,sourceRef:source.sourceRef,line,hostId:source.hostId,threadId:source.threadId,role:source.role,association:'analyst-scoped',kind,observedAt};
    if(kind==='tool-call'||kind==='tool-result') {
      event.callId=id(p.call_id);
      if(!event.callId)diagnostics.push({code:'missing-call-id',sourceRef:source.sourceRef,line});
    }
    if(kind==='tool-call') {
      event.tool=id(p.name);
      if(['write_stdin','functions.write_stdin','tools.write_stdin'].includes(event.tool))try{
        const args=JSON.parse(p.arguments);
        if(Number.isSafeInteger(args.session_id)&&args.session_id>=0)event.processSessionId=args.session_id;
      }catch{/* Retain only a structured session identifier, never input text. */}
      if(['wait','functions.wait'].includes(event.tool))try {
        const args=JSON.parse(p.arguments);
        if(id(args.cell_id)&&args.terminate!==true)event.waitCellId=args.cell_id;
      }catch{/* Never parse code or guess a continuation from free text. */}
    }
    if(kind==='tool-result') {
      const blocks=typeof p.output==='string'?[p.output]:Array.isArray(p.output)?p.output.filter(b=>b?.type==='input_text'&&typeof b.text==='string').map(b=>b.text):[];
      const header=blocks[0]??'';
      if(blocks.length===1)try{
        const native=JSON.parse(header);
        if(id(native?.chunk_id)&&typeof native.wall_time_seconds==='number'&&Number.isFinite(native.wall_time_seconds)&&native.wall_time_seconds>=0){
          const sessionId=Number.isSafeInteger(native.session_id)&&native.session_id>=0?native.session_id:null;
          const exitCode=Number.isSafeInteger(native.exit_code)?native.exit_code:null;
          if(sessionId!==null||exitCode!==null)event.nativeProcess={sessionId,exitCode};
        }
      }catch{/* Script bodies and nested results are not native call envelopes. */}
      const yielded=/^Script running with cell ID ([a-zA-Z0-9_-]+)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n/.exec(header);
      if(yielded)event.cellId=yielded[1];
      event.scriptCompleted=/^Script completed\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n/.test(header);
      event.reportedDurations=[];
      for(let block=0;block<blocks.length;block++)try {
        const native=JSON.parse(blocks[block]);
        if(id(native?.chunk_id)&&typeof native.wall_time_seconds==='number'&&Number.isFinite(native.wall_time_seconds)&&native.wall_time_seconds>=0&&Number.isSafeInteger(Math.round(native.wall_time_seconds*1000))) {
          event.reportedDurations.push({block,durationMs:Math.round(native.wall_time_seconds*1000),timeBasis:'reported-wall-time',startAt:null,endAt:null,processStillRunning:Number.isSafeInteger(native.session_id)&&native.exit_code==null});
        }
      }catch{/* Only structured native result metadata is retained. */}
      // Only recognize the host envelope, never export arbitrary output text.
      event.yielded=!!yielded;
      if(typeof p.output==='string')try {
        const envelope=JSON.parse(p.output);
        if(envelope&&Number.isSafeInteger(envelope.session_id)&&envelope.exit_code==null)event.yielded=true;
      }catch{/* Not a native JSON envelope; never interpret arbitrary text as data. */}
    }
    events.push(event);
  }
  function finish({incompleteFinalLine=false}={}) {
    if(!identitySeen)throw new Error('Timeline source identity missing');
    return {source:{...source,lastCompleteLine:line,incompleteFinalLine},events,diagnostics:[...diagnostics,...(incompleteFinalLine?[{code:'incomplete-final-line',sourceRef:source.sourceRef}]:[])]};
  }
  return {push,finish};
}

export function buildTaskTimeline(options,inputs) {
  if(!id(options.teamId)||!id(options.taskId))throw new Error('Invalid team/task identity');
  const timeZone=options.timeZone??'Asia/Shanghai';
  new Intl.DateTimeFormat('en',{timeZone});
  const sources=new Map(),eventsById=new Map(),diagnostics=[];
  for(const input of inputs) {
    const key=input.source.sourceRef;
    if(sources.has(key)) {
      if(JSON.stringify(sources.get(key))!==JSON.stringify(input))throw new Error('Source import conflict');
      continue;
    }
    sources.set(key,input);diagnostics.push(...input.diagnostics);
    for(const e of input.events) {
      if(eventsById.has(e.eventId))throw new Error('Event identity conflict');
      eventsById.set(e.eventId,e);
    }
  }
  const events=[...eventsById.values()].sort((a,b)=>a.observedAt.localeCompare(b.observedAt)||a.eventId.localeCompare(b.eventId));
  const calls=new Map(),spans=[],gaps=[];
  for(const e of events)if(e.callId) {
    const key=JSON.stringify([e.sourceRef,e.hostId,e.threadId,e.callId]);
    if(!calls.has(key))calls.set(key,{starts:[],ends:[]});
    calls.get(key)[e.kind==='tool-call'?'starts':'ends'].push(e);
  }
  for(const {starts,ends} of calls.values()) {
    const first=starts[0]??ends[0];
    if(starts.length>1||ends.length>1){diagnostics.push({code:'ambiguous-call-id',eventId:first.eventId});continue;}
    if(!starts.length){diagnostics.push({code:'orphan-result',eventId:first.eventId});continue;}
    const start=starts[0],end=ends[0]??null,durationMs=delta(start.observedAt,end?.observedAt);
    spans.push({kind:end?.yielded?'tool-first-return':'outer-tool-call',startEventId:start.eventId,endEventId:end?.eventId??null,durationMs,timeBasis:'observedAt',completionKnown:!!end&&!end.yielded&&durationMs!==null,reportedDurationMs:null,missingReason:!end?'missing-result':durationMs===null?'clock-regression':end.yielded?'async-completion-unlinked':null});
  }
  for(const input of sources.values()) {
    // Physical source order preserves regressions instead of hiding them by sort.
    for(let i=1;i<input.events.length;i++) {
      const a=input.events[i-1],b=input.events[i];
      gaps.push({kind:'unattributed-log-gap',startEventId:a.eventId,endEventId:b.eventId,durationMs:delta(a.observedAt,b.observedAt),overlapsTools:true});
    }
  }
  const intervals=spans.filter(s=>s.durationMs!==null).map(s=>[Date.parse(eventsById.get(s.startEventId).observedAt),Date.parse(eventsById.get(s.endEventId).observedAt)]).sort((a,b)=>a[0]-b[0]);
  let observedToolUnionMs=intervals.length?0:null,end=-Infinity;
  for(const [a,b]of intervals){observedToolUnionMs+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
  const milestone=ref=>ref?events.find(e=>e.sourceRef===ref.sourceRef&&e.line===ref.line):null;
  const request=milestone(options.milestones?.request),delivery=milestone(options.milestones?.delivery);
  const asyncSpans=[];
  for(const span of spans) {
    const first=eventsById.get(span.endEventId),start=eventsById.get(span.startEventId);
    if(!first?.cellId||span.durationMs===null)continue;
    const same=e=>e.sourceRef===first.sourceRef&&e.hostId===first.hostId&&e.threadId===first.threadId;
    const roots=spans.filter(s=>{const e=eventsById.get(s.endEventId),c=eventsById.get(s.startEventId);return e&&same(e)&&e.cellId===first.cellId&&!c.waitCellId;});
    if(start.waitCellId)continue;
    const matches=spans.filter(s=>{const c=eventsById.get(s.startEventId),e=eventsById.get(s.endEventId);return same(c)&&c.waitCellId===first.cellId&&c.line>first.line&&c.observedAt>=first.observedAt&&e?.scriptCompleted&&e.line>c.line&&s.durationMs!==null;});
    const endEvent=roots.length===1&&matches.length===1?eventsById.get(matches[0].endEventId):null;
    if(roots.length!==1||matches.length>1)diagnostics.push({code:'ambiguous-cell-continuation',eventId:start.eventId});
    asyncSpans.push({kind:'async-script-observed',cellId:first.cellId,startEventId:start.eventId,endEventId:endEvent?.eventId??null,durationMs:delta(start.observedAt,endEvent?.observedAt),completionKnown:!!endEvent,timeBasis:'observedAt',scope:'script-not-child-process',missingReason:endEvent?null:'continuation-unresolved'});
  }
  const reportedDurations=events.flatMap(e=>(e.reportedDurations??[]).map(d=>({...d,eventId:e.eventId})));
  const processSpans=[];
  const nativeCalls=spans.map(s=>({span:s,start:eventsById.get(s.startEventId),end:eventsById.get(s.endEventId)}));
  const roots=nativeCalls.filter(c=>['exec_command','functions.exec_command','tools.exec_command'].includes(c.start.tool)&&c.end?.nativeProcess);
  for(const root of roots){
    const {start,end:first}=root,meta=first.nativeProcess;
    const same=c=>c.start.sourceRef===start.sourceRef&&c.start.hostId===start.hostId&&c.start.threadId===start.threadId;
    let end=null,reason='missing-process-completion';
    if(root.span.durationMs===null||first.line<=start.line)reason='clock-or-order-regression';
    else if(meta.exitCode!==null)end=first;
    else{
      const duplicates=roots.filter(c=>same(c)&&c.end.nativeProcess.sessionId===meta.sessionId);
      const completions=nativeCalls.filter(c=>same(c)&&c.start.processSessionId===meta.sessionId&&c.start.line>first.line&&c.start.observedAt>=first.observedAt&&c.end?.nativeProcess?.exitCode!=null&&c.end.line>c.start.line&&c.span.durationMs!==null&&(c.end.nativeProcess.sessionId===null||c.end.nativeProcess.sessionId===meta.sessionId));
      if(duplicates.length!==1||completions.length>1)reason='ambiguous-process-continuation';
      else if(completions.length===1)end=completions[0].end;
    }
    processSpans.push({kind:'native-process-observed',sessionId:meta.sessionId,startEventId:start.eventId,endEventId:end?.eventId??null,durationMs:delta(start.observedAt,end?.observedAt),exitCode:end?.nativeProcess.exitCode??null,completionKnown:!!end,timeBasis:'observedAt',scope:'process-observation-not-cpu-time',missingReason:end?null:reason});
  }
  return {schemaVersion:1,rulesVersion:'task-timeline-v2',processRulesVersion:'native-process-v1',teamId:options.teamId,taskId:options.taskId,timeZone,experimentId:null,sources:[...sources.values()].map(i=>i.source),events,spans,asyncSpans,processSpans,reportedDurations,gaps,endToEndMs:delta(request?.observedAt,delivery?.observedAt),milestones:{requestEventId:request?.eventId??null,deliveryEventId:delivery?.eventId??null},observedToolUnionMs,coverage:{status:'partial',association:'analyst-scoped',missing:['inner-tool-execution-boundaries','nested-process-continuations','business-state-events',...(processSpans.some(s=>!s.completionKnown)?['unresolved-process-continuations']:[]),...(asyncSpans.some(s=>!s.completionKnown)?['unresolved-script-continuations']:[]),...(!request?['request-milestone']:[]),...(!delivery?['delivery-milestone']:[])]},diagnostics};
}

export function renderTimelineMarkdown(report) {
  const fmt=value=>value===null?'未知':`${(value/1000).toFixed(3)} 秒`;
  const date=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:report.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
  const lines=['# 任务时间线', '', `任务：${report.teamId} / ${report.taskId}`, '',`时区：${report.timeZone}；覆盖：partial；任务关联：analyst-scoped。`, '',`端到端：${fmt(report.endToEndMs)}；已观测外层工具区间并集：${fmt(report.observedToolUnionMs)}。`, '', '并集不是实际计算时间；日志间隔可能与工具执行重叠，不可相加。首次返回不代表内部执行完成。', '', '| 时间 | 角色 | 事件 | 工具 | 证据 |', '| --- | --- | --- | --- | --- |'];
  for(const e of report.events)lines.push(`| ${date(e.observedAt)} | ${e.role} | ${e.kind} | ${e.tool??'—'} | ${e.eventId} |`);
  lines.push('', '| 调用起点 | 返回证据 | 口径 | 耗时 | 缺口 |','| --- | --- | --- | --- | --- |');
  for(const s of report.spans)lines.push(`| ${s.startEventId} | ${s.endEventId??'—'} | ${s.kind} | ${fmt(s.durationMs)} | ${s.missingReason??'—'} |`);
  lines.push('', '## 异步脚本续接（不等于子进程或业务完成）', '', '| 起点 | 完成证据 | 观测历时 |','| --- | --- | --- |');
  for(const s of report.asyncSpans??[])lines.push(`| ${s.startEventId} | ${s.endEventId??'未知'} | ${fmt(s.durationMs)} |`);
  lines.push('', '## 原生进程观测（含调用与轮询间隔，不是 CPU 时间）', '', '| 起点 | 完成证据 | 观测历时 | 退出码 | 缺口 |','| --- | --- | --- | --- | --- |');
  for(const s of report.processSpans??[])lines.push(`| ${s.startEventId} | ${s.endEventId??'未知'} | ${fmt(s.durationMs)} | ${s.exitCode??'未知'} | ${s.missingReason??'—'} |`);
  lines.push('', '## 工具返回中报告的耗时（不可相加为总工时）', '', '| 证据 | 数据块 | 报告耗时 | 进程仍在运行 |','| --- | --- | --- | --- |');
  for(const d of report.reportedDurations??[])lines.push(`| ${d.eventId} | ${d.block} | ${fmt(d.durationMs)} | ${d.processStillRunning?'是':'未知或已结束'} |`);
  lines.push('', '## 宿主内部调用报告（人工选定条目，起止未知，不与外层相加）', '', '| 来源 | 角色 | 条目 ID | 类型 | 报告耗时 | 退出码 |','| --- | --- | --- | --- | --- | --- |');
  for(const source of report.nativeObservations??[])for(const item of source.items)lines.push(`| ${source.sourceRef} | ${source.role} | ${item.itemId} | ${item.kind} | ${fmt(item.durationMs)} | ${item.exitCode??'未知'} |`);
  lines.push('', '## 未归因日志间隔', '', '| 起点 | 终点 | 间隔 |','| --- | --- | --- |');
  for(const g of report.gaps)lines.push(`| ${g.startEventId} | ${g.endEventId} | ${fmt(g.durationMs)} |`);
  if(report.businessTimeline) {
    const business=report.businessTimeline;
    lines.push('', '## 业务声明阶段（不是程序执行耗时）', '', `完整任务状态历史，独立于日志时间窗；快照版本 ${business.sourceVersion}，更新于 ${date(business.sourceUpdatedAt)}。`, '', '| 阶段 | 声明开始 | 声明结束 | 声明历时 |', '| --- | --- | --- | --- |');
    for(const s of business.stages)lines.push(`| ${s.status} | ${s.declaredStartAt?date(s.declaredStartAt):'未知'} | ${s.declaredEndAt?date(s.declaredEndAt):'—'} | ${s.kind==='terminal-state'?'终态点':fmt(s.durationMs)} |`);
    lines.push('', '| 声明时间 | 角色 | 业务事件 | 证据 ID |', '| --- | --- | --- | --- |');
    for(const e of business.events)lines.push(`| ${date(e.declaredAt)} | ${e.role} | ${e.kind} | ${e.eventId} |`);
  }
  lines.push('',`盲区：${report.coverage.missing.join(', ')}`, '', `诊断条数：${report.diagnostics.length}（详见 JSON）。`,'');
  return lines.join('\n');
}
