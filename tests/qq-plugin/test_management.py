"""Synthetic-only tests: no network bridge, SDK, production config or real messages."""
import asyncio
import copy
import hashlib
import importlib
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import test_runtime as fixtures
Bridge, Event = fixtures.Bridge, fixtures.Event

module = importlib.import_module("plugins.astrbot_plugin_artzoo.management")
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
runtime_module = importlib.import_module("plugins.astrbot_plugin_artzoo.runtime")
sdk = importlib.import_module("plugins.astrbot_plugin_artzoo.sdk")
PREFIX = "/api/qq-official"


def config(**changes):
    value = {"proactivePaused": False,
             "notifications": {key: True for key in module.KINDS},
             "parameters": {"proactivePerMinute": 3, "proactivePerDay": 100,
                            "passivePerUserMinute": 3, "groupPerMinute": 10, "pollSeconds": 10},
             "templates": {**{key: "{event}\n{title}\n{time}\n{location}" for key in module.KINDS},
                           **{key: "提示：{result}" for key in module.REPLIES}}}
    value.update(changes)
    return value


class ManagedBridge(Bridge):
    def __init__(self, scope):
        super().__init__()
        self.mode = False
        self.scope = scope
        self.publication = None
        self.sync_error = False
        self.test_tasks = []
        self.activities = []
        self.response_override = None

    async def post(self, path, body):
        if "/management/" in path:
            self.calls.append((path, copy.deepcopy(body)))
            if path.endswith("/sync"):
                if self.sync_error:
                    raise TimeoutError()
                return copy.deepcopy(self.response_override or
                    {"protocol": 1, "scope": self.scope.wire(), "publication": self.publication})
            if path.endswith("/test-claim"):
                return {"delivery": self.test_tasks.pop(0) if self.test_tasks else None}
            if path.endswith("/test-begin"):
                return {"dispatch": self.dispatch, "simulation": self.mode}
            if path.endswith("/test-ack"):
                if self.fail_ack_once:
                    self.fail_ack_once = False
                    raise TimeoutError()
                return self.ack
        if path.endswith("/claim") and self.activities:
            self.task = self.activities.pop(0)
        return await super().post(path, body)


class ManagementTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixtures.RuntimeTests.setUp
    tearDown = fixtures.RuntimeTests.tearDown

    def runtime(self, **kwargs):
        self.scope = core.Scope("mock_app", "mock_bot", "mock_group")
        if not isinstance(self.bridge, ManagedBridge):
            self.bridge = ManagedBridge(self.scope)
        defaults = dict(operation_mode="production", simulation=False,
                        management_enabled=True, allow_real_send=True,
                        approved_test_groups=["mock_group"], poll_seconds=10, per_day=100)
        defaults.update(kwargs)
        runtime = fixtures.RuntimeTests.runtime(self, **defaults)
        if not hasattr(self, "now"):
            self.now = [1000.0]
        runtime.sender.clock = lambda: self.now[0]
        if runtime.management:
            runtime.management.clock = lambda: self.now[0]
            runtime.management.wall_clock = lambda: self.now[0]
        return runtime

    def publish(self, value=None, version=1):
        value = config() if value is None else value
        self.bridge.publication = {"version": version, "digest": module.config_digest(value),
                                   "config": value}

    def task(self, key="bot-test-00000000-0000-4000-8000-000000000001"):
        return {"delivery_id": key, "claim_token": "mock_claim", "idempotency_key": key,
                "msg_seq": 1, "simulation": False, "content": "合成测试消息"}

    async def test_default_off_and_test_batch_preserve_old_mode(self):
        runtime = self.runtime(management_enabled=False)
        self.assertIsNone(runtime.management)
        await runtime.poll_once()
        self.assertFalse(any("/management/" in path for path, body in self.bridge.calls))
        self.assertIsNone(self.runtime(operation_mode="test_batch", simulation=True, poll_seconds=30).management)

    async def test_apply_and_ack_are_separate_requests(self):
        runtime = self.runtime()
        self.publish()
        await runtime.management.sync()
        first = self.bridge.calls[-1][1]
        self.assertEqual(first["applied_version"], 0)
        self.assertIsNone(first["applied_digest"])
        self.assertEqual(runtime.management.version, 1)
        self.assertEqual((runtime.sender.minute, runtime.sender.day, runtime.sender.user_minute,
                          runtime.sender.group_minute, runtime.settings.poll_seconds), (3,100,3,10,10))
        await runtime.management.sync()
        ack = self.bridge.calls[-1][1]
        self.assertEqual(ack["applied_version"], 1)
        self.assertEqual(ack["applied_digest"], self.bridge.publication["digest"])
        self.assertIsNone(ack["apply_error"])

    async def test_restart_restores_version_but_never_freshness(self):
        runtime = self.runtime()
        self.publish(config(proactivePaused=True))
        await runtime.management.sync()
        restored = self.runtime()
        self.assertEqual(restored.management.version, 1)
        self.assertFalse(restored.management.fresh())
        self.assertFalse(restored.sender.allow_proactive_send)
        with self.assertRaises(core.Rejected):
            await restored.handle(Event())
        self.assertEqual(len(self.api_calls), 0)

    async def test_legacy_reply_templates_preserve_wire_digest_and_restart_with_fixed_results(self):
        runtime = self.runtime()
        value = config()
        for key in module.REPLIES:
            value["templates"][key] = "历史自定义前缀{result}历史后缀"
        digest = module.config_digest(value)
        self.publish(value)
        self.assertTrue(await runtime.management.sync())
        row = self.journal.db.execute(
            "SELECT version,digest,config FROM management_state WHERE scope=?",
            (runtime.management.scope_key,)).fetchone()
        self.assertEqual(row, (1, digest, core.canonical_json(value).decode()))
        restored = self.runtime()
        self.assertEqual(restored.management.config, value)
        self.assertEqual(restored.management.digest, digest)
        self.assertFalse(restored.management.fresh())
        for key in module.REPLIES:
            self.assertEqual(restored.management.render_reply(key, "确定结果{操作结果}"),
                             "确定结果{操作结果}")
        self.assertEqual(self.api_calls, [])

    async def test_new_notice_variables_sync_ack_and_restore_without_wire_rewrite(self):
        runtime = self.runtime()
        value = config()
        value["templates"]["PUBLISHED"] = "{arrangement}|{participationRequirements}"
        value["templates"]["CHANGED"] = "{活动安排}|{参与要求}"
        value["reminders"] = [
            {"id": "new-fields", "minutes": 30, "enabled": True,
             "template": "{活动安排}|{参与要求}"}]
        digest = module.config_digest(value)
        self.publish(value)
        self.assertTrue(await runtime.management.sync())
        self.assertTrue(await runtime.management.sync())
        self.assertEqual(self.bridge.calls[-1][1]["applied_digest"], digest)
        self.assertIsNone(self.bridge.calls[-1][1]["apply_error"])
        restored = self.runtime()
        self.assertEqual(restored.management.config, value)
        self.assertEqual(restored.management.digest, digest)
        self.assertFalse(restored.management.fresh())
        self.assertEqual(self.api_calls, [])

    async def test_monotonic_lease_expires_and_ack_continues_on_network_loss(self):
        runtime = self.runtime()
        await runtime.management.sync()
        self.bridge.sync_error = True
        self.now[0] = 1119
        self.assertFalse(await runtime.management.sync())
        self.assertTrue(runtime.management.fresh())
        self.now[0] = 1120
        await runtime.poll_once()
        self.assertFalse(runtime.management.fresh())
        event = Event()
        with self.assertRaises(core.Rejected):
            await runtime.handle(event)
        self.assertTrue(event.stopped)
        self.assertFalse(any(path.endswith("/commands") for path, body in self.bridge.calls))
        self.assertEqual(self.api_calls, [])

    async def test_sync_runs_before_pause_quota_and_ack_error(self):
        runtime = self.runtime(allow_proactive_send=False)
        self.journal.db.execute("INSERT INTO direction_pauses VALUES(?,?,?)",
                                (runtime.management.scope_key,"proactive","unknown"))
        self.journal.db.commit()
        self.publish()
        await runtime.poll_once()
        self.assertEqual([path for path,body in self.bridge.calls], [PREFIX+"/management/sync"])
        self.assertFalse(runtime.sender.allow_proactive_send)
        self.journal.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,0)",
            ("pending", "hash", "unknown", "{}", 1000,
             json.dumps({**self.scope.wire(),"delivery_id":"old","claim_token":"old","simulation":False})))
        self.journal.db.commit()
        self.bridge.fail_ack_once = True
        self.bridge.calls.clear()
        with self.assertRaises(TimeoutError):
            await runtime.poll_once()
        self.assertEqual([path for path,body in self.bridge.calls],
                         [PREFIX+"/management/sync",PREFIX+"/deliveries/ack"])

    async def test_invalid_protocol_scope_digest_rollback_and_unknown_fields_fail_closed(self):
        runtime = self.runtime()
        self.publish(version=2)
        await runtime.management.sync()
        original = copy.deepcopy(self.bridge.publication)
        for mutation in ("protocol", "scope", "digest", "rollback", "same_version", "extra"):
            response = {"protocol":1,"scope":self.scope.wire(),"publication":copy.deepcopy(original)}
            if mutation == "protocol": response["protocol"] = True
            if mutation == "scope": response["scope"]["group_openid"] = "other"
            if mutation == "digest": response["publication"]["digest"] = "0"*64
            if mutation == "rollback": response["publication"]["version"] = 1
            if mutation == "same_version":
                response["publication"]["config"]["proactivePaused"] = True
                response["publication"]["digest"] = module.config_digest(response["publication"]["config"])
            if mutation == "extra": response["publication"]["config"]["allow_real_send"] = True
            self.bridge.response_override = response
            self.assertFalse(await runtime.management.sync(), mutation)
            self.assertEqual(runtime.management.apply_error, "INVALID_CONFIG", mutation)
            self.assertFalse(runtime.management.fresh(), mutation)
            self.assertEqual(runtime.management.version, 2, mutation)
            self.assertEqual(runtime.sender.day, 100, mutation)
        self.bridge.response_override = None
        self.assertTrue(await runtime.management.sync())
        self.assertIsNone(runtime.management.apply_error)
        self.assertEqual(self.bridge.calls[-1][1]["apply_error"], "INVALID_CONFIG")

    async def test_config_raises_on_bad_types_ranges_tokens_and_unsafe_text(self):
        invalid = []
        for field,value in (("proactivePerMinute",True),("proactivePerDay",101),("pollSeconds",9),
                            ("groupPerMinute",11),("passivePerUserMinute",0)):
            item=config(); item["parameters"][field]=value; invalid.append(item)
        item=config();item["notifications"]["PUBLISHED"]=1;invalid.append(item)
        for template in ("去网站", "{result}{missing}", "{result}{{}}", "{result}<b>",
                         "{result}@all", "{result}HTTPS://bad", "{result}\u200b", "{result}\r", "{result}"+"长"*300):
            item=config();item["templates"]["INVALID"]=template;invalid.append(item)
        for template in ("{event}{title}{secret}", "{event}{title}{time}{result}"):
            item=config();item["templates"]["PUBLISHED"]=template;invalid.append(item)
        for item in invalid:
            with self.assertRaises(core.Rejected):
                module.validate_config(item)
        self.assertEqual(module.validate_config(config()), config())

    async def test_parameter_apply_serializes_with_send_and_does_not_clear_ledger(self):
        runtime=self.runtime()
        self.journal.db.execute("INSERT INTO direction_pauses VALUES(?,?,?)",
            (runtime.management.scope_key,"proactive","provider_40034105"))
        self.journal.db.execute("INSERT INTO send_budgets VALUES(?,?,?,?,?)",
            ("old",runtime.management.scope_key,"proactive",1,999))
        self.journal.db.commit()
        before=list(self.journal.db.execute("SELECT * FROM send_budgets"))
        value=config();value["parameters"]["proactivePerMinute"]=2
        self.publish(value)
        async with runtime.sender.lock:
            pending=asyncio.create_task(runtime.management.sync())
            await asyncio.sleep(0)
            self.assertFalse(pending.done())
        self.assertTrue(await pending)
        self.assertEqual(runtime.sender.minute,2)
        self.assertEqual(list(self.journal.db.execute("SELECT * FROM send_budgets")),before)
        self.assertTrue(self.journal.budget_status(self.scope,"proactive",0,"production")["paused"])
        self.assertFalse(runtime.sender.can_start(self.scope,"proactive"))

    async def test_null_publication_preserves_raw_limits_and_capabilities(self):
        runtime=self.runtime(per_minute=1,per_day=7,allow_proactive_send=False)
        self.assertTrue(await runtime.management.sync())
        self.assertEqual((runtime.sender.minute,runtime.sender.day),(1,7))
        self.assertFalse(runtime.sender.allow_proactive_send)
        self.assertEqual(runtime.settings.allowed,{self.scope})
        self.assertEqual(runtime.settings.approved,{self.scope})

    async def test_local_reply_ignores_legacy_template_and_web_reply_is_not_wrapped(self):
        runtime=self.runtime()
        self.publish()
        await runtime.management.sync()
        await runtime.handle(Event("退出"))
        self.assertEqual(self.api_calls[-1]["content"],"请到网站办理退出或调整报名。")
        self.now[0]+=61
        await runtime.management.sync()
        event=Event();event.message_obj.raw_message.raw_data["id"]="another_event"
        await runtime.handle(event)
        self.assertEqual(self.api_calls[-1]["content"],"已处理")
        self.assertEqual(runtime.management.render_reply("INVALID","<&@安全>"),"＜&＠安全＞")

    async def test_telemetry_uses_real_direction_windows_is_anonymous_and_read_only(self):
        runtime=self.runtime()
        key=runtime.management.scope_key+":reply:private_event"
        self.journal.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,0)",
            (key,"digest","sent",json.dumps({"secret":"not-uploaded"}),990,"{}"))
        self.journal.db.execute("INSERT INTO send_budgets VALUES(?,?,?,?,?)",
            (key,runtime.management.scope_key,"passive",1,990))
        old=runtime.management.scope_key+":pending_private"
        self.journal.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,0)",
            (old,"digest","started","{}",1,"{}"))
        self.journal.db.execute("INSERT INTO send_budgets VALUES(?,?,?,?,?)",
            (old,runtime.management.scope_key,"proactive",1,1))
        self.journal.db.commit()
        before=self.journal.db.total_changes
        telemetry=runtime.management.telemetry()
        self.assertEqual(self.journal.db.total_changes,before)
        self.assertEqual((telemetry["minute_proactive"],telemetry["minute_group"],
                          telemetry["rolling_proactive"]),(1,2,1))
        self.assertEqual(telemetry["reply_outcomes"]["sent"],1)
        raw=json.dumps(telemetry)
        for private in ("private_event","pending_private","not-uploaded","mock_group","mock_bot"):
            self.assertNotIn(private,raw)
        self.assertEqual(telemetry["recent"][0]["eventKey"],hashlib.sha256(key.encode()).hexdigest())
        self.adapter.appid="wrong"
        self.assertFalse(runtime.management.telemetry()["ready"])

    async def test_test_message_uses_existing_capacity_and_its_own_receipt_routes(self):
        runtime=self.runtime()
        self.publish()
        self.bridge.test_tasks=[self.task()]
        self.bridge.activities=[self.task("activity-1"),self.task("activity-2"),self.task("activity-3")]
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls),3)
        self.assertEqual(len(self.bridge.activities),1)
        paths=[path for path,body in self.bridge.calls]
        self.assertEqual(paths.count(PREFIX+"/management/test-claim"),1)
        self.assertEqual(paths.count(PREFIX+"/management/test-begin"),1)
        self.assertEqual(paths.count(PREFIX+"/management/test-ack"),1)
        self.assertEqual(paths.count(PREFIX+"/deliveries/begin"),2)
        self.assertEqual(paths.count(PREFIX+"/deliveries/ack"),2)
        self.assertEqual(runtime.management.telemetry()["rolling_proactive"],3)

    async def test_unknown_test_stays_terminal_and_pauses_without_resend(self):
        runtime=self.runtime()
        self.publish()
        self.bridge.test_tasks=[self.task()]
        async def unknown(**kwargs):
            self.api_calls.append(kwargs)
            raise TimeoutError()
        self.api.post_group_message=unknown
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls),1)
        self.assertTrue(self.journal.budget_status(self.scope,"proactive",0,"production")["paused"])
        self.now[0]+=11
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls),1)
        ack=[body for path,body in self.bridge.calls if path.endswith("/test-ack")]
        self.assertEqual(ack[-1]["outcome"],"unknown")

    async def test_disabled_stale_or_paused_management_never_claims_test(self):
        for options in ({"allow_real_send":False},{"allow_proactive_send":False},{}):
            runtime=self.runtime(**options)
            self.publish(config(proactivePaused=True))
            self.bridge.calls.clear()
            await runtime.poll_once()
            self.assertFalse(any(path.endswith("/test-claim") for path,body in self.bridge.calls))
        self.assertEqual(self.api_calls,[])

    async def test_test_claim_cannot_redirect_scope_or_use_activity_delivery(self):
        runtime=self.runtime()
        self.publish()
        for task in (self.task("activity-not-a-test"),{**self.task(),"group_openid":"other"}):
            self.bridge.test_tasks=[task]
            self.now[0]+=11
            with self.assertRaises(core.Rejected):
                await runtime.poll_once()
        self.assertEqual(self.api_calls,[])

    async def test_long_business_poll_has_independent_sync_heartbeat(self):
        runtime=self.runtime()
        value=config();value["parameters"]["pollSeconds"]=3600
        self.publish(value)
        await runtime.poll_once()
        self.bridge.calls.clear()
        self.now[0]+=60
        await runtime.poll_once()
        self.assertEqual([path for path,body in self.bridge.calls],[PREFIX+"/management/sync"])
        self.assertTrue(runtime.management.fresh())

    async def test_freshness_is_checked_after_begin_network_await(self):
        runtime=self.runtime()
        await runtime.management.sync()
        original=self.bridge.post
        async def delayed(path,body):
            result=await original(path,body)
            if path.endswith("/test-begin"):
                self.now[0]+=120
            return result
        self.bridge.post=delayed
        result=await runtime.sender.deliver({**self.scope.wire(),**self.task()},self.scope,self.api,
            begin=lambda body:runtime.begin_delivery(body,"/management/test-begin"))
        self.assertEqual(result["outcome"],"failed")
        self.assertEqual(self.api_calls,[])


    async def test_cross_runtime_late_response_cannot_roll_back_durable_version(self):
        older=self.runtime()
        newer=self.runtime()
        self.publish(version=2)
        self.assertTrue(await newer.management.sync())
        self.publish(version=1)
        self.assertFalse(await older.management.sync())
        self.assertEqual(older.management.apply_error,"INVALID_CONFIG")
        row=self.journal.db.execute("SELECT version FROM management_state").fetchone()
        self.assertEqual(row[0],2)
        self.publish(version=2)
        self.assertTrue(await older.management.sync())
        self.assertEqual(older.management.version,2)

    async def test_probe_validator_accepts_only_fixed_live_test_and_preserves_legacy(self):
        for malformed in (None, 1, True, [], "not-a-task"):
            with self.subTest(malformed=malformed), self.assertRaises(core.Rejected):
                module.validate_test_delivery(malformed)
        legacy = self.task()
        self.assertEqual(module.validate_test_delivery(legacy), legacy)
        probe = {**legacy, "content": sdk.BUTTON_PROBE_CONTENT, "button_probe": True}
        self.assertEqual(module.validate_test_delivery(probe), probe)
        for changes in ({"button_probe": False}, {"button_probe": 1}, {"button_probe": "true"},
                        {"button_probe": None}, {"content": legacy["content"]},
                        {"content": sdk.BUTTON_PROBE_CONTENT + "\n"},
                        {"content": sdk.BUTTON_PROBE_CONTENT.replace("测试编号", "7K4M2Q9R")},
                        {"delivery_id": "activity-1"}, {"idempotency_key": "activity-1"},
                        {"msg_seq": 2}, {"simulation": True}, {"activityId": "forbidden"}):
            with self.subTest(changes=changes), self.assertRaises(core.Rejected):
                module.validate_test_delivery({**probe, **changes})

    async def test_probe_uses_management_begin_ack_and_original_capacity(self):
        runtime = self.runtime()
        self.publish()
        self.bridge.test_tasks = [{**self.task(), "content": sdk.BUTTON_PROBE_CONTENT, "button_probe": True}]
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls), 1)
        self.assertIs(self.api_calls[0]["button_probe"], True)
        paths = [path for path, body in self.bridge.calls]
        self.assertEqual(paths.count(PREFIX + "/management/test-begin"), 1)
        self.assertEqual(paths.count(PREFIX + "/management/test-ack"), 1)
        self.assertEqual(paths.count(PREFIX + "/deliveries/begin"), 0)
        ack = [body for path, body in self.bridge.calls if path.endswith("/test-ack")][0]
        self.assertEqual(ack["outcome"], "sent")
        self.assertEqual(ack["ref_idx"], "mock_ref==")
        self.assertNotIn("button_probe", ack)
        self.assertEqual(runtime.management.telemetry()["rolling_proactive"], 1)

    async def test_probe_invalid_content_never_calls_begin_or_sdk(self):
        runtime = self.runtime()
        self.publish()
        self.bridge.test_tasks = [{**self.task(), "button_probe": True}]
        with self.assertRaises(core.Rejected):
            await runtime.poll_once()
        self.assertEqual(self.api_calls, [])
        self.assertFalse(any(path.endswith("/test-begin") for path, body in self.bridge.calls))

    async def test_probe_freshness_expiring_during_begin_stops_before_sdk(self):
        runtime = self.runtime()
        await runtime.management.sync()
        original = self.bridge.post
        async def delayed(path, body):
            result = await original(path, body)
            if path.endswith("/test-begin"):
                self.now[0] += 120
            return result
        self.bridge.post = delayed
        task = {**self.scope.wire(), **self.task(), "content": sdk.BUTTON_PROBE_CONTENT, "button_probe": True}
        result = await runtime.sender.deliver(task, self.scope, self.api,
            begin=lambda body: runtime.begin_delivery(body, "/management/test-begin"))
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(self.api_calls, [])

    async def test_probe_unknown_is_terminal_and_keeps_management_receipt_route(self):
        runtime = self.runtime()
        self.publish()
        task = {**self.task(), "content": sdk.BUTTON_PROBE_CONTENT, "button_probe": True}
        self.bridge.test_tasks = [task]
        async def uncertain(**kwargs):
            self.api_calls.append(kwargs)
            raise TimeoutError()
        self.api.post_group_message = uncertain
        await runtime.poll_once()
        self.bridge.test_tasks = [task]
        self.now[0] += 11
        await runtime.poll_once()
        self.assertEqual(len(self.api_calls), 1)
        self.assertTrue(self.journal.budget_status(self.scope, "proactive", 0, "production")["paused"])
        acks = [body for path, body in self.bridge.calls if path.endswith("/test-ack")]
        self.assertEqual(acks[-1]["outcome"], "unknown")

    async def test_test_delivery_requires_exact_namespace_uuid_and_sequence(self):
        for changes in ({"delivery_id":"bot-test-bad"}, {"idempotency_key":"different"},
                        {"msg_seq":True}, {"msg_seq":2}, {"simulation":True}, {"activityId":"forbidden"}):
            with self.assertRaises(core.Rejected):
                module.validate_test_delivery({**self.task(),**changes})

    async def test_control_plane_exception_does_not_suppress_durable_ack(self):
        runtime=self.runtime(allow_proactive_send=False)
        self.journal.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,0)",
            ("pending", "hash", "unknown", "{}", 1000,
             json.dumps({**self.scope.wire(),"delivery_id":"old","claim_token":"old","simulation":False})))
        self.journal.db.commit()
        async def failed_sync():
            raise RuntimeError("synthetic telemetry failure")
        runtime.management.sync=failed_sync
        await runtime.poll_once()
        self.assertEqual([path for path,body in self.bridge.calls],[PREFIX+"/deliveries/ack"])
        self.assertEqual(self.api_calls,[])

    async def test_template_limit_counts_utf16_units_for_astral_characters(self):
        value=config()
        value["templates"]["INVALID"]="😀"*146+"{result}"
        self.assertEqual(module.validate_config(value),value)
        value["templates"]["INVALID"]="😀"*147+"{result}"
        with self.assertRaises(core.Rejected):
            module.validate_config(value)

    async def test_template_tokens_cannot_repeat_in_notice_or_reply(self):
        for key,text in (("INVALID","{result}{result}"),
                         ("PUBLISHED","{event}{title}{time}{title}")):
            value=config();value["templates"][key]=text
            with self.assertRaises(core.Rejected):
                module.validate_config(value)

    async def test_config_limit_uses_utf8_byte_length(self):
        value=config()
        for key in module.KINDS | module.REPLIES:
            tokens="{event}{title}{time}" if key in module.KINDS else "{result}"
            value["templates"][key]=tokens+"长"*(300-len(tokens))
        self.assertGreater(len(core.canonical_json(value)),6500)
        with self.assertRaises(core.Rejected):
            module.validate_config(value)


