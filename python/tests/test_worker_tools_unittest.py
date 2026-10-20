"""SDK + Python/Node bridge tests using only installed dependencies; synthetic teams."""
import ast
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from codex_team_context.team_registry import TeamRegistry, initialize_registry
from codex_team_context.worker_tools import WorkerService

ROOT = Path(__file__).resolve().parents[2]
NODE = Path(shutil.which('node'))

class WorkerBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='worker-mcp-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'state.json'
        self.registry_path = Path(self.temp.name)/'registry.json'
        # Reuse original synthetic fixture functions without importing pytest.
        tree = ast.parse((ROOT/'python/tests/test_registry_cutover.py').read_text(encoding='utf-8'))
        module = ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'legacy_bytes','adoption_request'}],type_ignores=[])
        namespace = dict(ROOT=ROOT,NODE=NODE,json=json,hashlib=hashlib,subprocess=subprocess,Path=Path)
        exec(compile(module,'synthetic-fixture','exec'),namespace)
        raw = namespace['legacy_bytes']()
        self.path.write_bytes(raw)
        initialize_registry(self.registry_path)
        self.registry = TeamRegistry(registry_path=self.registry_path,node_executable=NODE,runtime_root=ROOT)
        self.registry.manage('fixture-host','fixture-manager',namespace['adoption_request'](self.path,raw))
        for i,member in enumerate(['manager','worker']):
            capsule=self.registry.read('fixture-host','fixture-'+member)
            self.registry.manage('fixture-host','fixture-manager',{'action':'confirm_ready','operation_id':'ready-'+member,'team_id':'legacy-team','expected_revision':i+1,'member_id':member,'receipt':capsule['onboardingReceipt'],'evidence_ref':'synthetic'})
        script=f"""
import {{readState,transact}} from {json.dumps((ROOT/'src/store.mjs').as_uri())};
const path={json.dumps(str(self.path))},options={{python:{json.dumps(sys.executable)}}};
let s=await readState(path,options);
const at='2026-10-01T00:00:00.000Z',source={{kind:'fixture',ref:'synthetic-no-send'}};
for(const event of [{{id:'open',type:'openRound',roundId:'r',title:'Round'}},{{id:'assign',type:'assign',roundId:'r',taskId:'t',title:'Task',workerId:'worker',required:true,assignedAt:at,caller:{{hostId:'fixture-host',threadId:'fixture-manager'}}}}])
 s=await transact(path,s.version,{{actor:'manager',at,source,...event}},options);
"""
        subprocess.run([str(NODE),'--input-type=module','-e',script],check=True,capture_output=True)
        self.request=dict(action='submit',actor_host_id='fixture-host',actor_thread_id='fixture-worker',team_id='legacy-team',submission_id='structured-1',reason='manual',submission=dict(taskId='t',summary='Synthetic evidence',files=['a'],verification=[dict(command='test',outcome='not-run',evidenceRef='synthetic')],artifacts=[],gaps=['not deployed']))

    def test_bridge_and_read_only_summary(self):
        service=WorkerService(self.registry)
        result=service.handle(self.request)
        self.assertEqual(result['status'],'submitted',result)
        before=self.path.read_bytes()
        self.assertTrue(service.handle(self.request)['replayed'])
        changed={**self.request,'submission':{**self.request['submission'],'summary':'changed'}}
        self.assertEqual(service.handle(changed)['reasonCode'],'OPERATION_CONFLICT')
        summary=service.handle(dict(action='summary',actor_host_id='fixture-host',actor_thread_id='fixture-manager',team_id='legacy-team',reason='manual'))
        self.assertEqual(summary['tasks'][0]['status'],'submitted',summary)
        self.assertEqual(summary['tasks'][0]['agentWork']['status'],'unknown')
        self.assertEqual(self.path.read_bytes(),before)
        self.assertFalse(list(self.path.parent.glob('*.lock')))

    def test_stdio_discovery_schema_error_and_submit(self):
        async def scenario():
            observations=self.path.parent/'observations'
            params=StdioServerParameters(command=sys.executable,args=['-m','codex_team_context.server','serve','--registry',str(self.registry_path),'--node-executable',str(NODE),'--runtime-root',str(ROOT),'--observation-root',str(observations),'--observe-team','legacy-team'],env=dict(os.environ))
            async with Client(params) as client:
                by_name={t.name:t for t in (await client.list_tools()).tools}
                self.assertEqual(len(by_name),12)
                self.assertTrue({'team_context.inbox','team_context.inbox_status'} <= by_name.keys())
                self.assertTrue(by_name['team_context.progress_summary'].annotations.read_only_hint)
                self.assertFalse(by_name['team_context.submit'].input_schema['additionalProperties'])
                attributed=await client.call_tool('team_context.read',dict(host_id='fixture-host',thread_id='fixture-worker',reason='resume',work_context=dict(scope='task',team_id='legacy-team',round_id='r',task_id='t',step_id='implementation')))
                self.assertFalse(attributed.is_error,attributed)
                args={k:v for k,v in self.request.items() if k!='action'}
                before=self.path.read_bytes()
                invalid_reason=await client.call_tool('team_context.submit',{**args,'reason':'before_submit'})
                self.assertEqual(json.loads(invalid_reason.content[0].text)['field'],'reason')
                self.assertEqual(self.path.read_bytes(),before)
                invalid={**args,'submission':{**args['submission'],'verification':[dict(command='test',outcome='made-up',evidenceRef='ref')]}}
                failed=json.loads((await client.call_tool('team_context.submit',invalid)).content[0].text)
                self.assertIn('field',failed,failed)
                self.assertEqual(failed['field'],'verification[0].outcome',failed)
                self.assertEqual(self.path.read_bytes(),before)
                good=await client.call_tool('team_context.submit',args)
                self.assertFalse(good.is_error,good)
                self.assertEqual(json.loads(good.content[0].text)['status'],'submitted')
                blocked=await client.call_tool('team_context.report_blocker',dict(actor_host_id='fixture-host',actor_thread_id='fixture-worker',team_id='legacy-team',operation_id='blocker-1',task_id='t',blocker=dict(reason='synthetic failure',who='operator',needs='fixture access',evidenceRef='synthetic-ref')))
                self.assertFalse(blocked.is_error,blocked)
                before=self.path.read_bytes()
                summary=await client.call_tool('team_context.progress_summary',dict(actor_host_id='fixture-host',actor_thread_id='fixture-manager',team_id='legacy-team',task_id='t'))
                decoded=json.loads(summary.content[0].text)
                self.assertEqual(decoded['scope'],'exact-task',decoded)
                self.assertEqual(decoded['tasks'][0]['blocker']['reason'],'synthetic failure')
                self.assertEqual(self.path.read_bytes(),before)
            events=[json.loads(p.read_text(encoding='utf-8')) for p in observations.glob('*/*.json')]
            self.assertEqual({e['worker']['action'] for e in events if 'worker' in e},{'submit','blocker','summary'})
            context_event=next(e for e in events if 'workContext' in e)
            self.assertEqual(context_event['schemaVersion'],2)
            self.assertEqual(context_event['workContext']['taskId'],'t')
            self.assertNotIn('Synthetic evidence',json.dumps(events))
        asyncio.run(scenario())

if __name__=='__main__':unittest.main()
