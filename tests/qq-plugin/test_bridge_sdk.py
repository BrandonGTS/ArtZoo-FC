import asyncio
import importlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
bridge = importlib.import_module("plugins.astrbot_plugin_artzoo.bridge")
sdk = importlib.import_module("plugins.astrbot_plugin_artzoo.sdk")


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_signed_exact_raw_body(self):
        calls = []
        def transport(path, body, headers):
            calls.append((path, body, headers))
            self.assertEqual(headers["X-ArtZoo-Signature"],
                             core.sign(b"k" * 32, headers["X-ArtZoo-Timestamp"],
                                       headers["X-ArtZoo-Nonce"], "POST", path, body))
            self.assertEqual(len(headers["X-ArtZoo-Nonce"]), 32)
            self.assertEqual(body, '{"content":"报名","simulation":true}'.encode())
            return b'{"ok":true,"data":{"message":"ok"}}'
        client = bridge.BridgeClient("https://mock.invalid", b"k" * 32, transport=transport)
        self.assertEqual(await client.post(bridge.PREFIX + "/commands",
                                          {"simulation": True, "content": "报名"}),
                         {"message": "ok"})
        self.assertEqual(len(calls), 1)

    async def test_invalid_bridge_response_never_retried(self):
        for raw in (b"bad", b'{"ok":false}', b'{"ok":true,"data":[]}', b"x" * 65537):
            calls = []
            def transport(*args):
                calls.append(args)
                return raw
            client = bridge.BridgeClient("https://mock.invalid", b"k" * 32, transport=transport)
            with self.assertRaises(core.Rejected):
                await client.post(bridge.PREFIX + "/commands", {})
            self.assertEqual(len(calls), 1)

    async def test_transport_timeout_one_attempt(self):
        calls = []
        def transport(*args):
            calls.append(args)
            raise TimeoutError()
        client = bridge.BridgeClient("https://mock.invalid", b"k" * 32, transport=transport)
        with self.assertRaises(TimeoutError):
            await client.post(bridge.PREFIX + "/commands", {})
        self.assertEqual(len(calls), 1)

    def test_origin_rejects_credentials_path_and_unapproved_http(self):
        for url in ("http://example.invalid", "http://127.0.0.1:3333",
                    "https://user:pass@example.invalid", "https://example.invalid/api",
                    "https://example.invalid?secret=x", "file:///tmp/test"):
            with self.subTest(url=url), self.assertRaises(core.Rejected):
                bridge.BridgeClient(url, b"k" * 32)
        client = bridge.BridgeClient("http://127.0.0.1:3333", b"k" * 32,
                                     allow_loopback_http=True)
        self.assertEqual(client.origin, "http://127.0.0.1:3333")

    async def test_unrecognized_path_never_reaches_transport(self):
        client = bridge.BridgeClient("https://mock.invalid", b"k" * 32,
                                     transport=lambda *args: self.fail("transport called"))
        with self.assertRaises(core.Rejected):
            await client.post("/other", {})

    def test_redirect_refused(self):
        with self.assertRaises(core.Rejected):
            bridge.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid")


class Response:
    def __init__(self, status=200, data=None, raw=None, error=None):
        self.status = status
        self.raw = bytearray(raw if raw is not None else json.dumps(data).encode())
        self.content = self
        self.error = error
    async def read(self, count):
        if self.error: raise self.error
        chunk = bytes(self.raw[:min(count, 7)])
        del self.raw[:len(chunk)]
        return chunk
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False


