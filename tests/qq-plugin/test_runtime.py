import asyncio
import importlib
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
module = importlib.import_module("plugins.astrbot_plugin_artzoo.runtime")
sender = importlib.import_module("plugins.astrbot_plugin_artzoo.sender")
PREFIX = "/api/qq-official"


class NativeGroup:
    def __init__(self, raw):
        self.raw_data = raw


class Event:
    def __init__(self, text="报名 H1 白魔", raw=None):
        self.text, self.stopped = text, False
        self.message_obj = SimpleNamespace(raw_message=NativeGroup(raw or {
            "id": "mock_event", "group_openid": "mock_group",
            "author": {"member_openid": "mock_member"},
            "content": '<@mock_bot> ' + text, "timestamp": "2026-10-26T12:00:00+08:00",
            "message_scene": {"ext": ["msg_idx=mock_self==", "ref_msg_idx=mock_notice=="]}}))

    def get_platform_id(self):
        return "mock_platform"

    def get_message_str(self):
        return self.text

    def stop_event(self):
        self.stopped = True


class Bridge:
    def __init__(self):
        self.calls, self.task = [], None
        self.dispatch = True
        self.mode = True
        self.ack = {"accepted": True}
        self.fail_ack_once = False

    async def post(self, path, body):
        self.calls.append((path, body))
        if path.endswith("/commands"):
            return {"message": "已处理"}
        if path.endswith("/claim"):
            task, self.task = self.task, None
            return {"delivery": task}
        if path.endswith("/begin"):
            return {"dispatch": self.dispatch, "simulation": self.mode}
        if path.endswith("/ack"):
            if self.fail_ack_once:
                self.fail_ack_once = False
                raise TimeoutError()
            return self.ack
        raise AssertionError(path)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.journal = sender.Journal(Path(self.tmp.name) / "journal.sqlite3")
        self.bridge = Bridge()
        self.adapter = SimpleNamespace(appid="mock_app",
            meta=lambda: SimpleNamespace(name="qq_official"),
            client=SimpleNamespace(robot=SimpleNamespace(id="mock_bot")))
        self.context = SimpleNamespace(get_platform_inst=lambda id: self.adapter)
        self.api_calls = []
        class API:
            async def post_group_message(inner, **kw):
                self.api_calls.append(kw)
                return {"id": "mock_ordinary", "ext_info": {"ref_idx": "mock_ref=="}}
        self.api = API()
        self.config = {"enabled": True, "simulation": True,
                       "allow_proactive_send": True, "allow_passive_replies": True,
                       "max_proactive_attempts": 7, "max_passive_attempts": 11,
                       "platform_id": "mock_platform",
                       "app_id": "mock_app", "bot_id": "mock_bot", "allow_groups": ["mock_group"]}

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def runtime(self, **kwargs):
        config = {**self.config, **kwargs}
        return module.Runtime(module.Settings(config), self.context, self.bridge,
                              self.journal, lambda client: self.api, group_message_type=NativeGroup)

    def delivery(self):
        return {"delivery_id": "mock_delivery", "claim_token": "mock_claim",
                "idempotency_key": "mock_key", "content": "mock notice",
                "msg_seq": 1, "simulation": self.bridge.mode}

    async def test_raw_native_content_verified_then_normalized_before_forwarding(self):
        event = Event()
        self.assertTrue(await self.runtime().handle(event))
        self.assertTrue(event.stopped)
        path, body = self.bridge.calls[0]
        self.assertEqual(path, PREFIX + "/commands")
        self.assertEqual(body["content"], "报名 H1 白魔")
        self.assertEqual(body["sender_openid"], "mock_member")
        self.assertEqual(body["message_idx"], "mock_self==")
        self.assertEqual(body["ref_idx"], "mock_notice==")
        self.assertEqual(body["event_timestamp"], "2026-10-26T12:00:00+08:00")
        self.assertTrue(body["simulation"])
        self.assertEqual(self.api_calls, [])

    async def test_website_only_and_invalid_commands_never_forward(self):
        for text in ("退出", "取消报名", "换职业 白魔", "换位置 H2", "绑定 x",
                     "确认绑定", "报名 " + "x" * 600):
            event = Event(text)
            self.assertTrue(await self.runtime().handle(event), text)
            self.assertTrue(event.stopped)
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.api_calls, [])

    async def test_chat_untouched(self):
        event = Event("今天天气")
        self.assertFalse(await self.runtime().handle(event))
        self.assertFalse(event.stopped)
        self.assertEqual(self.bridge.calls, [])

    async def test_binding_strict_and_no_private_identity_fallback(self):
        event = Event("确认绑定 mock_proof123")
        del event.message_obj.raw_message.raw_data["message_scene"]["ext"][1]
        await self.runtime().handle(event)
        self.assertNotIn("ref_idx", self.bridge.calls[-1][1])
        event = Event("绑定 mock_code123")
        event.message_obj.raw_message.raw_data["author"] = {"user_openid": "mock_private"}
        with self.assertRaises(core.Rejected):
            await self.runtime().handle(event)
        self.assertTrue(event.stopped)

    async def test_missing_quote_rejected_without_model_or_bridge(self):
        event = Event()
        event.message_obj.raw_message.raw_data["message_scene"]["ext"] = ["msg_idx=self"]
        self.assertTrue(await self.runtime().handle(event))
        self.assertTrue(event.stopped)
        self.assertEqual(self.bridge.calls, [])

    async def test_probe_prefill_without_quote_never_reaches_signup_bridge(self):
        event = Event("报名 测试编号 MT 骑士")
        event.message_obj.raw_message.raw_data["message_scene"]["ext"] = ["msg_idx=self"]
        self.assertTrue(await self.runtime().handle(event))
        self.assertTrue(event.stopped)
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.api_calls, [])

    async def test_ordinary_claim_cannot_request_probe_before_begin(self):
        sdk = importlib.import_module("plugins.astrbot_plugin_artzoo.sdk")
        self.bridge.mode = False
        self.bridge.task = {**self.delivery(), "content": sdk.BUTTON_PROBE_CONTENT, "button_probe": True}
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"])
        with self.assertRaises(core.Rejected):
            await runtime.poll_once()
        self.assertEqual(self.api_calls, [])
        self.assertFalse(any(path.endswith("/begin") for path, body in self.bridge.calls))

    async def test_wrong_identity_or_non_group_is_stopped_and_rejected(self):
        for change in ("bot", "app", "private", "raw", "type"):
            event = Event()
            runtime = self.runtime()
            if change == "bot":
                self.adapter.client.robot.id = "other"
            elif change == "app":
                self.adapter.appid = "other"
            elif change == "private":
                event.message_obj.raw_message = SimpleNamespace(raw_data={})
            elif change == "raw":
                event.message_obj.raw_message.raw_data = []
            elif change == "type":
                event.message_obj.raw_message.raw_data["t"] = "C2C_MESSAGE_CREATE"
            with self.subTest(change=change), self.assertRaises(core.Rejected):
                await runtime.handle(event)
            self.assertTrue(event.stopped)
            self.adapter.client.robot.id, self.adapter.appid = "mock_bot", "mock_app"
        self.assertEqual(self.bridge.calls, [])

    async def test_claim_begin_simulated_ack_never_invokes_sdk(self):
        self.bridge.task = self.delivery()
        await self.runtime().poll_once()
        self.assertEqual([path.rsplit("/", 1)[-1] for path, _ in self.bridge.calls],
                         ["claim", "begin", "ack"])
        self.assertEqual(self.bridge.calls[-1][1]["outcome"], "simulated")
        self.assertNotIn("ref_idx", self.bridge.calls[-1][1])
        self.assertEqual(self.api_calls, [])

    async def test_live_mock_transport_captures_receipt_and_ack_retry_only(self):
        self.bridge.mode = False
        self.bridge.task = self.delivery()
        self.bridge.fail_ack_once = True
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"])
        with self.assertRaises(TimeoutError):
            await runtime.poll_once()
        self.assertEqual(len(self.api_calls), 1)
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls), 1)
        acks = [body for path, body in self.bridge.calls if path.endswith("/ack")]
        self.assertEqual(len(acks), 2)
        self.assertEqual(acks[0], acks[1])
        self.assertEqual(acks[0]["ref_idx"], "mock_ref==")
        self.assertFalse(acks[0]["simulation"])

    async def test_claim_button_metadata_passes_through_once_without_changing_management(self):
        self.bridge.mode = False
        self.bridge.task = {**self.delivery(), "signup_code": "7K4M2Q9R", "signup_button": True}
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"])
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls), 1)
        self.assertEqual(self.api_calls[0]["signup_code"], "7K4M2Q9R")
        acks = [body for path, body in self.bridge.calls if path.endswith("/ack")]
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]["outcome"], "sent")
        self.assertEqual(acks[0]["ref_idx"], "mock_ref==")
        self.assertNotIn("signup_code", acks[0])

    async def test_claim_disabled_button_remains_text_only(self):
        self.bridge.mode = False
        self.bridge.task = {**self.delivery(), "signup_code": "7K4M2Q9R", "signup_button": False}
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"])
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls), 1)
        self.assertNotIn("signup_code", self.api_calls[0])
        self.assertEqual(self.api_calls[0]["msg_type"], 0)

    async def test_terminal_stale_ack_stops_retry(self):
        self.bridge.task = self.delivery()
        self.bridge.ack = {"accepted": False, "terminal": True}
        runtime = self.runtime()
        await runtime.poll_once()
        await runtime.poll_once()
        self.assertEqual(len([path for path, _ in self.bridge.calls if path.endswith("/ack")]), 1)

    async def test_unaccepted_nonterminal_ack_stays_pending(self):
        self.bridge.task = self.delivery()
        self.bridge.ack = {"accepted": False}
        runtime = self.runtime()
        with self.assertRaises(core.Rejected):
            await runtime.poll_once()
        self.assertEqual(len(self.journal.pending_acks()), 1)

    async def test_conflicting_task_scope_cannot_redirect(self):
        self.bridge.task = {**self.delivery(), "group_openid": "other_group"}
        with self.assertRaises(core.Rejected):
            await self.runtime().poll_once()
        self.assertEqual(len(self.bridge.calls), 1)
        self.assertEqual(self.api_calls, [])

    def test_default_settings_and_mock_identity_gate(self):
        settings = module.Settings({})
        self.assertFalse(settings.enabled)
        self.assertTrue(settings.simulation)
        self.assertFalse(settings.allow_real_send)
        self.assertEqual(settings.allowed, set())
        for change in ({"bot_id": "qq_official"}, {"app_id": "real_app"},
                       {"allow_groups": ["real_group"]},
                       {"approved_test_groups": ["mock_other"]}):
            with self.subTest(change=change), self.assertRaises(core.Rejected):
                module.Settings({**self.config, **change})

    async def test_unicode_whitespace_commands_stop_before_adapter_and_bridge(self):
        for separator in ("\t", "\n", "\u3000"):
            for text, forwarded in (
                    ("绑定" + separator + "mock_code123", True),
                    ("确认绑定" + separator + "A" * 43, True),
                    ("退出" + separator + "活动", False),
                    ("绑定" + separator, False),
                    ("确认绑定" + separator + "short", False)):
                event = Event(text)
                trace = []
                def adapter_lookup(platform_id):
                    self.assertTrue(event.stopped, "command reached adapter before stop_event")
                    trace.append("adapter")
                    return self.adapter
                async def post(path, body):
                    self.assertTrue(event.stopped, "command reached bridge before stop_event")
                    trace.append("bridge")
                    return {"message": "已处理"}
                self.context.get_platform_inst = adapter_lookup
                runtime = self.runtime()
                runtime.bridge = SimpleNamespace(post=post)
                with self.subTest(separator=repr(separator), text=text):
                    self.assertTrue(await runtime.handle(event))
                    self.assertTrue(event.stopped)
                    self.assertEqual("bridge" in trace, forwarded)

    async def test_proactive_gate_prevents_claim_begin_and_identity_lookup(self):
        runtime = self.runtime(allow_proactive_send=False)
        self.bridge.task = self.delivery()
        self.context.get_platform_inst = lambda value: self.fail("identity lookup not needed")
        await runtime.poll_once()
        self.assertEqual(self.bridge.calls, [])
        self.assertIsNotNone(self.bridge.task)

    async def test_zero_live_budget_prevents_claim_or_sdk_creation(self):
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"], max_proactive_attempts=0)
        runtime.api_factory = lambda client: self.fail("SDK should not be created")
        await runtime.poll_once()
        self.assertEqual(self.bridge.calls, [])

    async def test_passive_flag_off_still_stops_and_handles_website_command(self):
        event = Event()
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               allow_passive_replies=False, approved_test_groups=["mock_group"])
        await runtime.handle(event)
        self.assertTrue(event.stopped)
        self.assertEqual([path for path, _ in self.bridge.calls], [PREFIX + "/commands"])
        self.assertEqual(self.api_calls, [])

    async def test_unknown_proactive_pauses_next_poll_before_claim(self):
        class UnknownAPI:
            async def post_group_message(inner, **kwargs):
                raise TimeoutError()
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"])
        runtime.api_factory = lambda client: UnknownAPI()
        self.bridge.mode = False
        self.bridge.task = self.delivery()
        await runtime.poll_once()
        self.bridge.calls.clear()
        self.bridge.task = {**self.delivery(), "delivery_id": "second", "idempotency_key": "second"}
        await runtime.poll_once()
        self.assertEqual(self.bridge.calls, [])
        self.assertIsNotNone(self.bridge.task)

    def test_diagnostic_status_is_primitive_only_and_does_not_guess_identity(self):
        settings = module.Settings({"diagnostic_mode": True, "enabled": True,
                                    "platform_id": "default", "app_id": "mock_app",
                                    "allow_groups": ["mock_group"]})
        self.adapter.meta = lambda: SimpleNamespace(name="qq_official", id="default")
        self.adapter.client.robot.id = 123456
        result = module.identity_status(settings, self.context)
        self.assertFalse(settings.enabled)
        self.assertEqual(result["actual_bot_id"], "123456")
        self.assertEqual(result["actual_bot_id_type"], "int")
        self.assertFalse(result["bot_matches"])
        self.assertTrue(result["ready"])
        self.assertNotIn("secret", str(result))
        self.assertEqual(self.bridge.calls, [])

    def test_sdk_uint64_identity_is_exact_and_never_float_or_bool_coerced(self):
        value=17501371196166931554
        self.adapter.client.robot.id=value
        runtime=self.runtime(simulation=False, bot_id=str(value))
        self.assertIs(runtime.adapter(), self.adapter)
        runtime.settings.bot_id=str(value+1)
        with self.assertRaises(core.Rejected):runtime.adapter()
        for invalid in (True,False,0,-1,2**64,float(value),object(),None):
            with self.assertRaises(core.Rejected):module.canonical_sdk_bot_id(invalid)
        self.assertEqual(module.canonical_sdk_bot_id(value),str(value))
        self.assertEqual(module.canonical_sdk_bot_id(str(value)),str(value))

    async def test_native_own_mention_identity_is_event_local_not_scope_replacement(self):
        event=Event(text="绑定 Synthetic_binding_001")
        event.message_obj.raw_message.raw_data["content"]='<qqbot-at-user id="native_self_openid"/>  绑定 Synthetic_binding_001'
        event.message_obj.raw_message.mentions=[SimpleNamespace(id="native_self_openid",is_you=True)]
        self.assertTrue(await self.runtime().handle(event))
        body=self.bridge.calls[0][1]
        self.assertEqual(body["content"],"绑定 Synthetic_binding_001")
        self.assertEqual(body["bot_id"],"mock_bot")
        self.assertEqual(self.api_calls,[])

    async def test_production_daily_limit_stops_before_claim(self):
        self.bridge.mode = False
        self.bridge.task = self.delivery()
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"], operation_mode="production",
                               max_proactive_attempts=0, max_passive_attempts=0, per_day=1)
        await runtime.poll_once()
        self.bridge.calls.clear()
        self.bridge.task = {**self.delivery(), "delivery_id": "second", "idempotency_key": "second"}
        await runtime.poll_once()
        self.assertEqual(self.bridge.calls, [])
        self.assertIsNotNone(self.bridge.task)
        self.assertEqual(len(self.api_calls), 1)

    async def test_production_minute_limit_stops_before_claim(self):
        self.bridge.mode = False
        self.bridge.task = self.delivery()
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"], operation_mode="production",
                               max_proactive_attempts=0, max_passive_attempts=0, per_minute=1)
        await runtime.poll_once()
        self.bridge.calls.clear()
        self.bridge.task = {**self.delivery(), "delivery_id": "second", "idempotency_key": "second"}
        await runtime.poll_once()
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(len(self.api_calls), 1)

    async def test_closing_proactive_direction_still_flushes_existing_ack(self):
        self.bridge.mode = False
        self.bridge.task = self.delivery()
        self.bridge.fail_ack_once = True
        runtime = self.runtime(simulation=False, allow_real_send=True,
                               approved_test_groups=["mock_group"], operation_mode="production",
                               max_proactive_attempts=0, max_passive_attempts=0)
        with self.assertRaises(TimeoutError):
            await runtime.poll_once()
        runtime.settings.allow_proactive_send = False
        self.bridge.calls.clear()
        await runtime.poll_once()
        self.assertEqual([path for path, _ in self.bridge.calls], [PREFIX + "/deliveries/ack"])
        self.assertEqual(len(self.api_calls), 1)
