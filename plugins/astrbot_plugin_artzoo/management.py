"""Opt-in control plane: bounded config, durable acknowledgement and read-only telemetry."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
import unicodedata
from datetime import datetime, timezone

from .bridge import PREFIX
from .groups import registry_proof
from .core import Rejected, canonical_json, sanitize_qq_text
from .sdk import button_probe_payload

PLUGIN_VERSION = "0.3.6"
FRESH_SECONDS = 120
KINDS = frozenset(("PUBLISHED", "CHANGED", "CANCELLED", "REMINDER_2H", "REMINDER_1H"))
REPLIES = frozenset(("BINDING", "SIGNUP_SUCCESS", "SIGNUP_FAILURE", "INVALID",
                     "WEBSITE_ONLY", "SOURCE_REJECTED", "UNSUPPORTED"))
LIMITS = {"proactivePerMinute": (1, 10), "proactivePerDay": (1, 100),
          "passivePerUserMinute": (1, 10), "groupPerMinute": (1, 10),
          "pollSeconds": (10, 3600)}
OUTCOMES = frozenset(("sent", "unknown", "permission_denied", "simulated", "started", "SAFE_PRE_SEND"))


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise Rejected("invalid_management_config")


def validate_config(value):
    if type(value) is not dict:
        raise Rejected("invalid_management_config")
    exact(value, ("proactivePaused", "notifications", "parameters", "templates", *(("reminders",) if "reminders" in value else ())))
    if type(value["proactivePaused"]) is not bool:
        raise Rejected("invalid_management_config")
    exact(value["notifications"], KINDS)
    if any(type(item) is not bool for item in value["notifications"].values()):
        raise Rejected("invalid_management_config")
    exact(value["parameters"], LIMITS)
    for key, (low, high) in LIMITS.items():
        item = value["parameters"][key]
        if type(item) is not int or not low <= item <= high:
            raise Rejected("invalid_management_config")
    exact(value["templates"], KINDS | REPLIES)
    templates = list(value["templates"].items())
    if "reminders" in value:
        reminders = value["reminders"]
        if type(reminders) is not list or len(reminders) > 8:
            raise Rejected("invalid_management_reminders")
        ids, minutes = set(), set()
        for reminder in reminders:
            exact(reminder, ("id", "minutes", "enabled", "template"))
            identity, lead = reminder["id"], reminder["minutes"]
            if (type(identity) is not str or not re.fullmatch(r"[-A-Za-z0-9]{1,64}", identity)
                    or identity in ids or type(lead) is not int or not 1 <= lead <= 10080
                    or lead in minutes or type(reminder["enabled"]) is not bool):
                raise Rejected("invalid_management_reminders")
            ids.add(identity)
            minutes.add(lead)
            templates.append(("PUBLISHED", reminder["template"]))
    for key, template in templates:
        if (type(template) is not str or not template.strip() or len(template.encode("utf-16-le", errors="surrogatepass")) // 2 > 300
                or any(char in template for char in "<>@")
                or re.search(r"https?://", template, re.IGNORECASE)
                or any(char != "\n" and unicodedata.category(char).startswith("C") for char in template)):
            raise Rejected("invalid_management_template")
        names = re.findall(r"\{([^{}]*)\}", template)
        tokens = set(names)
        if len(tokens) != len(names):
            raise Rejected("invalid_management_template")
        aliases = {"event":"消息类别","title":"活动标题","time":"活动时间","location":"活动地点","duty":"副本名称","capacity":"人数信息","registrations":"报名情况","team":"队伍构成","vacancies":"空缺席位","arrangement":"活动安排","participationRequirements":"参与要求"} if key in KINDS else {"result":"操作结果"}
        names = [aliases.get(name,name) for name in names]
        tokens = set(names)
        if len(tokens) != len(names):
            raise Rejected("invalid_management_template")
        allowed = set(aliases.values())
        required = set() if key in KINDS else {"操作结果"}
        if not required <= tokens <= allowed or re.search(r"[{}]", re.sub(r"\{[^{}]*\}", "", template)):
            raise Rejected("invalid_management_template")
    encoded = canonical_json(value)
    if len(encoded) > 6500:
        raise Rejected("invalid_management_config")
    return json.loads(encoded)


def validate_test_delivery(task):
    exact(task, ("delivery_id", "claim_token", "idempotency_key", "content", "msg_seq", "simulation",
                 *(("button_probe",) if type(task) is dict and "button_probe" in task else ())))
    key = task["delivery_id"]
    if (type(key) is not str or not re.fullmatch(r"bot-test-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", key)
            or task["idempotency_key"] != key or type(task["msg_seq"]) is not int or task["msg_seq"] != 1
            or task["simulation"] is not False):
        raise Rejected("invalid_test_delivery")
    if "button_probe" in task:
        if task["button_probe"] is not True:
            raise Rejected("invalid_button_probe")
        button_probe_payload(task["content"])
    return task


def config_digest(config):
    return hashlib.sha256(canonical_json(config)).hexdigest()


class Management:
    def __init__(self, runtime, scope, *, clock=time.monotonic, wall_clock=time.time):
        self.runtime, self.scope = runtime, scope
        self.clock, self.wall_clock = clock, wall_clock
        self.version, self.digest, self.config = 0, None, None
        self.group_revision, self.group_digest = 0, None
        self.apply_error, self.last_success = None, None
        self.sync_lock = asyncio.Lock()
        db = runtime.journal.db
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS management_state("
                       "scope TEXT PRIMARY KEY,version INTEGER NOT NULL,digest TEXT,config TEXT)")
        if runtime.settings.managed_groups_enabled:
            with db:
                db.execute("CREATE TABLE IF NOT EXISTS management_group_state(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,digest TEXT NOT NULL)")
            prior=db.execute("SELECT revision,digest FROM management_group_state WHERE scope=?",(self.scope_key,)).fetchone()
            if prior:
                self.group_revision,self.group_digest=prior
        row = db.execute("SELECT version,digest,config FROM management_state WHERE scope=?",
                         (self.scope_key,)).fetchone()
        if row:
            try:
                if type(row[0]) is not int or not 1 <= row[0] <= 2147483647:
                    raise Rejected("invalid_management_state")
                self.version = row[0]
                if type(row[1]) is not str or not re.fullmatch(r"[0-9a-f]{64}", row[1]):
                    raise Rejected("invalid_management_state")
                self.digest = row[1]
                config = validate_config(json.loads(row[2]))
                if config_digest(config) != self.digest:
                    raise Rejected("invalid_management_state")
                self.config = config
                self._set_config(config)
            except Exception:
                self.apply_error = "APPLY_FAILED"
        # Freshness deliberately never survives a restart.

    @property
    def scope_key(self):
        return canonical_json(self.scope.wire()).decode()

    def fresh(self):
        return (self.last_success is not None and 0 <= self.clock() - self.last_success < FRESH_SECONDS
                and self.apply_error is None)

    def require_fresh(self):
        if not self.fresh():
            raise Rejected("management_sync_required")

    def _set_config(self, config):
        sender, settings = self.runtime.sender, self.runtime.settings
        params = config["parameters"]
        sender.minute, sender.day = params["proactivePerMinute"], params["proactivePerDay"]
        sender.user_minute, sender.group_minute = params["passivePerUserMinute"], params["groupPerMinute"]
        settings.poll_seconds = params["pollSeconds"]
        self.runtime._next_managed_poll = min(self.runtime._next_managed_poll, self.clock() + settings.poll_seconds)
        sender.allow_proactive_send = settings.allow_proactive_send and not config["proactivePaused"]

    def render_reply(self, key, result):
        # Fixed operational content; keep historical template config and digest intact.
        return sanitize_qq_text(result)

    def telemetry(self):
        db, sender = self.runtime.journal.db, self.runtime.sender
        now = self.wall_clock()
        # Pure SELECT: pending_acks/can_start/recover may mutate the send ledger.
        rows = db.execute("""SELECT b.direction,b.created,
            (r.state IN ('RESERVED','SENDING') OR a.outcome='started') pending
            FROM send_budgets b LEFT JOIN reply_slots r ON r.attempt_key=b.attempt_key
            LEFT JOIN attempts a ON a.delivery_key=b.attempt_key
            WHERE b.scope=? AND b.charged=1 AND
            (b.created>? OR r.state IN ('RESERVED','SENDING') OR a.outcome='started')""",
                          (self.scope_key, now - 86400)).fetchall()
        current = [row for row in rows if row[1] > now - 60 or row[2]]
        pauses = {row[0] for row in db.execute(
            "SELECT direction FROM direction_pauses WHERE scope IN (?, '*') AND reason NOT IN ('resolved_pre_sdk','resolved_provider_refusal')", (self.scope_key,))}
        ready = False
        try:
            self.runtime.adapter()
            ready = True
        except Exception:
            pass
        results = {key: 0 for key in ("sent", "unknown", "permission_denied", "simulated")}
        attempts = db.execute("""SELECT a.delivery_key,b.direction,a.outcome,a.created
            FROM attempts a JOIN send_budgets b ON b.attempt_key=a.delivery_key
            WHERE b.scope=? ORDER BY a.created DESC,a.delivery_key DESC LIMIT 10""",
                              (self.scope_key,)).fetchall()
        for outcome, count in db.execute("""SELECT a.outcome,COUNT(*) FROM attempts a
            JOIN send_budgets b ON b.attempt_key=a.delivery_key
            WHERE b.scope=? AND b.direction='passive' GROUP BY a.outcome""", (self.scope_key,)):
            if outcome in results:
                results[outcome] = count
        recent = []
        for key, direction, outcome, at in attempts:
            if direction not in ("proactive", "passive") or outcome not in OUTCOMES:
                continue
            if not isinstance(at, (int, float)) or not math.isfinite(at):
                continue
            try:
                when = datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")
            except (ValueError, OverflowError, OSError):
                continue
            recent.append({"eventKey": hashlib.sha256(key.encode()).hexdigest(),
                           "direction": direction, "outcome": outcome, "time": when})
        return {"ready": ready, "plugin_version": PLUGIN_VERSION,
                "proactive_paused": "proactive" in pauses or not sender.allow_proactive_send,
                "passive_paused": "passive" in pauses or not sender.allow_passive_replies,
                "minute_proactive": sum(row[0] == "proactive" for row in current),
                "minute_group": len(current),
                "rolling_proactive": sum(row[0] == "proactive" for row in rows),
                "reply_outcomes": results, "recent": recent}

    async def sync(self):
        async with self.sync_lock:
            body = {**self.scope.wire(), "simulation": self.runtime.settings.simulation,
                    "protocol": 2 if self.runtime.settings.managed_groups_enabled else 1, "applied_version": self.version, "applied_digest": self.digest,
                    "apply_error": self.apply_error, "telemetry": self.telemetry()}
            if self.runtime.settings.managed_groups_enabled:
                body.update(applied_group_revision=self.group_revision,applied_group_digest=self.group_digest)
            try:
                response = await self.runtime.bridge.post(PREFIX + "/management/sync", body)
            except Exception:
                # A transient network failure cannot refresh the monotonic lease.
                return False
            try:
                exact(response, ("protocol", "scope", "publication", *(("groups",) if self.runtime.settings.managed_groups_enabled else ())))
                if type(response["protocol"]) is not int or response["protocol"] != body["protocol"] or response["scope"] != self.scope.wire():
                    raise Rejected("invalid_management_response")
                group_result=None
                if self.runtime.settings.managed_groups_enabled:
                    group_result=registry_proof(response["groups"],self.scope,self.runtime.bridge.secret,self.wall_clock(),self.group_revision,self.group_digest)
                publication = response["publication"]
                if publication is not None:
                    exact(publication, ("version", "digest", "config"))
                    version, digest = publication["version"], publication["digest"]
                    if (type(version) is not int or not self.version <= version <= 2147483647 or version < 1
                            or type(digest) is not str or not re.fullmatch(r"[0-9a-f]{64}", digest)):
                        raise Rejected("invalid_management_version")
                    config = validate_config(publication["config"])
                    if config_digest(config) != digest or version == self.version and digest != self.digest:
                        raise Rejected("invalid_management_digest")
                    async with self.runtime.sender.lock:
                        try:
                            with self.runtime.journal.db:
                                cursor = self.runtime.journal.db.execute(
                                    "INSERT INTO management_state VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET "
                                    "version=excluded.version,digest=excluded.digest,config=excluded.config "
                                    "WHERE excluded.version > management_state.version OR "
                                    "(excluded.version = management_state.version AND excluded.digest = management_state.digest)",
                                    (self.scope_key, version, digest, canonical_json(config).decode()))
                                if cursor.rowcount != 1:
                                    raise Rejected("management_version_conflict")
                            self._set_config(config)
                            self.version, self.digest, self.config = version, digest, config
                        except Rejected:
                            self.apply_error, self.last_success = "INVALID_CONFIG", None
                            return False
                        except Exception:
                            self.apply_error, self.last_success = "APPLY_FAILED", None
                            return False
                elif self.apply_error == "APPLY_FAILED":
                    return False
                if group_result is not None:
                    revision,digest,allowed=group_result
                    async with self.runtime.sender.lock:
                        with self.runtime.journal.db:
                            self.runtime.journal.db.execute("INSERT INTO management_group_state VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,digest=excluded.digest WHERE excluded.revision>management_group_state.revision",(self.scope_key,revision,digest))
                        self.runtime.settings.allowed,self.runtime.settings.approved=set(allowed),set(allowed)
                        self.runtime.sender.allowed,self.runtime.sender.approved=set(allowed),set(allowed)
                        self.group_revision,self.group_digest=revision,digest
                self.apply_error, self.last_success = None, self.clock()
                return True
            except Exception:
                self.apply_error, self.last_success = "INVALID_CONFIG", None
                return False
