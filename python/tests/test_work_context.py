import asyncio,json,os,subprocess,sys
from pathlib import Path
import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from codex_team_context.server import create_server
from test_notice import notice_team,NODE,ROOT

def test_actual_producer_bridge_dual_events_collector_and_query_without_state_mutation(notice_team):
    registry,path,state,request=notice_team;before=(path.read_bytes(),state.read_bytes());observations=path.parent/'context-events'
    server=create_server(registry_path=path,node_executable=NODE,runtime_root=ROOT,observation_root=observations,observed_teams=['legacy-team'])
    read=server._tool_manager.get_tool('team_context.read').fn
    context={'scope':'task','team_id':'legacy-team','round_id':'r','task_id':'t','step_id':'implementation'}
    first=read('fixture-host','fixture-worker','resume');assert not first.is_error
    attributed=read('fixture-host','fixture-worker','resume',context);assert not attributed.is_error,attributed
    assert json.loads(first.content[0].text)==json.loads(attributed.content[0].text)
    for patch in [{'team_id':'other'},{'round_id':'wrong'},{'task_id':'unknown'},{'step_id':'bad/id'},{'extra':'not-allowed'}]:
        invalid=read('fixture-host','fixture-worker','resume',{**context,**patch});assert invalid.is_error
    read('fixture-host','fixture-manager','resume');read('fixture-host','fixture-worker','resume',{'scope':'team','team_id':'legacy-team'})
    assert json.loads(read('unknown','unknown').content[0].text) is None
    assert not read('fixture-host','fixture-worker','resume').is_error
    events=[json.loads(p.read_text()) for p in observations.glob('*/*.json')];task_events=[e for e in events if e.get('workContext',{}).get('scope')=='task'];assert len(task_events)==1
    assert task_events[0]['schemaVersion']==2 and task_events[0]['workContext']['associationSource']=='caller-declared'
    assert sum(e['schemaVersion']==1 for e in events)>0
    manifest=path.parent/'context-manifest.json';cache=path.parent/'context-cache';epoch={'memberId':'worker','bindingRevision':1,'hostId':'fixture-host','threadId':'fixture-worker','role':'Worker','roleEpoch':'worker','from':'2026-10-01T00:00:00.000Z','to':'2027-01-01T00:00:00.000Z','evidenceRef':'fixture:explicit-epoch'}
    sources=[]
    for i,p in enumerate(observations.glob('*/*.json')):
        event=json.loads(p.read_text());binding={**epoch,'memberId':event['memberId'],'threadId':event['threadId'],'role':event['role'],'roleEpoch':event['role'].lower()}
        sources.append({'sourceId':f'event-{i}','kind':'team-context-event','path':str(p),'adapterVersion':'v1','mutationPolicy':'immutable','authorizedFrom':epoch['from'],'authorizedTo':epoch['to'],'coverageAssertions':{'status':'partial','evidenceRef':'fixture:coverage'},'evidenceRef':'fixture:producer','bindings':[binding],'selection':{'taskId':None,'roundId':None,'turnIds':[],'itemIds':[]}})
    manifest.write_text(json.dumps({'schemaVersion':'dashboard-sources/v1','teamId':'legacy-team','registryId':task_events[0]['registryId'],'revision':1,'authorizationRef':'fixture:approved','sources':sources}))
    script=f"""import {{refreshStats}} from {json.dumps((ROOT/'src/stats-collector.mjs').as_uri())};import {{queryStats}} from {json.dumps((ROOT/'src/stats-query.mjs').as_uri())};await refreshStats({json.dumps(str(manifest))},{json.dumps(str(cache))});const all=await queryStats({json.dumps(str(cache))},{{view:'mcp'}}),task=await queryStats({json.dumps(str(cache))},{{view:'steps',taskId:'t',roundId:'r',stepId:'implementation',memberId:'worker'}});console.log(JSON.stringify({{all,task}}));"""
    result=json.loads(subprocess.check_output([str(NODE),'--input-type=module','-e',script],text=True));row=result['task']['data']['rows'][0];assert result['task']['data']['total']==1
    assert row['taskId']=='t' and row['roundId']=='r' and row['stepId']=='implementation' and row['memberId']=='worker'
    assert row['assurance']=='machine-source-reported' and row['associationSource']=='caller-declared'
    total=result['all']['data']['summary']['mcp'][1];assert total['calls']==len(events);assert sum(total['attribution'].values())==len(events)
    assert (path.read_bytes(),state.read_bytes())==before

def test_fresh_mcp_discovery_closed_context_and_old_calls(notice_team):
    registry,path,state,request=notice_team
    async def scenario():
        params=StdioServerParameters(command=sys.executable,args=['-m','codex_team_context.server','serve','--registry',str(path),'--node-executable',str(NODE),'--runtime-root',str(ROOT)],env=os.environ.copy())
        async with Client(params) as client:
            tool=next(t for t in (await client.list_tools()).tools if t.name=='team_context.read');assert 'work_context' in tool.input_schema['properties'];assert tool.input_schema['additionalProperties'] is False
            assert tool.input_schema['$defs']['TaskWorkContext']['additionalProperties'] is False;assert set(tool.input_schema['$defs']['TaskWorkContext']['required'])=={'scope','team_id','round_id','task_id','step_id'}
            old=await client.call_tool('team_context.read',{'host_id':'fixture-host','thread_id':'fixture-worker'});assert not old.is_error
            bad=await client.call_tool('team_context.read',{'host_id':'fixture-host','thread_id':'fixture-worker','work_context':{'scope':'task','team_id':'legacy-team','task_id':'t'}});assert bad.is_error
            again=await client.call_tool('team_context.read',{'host_id':'fixture-host','thread_id':'fixture-worker'});assert not again.is_error
            good=await client.call_tool('team_context.read',{'host_id':'fixture-host','thread_id':'fixture-worker','work_context':{'scope':'task','team_id':'legacy-team','round_id':'r','task_id':'t','step_id':'step'}});assert not good.is_error;assert json.loads(good.content[0].text)==json.loads(old.content[0].text)
    asyncio.run(scenario())

def test_node_rechecks_current_registry_projection_after_python_admission(notice_team,monkeypatch):
    import codex_team_context.notice as notice_module
    registry,path,state,request=notice_team;before=state.read_bytes();original=notice_module.invoke_notice_process
    def invoke(*args,**kwargs):
        current=json.loads(path.read_text());revision=current['teams'][0]['revision']
        registry.manage('fixture-host','fixture-manager',{'action':'exit_member','operation_id':'context-exit-race','team_id':'legacy-team','expected_revision':revision,'member_id':'worker','authorization_ref':'fixture:verified-race'})
        return original(*args,**kwargs)
    monkeypatch.setattr(notice_module,'invoke_notice_process',invoke)
    server=create_server(registry_path=path,node_executable=NODE,runtime_root=ROOT,observation_root=path.parent/'race-events',observed_teams=['legacy-team'])
    result=server._tool_manager.get_tool('team_context.read').fn('fixture-host','fixture-worker','resume',{'scope':'task','team_id':'legacy-team','round_id':'r','task_id':'t','step_id':'step'})
    assert result.is_error;assert state.read_bytes()==before
    assert all('workContext' not in json.loads(p.read_text()) for p in (path.parent/'race-events').glob('*/*.json'))