class ChineseTemplateTests(unittest.TestCase):
    def test_notice_pure_fields_and_optional_variables(self):
        value=config()
        value['templates']['PUBLISHED']='{消息类别}|{活动标题}|{活动时间}|{活动地点}|{副本名称}|{人数信息}|{报名情况}'
        module.validate_config(value)
        value['templates']['PUBLISHED']='用户完全手写'
        module.validate_config(value)
        value['templates']['PUBLISHED']='{地点前缀}'
        with self.assertRaises(core.Rejected): module.validate_config(value)

    def test_reply_dynamic_result_is_mandatory_and_substituted_once(self):
        value=config();value['templates']['BINDING']='{操作结果}'
        module.validate_config(value)
        holder=object.__new__(module.Management);holder.config=value
        self.assertEqual(holder.render_reply('BINDING','真实{操作结果}原值'),'真实{操作结果}原值')
        value['templates']['BINDING']='人为固定成功'
        with self.assertRaises(core.Rejected): module.validate_config(value)

    def test_alias_duplicate_is_rejected(self):
        value=config();value['templates']['PUBLISHED']='{location}{活动地点}'
        with self.assertRaises(core.Rejected): module.validate_config(value)


class DynamicReminderConfigTests(unittest.TestCase):
    def reminder_config(self):
        value=config()
        value["reminders"]=[{"id":"legacy-120","minutes":120,"enabled":True,"template":"{队伍构成}|{空缺席位}"},{"id":"legacy-60","minutes":60,"enabled":True,"template":"{消息类别} {活动标题}"}]
        return value

    def test_old_wire_digest_not_rewritten(self):
        value=config()
        self.assertEqual(module.validate_config(value),value)
        self.assertNotIn("reminders",module.validate_config(value))
        self.assertEqual(module.config_digest(module.validate_config(value)),module.config_digest(value))

    def test_dynamic_zero_and_default_rows_and_pure_variables(self):
        value=self.reminder_config()
        self.assertEqual(module.validate_config(value),value)
        value["reminders"]=[]
        self.assertEqual(module.validate_config(value),value)

    def test_reminder_time_count_identity_and_enabled_boundaries(self):
        good=self.reminder_config()
        for change in ({"minutes":0},{"minutes":10081},{"minutes":True},{"minutes":1.5},{"minutes":None},{"id":"bad:id"},{"enabled":1}):
            value=copy.deepcopy(good)
            value["reminders"][0].update(change)
            with self.assertRaises(core.Rejected):
                module.validate_config(value)
        value=copy.deepcopy(good)
        value["reminders"]=[{**good["reminders"][0],"id":"r"+str(i),"minutes":i+1} for i in range(9)]
        with self.assertRaises(core.Rejected):
            module.validate_config(value)

    def test_disabled_duplicate_minutes_and_duplicate_id_rejected(self):
        for changes in ({"minutes":120,"enabled":False},{"id":"legacy-120"}):
            value=self.reminder_config()
            value["reminders"][1].update(changes)
            with self.assertRaises(core.Rejected):
                module.validate_config(value)

    def test_new_variables_have_no_duplicate_alias_or_protocol_escape(self):
        for template in ("{secret}","{team}{队伍构成}","{vacancies}{空缺席位}","@all","<at>"):
            value=self.reminder_config()
            value["reminders"][0]["template"]=template
            with self.assertRaises(core.Rejected):
                module.validate_config(value)
        value=self.reminder_config()
        value["templates"]["BINDING"]="{队伍构成}"
        with self.assertRaises(core.Rejected):
            module.validate_config(value)


