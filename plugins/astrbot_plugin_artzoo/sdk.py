"""Narrow qq-botpy 1.2.1 single-attempt adapter; reuses AstrBot authentication."""
from __future__ import annotations

import ast
import asyncio
import json
import logging
import re
import inspect
import hashlib
import textwrap
import string
from importlib.metadata import version

from .core import Rejected, sanitize_qq_text

# SHA256 of ast.dump(ast.parse(dedented_source), include_attributes=False).
# Verified against official qq-botpy v1.2.1 source; no SDK code is vendored.
PINNED_REQUEST_AST_SHA256 = 'cc8bdeea4f8d35c9af97b830da1a465afce806c231875fd8c9e53c08a52aa19e'

def validate_request_source(source: str):
    try:
        actual = ast.dump(ast.parse(textwrap.dedent(source)), include_attributes=False)
    except (SyntaxError, TypeError) as exc:
        raise Rejected("unrecognized_sdk_request") from exc
    if hashlib.sha256(actual.encode()).hexdigest() != PINNED_REQUEST_AST_SHA256:
        raise Rejected("unrecognized_sdk_request")


class ProviderHttpError(RuntimeError):
    """Only numeric status/code survive; never retain response bodies or secrets."""
    def __init__(self, status, code=None):
        self.http_status = status
        self.code = code
        super().__init__("provider_http_error")


async def response_data(response):
    # Both success receipts and failures are bounded. No SDK debug/body logger.
    body = bytearray()
    while len(body) <= 65536:
        chunk = await response.content.read(min(8192, 65537 - len(body)))
        if not chunk:
            break
        body.extend(chunk)
    data = None
    if len(body) <= 65536:
        try:
            data = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            pass
    if not 200 <= response.status < 300:
        code = data.get('code') if isinstance(data, dict) else None
        if isinstance(code, str) and re.fullmatch(r'[0-9]{5,10}', code):
            code = int(code)
        if type(code) is not int or not 10000 <= code <= 9999999999:
            code = None
        logging.getLogger(__name__).warning(
            '[ArtZoo provider] http_status=%d provider_code=%s', response.status, code)
        raise ProviderHttpError(response.status, code)
    if not isinstance(data, dict):
        raise Rejected('invalid_provider_response')
    return data


BUTTON_PROBE_CONTENT = ("【按钮预填测试，不会报名】\n"
                        "点击“填写报名（测试）”仅把示例指令放入输入框。\n"
                        "请勿发送，检查后清空即可。\n"
                        "示例指令：报名 测试编号 MT 骑士。\n"
                        "“测试编号”不可用于任何活动报名。")


def button_probe_payload(content: str) -> dict:
    """Only a fixed, non-registerable probe; no arbitrary actions or real code."""
    if type(content) is not str or content != BUTTON_PROBE_CONTENT:
        raise Rejected("invalid_button_probe_content")
    markdown = "".join("\\" + char if char in string.punctuation else char for char in content)
    return {"msg_type": 2, "markdown": {"content": markdown},
            "keyboard": {"content": {"rows": [{"buttons": [{
                "id": "artzoo_button_probe",
                "render_data": {"label": "填写报名（测试）", "visited_label": "填写报名（测试）", "style": 1},
                "action": {"type": 2, "permission": {"type": 2},
                           "data": "报名 测试编号 MT 骑士", "enter": False, "reply": False,
                           "unsupport_tips": "客户端不支持按钮时，请勿发送示例指令。"}
            }]}]}}}


def validate_signup_code(value):
    if type(value) is not str or not re.fullmatch(r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}", value):
        raise Rejected("invalid_signup_code")
    return value


def signup_button_payload(content: str, signup_code: str) -> dict:
    """Fixed prefill-only command button; never accept arbitrary action payloads."""
    code = validate_signup_code(signup_code)
    text = sanitize_qq_text(content)
    markdown = "".join("\\" + char if char in string.punctuation else char for char in text)
    return {"msg_type": 2, "markdown": {"content": markdown},
            "keyboard": {"content": {"rows": [{"buttons": [{
                "id": "artzoo_signup",
                "render_data": {"label": "填写报名", "visited_label": "填写报名", "style": 1},
                "action": {"type": 2, "permission": {"type": 2},
                           "data": "报名 " + code + " ", "enter": False, "reply": False,
                           "unsupport_tips": "请复制消息中的报名指令，＠机器人发送"}
            }]}]}}}


class SingleAttemptAPI:
    """One HTTP request, using existing verified SDK session/authentication."""
    def __init__(self, client):
        from botpy.http import BotHttp, Route

        if version("qq-botpy") != "1.2.1":
            raise Rejected("unsupported_sdk_version")
        http = client.api._http
        if type(http) is not BotHttp or getattr(http.request, "__func__", None) is not BotHttp.request:
            raise Rejected("unrecognized_sdk_http")
        try:
            validate_request_source(inspect.getsource(BotHttp.request))
        except (OSError, TypeError) as exc:
            raise Rejected("uninspectable_sdk_request") from exc
        self.http, self.route = http, Route

    async def post_group_message(self, *, group_openid, msg_type, content, msg_seq,
                                 msg_id=None, button_probe=None, signup_code=None):
        if msg_type != 0:
            raise Rejected("text_only")
        if button_probe is not None and button_probe is not True:
            raise Rejected("invalid_button_probe")
        if button_probe is not None and signup_code is not None:
            raise Rejected("conflicting_button_metadata")
        if signup_code is not None and msg_id is not None:
            raise Rejected("signup_button_is_not_passive_reply")
        route = self.route("POST", "/v2/groups/{group_openid}/messages",
                           group_openid=group_openid)
        payload = {"content": sanitize_qq_text(content), "msg_type": 0, "msg_seq": msg_seq}
        if button_probe is True:
            if msg_id is not None:
                raise Rejected("button_probe_is_not_passive_reply")
            payload = {**button_probe_payload(content), "msg_seq": msg_seq}
        if signup_code is not None:
            payload = {**signup_button_payload(content, signup_code), "msg_seq": msg_seq}
        if msg_id is not None:
            payload["msg_id"] = msg_id
        # Calling BotHttp.request loses the numeric error body in _handle_response.
        # Reuse its already-validated session/auth/route, with no retry or global patch.
        await self.http.check_session()
        route.is_sandbox = self.http.is_sandbox
        async with asyncio.timeout(self.http.timeout):
            async with self.http._session.request(
                    method=route.method, url=route.url, headers=self.http._headers,
                    json=payload, allow_redirects=False) as response:
                return await response_data(response)
