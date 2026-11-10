import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib
from pathlib import Path
import sys
import tempfile
from threading import Barrier
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
core=importlib.import_module('plugins.astrbot_plugin_artzoo.core')
sender=importlib.import_module('plugins.astrbot_plugin_artzoo.sender')
policy=importlib.import_module('plugins.astrbot_plugin_artzoo.production_policy')
sdk=importlib.import_module('plugins.astrbot_plugin_artzoo.sdk')

class ResolutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'ledger.sqlite3'
        self.j=sender.Journal(self.path);self.scope=core.Scope('app','bot','group')
        self.key=policy.scope_key(self.scope)+':old-test'
        self.proof=hashlib.sha256(b'PUBLIC_FIXED_HTTP400_CODE40034105_EVIDENCE').hexdigest()
        self.seed(self.j,self.key,self.scope)
    def tearDown(self):self.j.close();self.tmp.cleanup()
    def seed(self,j,key,scope,outcome='unknown'):
        j.reserve(key,'fixed-digest',{**scope.wire(),'delivery_id':'old-test','simulation':False},1000,
                  budget=(scope,'proactive',0),operation_mode='production')
        j.finish(key,outcome,{})
        j.acknowledge(key)
    def resolve(self,j=None):
        return policy.resolve_confirmed_provider_refusal(j or self.j,self.scope,self.key,self.proof,1100)
    def restart(self):self.j.close();self.j=sender.Journal(self.path)
    def available(self,scope=None):return self.j.budget_status(scope or self.scope,'proactive',0,'production')['available']

    def test_exact_resolution_survives_restart_without_replay_or_ledger_change(self):
        before={t:self.j.db.execute('SELECT * FROM '+t).fetchall()for t in ['attempts','send_budgets']}
        self.assertTrue(self.resolve());self.assertFalse(self.resolve())
        self.restart();policy.recover(self.j,1101)
        self.assertTrue(self.available())
        for t,rows in before.items():self.assertEqual(self.j.db.execute('SELECT * FROM '+t).fetchall(),rows)
        prior=self.j.reserve(self.key,'fixed-digest',budget=(self.scope,'proactive',0),operation_mode='production')
        self.assertEqual(prior['outcome'],'unknown')
        self.assertEqual(self.j.db.execute('SELECT count(*) FROM provider_refusal_resolutions').fetchone()[0],1)

    def test_unconfirmed_network_unknown_never_skipped(self):
        self.restart();self.assertFalse(self.available())
        other=core.Scope('app','bot','other')
        self.seed(self.j,policy.scope_key(other)+':network',other)
        self.assertTrue(self.resolve());self.restart()
        self.assertTrue(self.available());self.assertFalse(self.available(other))

    def test_other_unknown_blocks_resolution_and_future_unknown_repauses(self):
        self.assertTrue(self.resolve())
        other_key=policy.scope_key(self.scope)+':new-network'
        self.seed(self.j,other_key,self.scope)
        self.assertFalse(self.available());self.restart();self.assertFalse(self.available())
        self.assertEqual(self.j.db.execute('SELECT outcome FROM attempts WHERE delivery_key=?',(self.key,)).fetchone()[0],'unknown')

    def test_late_outcome_preserves_unknown_and_invalidates_restart_exemption(self):
        self.resolve();self.restart()
        self.assertEqual(self.j.finish(self.key,'sent',{'message_id':'PUBLIC_FAKE'}),'unknown')
        self.assertFalse(self.available());self.restart();self.assertFalse(self.available())
        self.assertEqual(self.j.db.execute('SELECT outcome,receipt FROM attempts WHERE delivery_key=?',(self.key,)).fetchone(),('unknown','{}'))
        self.assertEqual(self.j.db.execute('SELECT count(*) FROM provider_resolution_invalidations').fetchone()[0],1)

    def test_fingerprint_tampering_reactivates_protection(self):
        self.resolve()
        with self.j.db:self.j.db.execute('UPDATE attempts SET digest=? WHERE delivery_key=?',('changed',self.key))
        policy.recover(self.j,1100);self.assertFalse(self.available())
        self.restart();self.assertFalse(self.available())

    def test_scope_global_bad_proof_and_extra_risk_refused(self):
        for scope,key,proof in [(core.Scope('app','bot','wrong'),self.key,self.proof),
                               (self.scope,self.key,'bad'),(self.scope,'not-a-record',self.proof)]:
            with self.assertRaises(core.Rejected):policy.resolve_confirmed_provider_refusal(self.j,scope,key,proof,1100)
        with self.j.db:policy.pause(self.j.db,'*','proactive','unknown')
        with self.assertRaises(core.Rejected):self.resolve()
        self.assertEqual(self.j.db.execute('SELECT count(*) FROM provider_refusal_resolutions').fetchone()[0],0)

    def test_parallel_resolution_and_new_unknown_never_clear_new_risk(self):
        barrier=Barrier(2)
        def action(resolve):
            j=sender.Journal(self.path)
            try:
                barrier.wait()
                if resolve:
                    try:policy.resolve_confirmed_provider_refusal(j,self.scope,self.key,self.proof,1100)
                    except core.Rejected:pass
                else:
                    key=policy.scope_key(self.scope)+':parallel-network'
                    # Independent already-in-flight operation completes with uncertainty.
                    with j.db:
                        j.db.execute('BEGIN IMMEDIATE')
                        j.db.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)',(key,'d','unknown','{}',1100,'{}',1))
                        j.db.execute('INSERT INTO send_budgets VALUES(?,?,?,?,?)',(key,policy.scope_key(self.scope),'proactive',1,1100))
                        policy.pause(j.db,policy.scope_key(self.scope),'proactive','unknown')
            finally:j.close()
        with ThreadPoolExecutor(max_workers=2)as pool:list(pool.map(action,[True,False]))
        self.restart();self.assertFalse(self.available())
        self.assertEqual(self.j.db.execute('SELECT outcome FROM attempts WHERE delivery_key=?',(self.key,)).fetchone()[0],'unknown')

    def test_typed_http_refusal_distinct_from_network_unknown(self):
        self.assertTrue(sender.provider_code_40034105(sdk.ProviderHttpError(400,40034105)))
        for error in [TimeoutError(),ConnectionResetError(),sdk.ProviderHttpError(500,40034105),sdk.ProviderHttpError(429,40034100)]:
            self.assertFalse(sender.provider_code_40034105(error))
