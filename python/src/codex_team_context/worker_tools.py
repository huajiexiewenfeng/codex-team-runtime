"""Structured evidence tools. No native host messaging capability."""
import json
from typing import Any
from mcp.types import ToolAnnotations
from pydantic import create_model, ConfigDict
from .notice import NoticeService, MAX_BYTES
from .core import ContextError
from .observations import observed_call, REASONS

def validate_worker_request(r):
    extra = {'submit': {'submission_id', 'submission'}, 'blocker': {'operation_id', 'task_id', 'blocker'}, 'summary': {'task_id'}}.get(r.get('action'))
    common = {'action', 'actor_host_id', 'actor_thread_id', 'team_id', 'reason'}
    if extra is None or not common <= set(r) or not set(r) <= common | extra or (r['action'] != 'summary' and set(r) != common | extra):
        raise ContextError('INVALID_REQUEST', 'Worker fields do not match action schema')
    for key in common - {'action'}:
        if not isinstance(r[key], str) or not r[key].strip():
            raise ContextError('INVALID_REQUEST', f'Invalid {key}')
    raw = json.dumps(r, ensure_ascii=False, allow_nan=False).encode('utf-8')
    if len(raw) > MAX_BYTES:
        raise ContextError('PAYLOAD_TOO_LARGE', 'Worker request exceeds 1 MiB')
    return raw

class WorkerService(NoticeService):
    validator = staticmethod(validate_worker_request)
    adapter_name = 'worker-adapter.mjs'
    def allowed_roles(self, action):
        return {'Manager', 'Liaison', 'Worker'} if action == 'summary' else {'Worker'}

def register_worker_tools(server, registry, recorder, runtime_revision, json_result):
    service = WorkerService(registry, runtime_revision)
    def execute(r):
        if r.get('reason') not in REASONS:
            return json_result({'status':'error','reasonCode':'FIELD_INVALID','field':'reason','message':'reason: expected supported notice reason','example':'manual','hostActionExecuted':False},is_error=True)
        try:
            result = observed_call(recorder, lambda: registry.observation_identity(r['actor_host_id'], r['actor_thread_id']),
                                   {'submit':'team_context.submit','blocker':'team_context.report_blocker','summary':'team_context.progress_summary'}[r['action']],
                                   r['reason'], lambda: service.handle(r), lambda v: 'error' if v.get('status') == 'error' else 'success',
                                   details=lambda v: {k:value for k,value in {'action':r['action'], 'taskId':r.get('task_id',r.get('submission',{}).get('taskId')), 'submissionId':r.get('submission_id'),
                                                     'requestBytes':len(json.dumps(r,ensure_ascii=False).encode('utf-8')), 'responseBytes':len(json.dumps(v,ensure_ascii=False).encode('utf-8')) if v else 0}.items() if value is not None})
            return json_result(result, is_error=result.get('status') == 'error')
        except ContextError as exc:
            return json_result(exc.as_dict(), is_error=True)

    @server.tool(name='team_context.submit', description='Persist assigned Worker structured evidence and enter submitted. Idempotent submission_id; different content conflicts. Review is required before approval. Never sends.', annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def submit(actor_host_id: str, actor_thread_id: str, team_id: str, submission_id: str, submission: dict[str, Any], reason: str = 'manual'):
        return execute({'action':'submit', **{k:v for k,v in locals().items() if k != 'execute'}})

    @server.tool(name='team_context.report_blocker', description='Assigned Worker reports who/needs/evidenceRef. Does not change Manager task state and does not send or wake anyone.', annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def report_blocker(actor_host_id: str, actor_thread_id: str, team_id: str, operation_id: str, task_id: str, blocker: dict[str, Any], reason: str = 'manual'):
        return execute({'action':'blocker', **{k:v for k,v in locals().items() if k != 'execute'}})

    @server.tool(name='team_context.progress_summary', description='Read concise ledger status, activity evidence, submission, review and blockers. Agent real-time work is unknown. Read before asking Workers; no polling.', annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def progress_summary(actor_host_id: str, actor_thread_id: str, team_id: str, reason: str = 'manual', task_id: str = None):
        return execute({'action':'summary', **{k:v for k,v in locals().items() if v is not None and k != 'execute'}})

    for name in ['team_context.submit', 'team_context.report_blocker', 'team_context.progress_summary']:
        tool = server._tool_manager.get_tool(name)
        model = create_model(name.replace('.', '_') + 'Input', __base__=tool.fn_metadata.arg_model,
                             __config__=ConfigDict(extra='forbid', strict=True))
        tool.fn_metadata.arg_model = model
        tool.parameters = model.model_json_schema(by_alias=True)
