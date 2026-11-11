import asyncio
import importlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
sender = importlib.import_module("plugins.astrbot_plugin_artzoo.sender")
sdk = importlib.import_module("plugins.astrbot_plugin_artzoo.sdk")


class Forbidden(Exception):
    pass


class MockAPI:
    """No network library imported or socket opened."""
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response
        self.error = error

    async def post_group_message(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response


async def allow_begin(body):
    return {"dispatch": True, "simulation": False}


class TestWorker(sender.Sender):
    async def deliver(self, task, scope, api, permission_errors=(), **kwargs):
        return await super().deliver(task, scope, api, permission_errors,
                                     begin=kwargs.pop("begin", allow_begin), **kwargs)


class SenderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "journal.sqlite3"
        self.journal = sender.Journal(self.path)
        self.scope = core.Scope("app", "bot", "group")
        self.task = {**self.scope.wire(), "delivery_id": "delivery", "claim_token": "claim",
                     "idempotency_key": "key", "content": "test notice", "msg_seq": 1,
                     "simulation": False, "expires_at": 2000}
        self.api = MockAPI({"id": "ordinary", "ext_info": {"ref_idx": "REFIDX_quote=="}})

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def live(self, **kw):
        options = dict(simulation=False, allow_real_send=True,
                       approved_test_scopes={self.scope}, clock=lambda: 1000,
                       allow_proactive_send=True, allow_passive_replies=True,
                       max_proactive_attempts=7, max_passive_attempts=11)
        options.update(kw)
        return TestWorker(self.journal, {self.scope}, **options)

    async def test_default_simulation_never_sends(self):
        worker = TestWorker(self.journal, {self.scope}, clock=lambda: 1000)
        result = await worker.deliver({**self.task, "simulation": True}, self.scope, self.api)
        self.assertEqual(result["outcome"], "simulated")
        self.assertEqual(self.api.calls, [])

    async def test_triple_gate_required_for_real_send(self):
        for kwargs in ({"simulation": False},
                       {"simulation": False, "allow_real_send": True}):
            worker = TestWorker(self.journal, {self.scope}, clock=lambda: 1000, **kwargs)
            with self.assertRaises(core.Rejected):
                await worker.deliver(self.task, self.scope, self.api)
        self.assertFalse(self.api.calls)

    async def test_sdk_send_captures_full_receipt_once(self):
        worker = self.live()
        result = await worker.deliver(self.task, self.scope, self.api)
        again = await worker.deliver(self.task, self.scope, self.api)
        self.assertEqual(result, again)
        self.assertEqual(result["message_id"], "ordinary")
        self.assertEqual(result["ref_idx"], "REFIDX_quote==")
        self.assertEqual(self.api.calls, [{"group_openid": "group", "content": "test notice",
                                         "msg_type": 0, "msg_seq": 1}])

    def probe_task(self):
        key = "bot-test-00000000-0000-4000-8000-000000000001"
        return {**self.scope.wire(), "delivery_id": key, "claim_token": "claim",
                "idempotency_key": key, "content": sdk.BUTTON_PROBE_CONTENT,
                "msg_seq": 1, "simulation": False, "button_probe": True}

    async def test_probe_is_sent_once_through_restricted_sdk_parameter(self):
        worker, task = self.live(), self.probe_task()
        one = await worker.deliver(task, self.scope, self.api)
        again = await worker.deliver(task, self.scope, self.api)
        self.assertEqual(one, again)
        self.assertEqual(one["outcome"], "sent")
        self.assertEqual(one["ref_idx"], "REFIDX_quote==")
        self.assertEqual(len(self.api.calls), 1)
        self.assertIs(self.api.calls[0]["button_probe"], True)
        self.assertNotIn("keyboard", self.api.calls[0])

    async def test_probe_rejects_ordinary_activity_task_before_budget_or_sdk(self):
        with self.assertRaises(core.Rejected):
            await self.live().deliver({**self.task, "content": sdk.BUTTON_PROBE_CONTENT,
                                       "button_probe": True}, self.scope, self.api)
        for change in ({"idempotency_key": "other"}, {"content": "arbitrary"},
                       {"content": sdk.BUTTON_PROBE_CONTENT + "\x00"}, {"msg_seq": 2},
                       {"simulation": True}, {"button_probe": False}, {"button_probe": 1},
                       {"button_probe": "true"}, {"button_probe": None},
                       {"activityId": "untrusted"}, {"signup_code": "7K4M2Q9R"}):
            with self.subTest(change=change), self.assertRaises(core.Rejected):
                await self.live().deliver({**self.probe_task(), **change}, self.scope, self.api)
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM send_budgets").fetchone()[0], 0)

    async def test_probe_metadata_cannot_be_added_to_historical_text_digest(self):
        import hashlib
        task = self.probe_task()
        del task["button_probe"]
        worker = self.live()
        await worker.deliver(task, self.scope, self.api)
        expected = hashlib.sha256(core.canonical_json({**self.scope.wire(),
            "delivery_id": task["delivery_id"], "content": task["content"],
            "rendered_content": task["content"], "simulation": False})).hexdigest()
        self.assertEqual(self.journal.db.execute("SELECT digest FROM attempts").fetchone()[0], expected)
        with self.assertRaises(core.Rejected):
            await worker.deliver({**task, "button_probe": True}, self.scope, self.api)
        self.assertEqual(len(self.api.calls), 1)
        self.assertNotIn("button_probe", self.api.calls[0])

    async def test_probe_removing_button_under_same_key_conflicts(self):
        worker, task = self.live(), self.probe_task()
        await worker.deliver(task, self.scope, self.api)
        del task["button_probe"]
        with self.assertRaises(core.Rejected):
            await worker.deliver(task, self.scope, self.api)
        self.assertEqual(len(self.api.calls), 1)

    async def test_probe_digest_binds_actual_fixed_button_payload(self):
        import hashlib
        task = self.probe_task()
        await self.live().deliver(task, self.scope, self.api)
        expected = hashlib.sha256(core.canonical_json({**self.scope.wire(),
            "delivery_id": task["delivery_id"], "content": task["content"],
            "rendered_content": task["content"], "simulation": False,
            "button_probe_payload": sdk.button_probe_payload(task["content"])})).hexdigest()
        self.assertEqual(self.journal.db.execute("SELECT digest FROM attempts").fetchone()[0], expected)

    async def test_probe_unknown_permission_and_partial_receipt_survive_restart_without_resend(self):
        cases = ((MockAPI(error=sdk.ProviderHttpError(400, 40034012)), "unknown"),
                 (MockAPI(error=sdk.ProviderHttpError(400, 40034105)), "permission_denied"),
                 (MockAPI(error=TimeoutError()), "unknown"),
                 (MockAPI({"id": "ordinary"}), "unknown"))
        prior = []
        for index, (api, outcome) in enumerate(cases):
            scope = core.Scope("app", "bot", "probe-group" + str(index))
            worker = self.live()
            worker.allowed.add(scope)
            worker.approved.add(scope)
            task = {**self.probe_task(), **scope.wire()}
            first = await worker.deliver(task, scope, api)
            self.assertEqual(first["outcome"], outcome)
            self.assertEqual(len(api.calls), 1)
            self.assertEqual(self.journal.budget_status(scope, "proactive", 7)["used"], 1)
            self.assertTrue(self.journal.budget_status(scope, "proactive", 7)["paused"])
            prior.append((scope, api, task, first))
        self.journal.close()
        self.journal = sender.Journal(self.path)
        for scope, api, task, first in prior:
            worker = self.live()
            worker.allowed.add(scope)
            worker.approved.add(scope)
            self.assertEqual(await worker.deliver(task, scope, api), first)
            self.assertEqual(len(api.calls), 1)

    async def test_probe_denied_begin_never_invokes_sdk(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        result = await self.live().deliver(self.probe_task(), self.scope, self.api, begin=denied)
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.journal.budget_status(self.scope, "proactive", 7)["used"], 0)

    async def test_integration_management_test_never_carries_real_signup_metadata(self):
        normal = self.probe_task()
        del normal["button_probe"]
        for task in (normal, self.probe_task()):
            for change in ({"signup_code": "7K4M2Q9R"}, {"signup_button": False},
                           {"signup_button": True, "signup_code": "7K4M2Q9R"}):
                with self.subTest(change=change), self.assertRaises(core.Rejected):
                    await self.live().deliver({**task, **change}, self.scope, self.api,
                                             begin=lambda _: self.fail("begin must not run"))
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM send_budgets").fetchone()[0], 0)

    async def test_integration_probe_digest_matches_already_released_payload(self):
        import hashlib
        task = self.probe_task()
        action = {"type": 2, "permission": {"type": 2}, "data": "报名 测试编号 MT 骑士",
                  "enter": False, "reply": False,
                  "unsupport_tips": "客户端不支持按钮时，请勿发送示例指令。"}
        released = {"msg_type": 2, "markdown": {"content": sdk.BUTTON_PROBE_CONTENT},
                    "keyboard": {"content": {"rows": [{"buttons": [{"id": "artzoo_button_probe",
                        "render_data": {"label": "填写报名（测试）", "visited_label": "填写报名（测试）", "style": 1},
                        "action": action}]}]}}}
        first = await self.live().deliver(task, self.scope, self.api)
        expected = hashlib.sha256(core.canonical_json({**self.scope.wire(),
            "delivery_id": task["delivery_id"], "content": task["content"],
            "rendered_content": task["content"], "simulation": False,
            "button_probe_payload": released})).hexdigest()
        self.assertEqual(self.journal.db.execute("SELECT digest FROM attempts").fetchone()[0], expected)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        self.assertEqual(await self.live().deliver(task, self.scope, self.api), first)
        self.assertEqual(len(self.api.calls), 1)

    async def test_permission_denied_is_terminal(self):
        api = MockAPI(error=Forbidden())
        worker = self.live()
        one = await worker.deliver(self.task, self.scope, api, (Forbidden,))
        two = await worker.deliver(self.task, self.scope, api, (Forbidden,))
        self.assertEqual(one["outcome"], "permission_denied")
        self.assertEqual(one, two)
        self.assertEqual(len(api.calls), 1)

    async def test_timeout_and_partial_receipt_unknown_never_resent(self):
        for index, api in enumerate((MockAPI(error=TimeoutError()),
                                    MockAPI({"id": "id-only"}),
                                    MockAPI(error=RuntimeError("unsafe error")))):
            scope = core.Scope("app", "bot", "group" + str(index))
            task = {**self.task, **scope.wire(), "idempotency_key": "key" + str(index)}
            worker = self.live()
            worker.allowed.add(scope)
            worker.approved.add(scope)
            first = await worker.deliver(task, scope, api)
            again = await worker.deliver(task, scope, api)
            self.assertEqual(first["outcome"], "unknown")
            self.assertEqual(first, again)
            self.assertEqual(len(api.calls), 1)

    async def test_concurrent_duplicate_serialized(self):
        worker = self.live()
        results = await asyncio.gather(*(worker.deliver(self.task, self.scope, self.api)
                                         for _ in range(5)))
        self.assertEqual(len(self.api.calls), 1)
        self.assertTrue(all(value == results[0] for value in results))

    async def test_restart_recovers_receipt_without_resend(self):
        await self.live().deliver(self.task, self.scope, self.api)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        result = await self.live().deliver(self.task, self.scope, self.api)
        self.assertEqual(result["outcome"], "sent")
        self.assertEqual(len(self.api.calls), 1)

    async def test_started_record_is_unknown_after_crash(self):
        worker = self.live()
        original = self.journal.finish
        self.journal.finish = lambda *args: (_ for _ in ()).throw(OSError("disk full"))
        with self.assertRaises(OSError):
            await worker.deliver(self.task, self.scope, self.api)
        self.journal.finish = original
        self.assertEqual((await worker.deliver(self.task, self.scope, self.api))["outcome"],
                         "unknown")
        self.assertEqual(len(self.api.calls), 1)

    async def test_changed_content_under_same_key_rejected(self):
        worker = self.live()
        await worker.deliver(self.task, self.scope, self.api)
        with self.assertRaises(core.Rejected):
            await worker.deliver({**self.task, "content": "different"}, self.scope, self.api)
        self.assertEqual(len(self.api.calls), 1)

    async def test_cross_group_app_bot_rejected(self):
        worker = self.live()
        for key in ("app_id", "bot_id", "group_openid"):
            with self.assertRaises(core.Rejected):
                await worker.deliver({**self.task, key: "other"}, self.scope, self.api)
        self.assertFalse(self.api.calls)

    async def test_invalid_claim_never_sent(self):
        worker = self.live()
        for change in ({"msg_seq": True}, {"msg_seq": 0},
                       {"content": ""}, {"claim_token": ""}):
            with self.subTest(change=change), self.assertRaises(core.Rejected):
                await worker.deliver({**self.task, **change}, self.scope, self.api)
        self.assertFalse(self.api.calls)

    async def test_restart_preserves_rate_limit(self):
        await self.live(per_minute=1).deliver(self.task, self.scope, self.api)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        with self.assertRaises(core.Rejected):
            await self.live(per_minute=1).deliver(
                {**self.task, "delivery_id": "second", "idempotency_key": "second"},
                self.scope, self.api)
        self.assertEqual(len(self.api.calls), 1)

    async def test_begin_denied_definitely_does_not_send(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        result = await self.live().deliver(self.task, self.scope, self.api, begin=denied)
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(self.api.calls, [])

    async def test_begin_timeout_unknown_never_sends_or_rebegins(self):
        calls = []
        async def uncertain(body):
            calls.append(body)
            raise TimeoutError()
        worker = self.live()
        first = await worker.deliver(self.task, self.scope, self.api, begin=uncertain)
        again = await worker.deliver(self.task, self.scope, self.api, begin=uncertain)
        self.assertEqual(first["outcome"], "unknown")
        self.assertEqual(first, again)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.api.calls, [])

    async def test_begin_can_only_force_simulation(self):
        async def simulated(body):
            return {"dispatch": True, "simulation": True}
        result = await self.live().deliver(self.task, self.scope, self.api, begin=simulated)
        self.assertEqual(result["outcome"], "simulated")
        self.assertEqual(self.api.calls, [])

    async def test_ack_survives_restart_and_only_ack_is_retried(self):
        await self.live().deliver(self.task, self.scope, self.api)
        self.journal.close()
        self.journal = sender.Journal(self.path)
        pending = self.journal.pending_acks()
        self.assertEqual(len(pending), 1)
        key, body = pending[0]
        self.assertEqual(body["outcome"], "sent")
        self.assertEqual(body["claim_token"], "claim")
        self.assertEqual(body["ref_idx"], "REFIDX_quote==")
        self.assertNotIn("content", body)
        self.journal.acknowledge(key)
        self.assertEqual(self.journal.pending_acks(), [])
        self.assertEqual(len(self.api.calls), 1)

    async def test_cancelled_send_is_durable_unknown(self):
        class SlowAPI:
            calls = 0
            async def post_group_message(inner, **kwargs):
                inner.calls += 1
                raise asyncio.CancelledError()
        api = SlowAPI()
        worker = self.live()
        with self.assertRaises(asyncio.CancelledError):
            await worker.deliver(self.task, self.scope, api)
        result = await worker.deliver(self.task, self.scope, api)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(api.calls, 1)

    async def test_notice_title_markup_is_visible_without_dropping_valid_notice(self):
        task = {**self.task, "content": "活动 <qqbot-at-all/> @all\x00"}
        result = await self.live().deliver(task, self.scope, self.api)
        self.assertEqual(result["outcome"], "sent")
        self.assertEqual(self.api.calls[0]["content"], "活动 ＜qqbot-at-all/＞ ＠all")

    async def test_persisted_rate_window_eventually_expires(self):
        first = self.live(per_minute=1)
        await first.deliver(self.task, self.scope, self.api)
        second = self.live(per_minute=1)
        second.clock = lambda: 1061
        await second.deliver({**self.task, "delivery_id": "second",
                              "idempotency_key": "second"}, self.scope, self.api)
        self.assertEqual(len(self.api.calls), 2)

    async def test_mode_mismatch_is_rejected_before_begin_or_sdk(self):
        calls = []
        async def begin(body):
            calls.append(body)
            return {"dispatch": True, "simulation": False}
        for mode in (True, None, 0):
            with self.subTest(mode=mode), self.assertRaises(core.Rejected):
                await self.live().deliver({**self.task, "simulation": mode},
                                          self.scope, self.api, begin=begin)
        self.assertEqual(calls, [])
        self.assertEqual(self.api.calls, [])

    async def test_denied_begin_reclaim_survives_restart_and_sends_once_with_new_fence(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        result = await self.live(per_minute=1).deliver(
            self.task, self.scope, self.api, begin=denied)
        self.assertEqual(result["outcome"], "failed")
        row = self.journal.db.execute("SELECT digest,outcome FROM attempts").fetchone()
        self.assertEqual(row[1], sender.SAFE_PRE_SEND)
        pending = self.journal.pending_acks()
        self.assertEqual(pending[0][1]["outcome"], "failed")
        self.journal.acknowledge(pending[0][0])
        self.journal.close()
        self.journal = sender.Journal(self.path)
        reclaimed = {**self.task, "claim_token": "new-claim", "msg_seq": 2}
        result = await self.live(per_minute=1).deliver(reclaimed, self.scope, self.api)
        self.assertEqual(result["outcome"], "sent")
        self.assertEqual(len(self.api.calls), 1)
        self.assertEqual(self.api.calls[0]["msg_seq"], 2)
        self.assertEqual(self.journal.db.execute("SELECT digest FROM attempts").fetchone()[0],
                         row[0])
        pending = self.journal.pending_acks()
        self.assertEqual(pending[0][1]["claim_token"], "new-claim")
        self.assertEqual(pending[0][1]["outcome"], "sent")

    async def test_safe_pre_send_still_rejects_changed_immutable_content(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        await self.live().deliver(self.task, self.scope, self.api, begin=denied)
        with self.assertRaises(core.Rejected):
            await self.live().deliver(
                {**self.task, "claim_token": "new-claim", "msg_seq": 2, "content": "changed"},
                self.scope, self.api)
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.journal.db.execute("SELECT outcome FROM attempts").fetchone()[0],
                         sender.SAFE_PRE_SEND)

    async def test_uncertain_begin_reclaim_never_rebegins_or_sends(self):
        calls = []
        async def uncertain(body):
            calls.append(body)
            raise TimeoutError()
        await self.live().deliver(self.task, self.scope, self.api, begin=uncertain)
        result = await self.live().deliver(
            {**self.task, "claim_token": "new-claim", "msg_seq": 2},
            self.scope, self.api, begin=uncertain)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.api.calls, [])

    async def test_begun_unknown_reclaim_never_sends_twice(self):
        api = MockAPI(error=TimeoutError())
        begin_calls = []
        async def begun(body):
            begin_calls.append(body)
            return {"dispatch": True, "simulation": False}
        await self.live().deliver(self.task, self.scope, api, begin=begun)
        result = await self.live().deliver(
            {**self.task, "claim_token": "new-claim", "msg_seq": 2},
            self.scope, api, begin=begun)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(begin_calls), 1)
        self.assertEqual(len(api.calls), 1)

    async def test_started_after_receipt_disk_failure_reclaim_never_sends_twice(self):
        finish = self.journal.finish
        self.journal.finish = lambda *args: (_ for _ in ()).throw(OSError("disk full"))
        with self.assertRaises(OSError):
            await self.live().deliver(self.task, self.scope, self.api)
        self.journal.finish = finish
        result = await self.live().deliver(
            {**self.task, "claim_token": "new-claim", "msg_seq": 2},
            self.scope, self.api)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(self.api.calls), 1)

    async def test_sent_and_permission_denied_reclaimed_fences_never_resend(self):
        for index, (api, outcome) in enumerate(((self.api, "sent"),
                                               (MockAPI(error=Forbidden()), "permission_denied"))):
            task = {**self.task, "idempotency_key": "terminal" + str(index)}
            await self.live().deliver(task, self.scope, api, (Forbidden,))
            result = await self.live().deliver(
                {**task, "claim_token": "new-claim", "msg_seq": 2},
                self.scope, api, (Forbidden,))
            self.assertEqual(result["outcome"], outcome)
            self.assertEqual(len(api.calls), 1)

    async def test_legacy_failed_does_not_gain_safe_retry_permission(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        await self.live().deliver(self.task, self.scope, self.api, begin=denied)
        key = self.journal.db.execute("SELECT delivery_key FROM attempts").fetchone()[0]
        self.journal.finish(key, "failed", {})
        result = await self.live().deliver(
            {**self.task, "claim_token": "new-claim", "msg_seq": 2},
            self.scope, self.api)
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(self.api.calls, [])

    async def test_invalid_denial_response_remains_unknown_not_safe(self):
        async def invalid(body):
            return {"dispatch": False, "simulation": None}
        await self.live().deliver(self.task, self.scope, self.api, begin=invalid)
        self.assertEqual(self.journal.db.execute("SELECT outcome FROM attempts").fetchone()[0],
                         "unknown")
        result = await self.live().deliver(
            {**self.task, "claim_token": "new-claim", "msg_seq": 2}, self.scope, self.api)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(self.api.calls, [])

    async def test_competing_reclaims_of_safe_state_allow_only_one_begin_and_send(self):
        async def denied(body):
            return {"dispatch": False, "simulation": False}
        await self.live().deliver(self.task, self.scope, self.api, begin=denied)
        calls = []
        async def begun(body):
            calls.append(body)
            await asyncio.sleep(0)
            return {"dispatch": True, "simulation": False}
        results = await asyncio.gather(*(
            self.live().deliver({**self.task, "claim_token": "claim-" + str(index),
                                 "msg_seq": index + 2}, self.scope, self.api, begin=begun)
            for index in range(2)))
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.api.calls), 1)
        self.assertEqual(sorted(result["outcome"] for result in results), ["sent", "unknown"])


    async def test_signup_button_only_explicit_true_reaches_constrained_sdk_argument(self):
        task = {**self.task, "signup_code": "7K4M2Q9R", "signup_button": True}
        worker = self.live()
        one = await worker.deliver(task, self.scope, self.api)
        again = await worker.deliver(task, self.scope, self.api)
        self.assertEqual(one, again)
        self.assertEqual(one["outcome"], "sent")
        self.assertEqual(one["ref_idx"], "REFIDX_quote==")
        self.assertEqual(len(self.api.calls), 1)
        self.assertEqual(self.api.calls[0]["signup_code"], "7K4M2Q9R")

    async def test_disabled_button_preserves_old_digest_and_sdk_shape(self):
        import hashlib
        worker = self.live()
        first = await worker.deliver(self.task, self.scope, self.api)
        again = await worker.deliver({**self.task, "signup_code": "7K4M2Q9R", "signup_button": False},
                                     self.scope, self.api)
        self.assertEqual(first, again)
        expected = hashlib.sha256(core.canonical_json({**self.scope.wire(),
            "delivery_id": self.task["delivery_id"], "content": self.task["content"],
            "rendered_content": self.task["content"], "simulation": False})).hexdigest()
        self.assertEqual(self.journal.db.execute("SELECT digest FROM attempts").fetchone()[0], expected)
        self.assertNotIn("signup_code", self.api.calls[0])
        self.assertEqual(len(self.api.calls), 1)

    async def test_changed_button_or_code_under_same_key_is_rejected(self):
        worker = self.live()
        task = {**self.task, "signup_code": "7K4M2Q9R", "signup_button": True}
        await worker.deliver(task, self.scope, self.api)
        for change in ({"signup_code": "Z8Y7X6W5"}, {"signup_button": False}):
            with self.subTest(change=change), self.assertRaises(core.Rejected):
                await worker.deliver({**task, **change}, self.scope, self.api)
        self.assertEqual(len(self.api.calls), 1)

    async def test_button_cannot_be_added_to_a_previously_text_only_attempt(self):
        worker = self.live()
        await worker.deliver(self.task, self.scope, self.api)
        with self.assertRaises(core.Rejected):
            await worker.deliver({**self.task, "signup_code": "7K4M2Q9R", "signup_button": True},
                                 self.scope, self.api)
        self.assertEqual(len(self.api.calls), 1)

    async def test_invalid_button_metadata_rejected_before_budget_or_sdk(self):
        invalid = ({"signup_button": True}, {"signup_button": 1}, {"signup_button": "true"},
                   {"signup_button": None}, {"signup_code": None}, {"signup_code": "7k4m2q9r"},
                   {"signup_code": "7K4M2Q9I", "signup_button": False},
                   {"signup_code": "7K4M2Q9R", "signup_button": True})
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(core.Rejected):
                await self.live().deliver({**self.task, **change}, self.scope, self.api)
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM attempts").fetchone()[0], 0)
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM send_budgets").fetchone()[0], 0)

    async def test_button_unknown_permission_and_partial_receipt_are_never_resent(self):
        sdk = importlib.import_module("plugins.astrbot_plugin_artzoo.sdk")
        cases = ((MockAPI(error=sdk.ProviderHttpError(400, 40034012)), "unknown"),
                 (MockAPI(error=sdk.ProviderHttpError(400, 40034105)), "permission_denied"),
                 (MockAPI(error=TimeoutError()), "unknown"),
                 (MockAPI({"id": "ordinary"}), "unknown"))
        for index, (api, outcome) in enumerate(cases):
            scope = core.Scope("app", "bot", "button-group" + str(index))
            worker = self.live()
            worker.allowed.add(scope)
            worker.approved.add(scope)
            task = {**self.task, **scope.wire(), "signup_code": "7K4M2Q9R", "signup_button": True}
            with self.subTest(outcome=outcome):
                first = await worker.deliver(task, scope, api)
                again = await worker.deliver(task, scope, api)
                self.assertEqual(first, again)
                self.assertEqual(first["outcome"], outcome)
                self.assertEqual(len(api.calls), 1)
                self.assertIn("signup_code", api.calls[0])
                status = self.journal.budget_status(scope, "proactive", 7)
                self.assertEqual(status["used"], 1)

    async def test_button_simulation_never_invokes_sdk(self):
        task = {**self.task, "simulation": True, "signup_code": "7K4M2Q9R", "signup_button": True}
        result = await TestWorker(self.journal, {self.scope}).deliver(task, self.scope, self.api)
        self.assertEqual(result["outcome"], "simulated")
        self.assertEqual(self.api.calls, [])


class ProviderRefusalCodeTests(unittest.TestCase):
    def test_typed_http_refusal_distinct_from_network_unknown(self):
        self.assertTrue(sender.provider_code_40034105(sdk.ProviderHttpError(400, 40034105)))
        for error in [TimeoutError(), ConnectionResetError(), sdk.ProviderHttpError(500, 40034105),
                      sdk.ProviderHttpError(429, 40034100)]:
            self.assertFalse(sender.provider_code_40034105(error))
