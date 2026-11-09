"""Signed bridge client. No redirects, proxy inheritance, retries, or secret logs."""
from __future__ import annotations

import asyncio
import json
import secrets
import time
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .core import Rejected, canonical_json, sign

PREFIX = "/api/qq-official"


class BridgeHttpFailure(Rejected):
    def __init__(self,status,category="HTTP_ERROR",field=None):
        super().__init__("bridge_http_rejected")
        self.status=status if type(status) is int and 400<=status<=599 else None
        allowed={"VALIDATION_ERROR","FORBIDDEN","CONFLICT","RATE_LIMITED","UNAUTHENTICATED","SERVICE_UNAVAILABLE"}
        self.category=category if type(category) is str and category in allowed else "HTTP_ERROR"
        self.field=field if type(field) is str and field in {"event_id","message_idx","event_timestamp","app_id","bot_id","group_openid","sender_openid","content"} else None

def http_failure(error):
    category,field="HTTP_ERROR",None
    try:
        value=json.loads(error.read(8193))
        if type(value) is dict and type(value.get("error")) is dict:
            info=value["error"];category=info.get("code")
            fields=info.get("fieldErrors")
            if type(fields) is dict and len(fields)==1:field=next(iter(fields))
    except Exception:pass
    return BridgeHttpFailure(error.code,category,field)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise Rejected("bridge_redirect_refused")


class BridgeClient:
    def __init__(self, origin: str, secret: bytes, *, timeout: int = 10,
                 allow_loopback_http: bool = False, transport=None):
        parsed = urlsplit(origin)
        if (parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or not parsed.hostname):
            raise Rejected("invalid_bridge_origin")
        loopback = parsed.hostname in ("127.0.0.1", "::1", "localhost")
        if parsed.scheme != "https" and not (
                allow_loopback_http and loopback and parsed.scheme == "http"):
            raise Rejected("bridge_requires_https")
        if len(secret) < 32:
            raise Rejected("bridge_secret_too_short")
        if type(timeout) is not int or not 1 <= timeout <= 30:
            raise Rejected("invalid_bridge_timeout")
        self.origin, self.secret, self.timeout = origin.rstrip("/"), secret, timeout
        self.transport = transport or self._request

    def _request(self, path: str, body: bytes, headers: dict) -> bytes:
        request = Request(self.origin + path, data=body, headers=headers, method="POST")
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=self.timeout) as response:
            if response.status != 200:
                raise Rejected("bridge_http_error")
            data = response.read(65537)
            if len(data) > 65536:
                raise Rejected("bridge_response_too_large")
            return data

    async def post(self, path: str, value: dict) -> dict:
        if path not in (PREFIX + "/commands", PREFIX + "/deliveries/claim",
                        PREFIX + "/deliveries/begin", PREFIX + "/deliveries/ack",
                        PREFIX + "/management/sync", PREFIX + "/management/test-claim",
                        PREFIX + "/management/test-begin", PREFIX + "/management/test-ack",
                        PREFIX + "/group-bindings/proof"):
            raise Rejected("unrecognized_bridge_path")
        body = canonical_json(value)
        if len(body) > 16384:
            raise Rejected("bridge_body_too_large")
        timestamp, nonce = str(int(time.time())), secrets.token_hex(16)
        headers = {"Content-Type": "application/json; charset=utf-8",
                   "X-ArtZoo-Timestamp": timestamp, "X-ArtZoo-Nonce": nonce,
                   "X-ArtZoo-Signature": sign(self.secret, timestamp, nonce, "POST", path, body)}
        # There is exactly one bridge attempt; server idempotency handles event replay.
        try:
            raw = await asyncio.to_thread(self.transport, path, body, headers)
        except HTTPError as error:
            raise http_failure(error) from None
        if not isinstance(raw, bytes) or len(raw) > 65536:
            raise Rejected("invalid_bridge_response")
        try:
            decoded = json.loads(raw)
        except (ValueError, UnicodeError) as exc:
            raise Rejected("invalid_bridge_json") from exc
        if not isinstance(decoded, dict) or decoded.get("ok") is not True:
            raise Rejected("bridge_rejected")
        data = decoded.get("data")
        if not isinstance(data, dict):
            raise Rejected("invalid_bridge_data")
        return data
