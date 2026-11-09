"""Plugin lifecycle and deterministic routing; imports no AstrBot at module level."""
from __future__ import annotations

import os
import hashlib
import asyncio
import hmac
import stat
from pathlib import Path

from .bridge import BridgeClient, BridgeHttpFailure, PREFIX
from .core import Rejected, Scope, command_envelope, identifier, parse_command, canonical_json
from .sender import ControlReplyPermit, Journal, Sender
from .management import Management, validate_test_delivery


def canonical_sdk_bot_id(value) -> str:
    """QQ SDK may expose uint64 IDs as int; never accept float/bool/object coercion."""
    if type(value) is int and 0 < value < 2**64:
        return str(value)
    if type(value) is str:
        return identifier(value, "sdk_bot_id")
    raise Rejected("invalid_sdk_bot_id_type")


class Settings:
    def __init__(self, raw):
        self.diagnostic_mode = raw.get("diagnostic_mode", False) is True
        self.enabled = raw.get("enabled", False) is True and not self.diagnostic_mode
        self.simulation = raw.get("simulation", True) is not False
        self.operation_mode = raw.get("operation_mode", "test_batch")
        if self.operation_mode not in ("test_batch", "production"):
            raise Rejected("invalid_operation_mode")
        if self.operation_mode == "production" and self.simulation:
            raise Rejected("production_requires_live_mode")
        self.management_enabled = raw.get("management_enabled", False) is True and self.operation_mode == "production"
        self.managed_groups_enabled = raw.get("managed_groups_enabled", False) is True
        if self.managed_groups_enabled and not self.management_enabled:
            raise Rejected("managed_groups_require_management")
        self.allow_real_send = raw.get("allow_real_send", False) is True
        self.allow_passive_replies = raw.get("allow_passive_replies", False) is True
        self.allow_proactive_send = raw.get("allow_proactive_send", False) is True
        self.max_proactive_attempts = raw.get("max_proactive_attempts", 0)
        self.max_passive_attempts = raw.get("max_passive_attempts", 0)
        self.diagnostic_groups = raw.get("allow_groups", [])
        self.platform_id = raw.get("platform_id", "")
        self.app_id, self.bot_id = raw.get("app_id", ""), raw.get("bot_id", "")
        self.origin = raw.get("bridge_origin", "")
        self.secret_from_data_file = raw.get("bridge_secret_from_data_file", False) is True
        self.secret_env = raw.get("bridge_secret_env", "ARTZOO_QQ_BRIDGE_SECRET")
        self.allow_loopback = raw.get("allow_loopback_http", False) is True
        self.poll_seconds = raw.get("poll_seconds", 60)
        self.per_minute = raw.get("per_minute", 3)
        self.per_day = raw.get("per_day", 20)
        self.group_per_minute = raw.get("group_per_minute",10)
        self.passive_per_user_minute = raw.get("passive_per_user_minute",3)
        self.allowed: set[Scope] = set()
        self.approved: set[Scope] = set()
        for value, cap in ((self.max_proactive_attempts, 7), (self.max_passive_attempts, 11)):
            if type(value) is not int or not 0 <= value <= cap:
                raise Rejected("invalid_direction_budget")
        if self.diagnostic_mode:
            identifier(self.platform_id, "platform_id")
            if not isinstance(self.diagnostic_groups, list) or len(self.diagnostic_groups) > 1:
                raise Rejected("invalid_diagnostic_scope")
            for group in self.diagnostic_groups:
                identifier(group, "group_openid")
        if not self.enabled:
            return
        identifier(self.platform_id, "platform_id")
        identifier(self.app_id, "app_id")
        identifier(self.bot_id, "bot_id")
        if self.bot_id == "qq_official":
            raise Rejected("placeholder_bot_identity")
        if (type(self.poll_seconds) is not int or not (10 if self.operation_mode == "production" else 30) <= self.poll_seconds <= 3600
                or type(self.per_minute) is not int or type(self.per_day) is not int):
            raise Rejected("invalid_poll_or_rate")
        for name, target in (("allow_groups", self.allowed),
                             ("approved_test_groups", self.approved)):
            groups = raw.get(name, [])
            if not isinstance(groups, list) or len(groups) > 20:
                raise Rejected("invalid_" + name)
            for group in groups:
                scope = Scope(self.app_id, self.bot_id, group)
                if self.simulation and not all(value.startswith("mock_")
                        for value in scope.wire().values()):
                    raise Rejected("simulation_requires_mock_identity")
                target.add(scope)
        if not self.approved.issubset(self.allowed):
            raise Rejected("test_group_not_allowlisted")
        if not self.allowed:
            raise Rejected("empty_allowlist")
        if not self.simulation and len(self.allowed) != 1:
            raise Rejected("single_test_scope_required")
        if (type(self.group_per_minute) is not int or not 1<=self.group_per_minute<=10
                or type(self.passive_per_user_minute) is not int or not 1<=self.passive_per_user_minute<=10):
            raise Rejected("invalid_production_rate")
        identifier(self.secret_env, "secret_env", 128)


