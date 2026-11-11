"""All identifiers, payloads and transports are synthetic; no real QQ or codes."""
import unittest,tempfile,json,io,hashlib,importlib,sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from urllib.error import HTTPError
from unittest.mock import patch
import test_runtime as f
import test_management as m
import test_groups as g
import test_lifecycle as lifecycle
from plugins.astrbot_plugin_artzoo import sender,core,production_policy as policy
from plugins.astrbot_plugin_artzoo.bridge import BridgeClient,BridgeHttpFailure

class PreSdkPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'journal.sqlite3';self.journal=sender.Journal(self.path)
        self.scope=core.Scope('mock_app','mock_bot','mock_incident');self.now=1000;self.worker()
    def tearDown(self):self.journal.close();self.tmp.cleanup()
    def worker(self):
        self.worker_instance=sender.Sender(self.journal,{self.scope},simulation=False,allow_real_send=True,approved_test_scopes={self.scope},allow_passive_replies=True,operation_mode='production',per_day=100,clock=lambda:self.now)
        return self.worker_instance
    def reserve(self,event='mock_event'):
        return self.worker_instance.prepare_reply(self.scope,event,'mock_member','c'*64)
    def placeholder(self):
        reservation=self.reserve();self.worker_instance.fail_reply(reservation);return reservation
    def test_reserved_safe_hint_is_terminal_audited_charged_and_not_replayed(self):
        res=self.reserve();self.assertTrue(self.worker_instance.fail_reply(res,safe_before_sdk=True))
        self.assertEqual(self.journal.db.execute('SELECT state FROM reply_slots').fetchone()[0],'PRE_SEND_FAILED')
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM reply_pre_send_failures').fetchone()[0],1)
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM attempts').fetchone()[0],0)
        self.assertEqual(self.journal.db.execute('SELECT sum(charged) FROM send_budgets').fetchone()[0],1)
        self.assertFalse(self.journal.budget_status(self.scope,'passive',0,'production')['paused'])
        self.assertIsNone(self.reserve())
    def test_wrong_owner_or_sending_state_cannot_claim_safe_failure(self):
        res=self.reserve();self.assertFalse(self.worker_instance.fail_reply({**res,'owner':'wrong'},safe_before_sdk=True))
        policy.start_reply(self.journal,res,res['key'],'d'*64,self.scope,self.now,10)
        self.assertFalse(self.worker_instance.fail_reply(res,safe_before_sdk=True))
        self.assertEqual(self.journal.db.execute('SELECT outcome FROM attempts').fetchone()[0],'unknown')
    def test_unknown_reply_pause_survives_restart_and_late_outcome(self):
        res=self.placeholder()
        self.assertTrue(self.journal.budget_status(self.scope,'passive',0,'production')['paused'])
        self.journal.close();self.journal=sender.Journal(self.path);self.worker()
        self.assertTrue(self.journal.budget_status(self.scope,'passive',0,'production')['paused'])
        self.assertEqual(self.journal.finish(res['key'],'sent',{}),'unknown')
        self.assertTrue(self.journal.budget_status(self.scope,'passive',0,'production')['paused'])
        self.assertEqual(self.journal.db.execute('SELECT outcome FROM attempts').fetchone()[0],'unknown')
    def test_pre_send_failure_restart_keeps_terminal_event_and_budget(self):
        res=self.reserve();self.worker_instance.fail_reply(res,safe_before_sdk=True)
        self.journal.close();self.journal=sender.Journal(self.path);self.worker()
        self.assertIsNone(self.reserve());self.assertEqual(self.journal.db.execute('SELECT sum(charged) FROM send_budgets').fetchone()[0],1)
        self.assertEqual(self.journal.db.execute('SELECT state FROM reply_slots').fetchone()[0],'PRE_SEND_FAILED')
    def test_two_connections_sdk_start_and_safe_failure_are_mutually_exclusive(self):
        res=self.reserve();barrier=Barrier(2)
        def perform(start):
            journal=sender.Journal(self.path)
            try:
                barrier.wait(timeout=3)
                if start:
                    try:policy.start_reply(journal,res,res['key'],'d'*64,self.scope,self.now,10);return True
                    except core.Rejected:return False
                return policy.fail_reply(journal,res,safe_before_sdk=True,now=self.now)
            finally:journal.close()
        with ThreadPoolExecutor(max_workers=2)as pool:
            a=pool.submit(perform,True);b=pool.submit(perform,False);started,safe=a.result(),b.result()
        self.assertNotEqual(started,safe)
        state=self.journal.db.execute('SELECT state FROM reply_slots').fetchone()[0]
        self.assertEqual(state,'UNKNOWN'if started else'PRE_SEND_FAILED')
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM attempts').fetchone()[0],1 if started else 0)

