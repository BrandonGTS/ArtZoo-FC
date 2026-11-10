import asyncio
import importlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
sender = importlib.import_module("plugins.astrbot_plugin_artzoo.sender")


class API:
    def __init__(self, error=None, response=True):
        self.calls, self.error, self.response = [], error, response

    async def post_group_message(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"id": "mock_id", "ext_info": {"ref_idx": "mock_ref"}} if self.response else None


async def begun(body):
    return {"dispatch": True, "simulation": False}


class DirectionTests(unittest.IsolatedAsyncioTestCase):
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

    def task(self, index=0):
        return {**self.scope.wire(), "delivery_id": "mock_delivery" + str(index),
                "claim_token": "mock_claim" + str(index), "idempotency_key": "mock_key" + str(index),
                "content": "notice", "msg_seq": index + 1, "simulation": False}

    async def test_seven_proactive_eleven_passive_hard_caps_survive_restart(self):
        for index in range(7):
            await self.worker().deliver(self.task(index), self.scope, self.api, begin=begun)
            self.now[0] += 61
        with self.assertRaises(core.Rejected):
            await self.worker().deliver(self.task(7), self.scope, self.api, begin=begun)
        for index in range(11):
            await self.worker().reply(self.scope, "event" + str(index), "ok", self.api)
            self.now[0] += 61
        with self.assertRaises(core.Rejected):
            await self.worker().reply(self.scope, "event11", "ok", self.api)
        self.assertEqual(len(self.api.calls), 18)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 7)["used"], 7)
        self.assertEqual(self.journal.budget_status(self.scope, "passive", 11)["used"], 11)
        with self.assertRaises(core.Rejected):
            await self.worker().deliver(self.task(8), self.scope, self.api, begin=begun)
        self.assertEqual(len(self.api.calls), 18)

    async def test_zero_budget_and_independent_flags_fail_before_begin_or_sdk(self):
        begins = []
        async def begin(body):
            begins.append(body)
            return await begun(body)
        for options in ({"max_proactive_attempts": 0}, {"allow_proactive_send": False},
                        {"allow_real_send": False}):
            with self.assertRaises(core.Rejected):
                await self.worker(**options).deliver(self.task(), self.scope, self.api, begin=begin)
        for options in ({"max_passive_attempts": 0}, {"allow_passive_replies": False},
                        {"allow_real_send": False}):
            with self.assertRaises(core.Rejected):
                await self.worker(**options).reply(self.scope, "event", "ok", self.api)
        self.assertEqual(begins, [])
        self.assertEqual(self.api.calls, [])

    async def test_simulation_and_definite_denied_begin_do_not_consume_budget(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        await self.worker().deliver(self.task(), self.scope, self.api, begin=denied)
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 7)["used"], 0)
        task = {**self.task(1), "simulation": True}
        await self.worker(simulation=True, max_proactive_attempts=0).deliver(
            task, self.scope, self.api, begin=begun)
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 7)["used"], 0)
        await self.worker().deliver({**self.task(), "msg_seq": 3, "claim_token": "renewed"},
                                    self.scope, self.api, begin=begun)
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 7)["used"], 1)
        self.assertEqual(len(self.api.calls), 1)

    async def test_unknown_pauses_only_its_direction_durably(self):
        api = API(error=TimeoutError())
        result = await self.worker().deliver(self.task(), self.scope, api, begin=begun)
        self.assertEqual(result["outcome"], "unknown")
        self.journal.close()
        self.journal = sender.Journal(self.path)
        status = self.journal.budget_status(self.scope, "proactive", 7)
        self.assertEqual(status["used"], 1)
        self.assertTrue(status["paused"])
        with self.assertRaises(core.Rejected):
            await self.worker().deliver(self.task(1), self.scope, api, begin=begun)
        await self.worker().reply(self.scope, "passive-event", "ok", self.api)
        self.assertEqual(len(api.calls), 1)
        self.assertEqual(len(self.api.calls), 1)

    async def test_unknown_passive_does_not_pause_proactive(self):
        api = API(response=False)
        result = await self.worker().reply(self.scope, "passive", "ok", api)
        self.assertEqual(result["outcome"], "unknown")
        self.assertTrue(self.journal.budget_status(self.scope, "passive", 11)["paused"])
        with self.assertRaises(core.Rejected):
            await self.worker().reply(self.scope, "passive2", "ok", api)
        await self.worker().deliver(self.task(), self.scope, self.api, begin=begun)
        self.assertEqual(len(api.calls), 1)
        self.assertEqual(len(self.api.calls), 1)

    async def test_provider_40034105_structured_body_pauses_without_raw_error_storage(self):
        error = RuntimeError("private vendor error must not be stored")
        error.body = {"data": {"code": 40034105}}
        api = API(error=error)
        result = await self.worker().reply(self.scope, "passive", "ok", api)
        self.assertEqual(result["outcome"], "permission_denied")
        self.journal.close()
        self.journal = sender.Journal(self.path)
        status = self.journal.budget_status(self.scope, "passive", 11)
        self.assertTrue(status["paused"])
        self.assertEqual(status["pause_reason"], "provider_40034105")
        self.assertEqual(status["used"], 1)
        with self.assertRaises(core.Rejected):
            await self.worker().reply(self.scope, "next", "ok", api)
        self.assertEqual(len(api.calls), 1)
        rows = str(self.journal.db.execute("SELECT * FROM direction_pauses").fetchall())
        self.assertNotIn("private vendor", rows)

    async def test_typed_provider_refusal_proactive_and_server_unknown(self):
        sdk = importlib.import_module('plugins.astrbot_plugin_artzoo.sdk')
        for status, outcome in [(500, 'unknown'), (400, 'permission_denied')]:
            with self.subTest(status=status):
                scope = core.Scope('mock_app', 'mock_bot', 'mock_group_' + str(status))
                worker = self.worker()
                worker.allowed.add(scope)
                worker.approved.add(scope)
                task = {**self.task(status), **scope.wire(), 'msg_seq': 1}
                api = API(error=sdk.ProviderHttpError(status, 40034105))
                result = await worker.deliver(task, scope, api, begin=begun)
                self.assertEqual(result['outcome'], outcome)
                self.assertTrue(self.journal.budget_status(scope, 'proactive', 7)['paused'])
                await worker.deliver(task, scope, api, begin=begun)
                self.assertEqual(len(api.calls), 1)

    async def test_cancelled_sdk_attempt_charged_and_paused_after_restart(self):
        api = API(error=asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            await self.worker().deliver(self.task(), self.scope, api, begin=begun)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        status = self.journal.budget_status(self.scope, "proactive", 7)
        self.assertEqual(status["used"], 1)
        self.assertTrue(status["paused"])

    def test_legacy_actual_unknown_attempt_is_imported_not_reset(self):
        key = core.canonical_json(self.scope.wire()).decode() + ":old"
        self.journal.reserve(key, "immutable", {**self.scope.wire(), "simulation": False})
        self.journal.finish(key, "unknown", {})
        self.journal.close()
        self.journal = sender.Journal(self.path)
        status = self.journal.budget_status(self.scope, "proactive", 7)
        self.assertEqual(status["used"], 1)
        self.assertTrue(status["paused"])
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 1)

    def test_provider_error_code_fields_are_bounded_and_precise(self):
        for name, value in (("code", 40034105), ("msgs", '{"code":40034105}'),
                            ("data", {"error": {"errcode": "40034105"}})):
            error = RuntimeError("hidden")
            setattr(error, name, value)
            self.assertTrue(sender.provider_code_40034105(error))
        self.assertFalse(sender.provider_code_40034105(RuntimeError("1400341059")))

    async def test_server_forced_simulation_refunds_reserved_actual_budget(self):
        async def forced_simulation(body):
            return {"dispatch": True, "simulation": True}
        result = await self.worker().deliver(self.task(), self.scope, self.api,
                                              begin=forced_simulation)
        self.assertEqual(result["outcome"], "simulated")
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 7)["used"], 0)
        self.assertEqual(self.api.calls, [])