class Runtime:
    def __init__(self, settings: Settings, context, bridge, journal: Journal,
                 api_factory, permission_errors=(), group_message_type=None):
        self.settings, self.context, self.bridge = settings, context, bridge
        self.journal, self.api_factory = journal, api_factory
        self.permission_errors = permission_errors
        self.group_message_type = group_message_type
        self.sender = Sender(journal, settings.allowed, simulation=settings.simulation,
                             allow_real_send=settings.allow_real_send,
                             approved_test_scopes=settings.approved,
                             per_minute=settings.per_minute, per_day=settings.per_day,
                             allow_passive_replies=settings.allow_passive_replies,
                             allow_proactive_send=settings.allow_proactive_send,
                             max_proactive_attempts=settings.max_proactive_attempts,
                             max_passive_attempts=settings.max_passive_attempts,
                             operation_mode=settings.operation_mode,
                             group_per_minute=settings.group_per_minute,
                             passive_per_user_minute=settings.passive_per_user_minute)
        self._next_managed_poll = 0.0
        self.management = (Management(self, next(iter(settings.allowed)))
                           if settings.management_enabled else None)

    def adapter(self):
        adapter = self.context.get_platform_inst(self.settings.platform_id)
        if adapter is None or adapter.meta().name != "qq_official":
            raise Rejected("official_platform_not_found")
        if str(adapter.appid) != self.settings.app_id:
            raise Rejected("app_identity_mismatch")
        try:
            actual_bot = adapter.client.robot.id
        except (AttributeError, TypeError) as exc:
            raise Rejected("bot_not_ready") from exc
        if canonical_sdk_bot_id(actual_bot) != self.settings.bot_id:
            raise Rejected("bot_identity_mismatch")
        return adapter

    def render_reply(self, key, result):
        return self.management.render_reply(key, result) if self.management else result

    async def reply(self, event, scope: Scope, message: str, reservation=None):
        if self.management:
            self.management.require_fresh()
        if not self.settings.allow_passive_replies:
            return
        if (not isinstance(message, str) or not message.strip() or len(message) > 1800):
            raise Rejected("unsafe_reply")
        if self.settings.simulation:
            return
        if (not self.settings.allow_real_send or scope not in self.settings.approved):
            raise Rejected("reply_not_approved")
        if reservation is None and not self.sender.can_start(scope, "passive"):
            return
        adapter = self.adapter()
        raw = getattr(event.message_obj.raw_message, "raw_data", None)
        if not isinstance(raw, dict):
            raise Rejected("missing_raw_data")
        event_id = identifier(raw.get("id"), "event_id")
        # The same SDK path and persisted rate limit apply to passive replies.
        await self.sender.reply(scope, event_id, message, self.api_factory(adapter.client),
                                self.permission_errors, reservation=reservation)

    async def handle(self, event):
        if event.get_platform_id() != self.settings.platform_id:
            return False
        text = event.get_message_str()
        kind = parse_command(text)
        if kind is None:
            return False
        # Stop BEFORE any identity validation/await/error, so supported-looking
        # commands and website-only commands never fall through to a model.
        event.stop_event()
        if self.management:
            self.management.require_fresh()
        adapter = self.adapter()
        native = event.message_obj.raw_message
        if self.group_message_type is None or not isinstance(native, self.group_message_type):
            raise Rejected("not_native_group_event")
        raw = getattr(native, "raw_data", None)
        if not isinstance(raw, dict):
            raise Rejected("missing_raw_data")
        if raw.get("t") not in (None, "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"):
            raise Rejected("unsupported_event_type")
        if self.settings.simulation:
            author = raw.get("author")
            member = author.get("member_openid") if isinstance(author, dict) else None
            if not isinstance(member, str) or not member.startswith("mock_"):
                raise Rejected("simulation_requires_mock_member")
        group = identifier(raw.get("group_openid"), "group_openid")
        scope = Scope(self.settings.app_id, self.settings.bot_id, group)
        if kind == "group_bind":
            if not self.settings.managed_groups_enabled:
                raise Rejected("group_discovery_disabled")
            return await self.group_proof(event,scope,text,raw,native)
        if scope not in self.settings.allowed:
            raise Rejected("scope_not_allowlisted")
        reservation=None
        if self.settings.operation_mode == "production" and not self.settings.simulation:
            author=raw.get("author")
            member=identifier(author.get("member_openid") if isinstance(author,dict) else None,"member_openid")
            content=raw.get("content")
            if not isinstance(content,str) or len(content)>2048:
                raise Rejected("invalid_native_content")
            fingerprint=hashlib.sha256(canonical_json({"content":content,"text":text})).hexdigest()
            reservation=self.sender.prepare_reply(scope,raw.get("id"),member,fingerprint)
            if reservation is None:
                return True
        heartbeat=asyncio.create_task(self.sender.keep_reply_alive(reservation)) if reservation is not None else None
        try:
            return await self._dispatch(event,scope,text,raw,native,kind,reservation)
        except BaseException:
            if reservation is not None:
                self.sender.fail_reply(reservation)
            raise
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
                try:
                    await heartbeat
                except asyncio.CancelledError:
                    pass

    async def group_proof(self,event,scope,text,raw,native):
        from .bridge import BridgeHttpFailure
        reservation,heartbeat=None,None
        try:
            if not self.settings.allow_passive_replies or not self.settings.allow_real_send:
                raise Rejected("group_proof_replies_disabled")
            mentions=getattr(native,"mentions",None) or []
            own=tuple(canonical_sdk_bot_id(mention.id) for mention in mentions if getattr(mention,"is_you",None) is True)
            body=command_envelope(raw,text,scope,own_mention_ids=own)
            body["simulation"]=self.settings.simulation
            author=raw.get("author") or {}
            member=identifier(author.get("member_openid"),"member_openid")
            fingerprint=hashlib.sha256(canonical_json({"content":raw.get("content"),"text":text})).hexdigest()
            reservation=self.sender.prepare_control_reply(scope,raw.get("id"),member,fingerprint)
            if reservation is None:return True
            heartbeat=asyncio.create_task(self.sender.keep_reply_alive(reservation))
            response=await self.bridge.post(PREFIX+"/group-bindings/proof",body)
            if response.get("challengeAccepted") is not True:
                raise Rejected("group_challenge_rejected")
            message=response.get("message")
            if type(message) is not str or not message.strip() or len(message)>1800:
                raise Rejected("unsafe_group_reply")
            permit=response.get("control")
            if type(permit) is not dict or set(permit)!={"scope","eventId","messageDigest","expiresAt","signature"}:
                raise Rejected("invalid_control_permit")
            signed={key:value for key,value in permit.items() if key!="signature"}
            expected=hmac.new(self.bridge.secret,b"ArtZoo-Qq-Control\n"+canonical_json(signed),hashlib.sha256).hexdigest()
            if (type(permit["signature"]) is not str or not hmac.compare_digest(expected,permit["signature"])
                    or permit["scope"]!=dict(appId=scope.app_id,botId=scope.bot_id,groupOpenId=scope.group_openid)
                    or permit["eventId"]!=raw.get("id")
                    or permit["messageDigest"]!=hashlib.sha256(message.encode()).hexdigest()):
                raise Rejected("invalid_control_permit")
            from datetime import datetime
            expiry=datetime.fromisoformat(permit["expiresAt"].replace("Z","+00:00")).timestamp()
            if not self.sender.clock()<expiry<=self.sender.clock()+60:
                raise Rejected("control_permit_expired")
            control=ControlReplyPermit(scope,raw.get("id"),permit["messageDigest"],expiry)
            self.management.require_fresh()
            if not self.settings.simulation:
                adapter=self.adapter()
                await self.sender.reply(scope,identifier(raw.get("id"),"event_id"),message,self.api_factory(adapter.client),self.permission_errors,reservation=reservation,control=control)
            return True
        except BaseException as error:
            safe=self.sender.fail_reply(reservation,safe_before_sdk=True) if reservation is not None else False
            indexes=[item.partition('=')[2] for item in ((raw.get('message_scene') or {}).get('ext') or []) if isinstance(item,str) and item.startswith('msg_idx=')] if isinstance(raw.get('message_scene'),dict) else []
            category=error.category if isinstance(error,BridgeHttpFailure) else 'LOCAL_REJECTED' if isinstance(error,Rejected) else 'TRANSPORT_OR_INTERNAL'
            error.artzoo_group_diagnostic={'category':category,'http_status':error.status if isinstance(error,BridgeHttpFailure) else None,'invalid_field':error.field if isinstance(error,BridgeHttpFailure) else None,'event_id_length':len(raw['id']) if isinstance(raw.get('id'),str) else None,'message_index_length':max(map(len,indexes)) if indexes else None,'recorded_no_sdk_start':safe}
            raise
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
                try:await heartbeat
                except asyncio.CancelledError:pass

    async def _dispatch(self,event,scope,text,raw,native,kind,reservation):
        if kind == "invalid":
            await self.reply(event, scope, self.render_reply("INVALID", "命令格式不正确，请到网站查看操作说明。"), reservation=reservation)
            return True
        if kind == "website_only":
            await self.reply(event, scope, self.render_reply("WEBSITE_ONLY", "请到网站办理退出或调整报名。"), reservation=reservation)
            return True
        try:
            mentions = getattr(native, "mentions", None) or []
            if not isinstance(mentions, list) or len(mentions) > 20:
                raise Rejected("invalid_native_mentions")
            own_mentions = tuple(canonical_sdk_bot_id(mention.id) for mention in mentions
                                 if getattr(mention, "is_you", None) is True)
            body = command_envelope(raw, text, scope, own_mention_ids=own_mentions)
        except Rejected:
            await self.reply(event, scope, self.render_reply("SOURCE_REJECTED", "无法确认消息来源或引用，请到网站操作。"), reservation=reservation)
            return True
        # In simulation, the bridge also receives the explicit mode; its global
        # default-off gate remains authoritative and must not mutate real state.
        body["simulation"] = self.settings.simulation
        data = await self.bridge.post(PREFIX + "/commands", body)
        await self.reply(event, scope, data.get("message"), reservation=reservation)
        return True

    async def flush_acks(self):
        for key, payload in self.journal.pending_acks():
            delivery_id = payload.get("delivery_id")
            route = "/management/test-ack" if isinstance(delivery_id, str) and delivery_id.startswith("bot-test-") else "/deliveries/ack"
            try:
                response = await self.bridge.post(PREFIX + route, payload)
            except Exception:
                if self.settings.managed_groups_enabled:
                    continue
                raise
            if response.get("accepted") is True or response.get("terminal") is True:
                self.journal.acknowledge(key)
            elif not self.settings.managed_groups_enabled:
                raise Rejected("ack_not_accepted")

    async def begin_delivery(self, body, path="/deliveries/begin"):
        if self.management and (not self.management.fresh() or not self.sender.allow_proactive_send):
            return {"dispatch": False, "simulation": self.settings.simulation}
        result = await self.bridge.post(PREFIX + path, body)
        if self.management and (not self.management.fresh() or not self.sender.allow_proactive_send):
            return {"dispatch": False, "simulation": self.settings.simulation}
        return result

    async def poll_once(self):
        # Control traffic is independent of send permission, quotas, and old receipt failures.
        if self.management:
            try:
                await self.management.sync()
            except Exception:
                # Control-plane/telemetry errors do not suppress durable receipt retries.
                pass
        await self.flush_acks()
        if self.management and not self.management.fresh():
            return
        if self.management:
            now = self.management.clock()
            if now < self._next_managed_poll:
                return
            self._next_managed_poll = now + self.settings.poll_seconds
        if not self.settings.allow_proactive_send or not self.sender.allow_proactive_send:
            return
        if not self.settings.simulation and not self.settings.allow_real_send:
            return
        scopes = [scope for scope in self.settings.allowed if self.settings.simulation
                  or self.sender.can_start(scope, "proactive")]
        if not scopes:
            return
        adapter = self.adapter()
        api = None if self.settings.simulation else self.api_factory(adapter.client)
        for scope in sorted(scopes,key=lambda item:item.group_openid):
            try:
                await self.poll_scope(scope,api)
            except Exception:
                if not self.settings.managed_groups_enabled:
                    raise
                # Other groups keep working; uncertainty remains in its own durable scope.
                continue

    async def poll_scope(self,scope,api):
        remaining = 3 if self.settings.operation_mode == "production" else 1
        if self.management and self.sender.can_start(scope, "proactive"):
            self.management.require_fresh()
            data = await self.bridge.post(PREFIX + "/management/test-claim",
                {**scope.wire(), "simulation": self.settings.simulation,
                 "applied_version": self.management.version, "applied_digest": self.management.digest})
            task = data.get("delivery")
            if task is not None:
                validate_test_delivery(task)
                self.management.require_fresh()
                await self.sender.deliver({**scope.wire(), **task}, scope, api,
                    self.permission_errors,
                    begin=lambda body: self.begin_delivery(body, "/management/test-begin"))
                remaining -= 1
                await self.flush_acks()
        for _ in range(remaining):
            if self.management:
                self.management.require_fresh()
            if not self.settings.simulation and not self.sender.can_start(scope,"proactive"):
                break
            data = await self.bridge.post(PREFIX + "/deliveries/claim",
                                          {**scope.wire(), "simulation": self.settings.simulation})
            task = data.get("delivery")
            if task is None:
                break
            if not isinstance(task, dict):
                raise Rejected("invalid_delivery")
            if self.management:
                self.management.require_fresh()
            # Scope is chosen locally; a task cannot redirect its group or bot.
            scoped_task = {**scope.wire(), **task}
            await self.sender.deliver(
                scoped_task, scope, api, self.permission_errors,
                begin=self.begin_delivery)
            await self.flush_acks()




