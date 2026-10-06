"""Optional declared correlation, validated read-only; never dispatch authority."""
import re
from datetime import datetime
from typing import Literal,Annotated
from pydantic import BaseModel,ConfigDict,Field
from .core import ContextError
from .notice import NoticeService
Identifier=Annotated[str,Field(pattern=r'^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$')]
class TeamWorkContext(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    scope:Literal['team']
    team_id:Identifier
class TaskWorkContext(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    scope:Literal['task']
    team_id:Identifier
    round_id:Identifier
    task_id:Identifier
    step_id:Identifier

def validate_context(context):
    if not isinstance(context,dict):raise ContextError('INVALID_WORK_CONTEXT','Context must be an object')
    keys={'scope','team_id'} if context.get('scope')=='team' else {'scope','team_id','round_id','task_id','step_id'} if context.get('scope')=='task' else set()
    if not keys or set(context)!=keys:raise ContextError('INVALID_WORK_CONTEXT','Context fields do not match scope')
    for key in keys-{'scope'}:
        if not isinstance(context[key],str) or re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}',context[key]) is None:raise ContextError('INVALID_WORK_CONTEXT','Invalid context identifier')
    return context

class WorkContextService(NoticeService):
    adapter_name='observation-context-adapter.mjs'
    def allowed_roles(self,action):return {'Manager','Liaison','Worker'}
    @staticmethod
    def validator(request):
        if set(request)!={'action','actor_host_id','actor_thread_id','team_id','work_context'} or request['action']!='status':raise ContextError('INVALID_WORK_CONTEXT','Invalid context request')
        validate_context(request['work_context'])
    def validate(self,host_id,thread_id,context):
        validate_context(context)
        result=self.handle({'action':'status','actor_host_id':host_id,'actor_thread_id':thread_id,'team_id':context['team_id'],'work_context':context})
        if result.get('status')!='validated':raise ContextError(result.get('reasonCode','INVALID_WORK_CONTEXT'),'Work context could not be validated')
        return result['workContext']

def validate_produced_context(context,identity):
    keys={'scope','teamId','associationSource','validation'} | ({'roundId','taskId','stepId'} if context.get('scope')=='task' else set())
    if set(context)!=keys or context.get('associationSource')!='caller-declared' or context.get('teamId')!=identity['teamId']:raise ValueError('Invalid produced context')
    validate_context({'scope':context['scope'],'team_id':context['teamId'],**({k:context[v] for k,v in [('round_id','roundId'),('task_id','taskId'),('step_id','stepId')]} if context['scope']=='task' else {})})
    proof=context['validation']
    if not isinstance(proof,dict) or set(proof)!={'basis','sourceVersion','stateAsOf','validatedAt','memberId','role','hostId','threadId'} or proof['basis']!='recorded-state-scope' or type(proof['sourceVersion']) is not int or proof['sourceVersion']<0:raise ValueError('Invalid context validation')
    if any(proof[k]!=identity[k] for k in ['memberId','role','hostId','threadId']):raise ValueError('Context identity changed')
    for key in ['stateAsOf','validatedAt']:
        if not isinstance(proof[key],str) or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',proof[key]) is None:raise ValueError('Invalid context time')
        datetime.fromisoformat(proof[key].replace('Z','+00:00'))
    return context

def configure_read_context_schema(server):
    from pydantic import ConfigDict,create_model,model_validator
    tool=server._tool_manager.get_tool('team_context.read')
    def validate(cls,raw):
        if raw.get('work_context') is not None:validate_context(raw['work_context'])
        return raw
    model=create_model('ReadContextInput',__base__=tool.fn_metadata.arg_model,__config__=ConfigDict(extra='forbid',strict=True),__validators__={'context_contract':model_validator(mode='before')(classmethod(validate))})
    tool.fn_metadata.arg_model=model;tool.parameters=model.model_json_schema(by_alias=True)