class Http:
    def __init__(self, response):
        self.response = response
        self.calls = []
        self.checks = 0
        self.timeout = 1
        self.is_sandbox = False
        self._headers = {'Authorization': 'PUBLIC_FAKE_CREDENTIAL'}
        self._session = self
    async def check_session(self): self.checks += 1
    def request(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class SDKTests(unittest.IsolatedAsyncioTestCase):
    def adapter(self, http):
        instance = sdk.SingleAttemptAPI.__new__(sdk.SingleAttemptAPI)
        instance.http = http
        instance.route = lambda method, path, **kw: SimpleNamespace(
            method=method, url='https://mock.invalid/groups/mock/messages')
        return instance

    async def send(self, http):
        return await self.adapter(http).post_group_message(
            group_openid='mock_group', msg_type=0, content='hello', msg_seq=7)

    def test_probe_has_exact_warning_text_and_nonregisterable_fixed_command(self):
        expected = ("【按钮预填测试，不会报名】\n"
                    "点击“填写报名（测试）”仅把示例指令放入输入框。\n"
                    "请勿发送，检查后清空即可。\n"
                    "示例指令：报名 测试编号 MT 骑士。\n"
                    "“测试编号”不可用于任何活动报名。")
        self.assertEqual(sdk.BUTTON_PROBE_CONTENT, expected)
        payload = sdk.button_probe_payload(expected)
        self.assertEqual(payload["markdown"]["content"], expected)
        rows = payload["keyboard"]["content"]["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]["buttons"]), 1)
        button = rows[0]["buttons"][0]
        self.assertEqual(button["render_data"]["label"], "填写报名（测试）")
        self.assertEqual(button["action"], {
            "type": 2, "permission": {"type": 2}, "data": "报名 测试编号 MT 骑士",
            "enter": False, "reply": False,
            "unsupport_tips": "客户端不支持按钮时，请勿发送示例指令。"})

    async def test_integration_mixed_buttons_or_signup_passive_reply_reject_before_session(self):
        for kw in ({"button_probe": True, "signup_code": "7K4M2Q9R"},
                   {"button_probe": False, "signup_code": "7K4M2Q9R"},
                   {"signup_code": "7K4M2Q9R", "msg_id": "passive"}):
            http = Http(Response(data={"id": "unused"}))
            with self.subTest(kw=kw), self.assertRaises(sdk.Rejected):
                await self.adapter(http).post_group_message(group_openid="mock_group", msg_type=0,
                    content=sdk.BUTTON_PROBE_CONTENT, msg_seq=1, **kw)
            self.assertEqual(http.calls, [])
            self.assertEqual(http.checks, 0)

    async def test_probe_single_markdown_request_and_complete_receipt(self):
        data = {"id": "ordinary", "ext_info": {"ref_idx": "REF=="}}
        http = Http(Response(data=data))
        actual = await self.adapter(http).post_group_message(
            group_openid="mock_group", msg_type=0, content=sdk.BUTTON_PROBE_CONTENT,
            msg_seq=1, button_probe=True)
        self.assertEqual(actual, data)
        self.assertEqual(len(http.calls), 1)
        payload = http.calls[0]["json"]
        self.assertEqual(payload["msg_type"], 2)
        self.assertEqual(payload["msg_seq"], 1)
        self.assertNotIn("content", payload)
        self.assertNotIn("msg_id", payload)
        self.assertIs(http.calls[0]["allow_redirects"], False)

    async def test_probe_default_keeps_exact_text_only_payload(self):
        http = Http(Response(data={"id": "ordinary"}))
        await self.send(http)
        self.assertEqual(http.calls[0]["json"], {"content": "hello", "msg_type": 0, "msg_seq": 7})

    async def test_probe_rejects_nontrue_flags_before_session_or_request(self):
        for flag in (False, 1, 0, "true", {}, []):
            with self.subTest(flag=flag):
                http = Http(Response(data={"id": "ordinary"}))
                with self.assertRaises(core.Rejected):
                    await self.adapter(http).post_group_message(
                        group_openid="mock_group", msg_type=0, content=sdk.BUTTON_PROBE_CONTENT,
                        msg_seq=1, button_probe=flag)
                self.assertEqual(http.checks, 0)
                self.assertEqual(http.calls, [])

    async def test_probe_rejects_custom_content_real_code_and_control_aliases(self):
        for content in ("arbitrary", sdk.BUTTON_PROBE_CONTENT + "\x00",
                        sdk.BUTTON_PROBE_CONTENT + "\n", sdk.BUTTON_PROBE_CONTENT.replace("测试编号", "7K4M2Q9R")):
            with self.subTest(content=repr(content)):
                http = Http(Response(data={"id": "ordinary"}))
                with self.assertRaises(core.Rejected):
                    await self.adapter(http).post_group_message(
                        group_openid="mock_group", msg_type=0, content=content,
                        msg_seq=1, button_probe=True)
                self.assertEqual(http.checks, 0)
                self.assertEqual(http.calls, [])

    async def test_probe_cannot_be_a_passive_reply(self):
        http = Http(Response(data={"id": "ordinary"}))
        with self.assertRaises(core.Rejected):
            await self.adapter(http).post_group_message(
                group_openid="mock_group", msg_type=0, content=sdk.BUTTON_PROBE_CONTENT,
                msg_seq=1, msg_id="event", button_probe=True)
        self.assertEqual(http.checks, 0)
        self.assertEqual(http.calls, [])

    async def test_probe_failure_never_retries_or_falls_back_to_text(self):
        for response in (Response(400, {"code": 40034012}), Response(400, {"code": 40034105}),
                         Response(error=TimeoutError()), Response(error=ConnectionResetError())):
            http = Http(response)
            with self.assertRaises((sdk.ProviderHttpError, TimeoutError, ConnectionResetError)):
                await self.adapter(http).post_group_message(
                    group_openid="mock_group", msg_type=0, content=sdk.BUTTON_PROBE_CONTENT,
                    msg_seq=1, button_probe=True)
            self.assertEqual(len(http.calls), 1)
            self.assertEqual(http.calls[0]["json"]["msg_type"], 2)

    async def test_one_attempt_on_reset_timeout_and_no_redirect(self):
        for error in [ConnectionResetError(), TimeoutError()]:
            http = Http(Response(error=error))
            with self.assertRaises(type(error)): await self.send(http)
            self.assertEqual(len(http.calls), 1)
            self.assertIs(http.calls[0]['allow_redirects'], False)
            self.assertEqual(http.checks, 1)

    async def test_full_receipt_and_passive_id_preserved(self):
        data = {'id': 'ordinary', 'ext_info': {'ref_idx': 'REF=='}}
        http = Http(Response(data=data))
        actual = await self.adapter(http).post_group_message(
            group_openid='mock_group', msg_type=0, content='ok', msg_seq=1, msg_id='event')
        self.assertEqual(actual, data)
        self.assertEqual(http.calls[0]['json']['msg_id'], 'event')
        self.assertEqual(len(http.calls), 1)

    async def test_numeric_permission_refusal_survives_without_raw_message(self):
        for code in [40034105, '40034105']:
            http = Http(Response(400, {'code': code, 'message': 'PRIVATE_BODY_SENTINEL'}))
            with self.assertLogs(sdk.__name__, level='WARNING') as logs:
                with self.assertRaises(sdk.ProviderHttpError) as ctx: await self.send(http)
            self.assertEqual(ctx.exception.http_status, 400)
            self.assertEqual(ctx.exception.code, 40034105)
            self.assertNotIn('PRIVATE_BODY_SENTINEL', str(ctx.exception.__dict__) + str(ctx.exception) + str(logs.output))
            self.assertNotIn('PUBLIC_FAKE_CREDENTIAL', str(logs.output))
            self.assertEqual(len(http.calls), 1)

    async def test_malformed_large_redirect_and_server_errors_no_retry(self):
        for status, raw in [(400, b'bad'), (500, b'{"code":50000001}'),
                            (302, b'bad'), (429, b'{"code":40034100}'),
                            (400, b'x' * 65537), (400, b'{"code":true}')]:
            http = Http(Response(status, raw=raw))
            with self.assertLogs(sdk.__name__, level='WARNING'):
                with self.assertRaises(sdk.ProviderHttpError): await self.send(http)
            self.assertEqual(len(http.calls), 1)
        for raw in [b'bad', b'x' * 65537, b'[]']:
            with self.assertRaises(core.Rejected): await self.send(Http(Response(raw=raw)))

    def test_unrecognized_implementations_fail_closed(self):
        for source in ('not python !!!',
                       'async def request(self, route, **kwargs):\n return await self.send(route)',
                       'async def request(self, route, retry_time=0):\n return None'):
            with self.subTest(source=source), self.assertRaises(core.Rejected):
                sdk.validate_request_source(source)
        self.assertEqual(sdk.PINNED_REQUEST_AST_SHA256,
                         'cc8bdeea4f8d35c9af97b830da1a465afce806c231875fd8c9e53c08a52aa19e')


    async def test_button_opt_in_has_one_prefill_only_command_and_full_receipt(self):
        data = {"id": "ordinary", "ext_info": {"ref_idx": "REF=="}}
        http = Http(Response(data=data))
        result = await self.adapter(http).post_group_message(
            group_openid="mock_group", msg_type=0, content="活动\n报名 7K4M2Q9R MT 骑士",
            msg_seq=7, signup_code="7K4M2Q9R")
        self.assertEqual(result, data)
        self.assertEqual(len(http.calls), 1)
        payload = http.calls[0]["json"]
        self.assertEqual(payload["msg_type"], 2)
        self.assertEqual(payload["msg_seq"], 7)
        self.assertNotIn("content", payload)
        self.assertEqual(payload["markdown"]["content"], "活动\n报名 7K4M2Q9R MT 骑士")
        rows = payload["keyboard"]["content"]["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]["buttons"]), 1)
        action = rows[0]["buttons"][0]["action"]
        self.assertEqual(action, {"type": 2, "permission": {"type": 2},
                                  "data": "报名 7K4M2Q9R ", "enter": False, "reply": False,
                                  "unsupport_tips": "请复制消息中的报名指令，＠机器人发送"})
        self.assertIs(http.calls[0]["allow_redirects"], False)

    async def test_button_markdown_escapes_untrusted_text_but_preserves_copy_command(self):
        text = "[链接](https://example.invalid) *加粗* _x_ `cmd` #标题 <qqbot-at-all/> @all\n报名 7K4M2Q9R"
        payload = sdk.signup_button_payload(text, "7K4M2Q9R")
        safe = core.sanitize_qq_text(text)
        import string
        expected = "".join("\\" + char if char in string.punctuation else char for char in safe)
        self.assertEqual(payload["markdown"]["content"], expected)
        self.assertIn("\n报名 7K4M2Q9R", expected)
        self.assertNotIn("<qqbot", expected)
        self.assertNotIn("@all", expected)
        self.assertIn("\\[链接\\]\\(", expected)

    async def test_sdk_default_remains_exact_text_only(self):
        http = Http(Response(data={"id": "ordinary"}))
        await self.send(http)
        self.assertEqual(http.calls[0]["json"], {"content": "hello", "msg_type": 0, "msg_seq": 7})

    async def test_invalid_button_codes_never_check_session_or_send(self):
        for code in ("7k4m2q9r", "7K4M2Q9", "7K4M2Q9I", "7K4M2Q9R", "7Ｋ4M2Q9R", 123, True, {}):
            with self.subTest(code=code):
                http = Http(Response(data={"id": "ordinary"}))
                with self.assertRaises(core.Rejected):
                    await self.adapter(http).post_group_message(
                        group_openid="mock_group", msg_type=0, content="notice", msg_seq=1,
                        signup_code=code)
                self.assertEqual(http.checks, 0)
                self.assertEqual(http.calls, [])

    async def test_button_permission_or_network_failure_never_falls_back_to_text(self):
        for response in (Response(400, {"code": 40034012}), Response(400, {"code": 40034105}),
                         Response(error=TimeoutError()), Response(error=ConnectionResetError())):
            http = Http(response)
            with self.assertRaises((sdk.ProviderHttpError, TimeoutError, ConnectionResetError)):
                await self.adapter(http).post_group_message(
                    group_openid="mock_group", msg_type=0, content="notice", msg_seq=1,
                    signup_code="7K4M2Q9R")
            self.assertEqual(len(http.calls), 1)
            self.assertEqual(http.calls[0]["json"]["msg_type"], 2)


def metadata_version(text):
    """Parse the project's restricted semver YAML scalar, not source spelling."""
    import re
    values=[]
    for line in text.splitlines():
        if not re.match(r"^version\s*:",line):
            continue
        value=line.split(':',1)[1].strip()
        match=re.fullmatch(r"(?:v(\d+\.\d+\.\d+)|'v(\d+\.\d+\.\d+)'|\"v(\d+\.\d+\.\d+)\")\s*(?:#.*)?",value)
        if not match:
            raise AssertionError('Unexpected metadata version scalar')
        values.append(next(part for part in match.groups() if part is not None))
    if len(values)!=1:
        raise AssertionError('Expected exactly one top-level metadata version')
    return values[0]


class PluginVersionTests(unittest.TestCase):
    def test_metadata_and_telemetry_versions_match(self):
        root = Path(__file__).resolve().parents[2] / "plugins/astrbot_plugin_artzoo"
        management = importlib.import_module("plugins.astrbot_plugin_artzoo.management")
        value = management.PLUGIN_VERSION
        self.assertEqual(metadata_version((root / "metadata.yaml").read_text()), value)

    def test_version_scalar_accepts_yaml_spacing_quotes_and_rejects_changed_or_duplicate_values(self):
        for line in ["version: v0.3.6", "version : 'v0.3.6' # comment", 'version: "v0.3.6"']:
            self.assertEqual(metadata_version(line), "0.3.6")
        self.assertNotEqual(metadata_version("version: v0.3.7"), "0.3.6")
        for text in ["# version: v0.3.6", "version: other", "version: v0.3.6\nversion: v0.3.6"]:
            with self.assertRaises(AssertionError):metadata_version(text)
