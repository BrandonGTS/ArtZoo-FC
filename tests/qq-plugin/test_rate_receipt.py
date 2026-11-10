import asyncio
import importlib
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import test_runtime as fixtures
from plugins.astrbot_plugin_artzoo import sender, runtime, production_policy as policy, core

class RateReceiptTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'journal';self.j=sender.Journal(self.path);self.scope=core.Scope('mock_app','mock_bot','mock_group');self.now=[1000.0];self.calls=[];self.posts=[]
        outer=self
        class API:
            error=None
            async def post_group_message(inner,**body):
                outer.calls.append(body)
                if inner.error:raise inner.error
                return {'id':'mock_id','ext_info':{'ref_idx':'mock_ref'}}
        self.api=API()
    def tearDown(self):self.j.close();self.tmp.cleanup()
    def worker(self,j=None,**kw):
        args=dict(simulation=False,allow_real_send=True,approved_test_scopes={self.scope},allow_proactive_send=True,allow_passive_replies=True,operation_mode='production',per_minute=3,per_day=100,group_per_minute=10,passive_per_user_minute=3,clock=lambda:self.now[0]);args.update(kw)
        return sender.Sender(j or self.j,{self.scope},**args)
    def event(self,event='e1',member='member1'):
        e=fixtures.Event();e.message_obj.raw_message.raw_data['id']=event;e.message_obj.raw_message.raw_data['author']['member_openid']=member;return e
    def app(self,j=None,bridge_error=None):
        outer=self
        class Bridge:
            async def post(inner,path,body):
                outer.posts.append((path,body));await asyncio.sleep(0)
                if bridge_error:raise bridge_error
                return {'message':'ok'}
        cfg=dict(enabled=True,simulation=False,operation_mode='production',allow_real_send=True,allow_passive_replies=True,allow_proactive_send=True,max_proactive_attempts=0,max_passive_attempts=0,platform_id='mock_platform',app_id='mock_app',bot_id='mock_bot',allow_groups=['mock_group'],approved_test_groups=['mock_group'],per_minute=3,per_day=100,poll_seconds=10)
        adapter=SimpleNamespace(appid='mock_app',meta=lambda:SimpleNamespace(name='qq_official'),client=SimpleNamespace(robot=SimpleNamespace(id='mock_bot')))
        rt=runtime.Runtime(runtime.Settings(cfg),SimpleNamespace(get_platform_inst=lambda _:adapter),Bridge(),j or self.j,lambda _:self.api,group_message_type=fixtures.NativeGroup);rt.sender.clock=lambda:self.now[0];return rt
    def task(self,n):return {**self.scope.wire(),'delivery_id':'d'+str(n),'claim_token':'c'+str(n),'idempotency_key':'k'+str(n),'content':'notice','msg_seq':1,'simulation':False}
    async def begun(self,body):return {'dispatch':True,'simulation':False}
    async def test_user_limit_before_business_leaves_no_fourth_mutation(self):
        rt=self.app()
        for i in range(3):await rt.handle(self.event('e'+str(i)))
        with self.assertRaises(core.Rejected):await rt.handle(self.event('e4'))
        self.assertEqual(len(self.posts),3);self.assertEqual(len(self.calls),3)
        self.assertEqual(self.j.db.execute('SELECT count(*) FROM send_budgets').fetchone()[0],3)
    async def test_other_member_has_independent_capacity(self):
        rt=self.app()
        for i in range(3):await rt.handle(self.event('e'+str(i)))
        await rt.handle(self.event('other','member2'));self.assertEqual(len(self.posts),4)
    async def test_proactive_day_exhaustion_does_not_block_command(self):
        w=self.worker(per_day=1);await w.deliver(self.task(1),self.scope,self.api,begin=self.begun);self.now[0]+=61
        self.assertFalse(w.can_start(self.scope,'proactive'));await self.app().handle(self.event());self.assertEqual(len(self.posts),1);self.assertEqual(len(self.calls),2)
    async def test_reserved_reply_not_squeezed_out_by_other_users(self):
        w=self.worker();slot=w.prepare_reply(self.scope,'first','first_member','fingerprint')
        for i in range(9):
            event='e'+str(i);s=w.prepare_reply(self.scope,event,'m'+str(i),'fp'+str(i));await w.reply(self.scope,event,'ok',self.api,reservation=s)
        self.assertFalse(w.can_start(self.scope,'proactive'));await w.reply(self.scope,'first','ok',self.api,reservation=slot);self.assertEqual(len(self.calls),10)
    async def test_duplicate_native_event_two_instances_one_business_and_reply(self):
        other=sender.Journal(self.path)
        try:await asyncio.gather(self.app().handle(self.event()),self.app(other).handle(self.event()))
        finally:other.close()
        self.assertEqual(len(self.posts),1);self.assertEqual(len(self.calls),1)
    async def test_bridge_unknown_pauses_and_never_reexecutes(self):
        rt=self.app(bridge_error=TimeoutError())
        with self.assertRaises(TimeoutError):await rt.handle(self.event())
        with self.assertRaises(core.Rejected):await rt.handle(self.event())
        self.assertEqual(len(self.posts),1);self.assertEqual(len(self.calls),0);self.assertTrue(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
    async def test_website_success_sdk_unknown_does_not_repeat_registration(self):
        self.api.error=TimeoutError();rt=self.app();await rt.handle(self.event())
        with self.assertRaises(core.Rejected):await rt.handle(self.event())
        self.assertEqual(len(self.posts),1);self.assertEqual(len(self.calls),1);self.assertTrue(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
    async def test_permission_denied_pauses_only_passive(self):
        class Forbidden(Exception):pass
        w=self.worker();slot=w.prepare_reply(self.scope,'e','m','fp');self.api.error=Forbidden();r=await w.reply(self.scope,'e','ok',self.api,(Forbidden,),reservation=slot)
        self.assertEqual(r['outcome'],'permission_denied');self.assertFalse(w.can_start(self.scope,'passive'));self.assertTrue(w.can_start(self.scope,'proactive'))
    async def test_restart_does_not_reset_sent_user_budget(self):
        rt=self.app()
        for i in range(3):await rt.handle(self.event('e'+str(i)))
        self.j.close();self.j=sender.Journal(self.path)
        with self.assertRaises(core.Rejected):await self.app().handle(self.event('new'))
        self.assertEqual(len(self.posts),3)
    async def test_valid_lease_not_recovered_and_expired_owner_cannot_send(self):
        w=self.worker();slot=w.prepare_reply(self.scope,'e','m','fp');other=sender.Journal(self.path)
        try:
            policy.recover(other,1001);self.assertFalse(other.budget_status(self.scope,'passive',0,'production')['paused'])
            policy.recover(other,1031)
            with self.assertRaises(core.Rejected):await w.reply(self.scope,'e','ok',self.api,reservation=slot)
            self.assertTrue(other.budget_status(self.scope,'passive',0,'production')['paused']);self.assertEqual(len(self.calls),0)
        finally:other.close()
    async def test_old_pending_slot_does_not_age_out_of_global_capacity(self):
        w=self.worker(group_per_minute=1);slot=w.prepare_reply(self.scope,'e','m','fp')
        self.assertFalse(policy.capacity(self.j,self.scope,'proactive',1061,3,100,1))
        self.now[0]=1061
        with self.assertRaises(core.Rejected):await w.reply(self.scope,'e','ok',self.api,reservation=slot)
        self.assertEqual(len(self.calls),0)
    async def test_native_wrong_group_or_missing_id_no_business(self):
        for mutate in ('group','id'):
            e=self.event();raw=e.message_obj.raw_message.raw_data
            if mutate=='group':raw['group_openid']='other'
            else:raw.pop('id')
            with self.assertRaises(core.Rejected):await self.app().handle(e)
        self.assertEqual(self.posts,[]);self.assertEqual(self.calls,[])
    async def test_poll_drains_three_valid_reminders_within_one_cycle(self):
        rt=self.app();outer=self;queue=[self.task(i) for i in range(3)]
        class Bridge:
            async def post(inner,path,body):
                if path.endswith('/claim'):return {'delivery':queue.pop(0) if queue else None}
                if path.endswith('/begin'):return {'dispatch':True,'simulation':False}
                if path.endswith('/ack'):return {'accepted':True}
                raise AssertionError(path)
        rt.bridge=Bridge();await rt.poll_once();self.assertEqual(len(self.calls),3);self.assertEqual(queue,[])
    async def test_atomic_last_group_slot_across_connections(self):
        w=self.worker()
        for i in range(9):
            e='old'+str(i);slot=w.prepare_reply(self.scope,e,'m'+str(i),'fp'+str(i));await w.reply(self.scope,e,'ok',self.api,reservation=slot)
        barrier=Barrier(2)
        def reserve(i):
            j=sender.Journal(self.path);worker=self.worker(j)
            try:
                barrier.wait(timeout=5)
                try:return bool(worker.prepare_reply(self.scope,'race'+str(i),'race_m'+str(i),'fp'))
                except core.Rejected:return False
            finally:j.close()
        loop=asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=2) as pool:results=await asyncio.gather(*(loop.run_in_executor(pool,reserve,i) for i in range(2)))
        self.assertEqual(sum(results),1);self.assertEqual(self.j.db.execute('SELECT count(*) FROM send_budgets').fetchone()[0],10)

    async def test_second_connection_does_not_pause_valid_sending_owner(self):
        w=self.worker();slot=w.prepare_reply(self.scope,'e','m','fp')
        policy.start_reply(self.j,slot,slot['key'],'reply_digest',self.scope,self.now[0],10)
        other=sender.Journal(self.path)
        try:
            self.assertFalse(other.budget_status(self.scope,'passive',0,'production')['paused'])
            policy.recover(other,1001)
            self.assertFalse(other.budget_status(self.scope,'passive',0,'production')['paused'])
            self.j.finish(slot['key'],'sent',{})
            self.assertEqual(self.j.db.execute('SELECT state FROM reply_slots').fetchone()[0],'SENT')
        finally:other.close()
    async def test_unknown_is_terminal_when_late_success_arrives(self):
        w=self.worker();slot=w.prepare_reply(self.scope,'e','m','fp')
        policy.start_reply(self.j,slot,slot['key'],'reply_digest',self.scope,1000,10)
        policy.recover(self.j,1031);self.assertEqual(self.j.finish(slot['key'],'sent',{}),'unknown')
        self.assertEqual(self.j.db.execute('SELECT state FROM reply_slots').fetchone()[0],'UNKNOWN')
        self.assertEqual(self.j.db.execute('SELECT outcome FROM attempts').fetchone()[0],'unknown')
        self.assertEqual(self.j.db.execute('SELECT outcome FROM reply_late_outcomes').fetchone()[0],'sent')
        self.assertTrue(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
    async def test_heartbeat_is_owner_bound_and_has_hard_deadline(self):
        w=self.worker();slot=w.prepare_reply(self.scope,'e','m','fp')
        self.assertFalse(policy.renew(self.j,{**slot,'owner':'wrong'},1001))
        for offset in range(5,120,5):self.assertTrue(policy.renew(self.j,slot,1000+offset))
        self.assertFalse(policy.renew(self.j,slot,1120))
        self.assertTrue(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
        self.assertEqual(self.j.db.execute('SELECT sum(charged) FROM send_budgets').fetchone()[0],1)
    async def test_ten_normal_waiters_with_proactive_send_keep_their_leases(self):
        import time
        from unittest.mock import patch
        rt=self.app();rt.sender.clock=time.monotonic;original=self.api.post_group_message
        async def slow_api(**body):
            await asyncio.sleep(.3);return await original(**body)
        self.api.post_group_message=slow_api
        original_post=rt.bridge.post
        async def slow_post(path,body):
            await asyncio.sleep(.3);return await original_post(path,body)
        rt.bridge.post=slow_post
        # Same timing ratios, with room for CI scheduler stalls beyond the old 50ms lease.
        # Ten serialized .3s sends still make tail replies wait through several .5s leases.
        with patch.object(policy,'LEASE_SECONDS',.5),patch.object(policy,'HEARTBEAT_SECONDS',.1),patch.object(policy,'MAX_REPLY_SECONDS',20):
            jobs=[rt.sender.deliver(self.task(1),self.scope,self.api,begin=self.begun)]
            jobs.extend(rt.handle(self.event('e'+str(i),'m'+str(i))) for i in range(9))
            await asyncio.gather(*jobs)
        self.assertEqual(len(self.posts),9);self.assertEqual(len(self.calls),10)
        self.assertEqual(self.j.db.execute("SELECT count(*) FROM reply_slots WHERE state='SENT'").fetchone()[0],9)
        self.assertFalse(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
    async def test_active_and_passive_atomic_shared_group_cap(self):
        w=self.worker()
        for i in range(9):
            e='old'+str(i);slot=w.prepare_reply(self.scope,e,'m'+str(i),'fp'+str(i));await w.reply(self.scope,e,'ok',self.api,reservation=slot)
        barrier=Barrier(2)
        def reserve(i):
            j=sender.Journal(self.path);worker=self.worker(j)
            try:
                barrier.wait(timeout=5)
                try:
                    if i:
                        key=policy.scope_key(self.scope)+':active_race'
                        j.reserve(key,'digest',{**self.scope.wire(),'simulation':False},created=1000,budget=(self.scope,'proactive',0),rolling=(self.scope,3,100,10),operation_mode='production');j.finish(key,'sent',{})
                    else:worker.prepare_reply(self.scope,'passive_race','m_race','fp')
                    return True
                except core.Rejected:return False
            finally:j.close()
        loop=asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=2) as pool:results=await asyncio.gather(*(loop.run_in_executor(pool,reserve,i) for i in range(2)))
        self.assertEqual(sum(results),1);self.assertEqual(self.j.db.execute('SELECT count(*) FROM send_budgets').fetchone()[0],10)

    async def test_finish_and_recover_serialized_before_state_read(self):
        from threading import Event as ThreadEvent
        w=self.worker();slot=w.prepare_reply(self.scope,'e','m','fp')
        policy.start_reply(self.j,slot,slot['key'],'digest',self.scope,1000,10)
        both=Barrier(2);reading=ThreadEvent();recover_attempted=ThreadEvent()
        def finish():
            j=sender.Journal(self.path)
            try:
                def trace(sql):
                    if sql.startswith('SELECT state FROM reply_slots'):
                        reading.set();self.assertTrue(recover_attempted.wait(3))
                j.db.set_trace_callback(trace);both.wait(timeout=3);j.finish(slot['key'],'sent',{})
            finally:j.close()
        def recover():
            j=sender.Journal(self.path)
            try:
                both.wait(timeout=3);self.assertTrue(reading.wait(3));recover_attempted.set();policy.recover(j,1031)
            finally:j.close()
        loop=asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=2) as pool:await asyncio.gather(loop.run_in_executor(pool,finish),loop.run_in_executor(pool,recover))
        self.assertEqual(self.j.db.execute('SELECT state FROM reply_slots').fetchone()[0],'SENT')
        self.assertEqual(self.j.db.execute('SELECT outcome FROM attempts').fetchone()[0],'sent')
        self.assertFalse(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
    async def test_sdk_cannot_start_without_hard_deadline_margin(self):
        slot=self.worker().prepare_reply(self.scope,'e','m','fp')
        for now in range(1005,1116,5):self.assertTrue(policy.renew(self.j,slot,now))
        with self.assertRaises(core.Rejected):policy.start_reply(self.j,slot,slot['key'],'digest',self.scope,1115,10)
        self.assertEqual(self.j.db.execute('SELECT state FROM reply_slots').fetchone()[0],'UNKNOWN')
    async def test_renew_samples_clock_inside_write_transaction(self):
        slot=self.worker().prepare_reply(self.scope,'e','m','fp')
        def after_lock():
            self.assertTrue(self.j.db.in_transaction);return 1031
        self.assertFalse(policy.renew(self.j,slot,after_lock))
        self.assertEqual(self.j.db.execute('SELECT state FROM reply_slots').fetchone()[0],'UNKNOWN')

    async def test_initializer_snapshot_cannot_pause_concurrent_success(self):
        import sqlite3
        import threading
        from unittest.mock import patch
        from threading import Event as ThreadEvent
        slot=self.worker().prepare_reply(self.scope,'e','m','fp')
        policy.start_reply(self.j,slot,slot['key'],'digest',self.scope,1000,10)
        ready=ThreadEvent();snapshot=ThreadEvent();attempting=ThreadEvent();finished=ThreadEvent();errors=[]
        original=sqlite3.connect
        class Cursor(sqlite3.Cursor):
            def fetchall(inner):
                rows=super().fetchall()
                if getattr(inner,'command','').startswith('SELECT delivery_key,outcome,created,ack FROM attempts'):
                    snapshot.set();self.assertTrue(attempting.wait(3));finished.wait(.1)
                return rows
        class Connection(sqlite3.Connection):
            def execute(inner,sql,parameters=()):
                cur=inner.cursor(factory=Cursor);cur.command=sql;return cur.execute(sql,parameters)
        def connect(*args,**kwargs):
            if threading.current_thread().name=='qq-init':kwargs['factory']=Connection
            return original(*args,**kwargs)
        def finish():
            j=None
            try:
                j=sender.Journal(self.path);ready.set();self.assertTrue(snapshot.wait(3));attempting.set();j.finish(slot['key'],'sent',{})
            except BaseException as error:errors.append(error)
            finally:
                if j:j.close()
                finished.set()
        def initialize():
            j=None
            try:self.assertTrue(ready.wait(3));j=sender.Journal(self.path)
            except BaseException as error:errors.append(error)
            finally:
                if j:j.close()
        with patch.object(sqlite3,'connect',connect):
            a=threading.Thread(target=finish,name='qq-finish');b=threading.Thread(target=initialize,name='qq-init');a.start();b.start();await asyncio.to_thread(a.join,5);await asyncio.to_thread(b.join,5)
        self.assertFalse(a.is_alive());self.assertFalse(b.is_alive());self.assertEqual(errors,[])
        self.assertEqual(self.j.db.execute('SELECT state FROM reply_slots').fetchone()[0],'SENT')
        self.assertEqual(self.j.db.execute('SELECT outcome FROM attempts').fetchone()[0],'sent')
        self.assertFalse(self.j.budget_status(self.scope,'passive',0,'production')['paused'])
