"""No external transport: count actual SQLite work and preserve safety paths."""
import copy,importlib,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
import test_groups as g
import test_runtime as fixtures
from plugins.astrbot_plugin_artzoo import core,sender,production_policy as policy

class BudgetWorkTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.j=sender.Journal(Path(self.tmp.name)/'j.sqlite');self.scope=core.Scope('mock_app','mock_bot','mock_group')
 def tearDown(self):self.j.close();self.tmp.cleanup()
 def test_available_matches_full_status_in_both_modes_and_reads_live_pauses(self):
  for mode in ['test_batch','production']:
   for cap in [0,1,7]:self.assertEqual(self.j.budget_available(self.scope,'proactive',cap,mode),self.j.budget_status(self.scope,'proactive',cap,mode)['available'])
  statements=[];self.j.db.set_trace_callback(statements.append)
  for _ in range(5):self.j.budget_status(self.scope,'proactive',0,'production')
  old_sum=sum('SUM(charged)'in x for x in statements);old_queries=sum(x.startswith('SELECT')for x in statements);statements.clear()
  for _ in range(5):self.j.budget_available(self.scope,'proactive',0,'production')
  new_sum=sum('SUM(charged)'in x for x in statements);new_queries=sum(x.startswith('SELECT')for x in statements);self.j.db.set_trace_callback(None)
  self.assertEqual((old_sum,new_sum,old_queries,new_queries),(5,0,10,5))
  print('METRIC BUDGET 5checks lifetime_SUM=5->0 SELECT=10->5')
  with self.j.db:policy.pause(self.j.db,policy.scope_key(self.scope),'proactive','unknown')
  self.assertFalse(self.j.budget_available(self.scope,'proactive',0,'production'))
  other=core.Scope('mock_app','mock_bot','other');self.assertTrue(self.j.budget_available(other,'proactive',0,'production'))
  with self.j.db:policy.pause(self.j.db,'*','proactive','unknown')
  self.assertFalse(self.j.budget_available(other,'proactive',0,'production'))
  with self.assertRaises(core.Rejected):self.j.budget_available(self.scope,'proactive',0,'bad_mode')
 def test_production_keeps_lifetime_reporting_and_rolling_cap(self):
  with self.j.db:self.j.db.executemany('INSERT INTO send_budgets VALUES(?,?,?,?,?)',[(str(n),policy.scope_key(self.scope),'proactive',1,1000)for n in range(100)])
  self.assertEqual(self.j.budget_status(self.scope,'proactive',0,'production')['used'],100)
  self.assertTrue(self.j.budget_available(self.scope,'proactive',0,'production'))
  self.assertFalse(policy.capacity(self.j,self.scope,'proactive',1000,3,100,10))

class SyncWorkTests(unittest.IsolatedAsyncioTestCase):
 setUp=fixtures.RuntimeTests.setUp
 tearDown=fixtures.RuntimeTests.tearDown
 runtime=g.m.ManagementTests.runtime
 publish=g.m.ManagementTests.publish
 managed=g.GroupRuntimeTests.managed

async def unchanged_sync(test):
 r=test.managed();test.bridge.rows=[g.row('mock_other')]
 test.bridge.publication=None
 test.assertTrue(await r.management.sync())
 # Execute the previous exact SQL against the same fixture to measure the baseline.
 old_start=test.journal.db.total_changes
 with test.journal.db:
  for _ in range(3):test.journal.db.execute("INSERT INTO management_group_state VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,digest=excluded.digest WHERE excluded.revision>management_group_state.revision OR (excluded.revision=management_group_state.revision AND excluded.digest=management_group_state.digest)",(r.management.scope_key,r.management.group_revision,r.management.group_digest))
 test.assertEqual(test.journal.db.total_changes-old_start,3)
 before=test.journal.db.total_changes
 for _ in range(3):test.assertTrue(await r.management.sync())
 test.assertEqual(test.journal.db.total_changes-before,0)
 test.assertEqual(r.sender.allowed,{core.Scope('mock_app','mock_bot','mock_other')})
 print('METRIC REGISTRY 3unchanged_sync row_updates=3->0')
 # Missing durable row still restores via INSERT, unlike an in-memory skip.
 with test.journal.db:test.journal.db.execute('DELETE FROM management_group_state')
 test.assertTrue(await r.management.sync());test.assertEqual(test.journal.db.execute('SELECT count(*) FROM management_group_state').fetchone()[0],1)
 # Cached registry/config restart still requires fresh signed response and applies actual groups.
 test.publish();test.assertTrue(await r.management.sync());cached=(r.management.version,r.management.digest)
 other=test.runtime(managed_groups_enabled=True);test.bridge.publication=None
 test.assertEqual((other.management.version,other.management.digest),cached)
 test.assertFalse(other.management.fresh());test.assertTrue(await other.management.sync())
 test.assertEqual(other.sender.allowed,{core.Scope('mock_app','mock_bot','mock_other')})
 # Every no-change sync still validates signature and expires stale control.
 post=test.bridge.post
 async def corrupt(path,body):
  value=await post(path,body)
  if path.endswith('/management/sync'):value['groups']['signature']='0'*64
  return value
 test.bridge.post=corrupt;test.assertFalse(await other.management.sync());test.assertFalse(other.management.fresh())

SyncWorkTests.test_unchanged_registry_and_restart_config_omit_no_safety=unchanged_sync
