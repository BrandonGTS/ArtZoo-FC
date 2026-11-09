"""One SDK invocation per durable delivery; ack retries never repeat QQ sends."""
from __future__ import annotations
from dataclasses import dataclass

import asyncio
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path

from .core import Rejected, Scope, canonical_json, identifier, receipt, sanitize_qq_text
from . import production_policy as policy
from .sdk import ProviderHttpError, button_probe_payload, signup_button_payload, validate_signup_code

SAFE_PRE_SEND = "SAFE_PRE_SEND"


def provider_code_40034105(error) -> bool:
    """Inspect bounded primitive error fields only; never log vendor bodies."""
    if isinstance(error, ProviderHttpError):
        return error.http_status == 400 and error.code == 40034105
    def contains(value, depth=0):
        if depth > 4:
            return False
        if type(value) is int:
            return value == 40034105
        if isinstance(value, str):
            return bool(re.search(r"(?<![0-9])40034105(?![0-9])", value[:8192]))
        if isinstance(value, dict):
            return any(contains(value.get(key), depth + 1) for key in
                       ("code", "errcode", "error_code", "message", "msg", "error", "data", "body"))
        return False
    for name in ("code", "errcode", "error_code", "data", "body", "response", "msgs", "message"):
        try:
            if contains(getattr(error, name, None)):
                return True
        except Exception:
            continue
    try:
        return contains(str(error))
    except Exception:
        return False


