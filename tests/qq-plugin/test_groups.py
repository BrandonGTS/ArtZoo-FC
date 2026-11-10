"""Synthetic signed-group and unknown-group proof tests: no external SDK/network."""
import unittest,copy,hashlib,hmac,json,asyncio
from datetime import datetime,timezone
import test_management as m
import test_runtime as f
from plugins.astrbot_plugin_artzoo import groups,core,sender
from plugins.astrbot_plugin_artzoo.core import canonical_json

SECRET=b"synthetic-group-management-test-only-0000"
def stamp(value):return datetime.fromtimestamp(value,timezone.utc).isoformat().replace("+00:00","Z")
def registry(scope,now,rows,revision=1):
    content={"appId":scope.app_id,"botId":scope.bot_id,"revision":revision,"groups":rows}
    payload={**content,"digest":hashlib.sha256(canonical_json(content)).hexdigest(),"issuedAt":stamp(now),"expiresAt":stamp(now+120)}
    return {**payload,"signature":hmac.new(SECRET,b"ArtZoo-Qq-Groups\n"+canonical_json(payload),hashlib.sha256).hexdigest()}
def row(group,enabled=True):return {"groupOpenId":group,"label":group,"enabled":enabled,"enabledAt":stamp(900) if enabled else None,"generation":1}
class RegistryTests(unittest.TestCase):
    def test_registry_signature_digest_expiry_identity_and_rollback(self):
        scope=core.Scope("mock_app","mock_bot","mock_group")
        good=registry(scope,1000,[row("mock_group"),row("mock_other",False)])
        self.assertEqual(groups.registry_proof(good,scope,SECRET,1000)[2],{scope})
        for change in ({"signature":"0"*64},{"appId":"other"},{"digest":"0"*64},{"revision":0},{"expiresAt":stamp(999)}):
            bad={**good,**change}
            with self.assertRaises(core.Rejected):
                groups.registry_proof(bad,scope,SECRET,1000,1,good["digest"])
        with self.assertRaises(core.Rejected):
            groups.registry_proof(registry(scope,1000,[row("mock_other")]),scope,SECRET,1000,1,good["digest"])
        for rows in ([row("mock_group"),row("mock_group")],[row("mock_"+str(i)) for i in range(21)]):
            with self.assertRaises(core.Rejected):
                groups.registry_proof(registry(scope,1000,rows),scope,SECRET,1000)
class GroupBridge(m.ManagedBridge):
    def __init__(self,scope):
        super().__init__(scope);self.secret=SECRET;self.now=lambda:1000;self.rows=[row("mock_group"),row("mock_other",False)]
        self.bad_control=False;self.group_tasks={};self.fail_group_ack=None
    async def post(self,path,body):
        if path.endswith("/management/sync"):
            response=await super().post(path,body);response["protocol"]=2
            response["groups"]=registry(self.scope,self.now(),self.rows)
            return response
        if path.endswith("/group-bindings/proof"):
            self.calls.append((path,copy.deepcopy(body)))
            message="仅将回复本人这条消息的校验码填回网站：mock_receipt123"
            scope=dict(appId=body["app_id"],botId=body["bot_id"],groupOpenId=body["group_openid"])
            permit={"scope":scope,"eventId":body["event_id"],"messageDigest":hashlib.sha256(message.encode()).hexdigest(),"expiresAt":stamp(self.now()+30)}
            permit["signature"]=hmac.new(SECRET,b"ArtZoo-Qq-Control\n"+canonical_json(permit),hashlib.sha256).hexdigest()
            if self.bad_control:permit["signature"]="0"*64
            return {"challengeAccepted":True,"message":message,"control":permit}
        if path.endswith("/deliveries/claim") and self.group_tasks:
            self.calls.append((path,copy.deepcopy(body)));return {"delivery":self.group_tasks.pop(body["group_openid"],None)}
        if path.endswith("/deliveries/ack") and body.get("group_openid")==self.fail_group_ack:
            raise TimeoutError()
        return await super().post(path,body)