class ArrangementRequirementTemplateTests(unittest.TestCase):
    def test_notice_and_dynamic_reminder_accept_both_new_aliases(self):
        for text in ("{活动安排}|{参与要求}",
                     "{arrangement}|{participationRequirements}"):
            for key in module.KINDS:
                with self.subTest(text=text, key=key):
                    value = config()
                    value["templates"][key] = text
                    value["reminders"] = [
                        {"id": "new-fields", "minutes": 30, "enabled": True,
                         "template": text}]
                    self.assertEqual(module.validate_config(value), value)
                    self.assertEqual(module.config_digest(module.validate_config(value)),
                                     module.config_digest(value))

    def test_duplicate_new_aliases_rejected_in_notice_and_reminder(self):
        for text in ("{arrangement}{活动安排}",
                     "{participationRequirements}{参与要求}",
                     "{活动安排}{活动安排}", "{参与要求}{参与要求}"):
            for target in ("notice", "reminder"):
                with self.subTest(text=text, target=target):
                    value = config()
                    if target == "notice":
                        value["templates"]["PUBLISHED"] = text
                    else:
                        value["reminders"] = [
                            {"id": "duplicate", "minutes": 30, "enabled": True,
                             "template": text}]
                    with self.assertRaises(core.Rejected):
                        module.validate_config(value)

    def test_new_notice_fields_cannot_enter_reply_templates(self):
        for key in module.REPLIES:
            for token in ("活动安排", "参与要求", "arrangement", "participationRequirements"):
                with self.subTest(key=key, token=token):
                    value = config()
                    value["templates"][key] = "{操作结果}{" + token + "}"
                    with self.assertRaises(core.Rejected):
                        module.validate_config(value)

    def test_fixed_result_sanitized_with_or_without_legacy_config(self):
        holder = object.__new__(module.Management)
        for value in (None, config()):
            holder.config = value
            for key in module.REPLIES:
                with self.subTest(configured=value is not None, key=key):
                    self.assertEqual(holder.render_reply(key, "<@结果>\x00{result}"),
                                     "＜＠结果＞{result}")