class Journal:
    """Store receipt and lease metadata only; protect the operator data directory."""
    def __init__(self, path: str | Path):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS attempts(
            delivery_key TEXT PRIMARY KEY, digest TEXT NOT NULL,
            outcome TEXT NOT NULL, receipt TEXT NOT NULL, created REAL NOT NULL,
            ack TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS send_budgets(
            attempt_key TEXT PRIMARY KEY, scope TEXT NOT NULL, direction TEXT NOT NULL,
            charged INTEGER NOT NULL, created REAL NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS direction_pauses(
            scope TEXT NOT NULL, direction TEXT NOT NULL, reason TEXT NOT NULL,
            PRIMARY KEY(scope,direction))""")
        policy.schema(self.db)
        # Serialize the migration snapshot with finish/recover across instances.
        self.db.execute("BEGIN IMMEDIATE")
        # Import older real attempts conservatively; never discard the send journal.
        for key, outcome, created, ack in self.db.execute(
                "SELECT delivery_key,outcome,created,ack FROM attempts").fetchall():
            if outcome in (SAFE_PRE_SEND, "simulated"):
                continue
            try:
                scope_value, index = json.JSONDecoder().raw_decode(key)
                scope_key = canonical_json(Scope(**scope_value).wire()).decode()
                wire = json.loads(ack)
                passive = key[index:].startswith(":reply:")
                if not passive and wire.get("simulation") is not False:
                    continue
                direction = "passive" if passive else "proactive"
                self.db.execute("INSERT OR IGNORE INTO send_budgets VALUES(?,?,?,?,?)",
                                (key, scope_key, direction, 1, created))
                if outcome in ("started", "unknown", "permission_denied") and not policy.resolved_placeholder(self.db,key) and not policy.resolved_provider_refusal(self.db,key) and not (
                        outcome == "started" and passive and policy.owns_pending(self.db,key)):
                    policy.pause(self.db,scope_key,direction,"unknown" if outcome == "started" else outcome)
            except (ValueError, TypeError, Rejected):
                # Unrecognized historical records never grant new send capacity.
                for direction in ("passive", "proactive"):
                    policy.pause(self.db,"*",direction,"unrecognized_history")
        self.db.commit()

    def budget_status(self, scope: Scope, direction: str, maximum: int,
                      operation_mode="test_batch") -> dict:
        if operation_mode not in ("test_batch", "production"):
            raise Rejected("invalid_operation_mode")
        effective_maximum = None if operation_mode == "production" else maximum
        scope_key = canonical_json(scope.wire()).decode()
        used = self.db.execute(
            "SELECT COALESCE(SUM(charged),0) FROM send_budgets WHERE scope=? AND direction=?",
            (scope_key, direction)).fetchone()[0]
        paused = self.db.execute(
            "SELECT reason FROM direction_pauses WHERE scope IN (?, '*') AND direction=? AND reason NOT IN ('resolved_pre_sdk','resolved_provider_refusal')",
            (scope_key, direction)).fetchone()
        return {"used": used, "maximum": effective_maximum, "paused": bool(paused),
                "pause_reason": paused[0] if paused else None,
                "available": not paused and (
                    effective_maximum is None or used < effective_maximum)}

    def budget_available(self, scope: Scope, direction: str, maximum: int,
                         operation_mode="test_batch") -> bool:
        # Production has no lifetime cap; rolling limits remain independently
        # checked at every existing caller/atomic reservation. Never cache pauses.
        if operation_mode == "production":
            scope_key = canonical_json(scope.wire()).decode()
            return not self.db.execute(
                "SELECT 1 FROM direction_pauses WHERE scope IN (?, '*') AND direction=? "
                "AND reason NOT IN ('resolved_pre_sdk','resolved_provider_refusal') LIMIT 1",
                (scope_key, direction)).fetchone()
        return self.budget_status(scope, direction, maximum, operation_mode)["available"]

    def reserve(self, key: str, digest: str, wire: dict | None = None,
                created: float | None = None, budget=None, rolling=None,
                operation_mode="test_batch") -> dict | None:
        with self.db:
            # Claiming a SAFE_PRE_SEND row is atomic across journal connections.
            # No await/network occurs inside this short write transaction.
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute(
                "SELECT digest,outcome,receipt FROM attempts WHERE delivery_key=?",
                (key,)).fetchone()
            if row:
                if row[0] != digest:
                    raise Rejected("delivery_content_changed")
                if row[1] != SAFE_PRE_SEND:
                    # A prior started/unknown/sent/denied/legacy failed state
                    # never grants another begin or SDK call, even with a new fence.
                    if row[1] == "started":
                        self.db.execute("UPDATE attempts SET outcome='unknown' WHERE delivery_key=?",
                                        (key,))
                        prior_budget = self.db.execute(
                            "SELECT scope,direction FROM send_budgets WHERE attempt_key=?",
                            (key,)).fetchone()
                        if prior_budget:
                            policy.pause(self.db,*prior_budget,"unknown")
                    return {"outcome": "unknown" if row[1] == "started" else row[1],
                            **json.loads(row[2])}
                self._reserve_capacity(key, budget, rolling, created, operation_mode)
                # Only a positively denied begin can enter SAFE_PRE_SEND.
                # Replace lease/fence metadata while preserving the immutable hash.
                self.db.execute(
                    "UPDATE attempts SET outcome='started',receipt='{}',created=?,"
                    "ack=?,acknowledged=0 WHERE delivery_key=?",
                    (time.time() if created is None else created,
                     json.dumps(wire or {}), key))
                return None
            self._reserve_capacity(key, budget, rolling, created, operation_mode)
            self.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,0)",
                            (key, digest, "started", "{}", time.time() if created is None else created,
                             json.dumps(wire or {})))
        return None

    def _reserve_capacity(self, key, budget, rolling, created, operation_mode):
        # Called only while reserve holds BEGIN IMMEDIATE, before any ledger
        # mutation: competing connections cannot pass a stale rate snapshot.
        if rolling is not None:
            scope, minute, day = rolling[:3]
            now = time.time() if created is None else created
            available = (policy.capacity(self, scope, budget[1], now, minute, day, rolling[3])
                         if len(rolling) == 4 else self.rate_status(scope, now, minute, day)["available"])
            if not available:
                raise Rejected("rate_limited")
        if budget is not None:
            self._charge(key, *budget, created, operation_mode)

    def _charge(self, key, scope, direction, maximum, created, operation_mode):
        if not self.budget_available(scope, direction, maximum, operation_mode):
            raise Rejected("direction_paused_or_budget_exhausted")
        scope_key = canonical_json(scope.wire()).decode()
        self.db.execute(
            "INSERT INTO send_budgets VALUES(?,?,?,?,?) ON CONFLICT(attempt_key)"
            " DO UPDATE SET charged=1,created=excluded.created",
            (key, scope_key, direction, 1, time.time() if created is None else created))

    def finish(self, key: str, outcome: str, response: dict, pause_reason=None):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            resolution=self.db.execute('SELECT scope,direction FROM provider_refusal_resolutions WHERE attempt_key=?',(key,)).fetchone()
            if resolution:
                self.db.execute('INSERT OR IGNORE INTO provider_resolution_invalidations VALUES(?,?,?)',(key,time.time(),outcome if outcome in ('sent','unknown','permission_denied','started') else 'other'))
                policy.pause(self.db,*resolution,'late_outcome_after_provider_resolution')
                return 'unknown'
            prior=self.db.execute("SELECT state FROM reply_slots WHERE attempt_key=?",(key,)).fetchone()
            if prior and prior[0]=='UNKNOWN':
                self.db.execute("INSERT OR REPLACE INTO reply_late_outcomes VALUES(?,?,?)",(key,outcome,time.time()))
                blocked=self.db.execute('SELECT scope,direction FROM send_budgets WHERE attempt_key=?',(key,)).fetchone()
                if blocked:policy.pause(self.db,*blocked,'late_outcome_after_unknown')
                return "unknown"
            self.db.execute("UPDATE reply_slots SET state=? WHERE attempt_key=? AND state IN ('RESERVED','SENDING')", (outcome.upper(), key))
            self.db.execute("UPDATE attempts SET outcome=?,receipt=? WHERE delivery_key=?",
                            (outcome, json.dumps(response), key))
            if outcome in (SAFE_PRE_SEND, "simulated"):
                self.db.execute("UPDATE send_budgets SET charged=0 WHERE attempt_key=?", (key,))
            if outcome in ("unknown", "permission_denied") or pause_reason:
                row = self.db.execute(
                    "SELECT scope,direction FROM send_budgets WHERE attempt_key=?", (key,)).fetchone()
                if row:
                    policy.pause(self.db,*row,pause_reason or outcome)

    def recent(self, scope: Scope, now: float) -> list[float]:
        scope_key = canonical_json(scope.wire()).decode()
        # Charged actual attempts across both directions; old imported history
        # remains included. Simulation/definite no-SDK denials consume no slot.
        return [row[0] for row in self.db.execute(
            "SELECT created FROM send_budgets WHERE scope=? AND charged=1 AND created>?",
            (scope_key, now - 86400))]

    def rate_status(self, scope: Scope, now: float, per_minute: int, per_day: int) -> dict:
        recent = self.recent(scope, now)
        minute = sum(at > now - 60 for at in recent)
        return {"minute_used": minute, "day_used": len(recent),
                "available": minute < per_minute and len(recent) < per_day}

    def pending_acks(self):
        rows = self.db.execute(
            "SELECT delivery_key,outcome,receipt,ack FROM attempts WHERE acknowledged=0"
        ).fetchall()
        pending = []
        for key, outcome, response, wire in rows:
            payload = json.loads(wire)
            if not payload:
                continue
            if outcome == "started":
                outcome = "unknown"
                self.finish(key, outcome, {})
            # Local safe-retry evidence is never sent as an unknown wire status.
            wire_outcome = "failed" if outcome == SAFE_PRE_SEND else outcome
            pending.append((key, {**payload, "outcome": wire_outcome, **json.loads(response)}))
        return pending

    def acknowledge(self, key):
        with self.db:
            self.db.execute("UPDATE attempts SET acknowledged=1 WHERE delivery_key=?", (key,))

    def close(self):
        self.db.close()


@dataclass(frozen=True)
class ControlReplyPermit:
    scope: Scope
    event_id: str
    content_digest: str
    expires_at: float


class Sender:
    def __init__(self, journal: Journal, allowed: set[Scope], *,
                 simulation: bool = True, allow_real_send: bool = False,
                 approved_test_scopes: set[Scope] | None = None,
                 per_minute: int = 3, per_day: int = 20, timeout: float = 10,
                 clock=time.time, allow_passive_replies=False, allow_proactive_send=False,
                 max_proactive_attempts=0, max_passive_attempts=0,
                 operation_mode="test_batch", group_per_minute=10, passive_per_user_minute=3):
        if not 1 <= group_per_minute <= 10 or not 1 <= passive_per_user_minute <= 10:
            raise Rejected("invalid_production_rate")
        if not 1 <= per_minute <= 10 or not 1 <= per_day <= 100:
            raise Rejected("invalid_rate_limit")
        if not 1 <= timeout <= 30:
            raise Rejected("invalid_timeout")
        if operation_mode not in ("test_batch", "production"):
            raise Rejected("invalid_operation_mode")
        if operation_mode == "production" and simulation is not False:
            raise Rejected("production_requires_live_mode")
        self.operation_mode = operation_mode
        self.group_minute, self.user_minute = group_per_minute, passive_per_user_minute
        self.journal, self.allowed = journal, allowed
        self.simulation, self.allow_real_send = simulation, allow_real_send
        self.approved = approved_test_scopes or set()
        self.minute, self.day, self.timeout, self.clock = per_minute, per_day, timeout, clock
        self.allow_passive_replies = allow_passive_replies is True
        self.allow_proactive_send = allow_proactive_send is True
        for value, maximum in ((max_proactive_attempts, 7), (max_passive_attempts, 11)):
            if type(value) is not int or not 0 <= value <= maximum:
                raise Rejected("invalid_direction_budget")
        self.max_proactive = max_proactive_attempts
        self.max_passive = max_passive_attempts
        self.lock = asyncio.Lock()

    def can_start(self, scope: Scope, direction: str) -> bool:
        if self.operation_mode == "production":
            policy.recover(self.journal, self.clock)
        maximum = self.max_proactive if direction == "proactive" else self.max_passive
        return (scope in self.allowed and scope in self.approved and self.allow_real_send
                and (self.allow_proactive_send if direction == "proactive"
                     else self.allow_passive_replies)
                and self.journal.budget_available(
                    scope, direction, maximum, self.operation_mode)
                and (policy.capacity(self.journal,scope,direction,self.clock(),self.minute,self.day,self.group_minute)
                     if self.operation_mode == "production" else self.journal.rate_status(
                         scope, self.clock(), self.minute, self.day)["available"]))

    async def deliver(self, task: dict, scope: Scope, api, permission_errors=(),
                      begin=None) -> dict:
        """The bridge owns claims/expiry. Invalid tasks never reach QQ."""
        if scope not in self.allowed:
            raise Rejected("scope_not_allowlisted")
        if any(task.get(key) != value for key, value in scope.wire().items()):
            raise Rejected("delivery_scope_mismatch")
        delivery_id = identifier(task.get("delivery_id"), "delivery_id")
        claim_token = identifier(task.get("claim_token"), "claim_token")
        idempotency = identifier(task.get("idempotency_key"), "idempotency_key")
        content = sanitize_qq_text(task.get("content"))
        probe = "button_probe" in task
        if delivery_id.startswith("bot-test-") and ("signup_code" in task or "signup_button" in task):
            raise Rejected("signup_metadata_is_not_management_test")
        button_enabled = task.get("signup_button", False)
        if type(button_enabled) is not bool:
            raise Rejected("invalid_signup_button")
        signup_code = validate_signup_code(task["signup_code"]) if "signup_code" in task else None
        if button_enabled and signup_code is None:
            raise Rejected("signup_button_requires_code")
        button = signup_button_payload(content, signup_code) if button_enabled else None
        if probe:
            # Reuse the management-only exact test namespace/sequence/mode gate.
            # Ordinary activity tasks cannot opt into Markdown or arbitrary data.
            from .management import validate_test_delivery
            validate_test_delivery({key: value for key, value in task.items() if key not in scope.wire()})
            button = button_probe_payload(task["content"])
        seq = task.get("msg_seq")
        if not isinstance(content, str) or not content.strip() or len(content) > 1800:
            raise Rejected("invalid_content")
        if type(seq) is not int or not 1 <= seq <= 10000:
            raise Rejected("invalid_msg_seq")
        if type(task.get("simulation")) is not bool or task["simulation"] != self.simulation:
            raise Rejected("delivery_mode_mismatch")
        simulated = self.simulation
        if not simulated and (not self.allow_real_send or not self.allow_proactive_send
                              or scope not in self.approved):
            raise Rejected("real_send_not_approved")
        wire = {**scope.wire(), "delivery_id": delivery_id, "claim_token": claim_token,
                "simulation": self.simulation}
        key = canonical_json(scope.wire()).decode() + ":" + idempotency
        digest_value = {**scope.wire(), "delivery_id": delivery_id,
                        "content": task["content"], "rendered_content": content,
                        "simulation": simulated}
        # Absent probe metadata preserves every historical text-only digest.
        if button is not None:
            digest_value["button_probe_payload" if probe else "signup_button_payload"] = button
        digest = hashlib.sha256(canonical_json(digest_value)).hexdigest()
        async with self.lock:
            now = self.clock()
            # Potential sends count across restarts. A definite denied begin
            # consumed no QQ send; a safe rearm still checks other attempts.
            prior = self.journal.db.execute(
                "SELECT outcome FROM attempts WHERE delivery_key=?", (key,)).fetchone()
            if not prior or prior[0] == SAFE_PRE_SEND:
                available = (policy.capacity(self.journal,scope,"proactive",now,self.minute,self.day,self.group_minute)
                             if self.operation_mode == "production" else self.journal.rate_status(scope,now,self.minute,self.day)["available"])
                if not available:
                    raise Rejected("rate_limited")
            previous = self.journal.reserve(
                key, digest, wire, self.clock(),
                None if simulated else (scope, "proactive", self.max_proactive),
                rolling=None if simulated else ((scope,self.minute,self.day,self.group_minute) if self.operation_mode == "production" else (scope,self.minute,self.day)),
                operation_mode=self.operation_mode)
            if previous is not None:
                return {**wire, **previous}
            safe_pre_send = False
            pause_reason = None
            try:
                if begin is None:
                    raise Rejected("begin_required")
                decision = await begin({**scope.wire(), "delivery_id": delivery_id,
                                        "claim_token": claim_token,
                                        "simulation": self.simulation})
                if (not isinstance(decision, dict)
                        or type(decision.get("dispatch")) is not bool
                        or type(decision.get("simulation")) is not bool):
                    raise Rejected("invalid_begin_response")
                if decision["dispatch"] is not True:
                    # Positive response + no SDK branch entered: the only safe
                    # state that may retry under a renewed claim/fence.
                    safe_pre_send = True
                    result = {"outcome": "failed"}
                elif simulated or decision["simulation"]:
                    result = {"outcome": "simulated"}
                else:
                    try:
                        if self.operation_mode == "production":
                            with self.journal.db:
                                self.journal.db.execute("BEGIN IMMEDIATE")
                                self.journal.db.execute("UPDATE send_budgets SET created=? WHERE attempt_key=?",(self.clock(),key))
                        async with asyncio.timeout(self.timeout):
                            options = {"button_probe": True} if probe else {"signup_code": signup_code} if button_enabled else {}
                            raw = await api.post_group_message(
                                group_openid=scope.group_openid, msg_type=0,
                                content=content, msg_seq=seq, **options)
                        result = {"outcome": "sent", **receipt(raw)}
                    except Exception as error:
                        if provider_code_40034105(error):
                            pause_reason = "provider_40034105"
                            result = {"outcome": "permission_denied"}
                        elif isinstance(error, permission_errors):
                            result = {"outcome": "permission_denied"}
                        else:
                            raise
            except asyncio.CancelledError:
                self.journal.finish(key, "unknown", {})
                raise
            except Exception:
                # Includes uncertain begin, partial receipt, timeout, 429 and 5xx.
                # An unacknowledged in-flight task is never blindly resent.
                result = {"outcome": "unknown"}
            fields = {key: value for key, value in result.items() if key != "outcome"}
            self.journal.finish(
                key, SAFE_PRE_SEND if safe_pre_send else result["outcome"], fields, pause_reason)
            return {**wire, **result}

    def prepare_reply(self, scope, event_id, member, fingerprint):
        if self.operation_mode != "production" or self.simulation or not self.can_start(scope,"passive"):
            raise Rejected("reply_capacity_unavailable")
        return policy.reserve_reply(self,scope,identifier(event_id,"event_id"),identifier(member,"member_openid"),fingerprint,self.clock)

    def prepare_control_reply(self,scope,event_id,member,fingerprint):
        # Reservation grants no send permission. Only a separately signed one-event permit can send.
        if (self.operation_mode!="production" or self.simulation or not self.allow_real_send
                or not self.allow_passive_replies
                or not self.journal.budget_available(scope,"passive",self.max_passive,self.operation_mode)
                or not policy.capacity(self.journal,scope,"passive",self.clock(),self.minute,self.day,self.group_minute)):
            raise Rejected("reply_capacity_unavailable")
        return policy.reserve_reply(self,scope,identifier(event_id,"event_id"),identifier(member,"member_openid"),fingerprint,self.clock)

    def fail_reply(self,reservation,*,safe_before_sdk=False):
        return policy.fail_reply(self.journal,reservation,safe_before_sdk=safe_before_sdk,now=self.clock)

    async def keep_reply_alive(self,reservation):
        while True:
            await asyncio.sleep(policy.HEARTBEAT_SECONDS)
            if not policy.renew(self.journal,reservation,self.clock):
                return

    async def reply(self, scope: Scope, event_id: str, content: str, api,
                    permission_errors=(), reservation=None, control=None):
        content = sanitize_qq_text(content)
        permitted=(isinstance(control,ControlReplyPermit) and control.scope==scope
                   and control.event_id==event_id and control.expires_at>self.clock()
                   and control.content_digest==hashlib.sha256(content.encode()).hexdigest()
                   and reservation is not None)
        if control is not None and not permitted:
            raise Rejected('invalid_control_reply_permit')
        if (scope not in self.allowed or scope not in self.approved) and not permitted:
            raise Rejected("reply_scope_not_approved")
        if self.simulation:
            return {"outcome": "simulated"}
        if not self.allow_real_send or not self.allow_passive_replies:
            raise Rejected("passive_replies_disabled")
        key = canonical_json(scope.wire()).decode() + ":reply:" + identifier(event_id, "event_id")
        digest = hashlib.sha256(canonical_json({"content": content, "event_id": event_id})).hexdigest()
        async with self.lock:
            if (scope not in self.allowed or scope not in self.approved) and not permitted:
                raise Rejected("reply_scope_not_approved")
            if not self.allow_real_send or not self.allow_passive_replies:
                raise Rejected("passive_replies_disabled")
            if control is not None and control.expires_at<=self.clock():
                raise Rejected('control_reply_permit_expired')
            if self.operation_mode == "production":
                if reservation is None:
                    reservation=self.prepare_reply(scope,event_id,"unknown_member",digest)
                if reservation is None:
                    row=self.journal.db.execute("SELECT outcome FROM attempts WHERE delivery_key=?",(key,)).fetchone()
                    return {"outcome": row[0] if row else "duplicate"}
                policy.start_reply(self.journal,reservation,key,digest,scope,self.clock,self.timeout)
            else:
                prior = self.journal.db.execute(
                    "SELECT 1 FROM attempts WHERE delivery_key=?", (key,)).fetchone()
                if not prior:
                    now = self.clock()
                    recent = self.journal.recent(scope, now)
                    if len(recent) >= self.day or sum(at > now - 60 for at in recent) >= self.minute:
                        raise Rejected("rate_limited")
                previous = self.journal.reserve(
                    key, digest, created=self.clock(),
                    budget=(scope, "passive", self.max_passive),
                    rolling=(scope, self.minute, self.day), operation_mode=self.operation_mode)
                if previous is not None:
                    return previous
            pause_reason = None
            try:
                async with asyncio.timeout(self.timeout):
                    raw = await api.post_group_message(
                        group_openid=scope.group_openid, msg_type=0,
                        content=content, msg_seq=1, msg_id=event_id)
                # Passive reply needs only outcome; do not map it as an activity notice.
                result = {"outcome": "sent"} if isinstance(raw, dict) and raw.get("id") else {
                    "outcome": "unknown"}
            except asyncio.CancelledError:
                self.journal.finish(key, "unknown", {})
                raise
            except Exception as error:
                if provider_code_40034105(error):
                    pause_reason = "provider_40034105"
                    result = {"outcome": "permission_denied"}
                elif isinstance(error, permission_errors):
                    result = {"outcome": "permission_denied"}
                else:
                    result = {"outcome": "unknown"}
            if self.journal.finish(key, result["outcome"], {}, pause_reason) == "unknown":
                return {"outcome":"unknown"}
            return result