def identity_status(settings: Settings, context) -> dict:
    """Synchronous read-only snapshot; no SDK call, bridge, journal, or model."""
    result = {"diagnostic_mode": settings.diagnostic_mode,
              "operation_mode": settings.operation_mode,
              "configured_platform_id": settings.platform_id,
              "configured_app_id": settings.app_id,
              "configured_bot_id": settings.bot_id,
              "configured_groups": settings.diagnostic_groups,
              "ready": False}
    def primitive(value):
        return value if type(value) in (str, int, bool, type(None)) else None
    try:
        adapter = context.get_platform_inst(settings.platform_id)
        if adapter is None:
            result["status"] = "platform_missing"
            return result
        metadata = adapter.meta()
        result["actual_platform_name"] = primitive(metadata.name)
        result["actual_platform_id"] = primitive(metadata.id)
        actual_app = adapter.appid
        result["actual_app_id"] = primitive(actual_app)
        result["app_matches"] = str(actual_app) == settings.app_id
        try:
            bot = adapter.client.robot.id
        except (AttributeError, TypeError):
            result["status"] = "bot_not_ready"
            return result
        canonical_bot = canonical_sdk_bot_id(bot)
        result["actual_bot_id"] = canonical_bot
        result["actual_bot_id_type"] = type(bot).__name__
        result["bot_matches"] = canonical_bot == settings.bot_id
        result["ready"] = bool(canonical_bot)
        result["platform_matches"] = (metadata.name == "qq_official"
                                      and metadata.id == settings.platform_id)
        result["status"] = "observed"
    except Exception:
        result["status"] = "identity_unavailable"
    return result


def configured_bridge(settings: Settings, directory: Path | None = None):
    if settings.secret_from_data_file:
        if directory is None:
            raise Rejected("missing_secret_directory")
        try:
            parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                parent_info = os.fstat(parent_fd)
                if parent_info.st_mode & 0o022 or parent_info.st_uid != os.geteuid():
                    raise Rejected("unsafe_secret_directory")
                fd = os.open("bridge.secret", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) not in (0o400, 0o600) or info.st_uid != os.geteuid():
                    raise Rejected("unsafe_secret_file")
                value = source.read(257)
        except OSError as exc:
            raise Rejected("unavailable_secret_file") from exc
        if not 32 <= len(value) <= 256 or b"\r" in value or b"\n" in value:
            raise Rejected("invalid_secret_file")
        return BridgeClient(settings.origin, value, allow_loopback_http=settings.allow_loopback)
    # No environment enumeration; only the exact operator-selected key is read.
    value = os.environ.get(settings.secret_env, "")
    return BridgeClient(settings.origin, value.encode(), allow_loopback_http=settings.allow_loopback)


def protected_journal(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    path = directory / "delivery-journal.sqlite3"
    journal = Journal(path)
    path.chmod(0o600)
    return journal
