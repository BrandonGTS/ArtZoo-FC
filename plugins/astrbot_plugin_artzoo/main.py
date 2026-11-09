"""AstrBot v4.29.3 entry point; default disabled, no AI hooks or tools."""
import asyncio
import json

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register

from .core import Rejected
from .runtime import Runtime, Settings, configured_bridge, protected_journal, identity_status
from .sdk import SingleAttemptAPI


def rejection_reason_code(error):
    """Only reviewed constants reach logs; never stringify an exception."""
    reasons = {
        'unsupported_sdk_version': 'UNSUPPORTED_SDK_VERSION',
        'unrecognized_sdk_http': 'UNRECOGNIZED_SDK_HTTP',
        'unrecognized_sdk_request': 'UNRECOGNIZED_SDK_REQUEST',
        'uninspectable_sdk_request': 'UNINSPECTABLE_SDK_REQUEST',
        'group_mismatch': 'GROUP_MISMATCH',
        'missing_or_invalid_quote': 'INVALID_QUOTE',
        'missing_or_ambiguous_quote': 'AMBIGUOUS_QUOTE',
        'invalid_event_timestamp': 'INVALID_EVENT_TIMESTAMP',
    }
    args = error.args
    reason = args[0] if len(args) == 1 and type(args[0]) is str else None
    return reasons.get(reason, 'LOCAL_REJECTED')


def log_group_diagnostic(error):
    value=getattr(error,'artzoo_group_diagnostic',None)
    if not isinstance(value,dict):return
    allowed={'VALIDATION_ERROR','FORBIDDEN','CONFLICT','RATE_LIMITED','UNAUTHENTICATED','SERVICE_UNAVAILABLE','HTTP_ERROR','LOCAL_REJECTED','TRANSPORT_OR_INTERNAL'}
    if value.get('category') not in allowed:return
    keys={'category','http_status','invalid_field','event_id_length','message_index_length','recorded_no_sdk_start'}
    if set(value)!=keys:return
    for name in ['event_id_length','message_index_length']:
        if value[name] is not None and (type(value[name]) is not int or not 0<=value[name]<=100000):return
    if value['invalid_field'] not in {None,'event_id','message_idx','event_timestamp','app_id','bot_id','group_openid','sender_openid','content'}:return
    if value['http_status'] is not None and (type(value['http_status']) is not int or not 400<=value['http_status']<=599):return
    if type(value['recorded_no_sdk_start']) is not bool:return
    logger.warning('[ArtZoo group-proof] '+json.dumps(value,sort_keys=True))

@register("astrbot_plugin_artzoo", "ArtZoo",
          "官方 QQ 确定性命令与完整回执桥接（默认关闭）", "0.3.6")
class ArtZooPlugin(Star):
    def __init__(self, context: Context, config):
        super().__init__(context)
        self.context = context
        self.settings = Settings(config)
        self.runtime = None
        self.task = None

    def identity_status(self):
        return identity_status(self.settings, self.context)

    async def initialize(self):
        if self.settings.diagnostic_mode:
            logger.info("[ArtZoo identity] " + json.dumps(
                self.identity_status(), ensure_ascii=False, sort_keys=True))
            return
        if not self.settings.enabled:
            return
        from botpy.errors import ForbiddenError, AuthenticationFailedError
        from botpy.message import GroupMessage

        bridge = configured_bridge(self.settings, StarTools.get_data_dir("astrbot_plugin_artzoo"))
        journal = protected_journal(StarTools.get_data_dir("astrbot_plugin_artzoo"))
        self.runtime = Runtime(self.settings, self.context, bridge, journal,
                               SingleAttemptAPI, (ForbiddenError, AuthenticationFailedError),
                               group_message_type=GroupMessage)
        self.task = asyncio.create_task(self._poll(), name="artzoo-qq-official")

    async def _poll(self):
        normal_delay = (min(self.settings.poll_seconds, 60)
                        if self.settings.management_enabled else self.settings.poll_seconds)
        failure_delay = min(normal_delay, 300)
        while True:
            try:
                await self.runtime.poll_once()
            except asyncio.CancelledError:
                raise
            except Rejected as error:
                logger.warning("[ArtZoo] bridge cycle rejected; reason_code="
                               + rejection_reason_code(error))
                delay = failure_delay
                failure_delay = min(failure_delay * 2, 300)
            except Exception:
                # Never include incoming commands, codes, identities or SDK errors.
                logger.warning("[ArtZoo] bridge cycle failed closed; reason_code=TRANSPORT_OR_INTERNAL")
                delay = failure_delay
                failure_delay = min(failure_delay * 2, 300)
            else:
                delay = normal_delay
                failure_delay = min(normal_delay, 300)
            await asyncio.sleep(delay)

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=100)
    async def handle_group(self, event: AstrMessageEvent):
        if self.runtime is None:
            return
        try:
            await self.runtime.handle(event)
        except Rejected as error:
            # Handled command propagation has already stopped; no model fallback.
            log_group_diagnostic(error)
            logger.warning("[ArtZoo] deterministic command rejected; reason_code="
                           + rejection_reason_code(error))
        except Exception as error:
            log_group_diagnostic(error)
            logger.warning("[ArtZoo] bridge command failed closed.")

    async def terminate(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None
        if self.runtime:
            self.runtime.journal.close()
            self.runtime = None
