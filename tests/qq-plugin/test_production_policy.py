import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
from pathlib import Path
import sys
import tempfile
from threading import Barrier
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
sender = importlib.import_module("plugins.astrbot_plugin_artzoo.sender")
runtime = importlib.import_module("plugins.astrbot_plugin_artzoo.runtime")


class API:
    def __init__(self, error=None):
        self.calls, self.error = [], error

    async def post_group_message(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"id": "mock_message", "ext_info": {"ref_idx": "mock_reference"}}


class Forbidden(Exception):
    pass


class AuthenticationFailed(Exception):
    pass


async def begun(body):
    return {"dispatch": True, "simulation": False}


class ProductionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "journal.sqlite3"
        self.journal = sender.Journal(self.path)
        self.scope = core.Scope("mock_app", "mock_bot", "mock_group")
        self.now = [1000]
        self.api = API()

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def worker(self, **changes):
        options = dict(simulation=False, allow_real_send=True,
                       allow_proactive_send=True, allow_passive_replies=True,
                       approved_test_scopes={self.scope}, max_proactive_attempts=7,
                       max_passive_attempts=11, clock=lambda: self.now[0])
        options.update(changes)
        return sender.Sender(self.journal, {self.scope}, **options)

    def task(self, index):
        return {**self.scope.wire(), "delivery_id": "mock_delivery" + str(index),
                "claim_token": "mock_claim" + str(index), "idempotency_key": "mock_key" + str(index),
                "content": "notice", "msg_seq": index + 1, "simulation": False}

    def test_old_config_stays_batch_and_production_requires_explicit_live(self):
        settings = runtime.Settings({})
        self.assertEqual(settings.operation_mode, "test_batch")
        self.assertFalse(settings.enabled)
        self.assertFalse(settings.allow_real_send)
        self.assertFalse(settings.allow_proactive_send)
        self.assertFalse(settings.allow_passive_replies)
        self.assertEqual(settings.max_proactive_attempts, 0)
        self.assertEqual(settings.max_passive_attempts, 0)
        for mode in ("unknown", "", None):
            with self.assertRaises(core.Rejected):
                runtime.Settings({"operation_mode": mode})
        with self.assertRaises(core.Rejected):
            runtime.Settings({"operation_mode": "production", "simulation": True})
        with self.assertRaises(core.Rejected):
            self.worker(operation_mode="production", simulation=True)

    async def test_batch_exhaustion_does_not_change_without_explicit_policy(self):
        worker = self.worker(max_proactive_attempts=1)
        await worker.deliver(self.task(0), self.scope, self.api, begin=begun)
        self.now[0] += 61
        with self.assertRaises(core.Rejected):
            await self.worker(max_proactive_attempts=1).deliver(
                self.task(1), self.scope, self.api, begin=begun)
        self.assertEqual(len(self.api.calls), 1)
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 1)["maximum"], 1)

    async def test_production_preserves_seven_nine_history_and_continues_after_restart(self):
        batch = self.worker()
        for index in range(7):
            await batch.deliver(self.task(index), self.scope, self.api, begin=begun)
            self.now[0] += 61
        for index in range(9):
            await batch.reply(self.scope, "event" + str(index), "ok", self.api)
            self.now[0] += 61
        before = self.journal.db.execute("SELECT COUNT(*),SUM(charged) FROM send_budgets").fetchone()
        self.assertEqual(before, (16, 16))
        production = self.worker(operation_mode="production",
                                 max_proactive_attempts=0, max_passive_attempts=0)
        await production.deliver(self.task(7), self.scope, self.api, begin=begun)
        self.now[0] += 61
        for index in range(9, 12):
            await production.reply(self.scope, "event" + str(index), "ok", self.api)
            self.now[0] += 61
        self.assertEqual(len(self.api.calls), 20)
        await production.deliver(self.task(8), self.scope, self.api, begin=begun)
        self.assertEqual(len(self.api.calls), 21)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        status = self.journal.budget_status(self.scope, "proactive", 0, "production")
        self.assertEqual(status["used"], 9)
        self.assertIsNone(status["maximum"])
        self.assertEqual(self.journal.budget_status(
            self.scope, "passive", 0, "production")["used"], 12)
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 21)
        restarted = self.worker(operation_mode="production",
                                max_proactive_attempts=0, max_passive_attempts=0)
        # An old key remains idempotent even when the rolling window is full.
        result = await restarted.deliver(self.task(7), self.scope, self.api, begin=begun)
        self.assertEqual(result["outcome"], "sent")
        self.assertEqual(len(self.api.calls), 21)
        self.now[0] += 86401
        await restarted.deliver(self.task(9), self.scope, self.api, begin=begun)
        self.assertEqual(len(self.api.calls), 22)
        self.assertEqual(self.journal.budget_status(
            self.scope, "proactive", 0, "production")["used"], 10)

    async def test_production_keeps_unknown_pause_and_never_resends_new_claim(self):
        api = API(TimeoutError())
        worker = self.worker(operation_mode="production",
                             max_proactive_attempts=0, max_passive_attempts=0)
        await worker.deliver(self.task(0), self.scope, api, begin=begun)
        same = {**self.task(0), "claim_token": "renewed", "msg_seq": 2}
        result = await worker.deliver(same, self.scope, api, begin=begun)
        self.assertEqual(result["outcome"], "unknown")
        with self.assertRaises(core.Rejected):
            await worker.deliver(self.task(1), self.scope, api, begin=begun)
        self.assertEqual(len(api.calls), 1)

    async def test_all_generic_permission_denials_pause_their_direction_after_restart(self):
        for direction, error in (("proactive", Forbidden()), ("passive", AuthenticationFailed())):
            api = API(error)
            worker = self.worker(operation_mode="production",
                                 max_proactive_attempts=0, max_passive_attempts=0)
            if direction == "proactive":
                result = await worker.deliver(self.task(0), self.scope, api,
                                              (Forbidden, AuthenticationFailed), begin=begun)
            else:
                result = await worker.reply(self.scope, "event", "ok", api,
                                            (Forbidden, AuthenticationFailed))
            self.assertEqual(result["outcome"], "permission_denied")
            self.journal.close()
            self.journal = sender.Journal(self.path)
            status = self.journal.budget_status(self.scope, direction, 0, "production")
            self.assertTrue(status["paused"])
            self.assertEqual(status["pause_reason"], "permission_denied")
            self.assertFalse(status["available"])
            self.assertEqual(len(api.calls), 1)

    def test_historical_generic_permission_denial_is_paused_on_open(self):
        key = core.canonical_json(self.scope.wire()).decode() + ":historical"
        self.journal.reserve(key, "digest", {**self.scope.wire(), "simulation": False})
        self.journal.finish(key, "permission_denied", {})
        self.journal.close()
        self.journal = sender.Journal(self.path)
        status = self.journal.budget_status(self.scope, "proactive", 0, "production")
        self.assertTrue(status["paused"])
        self.assertEqual(status["used"], 1)

    def test_two_connections_stale_preflight_cannot_exceed_atomic_rolling_limit(self):
        barrier = Barrier(2)
        def reserve(index):
            journal = sender.Journal(self.path)
            try:
                self.assertTrue(journal.rate_status(self.scope, 1000, 1, 20)["available"])
                barrier.wait(timeout=5)
                key = core.canonical_json(self.scope.wire()).decode() + ":parallel" + str(index)
                try:
                    journal.reserve(
                        key, "digest", {**self.scope.wire(), "simulation": False}, created=1000,
                        budget=(self.scope, "proactive", 0), rolling=(self.scope, 1, 20),
                        operation_mode="production")
                    journal.finish(key, "sent", {})
                    return "reserved"
                except core.Rejected as error:
                    return str(error)
            finally:
                journal.close()
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(reserve, range(2)))
        self.assertEqual(sorted(results), ["rate_limited", "reserved"])
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 1)
        self.assertEqual(self.journal.budget_status(
            self.scope, "proactive", 0, "production")["used"], 1)

    async def test_proactive_minute_limit_does_not_consume_passive_reply_capacity(self):
        worker = self.worker(operation_mode="production", max_proactive_attempts=0,
                             max_passive_attempts=0, per_minute=1)
        await worker.deliver(self.task(0), self.scope, self.api, begin=begun)
        await worker.reply(self.scope, "other", "ok", self.api)
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 2)
        self.assertEqual(self.journal.db.execute("SELECT SUM(charged) FROM send_budgets").fetchone()[0], 2)
        self.assertEqual(len(self.api.calls), 2)
