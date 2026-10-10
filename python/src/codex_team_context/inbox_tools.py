"""Raw request JSON retains inner duplicate keys for the shared E05 boundary."""
from typing import Any
from pydantic import create_model, model_validator, ConfigDict
from mcp.types import ToolAnnotations
from .core import ContextError
from .inbox import InboxService, validate_request
from .observations import observed_call

def register_inbox_tools(server, registry, recorder, runtime_revision, json_result):
    service = InboxService(registry, runtime_revision)

    def execute(raw, status=False):
        try:
            request = validate_request(raw)
            if status and request['action'] != 'status' or not status and request['action'] == 'status':
                raise ContextError('INVALID_REQUEST', 'Use the action-appropriate inbox tool')
            value = observed_call(recorder,
                lambda: registry.observation_identity(request['actor_host_id'], request['actor_thread_id']),
                'team_context.inbox_status' if status else 'team_context.inbox', request['reason'],
                lambda: service.handle(request), lambda v: 'error' if v.get('status') == 'error' else 'success')
            return json_result(value, is_error=value.get('status') == 'error')
        except (ContextError, UnicodeError) as exc:
            return json_result({'status': 'error', 'reasonCode': getattr(exc, 'code', 'INVALID_REQUEST'), 'hostActionExecuted': False}, is_error=True)

    @server.tool(name='team_context.inbox', description='Persist a scoped report or perform an explicit foreground E05 checkpoint/claim/review/control. request_json is closed raw JSON, validated by the same Node core. Never sends, wakes, installs or approves. Default uninitialized/observe, queue_first requires explicit owner setup.',
                 annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False))
    def inbox(request_json: str):
        return execute(request_json)

    @server.tool(name='team_context.inbox_status', description='Read an exact E05 operation/item/work or bounded same-team status. request_json must have action=status. No claim, mutation, wake, native fallback or retry permission.',
                 annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
    def inbox_status(request_json: str):
        return execute(request_json, True)

    for name, is_status in [('team_context.inbox', False), ('team_context.inbox_status', True)]:
        tool = server._tool_manager.get_tool(name)
        def validate(cls, raw, fixed=is_status):
            if not isinstance(raw, dict) or set(raw) != {'request_json'} or not isinstance(raw['request_json'], str):
                raise ValueError('Exactly one raw request_json string is required')
            try:
                request = validate_request(raw['request_json'])
                if (request['action'] == 'status') != fixed:
                    raise ValueError('Wrong inbox tool for action')
            except (ContextError, UnicodeError) as exc:
                raise ValueError(str(exc)) from exc
            return raw
        model = create_model('InboxStatusInput' if is_status else 'InboxInput', __base__=tool.fn_metadata.arg_model,
                             __config__=ConfigDict(extra='forbid', strict=True),
                             __validators__={'inbox_contract': model_validator(mode='before')(classmethod(validate))})
        tool.fn_metadata.arg_model = model
        tool.parameters = model.model_json_schema(by_alias=True)
