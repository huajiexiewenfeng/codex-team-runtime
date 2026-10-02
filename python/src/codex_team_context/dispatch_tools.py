"""Closed E04 MCP input models and bounded metadata-only observations."""
import json
from typing import Any, Literal
from pydantic import create_model, model_validator, ConfigDict
from mcp.types import ToolAnnotations
from .core import ContextError
from .dispatch import DispatchService, validate_request
from .observations import observed_call

def register_dispatch_tools(server,registry,recorder,runtime_revision,json_result):
    service=DispatchService(registry,runtime_revision)
    def execute(request):
        def details(result):
            d={'action':request['action'],'taskId':request['task_id'],'requestBytes':len(json.dumps(request,ensure_ascii=False).encode('utf-8'))}
            for i,o in [('operation_id','operationId'),('attempt_id','attemptId')]:
                if i in request:d[o]=request[i]
            if result:
                for k in ['attemptId','reasonCode','sourceVersion']:
                    if k in result:d[k]=result[k]
                d['responseBytes']=len(json.dumps(result,ensure_ascii=False).encode('utf-8'))
            return d
        try:
            value=observed_call(recorder,lambda:registry.observation_identity(request['actor_host_id'],request['actor_thread_id']),
                'team_context.dispatch_status' if request['action']=='status' else 'team_context.dispatch',request['reason'],
                lambda:service.handle(request),lambda v:'error' if v.get('status')=='error' else 'success',details=details)
            return json_result(value,is_error=value.get('status')=='error')
        except ContextError as exc:return json_result({'status':'error','reasonCode':exc.code,'message':exc.message,'hostActionExecuted':False},is_error=True)

    @server.tool(name='team_context.dispatch',description='Prepare one queued task, record an exact native result, or explicitly withdraw proven undelivered work. Never sends. Fresh prepare permits one authorized host call; replay and unknown results never permit resend.',
                 annotations=ToolAnnotations(readOnlyHint=False,destructiveHint=False,idempotentHint=False,openWorldHint=False))
    def dispatch(action:Literal['prepare','result','cancel'],actor_host_id:str,actor_thread_id:str,team_id:str,round_id:str,task_id:str,worker_id:str,reason:str,operation_id:str,
                 enqueue_event_id:str=None,brief_ref:str=None,admission:dict[str,Any]=None,baseline:dict[str,Any]=None,retry_of_attempt_id:str=None,attempt_id:str=None,result:dict[str,Any]=None,cancellation:dict[str,Any]=None):
        return execute({k:v for k,v in locals().items() if v is not None and k!='execute'})

    @server.tool(name='team_context.dispatch_status',description='Read exact dispatch operation/attempt and frozen material. No mutations, lock cleanup or host request. Latest attempt is only an unverified correlation hint.',
                 annotations=ToolAnnotations(readOnlyHint=True,destructiveHint=False,idempotentHint=True,openWorldHint=False))
    def dispatch_status(actor_host_id:str,actor_thread_id:str,team_id:str,round_id:str,task_id:str,worker_id:str,reason:str,operation_id:str=None,attempt_id:str=None,include_content:bool=False):
        return execute({'action':'status',**{k:v for k,v in locals().items() if v is not None and k!='execute'}})

    for name,fixed in [('team_context.dispatch',None),('team_context.dispatch_status','status')]:
        tool=server._tool_manager.get_tool(name)
        def validate(cls,raw,action=fixed):
            request=dict(raw)
            if action:
                if 'action' in request:raise ValueError('status does not accept action')
                request['action']=action
            try:validate_request(request)
            except ContextError as exc:raise ValueError(f'{exc.code}: {exc.message}') from exc
            return raw
        model=create_model('DispatchStatusInput' if fixed else 'DispatchInput',__base__=tool.fn_metadata.arg_model,
            __config__=ConfigDict(extra='forbid',strict=True),__validators__={'dispatch_contract':model_validator(mode='before')(classmethod(validate))})
        tool.fn_metadata.arg_model=model;tool.parameters=model.model_json_schema(by_alias=True)
        for spec in tool.parameters.get('properties',{}).values():
            if spec.get('default',True) is None:del spec['default']