class GroupRuntimeTests(unittest.IsolatedAsyncioTestCase):
    setUp=f.RuntimeTests.setUp
    tearDown=f.RuntimeTests.tearDown
    runtime=m.ManagementTests.runtime
    publish=m.ManagementTests.publish
    def managed(self):
        scope=core.Scope("mock_app","mock_bot","mock_group")
        self.bridge=GroupBridge(scope)
        runtime=self.runtime(managed_groups_enabled=True)
        self.bridge.now=lambda:self.now[0]
        self.publish()
        return runtime
    async def test_signed_registry_updates_actual_sender_and_keeps_disabled_group_out(self):
        runtime=self.managed();await runtime.management.sync()
        self.assertEqual(runtime.settings.allowed,runtime.sender.allowed)
        self.assertNotIn(core.Scope("mock_app","mock_bot","mock_other"),runtime.sender.allowed)
        self.bridge.rows[1]=row("mock_other")
        # Same revision with a different digest is rejected; proper revision follows.
        self.assertFalse(await runtime.management.sync())
        self.assertFalse(runtime.management.fresh())
    async def test_unknown_group_actual_handle_control_reply_no_business_allowlist_or_repeat(self):
        runtime=self.managed();await runtime.management.sync()
        event=f.Event("绑定群 mock_code123456")
        event.message_obj.raw_message.raw_data["group_openid"]="mock_new_group"
        self.assertTrue(await runtime.handle(event));self.assertTrue(event.stopped)
        self.assertEqual(len(self.api_calls),1)
        self.assertEqual(self.api_calls[0]["group_openid"],"mock_new_group")
        unknown=core.Scope("mock_app","mock_bot","mock_new_group")
        self.assertNotIn(unknown,runtime.sender.allowed);self.assertNotIn(unknown,runtime.settings.allowed)
        self.assertFalse(runtime.sender.can_start(unknown,"proactive"))
        self.assertTrue(await runtime.handle(event));self.assertEqual(len(self.api_calls),1)
        signup=f.Event("报名 H1 白魔");signup.message_obj.raw_message.raw_data["group_openid"]="mock_new_group"
        with self.assertRaises(core.Rejected):await runtime.handle(signup)
        self.assertTrue(signup.stopped)
    async def test_invalid_control_signature_never_sends_or_adds_group(self):
        runtime=self.managed();await runtime.management.sync();self.bridge.bad_control=True
        event=f.Event("绑定群 mock_code123456");event.message_obj.raw_message.raw_data["group_openid"]="mock_new_group"
        with self.assertRaises(core.Rejected):await runtime.handle(event)
        self.assertEqual(self.api_calls,[]);self.assertEqual(runtime.sender.allowed,{core.Scope("mock_app","mock_bot","mock_group")})
    async def test_missing_native_identity_and_malformed_challenges_never_call_proof(self):
        runtime=self.managed();await runtime.management.sync()
        event=f.Event("绑定群 mock_code123456");event.message_obj.raw_message.raw_data["author"]={"user_openid":"private"}
        with self.assertRaises(core.Rejected):await runtime.handle(event)
        self.assertFalse(any(p.endswith("/group-bindings/proof") for p,b in self.bridge.calls))
        event=f.Event("绑定群");event.message_obj.raw_message.raw_data["group_openid"]="mock_new_group"
        with self.assertRaises(core.Rejected):await runtime.handle(event)
        self.assertTrue(event.stopped);self.assertEqual(self.api_calls,[])
    async def test_expired_or_wrong_control_permit_cannot_bypass_group_guard(self):
        runtime=self.managed();await runtime.management.sync()
        scope=core.Scope("mock_app","mock_bot","mock_new")
        reservation=runtime.sender.prepare_control_reply(scope,"mock_control","mock_member","1"*64)
        permit=sender.ControlReplyPermit(scope,"mock_control",hashlib.sha256("safe".encode()).hexdigest(),self.now[0]-1)
        with self.assertRaises(core.Rejected):await runtime.sender.reply(scope,"mock_control","safe",self.api,reservation=reservation,control=permit)
        self.assertEqual(self.api_calls,[])
    async def test_one_group_failure_and_ack_failure_do_not_block_other_group(self):
        runtime=self.managed();self.bridge.rows=[row("mock_group"),row("mock_other")]
        for group in ("mock_group","mock_other"):
            self.bridge.group_tasks[group]={"delivery_id":"mock_"+group,"claim_token":"mock_claim","idempotency_key":"mock_key_"+group,"content":"活动","msg_seq":1,"simulation":False}
        base_api=self.api
        class API:
            async def post_group_message(inner,**kwargs):
                if kwargs["group_openid"]=="mock_group":
                    raise TimeoutError()
                return await base_api.post_group_message(**kwargs)
        runtime.api_factory=lambda _:API()
        self.bridge.fail_group_ack="mock_group"
        await runtime.poll_once()
        self.assertEqual([x["group_openid"] for x in self.api_calls],["mock_other"])
        self.assertFalse(runtime.sender.can_start(core.Scope("mock_app","mock_bot","mock_group"),"proactive"))
        self.assertTrue(runtime.sender.can_start(core.Scope("mock_app","mock_bot","mock_other"),"proactive"))


    async def test_waiting_reply_rechecks_removed_group_under_sender_lock(self):
        runtime=self.managed();await runtime.management.sync()
        scope=core.Scope("mock_app","mock_bot","mock_group")
        await runtime.sender.lock.acquire()
        task=asyncio.create_task(runtime.sender.reply(scope,"mock_waiting_reply","safe",self.api))
        await asyncio.sleep(0)
        runtime.sender.allowed=set();runtime.sender.approved=set()
        runtime.sender.lock.release()
        with self.assertRaises(core.Rejected):await task
        self.assertEqual(self.api_calls,[])

    async def test_real_bridge_client_allows_only_exact_signed_group_proof_path(self):
        from plugins.astrbot_plugin_artzoo.bridge import BridgeClient
        runtime=self.managed();await runtime.management.sync();calls=[]
        def transport(path,body,headers):
            calls.append(path)
            self.assertEqual(headers["X-ArtZoo-Signature"],core.sign(SECRET,headers["X-ArtZoo-Timestamp"],headers["X-ArtZoo-Nonce"],"POST",path,body))
            request=json.loads(body);message="本人校验码：mock_receipt123"
            permit={"scope":{"appId":request["app_id"],"botId":request["bot_id"],"groupOpenId":request["group_openid"]},"eventId":request["event_id"],"messageDigest":hashlib.sha256(message.encode()).hexdigest(),"expiresAt":stamp(self.now[0]+30)}
            permit["signature"]=hmac.new(SECRET,b"ArtZoo-Qq-Control\n"+canonical_json(permit),hashlib.sha256).hexdigest()
            return json.dumps({"ok":True,"data":{"challengeAccepted":True,"message":message,"control":permit}}).encode()
        runtime.bridge=BridgeClient("https://example.invalid",SECRET,transport=transport)
        event=f.Event("绑定群 mock_code123456");event.message_obj.raw_message.raw_data["group_openid"]="mock_new_group"
        self.assertTrue(await runtime.handle(event))
        self.assertEqual(calls,["/api/qq-official/group-bindings/proof"])
        self.assertEqual(len(self.api_calls),1)
        with self.assertRaises(core.Rejected):await runtime.bridge.post("/api/qq-official/group-bindings/arbitrary",{})