class SafeDiagnosticTests(unittest.TestCase):
    def test_untrusted_http_fields_are_not_forwarded(self):
        error=BridgeHttpFailure(400,{'unsafe':'public synthetic'},['content'])
        self.assertEqual(error.category,'HTTP_ERROR');self.assertIsNone(error.field)
        self.assertNotIn('synthetic',str(error))

class GroupProofTransportTests(unittest.IsolatedAsyncioTestCase):
    setUp=f.RuntimeTests.setUp
    tearDown=f.RuntimeTests.tearDown
    runtime=m.ManagementTests.runtime
    publish=m.ManagementTests.publish
    managed=g.GroupRuntimeTests.managed
    async def test_real_client_http_rejection_records_no_sdk_and_safe_diagnostics_only(self):
        runtime=self.managed();await runtime.management.sync();calls=[]
        def transport(path,body,headers):
            calls.append(path)
            raise HTTPError('https://mock.invalid',400,'unsafe text must never be logged',{},io.BytesIO(json.dumps({'ok':False,'error':{'code':'VALIDATION_ERROR','message':'public synthetic opaque test text','fieldErrors':{'message_idx':'INVALID_FORMAT_OR_LENGTH'}}}).encode()))
        runtime.bridge=BridgeClient('https://mock.invalid',g.SECRET,transport=transport)
        event=f.Event('绑定群 mock_public_code1234');raw=event.message_obj.raw_message.raw_data;raw['group_openid']='mock_new_group';raw['id']='E'*200;raw['message_scene']['ext']=['msg_idx='+'I'*200]
        with self.assertRaises(BridgeHttpFailure)as got:await runtime.handle(event)
        diag=got.exception.artzoo_group_diagnostic
        self.assertEqual(diag,{'category':'VALIDATION_ERROR','http_status':400,'invalid_field':'message_idx','event_id_length':200,'message_index_length':200,'recorded_no_sdk_start':True})
        self.assertNotIn('mock_public_code',json.dumps(diag));self.assertEqual(self.api_calls,[])
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM direction_pauses').fetchone()[0],0)
        self.assertEqual(self.journal.db.execute('SELECT state FROM reply_slots').fetchone()[0],'PRE_SEND_FAILED')
        self.assertTrue(await runtime.handle(event));self.assertEqual(len(calls),1)
    async def test_bridge_timeout_before_sdk_does_not_claim_unknown_send(self):
        runtime=self.managed();await runtime.management.sync()
        def transport(*args):raise TimeoutError()
        runtime.bridge=BridgeClient('https://mock.invalid',g.SECRET,transport=transport)
        event=f.Event('绑定群 mock_public_code1234');event.message_obj.raw_message.raw_data['group_openid']='mock_new_group'
        with self.assertRaises(TimeoutError):await runtime.handle(event)
        self.assertEqual(self.api_calls,[]);self.assertEqual(self.journal.db.execute('SELECT count(*) FROM direction_pauses').fetchone()[0],0)
    async def test_sdk_timeout_keeps_unknown_pause(self):
        runtime=self.managed();await runtime.management.sync()
        class API:
            async def post_group_message(inner,**kwargs):self.api_calls.append(kwargs);raise TimeoutError()
        runtime.api_factory=lambda _:API()
        event=f.Event('绑定群 mock_public_code1234');event.message_obj.raw_message.raw_data['group_openid']='mock_new_group'
        self.assertTrue(await runtime.handle(event));self.assertEqual(len(self.api_calls),1)
        self.assertEqual(self.journal.db.execute('SELECT outcome FROM attempts').fetchone()[0],'unknown')
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM direction_pauses').fetchone()[0],1)
