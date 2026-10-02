"""E04 fixed bridge; native dispatch remains a separate authorized host action."""
import json
import re
from .core import ContextError
from .notice import NoticeService, REASONS, MAX_BYTES

COMMON = {'actor_host_id','actor_thread_id','team_id','round_id','task_id','worker_id','reason'}
EXTRA = {'prepare':{'operation_id','enqueue_event_id','brief_ref','admission','baseline','retry_of_attempt_id'},
         'result':{'operation_id','attempt_id','result'},'cancel':{'operation_id','attempt_id','cancellation'},
         'status':{'operation_id','attempt_id','include_content'}}
REQUIRED = {'prepare':{'operation_id','enqueue_event_id','brief_ref'},'result':{'operation_id','attempt_id','result'},'cancel':{'operation_id','attempt_id'},'status':set()}

def validate_request(r):
    def check(ok, message):
        if not ok: raise ContextError('INVALID_REQUEST',message)
    check(isinstance(r,dict) and isinstance(r.get('action'),str) and r['action'] in EXTRA,'Unknown dispatch action')
    action=r['action']
    check(COMMON|REQUIRED[action]|{'action'} <= r.keys() <= COMMON|EXTRA[action]|{'action'},'Dispatch fields do not match action')
    check(all(isinstance(r[k],str) and 0<len(r[k])<=256 for k in COMMON),'Invalid scope')
    check(r['reason'] in REASONS,'Invalid reason')
    for k in {'operation_id','attempt_id','retry_of_attempt_id','brief_ref','enqueue_event_id'} & r.keys():
        check(isinstance(r[k],str) and 0<len(r[k])<=256,'Invalid identifier')
    if 'operation_id' in r: check(re.fullmatch(r'[A-Za-z0-9_-]{1,128}',r['operation_id']) is not None,'Invalid operation_id')
    if 'include_content' in r: check(type(r['include_content']) is bool,'Invalid include_content')
    check(not ('baseline' in r and 'retry_of_attempt_id' in r),'Retry cannot supply baseline')
    fields={'baseline':({'outcome','evidence_ref'},{'outcome','evidence_ref'}),
            'admission':({'native','scope_evidence_ref'},{'native'}),
            'result':({'outcome','evidence_ref','summary'},{'outcome','evidence_ref','summary'}),
            'cancellation':({'authorization_ref','reason','nonreceipt_evidence_ref','execution_evidence_ref'},{'authorization_ref','reason','nonreceipt_evidence_ref','execution_evidence_ref'})}
    for k,(allowed,required) in fields.items():
        if k in r: check(isinstance(r[k],dict) and required<=r[k].keys()<=allowed,'Invalid '+k)
    if 'admission' in r:
        n=r['admission']['native']
        check(isinstance(n,dict) and {'host_id','thread_id','status','evidence_ref'}<=n.keys()<={'host_id','thread_id','status','evidence_ref','observed_at'},'Invalid native evidence')
    try: payload=json.dumps(r,ensure_ascii=False,allow_nan=False).encode('utf-8',errors='strict')
    except (ValueError,TypeError,UnicodeError) as exc: raise ContextError('INVALID_REQUEST','Invalid JSON/Unicode') from exc
    if len(payload)>MAX_BYTES: raise ContextError('PAYLOAD_TOO_LARGE','Dispatch request exceeds 1 MiB')
    return payload

class DispatchService(NoticeService):
    validator=staticmethod(validate_request)
    adapter_name='dispatch-adapter.mjs'

    def allowed_roles(self, action): return {'Manager'}

    def handle(self, request):
        result=super().handle(request)
        if result.get('nextAction')=='notice_status': result['nextAction']='dispatch_status'
        return result
