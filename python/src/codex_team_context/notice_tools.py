"""The two E03 tools and their closed, action-sensitive input contract."""
from typing import Any, Literal
import json
from pydantic import create_model, model_validator, ConfigDict
from mcp.types import ToolAnnotations
from .core import ContextError
from .notice import NoticeService, validate_request
from .observations import observed_call

def register_notice_tools(server, registry, recorder, runtime_revision, json_result):
    service = NoticeService(registry, runtime_revision)

    def execute(request):
        def details(result):
            value={'action':request['action'],'taskId':request['task_id'],'submissionId':request['submission_id'],
                   'requestBytes':len(json.dumps(request,ensure_ascii=False).encode('utf-8'))}
            for inp,out in [('operation_id','operationId'),('prepare_operation_id','operationId'),('attempt_id','attemptId')]:
                if inp in request:value[out]=request[inp]
            if result:
                for key in ['attemptId','reasonCode','sourceVersion','ledgerVersion']:
                    if key in result:value[key]=result[key]
                value['responseBytes']=len(json.dumps(result,ensure_ascii=False).encode('utf-8'))
            return value
        try:
            value = observed_call(recorder,
                lambda: registry.observation_identity(request['actor_host_id'],request['actor_thread_id']),
                'team_context.notice_status' if request['action'] == 'status' else 'team_context.notice',
                request['reason'], lambda: service.handle(request), lambda v: 'error' if v.get('status') == 'error' else 'success',details=details)
            return json_result(value,is_error=value.get('status') == 'error')
        except ContextError as exc:
            return json_result({'status':'error','reasonCode':exc.code,'message':exc.message,'hostActionExecuted':False},is_error=True)

    @server.tool(name='team_context.notice', description='Prepare one durable submission notification or record its exact native result. Never sends. Keep operation IDs for recovery; unknown delivery cannot be retried.',
                 annotations=ToolAnnotations(readOnlyHint=False,destructiveHint=False,idempotentHint=False,openWorldHint=False))
    def notice(action: Literal['prepare','result'], actor_host_id: str, actor_thread_id: str,
               team_id: str, task_id: str, submission_id: str, reason: str, operation_id: str,
               baseline: dict[str,Any] = None, attempt_id: str = None, result: dict[str,Any] = None):
        request = {k:v for k,v in locals().items() if v is not None and k != 'execute'}
        return execute(request)

    @server.tool(name='team_context.notice_status', description='Read a specified submission/attempt or recover an attempt by prepare operation ID. No claim, cleanup or replayable host request. Latest attempt is only a correlation hint.',
                 annotations=ToolAnnotations(readOnlyHint=True,destructiveHint=False,idempotentHint=True,openWorldHint=False))
    def notice_status(actor_host_id: str, actor_thread_id: str, team_id: str, task_id: str,
                      submission_id: str, reason: str, prepare_operation_id: str = None,
                      attempt_id: str = None, include_content: bool = False):
        request = {k:v for k,v in locals().items() if v is not None and k != 'execute'}
        return execute({'action':'status',**request})

    # MCP 2.x generates an argument model. Enforce the same closed schema BEFORE
    # its normal coercion/default handling; null is not an omitted baseline.
    # Discovery/stdio tests cover this small, isolated SDK integration point.
    for name, action in [('team_context.notice',None),('team_context.notice_status','status')]:
        tool = server._tool_manager.get_tool(name)
        def validate(cls, raw, fixed=action):
            request = dict(raw)
            if fixed:
                if 'action' in request:
                    raise ValueError('status tool does not accept action')
                request['action'] = fixed
            try:
                validate_request(request)
            except ContextError as exc:
                raise ValueError(f'{exc.code}: {exc.message}') from exc
            return raw
        model = create_model('NoticeStatusInput' if action else 'NoticeInput',
                             __base__=tool.fn_metadata.arg_model,
                             __config__=ConfigDict(extra='forbid',strict=True),
                             __validators__={'notice_contract':model_validator(mode='before')(classmethod(validate))})
        tool.fn_metadata.arg_model = model
        tool.parameters = model.model_json_schema(by_alias=True)
        for spec in tool.parameters.get('properties',{}).values():
            if spec.get('default',True) is None:
                del spec['default']
