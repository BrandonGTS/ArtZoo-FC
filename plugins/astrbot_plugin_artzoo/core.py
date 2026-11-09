"""AstrBot-independent QQ official boundary; never infer a member from private OpenID."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import unicodedata
from datetime import datetime
from dataclasses import dataclass
from typing import Any


class Rejected(ValueError):
    """A deliberately closed boundary; safe reason contains no raw payload."""


def identifier(value: Any, name: str, maximum: int = 1024) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise Rejected("invalid_" + name)
    if any(ord(char) < 33 or ord(char) == 127 for char in value):
        raise Rejected("invalid_" + name)
    return value


@dataclass(frozen=True)
class Scope:
    app_id: str
    bot_id: str
    group_openid: str

    def __post_init__(self):
        for name in ("app_id", "bot_id", "group_openid"):
            identifier(getattr(self, name), name)

    def wire(self) -> dict[str, str]:
        return {"app_id": self.app_id, "bot_id": self.bot_id,
                "group_openid": self.group_openid}


def quote_ref(raw: dict, *, required: bool = True) -> str | None:
    """Parse ONLY ref_msg_idx; optional absence never accepts malformed quotes."""
    scene = raw.get("message_scene")
    ext = scene.get("ext") if isinstance(scene, dict) else None
    if not isinstance(ext, list) or any(not isinstance(item, str) for item in ext):
        raise Rejected("missing_or_invalid_quote")
    matches = []
    for item in ext:
        key, separator, value = item.partition("=")
        if key == "ref_msg_idx":
            if not separator:
                raise Rejected("missing_or_invalid_quote")
            matches.append(value)
    if not matches and not required:
        return None
    if len(matches) != 1:
        raise Rejected("missing_or_ambiguous_quote")
    return identifier(matches[0], "ref_idx", 4096)


def receipt(raw: Any) -> dict[str, str]:
    """Ordinary response id and ext_info.ref_idx have distinct meanings."""
    if not isinstance(raw, dict):
        raise Rejected("missing_receipt")
    message_id = identifier(raw.get("id"), "message_id")
    ext = raw.get("ext_info")
    ref_idx = identifier(ext.get("ref_idx") if isinstance(ext, dict) else None,
                         "ref_idx", 4096)
    if message_id == ref_idx:
        raise Rejected("receipt_id_is_not_reference")
    return {"message_id": message_id, "ref_idx": ref_idx}


def parse_command(text: str) -> str | None:
    """Classify only; the website parser determines all registration semantics."""
    if not isinstance(text, str) or not text:
        return None
    normalized = text.strip()
    tokens = normalized.split(None, 1)
    first = tokens[0] if tokens else ""
    relevant = (normalized.startswith("报名") or first in
                ("绑定群", "确认群", "绑定", "确认绑定", "退出", "取消报名", "换职业", "换位置"))
    if not relevant:
        return None
    if len(text) > 512:
        return "invalid"
    if first in ("绑定群","确认群"):
        if re.fullmatch(r"(?:绑定群|确认群)\s+[A-Za-z0-9_-]{12,128}", normalized):
            return "group_bind"
        return "invalid"
    if normalized.startswith("报名"):
        return "register"
    if re.fullmatch(r"(?:绑定|确认绑定)\s+[A-Za-z0-9_-]{8,128}", normalized):
        return "bind"
    if first in ("退出", "取消报名", "换职业", "换位置"):
        return "website_only"
    return "invalid"


def registration_activity_code(text: str) -> str | None:
    """Only a complete first argument can select the explicit-code entry point."""
    tokens = text.split()
    if (len(tokens) >= 2 and tokens[0] == "报名"
            and re.fullmatch(r"[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}", tokens[1],
                             flags=re.IGNORECASE | re.ASCII)):
        return tokens[1].upper()
    return None


def scene_value(raw: dict, key: str) -> str:
    scene = raw.get("message_scene")
    ext = scene.get("ext") if isinstance(scene, dict) else None
    if not isinstance(ext, list) or any(not isinstance(item, str) for item in ext):
        raise Rejected("invalid_scene_ext")
    values = [item.partition("=")[2] for item in ext
              if item.partition("=")[0] == key and "=" in item]
    if len(values) != 1:
        raise Rejected("missing_or_ambiguous_" + key)
    return identifier(values[0], key, 4096)


def command_envelope(raw: Any, text: str, scope: Scope, *, own_mention_ids: tuple[str, ...] = ()) -> dict | None:
    command = parse_command(text)
    if command not in ("register", "bind", "group_bind"):
        return None
    if not isinstance(raw, dict):
        raise Rejected("missing_raw_data")
    if raw.get("group_openid") != scope.group_openid:
        raise Rejected("group_mismatch")
    event_id = identifier(raw.get("id"), "event_id")
    author = raw.get("author")
    sender = identifier(author.get("member_openid") if isinstance(author, dict) else None,
                        "sender_openid")
    timestamp = raw.get("timestamp")
    if not isinstance(timestamp, str) or len(timestamp) > 64:
        raise Rejected("invalid_event_timestamp")
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
    except ValueError as exc:
        raise Rejected("invalid_event_timestamp") from exc
    content = raw.get("content")
    if not isinstance(content, str) or len(content) > 2048:
        raise Rejected("invalid_raw_content")
    if not isinstance(own_mention_ids, tuple) or len(own_mention_ids) > 20:
        raise Rejected("invalid_own_mentions")
    # The official adapter strips native mentions marked is_you. These IDs may
    # differ from both AppID and SDK robot.id, so they are NOT identity aliases.
    # They only authorize removing exact own-bot markup from this native event.
    known = {scope.app_id, scope.bot_id}
    known.update(identifier(value, "own_mention_id", 160) for value in own_mention_ids)
    canonical = content
    for own in sorted(known, key=lambda value: (-len(value), value)):
        escaped = re.escape(own)
        markup = rf'(?:<qqbot-at-user\s+id="{escaped}"\s*/>|<@!?{escaped}>)'
        canonical = re.sub(rf"(?:[ \t]*{markup}[ \t]*)+", " ", canonical)
    canonical = canonical.strip()
    if canonical != text.strip() or parse_command(canonical) != command:
        raise Rejected("normalized_content_mismatch")
    result = {**scope.wire(), "event_id": event_id, "sender_openid": sender,
              "message_idx": scene_value(raw, "msg_idx"),
              "event_timestamp": timestamp, "content": canonical}
    # No direct IDs or private->member mapping. The server resolves the code or
    # exact quote within this same app/bot/group and checks any supplied pair.
    if command == "register":
        code = registration_activity_code(canonical)
        if code is not None:
            result["activity_code"] = code
        reference = quote_ref(raw, required=code is None)
        if reference is not None:
            result["ref_idx"] = reference
    return result


def sanitize_qq_text(text: str) -> str:
    """Text-only QQ payload: render markup/mentions visibly and strip controls."""
    if not isinstance(text, str):
        raise Rejected("invalid_outgoing_text")
    visible = "".join(char for char in text
                      if char == "\n" or not unicodedata.category(char).startswith("C"))
    visible = visible.replace("<", "＜").replace(">", "＞").replace("@", "＠")
    if not visible.strip() or len(visible) > 1800:
        raise Rejected("invalid_outgoing_text")
    return visible


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      sort_keys=True, allow_nan=False).encode("utf-8")


def sign(secret: bytes, timestamp: str, nonce: str, method: str,
         path: str, body: bytes) -> str:
    if len(secret) < 32:
        raise Rejected("bridge_secret_too_short")
    value = "\n".join((timestamp, nonce, method.upper(), path,
                       hashlib.sha256(body).hexdigest()))
    return hmac.new(secret, value.encode(), hashlib.sha256).hexdigest()


class RateLimiter:
    """Local conservative rolling window, enforced again by the server."""
    def __init__(self, per_minute: int = 3, per_day: int = 20, clock=time.time):
        if type(per_minute) is not int or type(per_day) is not int:
            raise Rejected("invalid_rate_limit")
        if not 1 <= per_minute <= 10 or not 1 <= per_day <= 100:
            raise Rejected("invalid_rate_limit")
        self.minute, self.day, self.clock = per_minute, per_day, clock
        self.events: dict[Scope, list[float]] = {}

    def acquire(self, scope: Scope) -> bool:
        now = self.clock()
        items = [at for at in self.events.get(scope, []) if at > now - 86400]
        self.events[scope] = items
        if len(items) >= self.day or sum(at > now - 60 for at in items) >= self.minute:
            return False
        items.append(now)
        return True
