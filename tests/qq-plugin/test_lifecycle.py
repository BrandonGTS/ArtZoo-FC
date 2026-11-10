"""Load only the plugin entrypoint against minimal AstrBot API doubles."""
import asyncio
import importlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sender = importlib.import_module("plugins.astrbot_plugin_artzoo.sender")


def modules():
    root, api, event, star = (ModuleType(name) for name in
                             ("astrbot", "astrbot.api", "astrbot.api.event", "astrbot.api.star"))
    api.logger = SimpleNamespace(warning=lambda *args: None, info=lambda *args: None)
    event.AstrMessageEvent = object
    event.filter = SimpleNamespace(
        EventMessageType=SimpleNamespace(GROUP_MESSAGE="group"),
        event_message_type=lambda *args, **kwargs: lambda function: function)
    class Star:
        def __init__(self, context):
            self.context = context
    star.Star, star.Context = Star, object
    star.register = lambda *args: lambda cls: cls
    star.StarTools = SimpleNamespace(get_data_dir=lambda *args: (_ for _ in ()).throw(
        AssertionError("disabled lifecycle created data directory")))
    botpy, errors, message = (ModuleType(name) for name in
                              ("botpy", "botpy.errors", "botpy.message"))
    errors.ForbiddenError = type("ForbiddenError", (Exception,), {})
    errors.AuthenticationFailedError = type("AuthenticationFailedError", (Exception,), {})
    message.GroupMessage = type("GroupMessage", (), {})
    return dict(zip(("astrbot", "astrbot.api", "astrbot.api.event", "astrbot.api.star",
                     "botpy", "botpy.errors", "botpy.message"),
                    (root, api, event, star, botpy, errors, message)))


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_initialization_has_no_io_or_task(self):
        name = "plugins.astrbot_plugin_artzoo.main"
        sys.modules.pop(name, None)
        with patch.dict(sys.modules, modules()):
            main = importlib.import_module(name)
            plugin = main.ArtZooPlugin(object(), {})
            await plugin.initialize()
            await plugin.handle_group(object())
            self.assertIsNone(plugin.task)
            self.assertIsNone(plugin.runtime)
            await plugin.terminate()
        sys.modules.pop(name, None)

    async def test_enabled_termination_cancels_poll_and_closes_only_plugin_journal(self):
        name = "plugins.astrbot_plugin_artzoo.main"
        sys.modules.pop(name, None)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, modules()):
            main = importlib.import_module(name)
            journal = sender.Journal(Path(tmp) / "journal.sqlite3")
            cycles = []
            class Runtime:
                def __init__(self, *args, **kwargs):
                    self.journal = journal
                async def poll_once(self):
                    cycles.append("cycle")
            config = {"enabled": True, "simulation": True, "platform_id": "mock_platform",
                      "app_id": "mock_app", "bot_id": "mock_bot",
                      "allow_groups": ["mock_group"]}
            with patch.object(main, "configured_bridge", return_value=object()), patch.object(
                    main, "protected_journal", return_value=journal), patch.object(
                    main.StarTools, "get_data_dir", return_value=Path(tmp)), patch.object(
                    main, "Runtime", Runtime):
                plugin = main.ArtZooPlugin(object(), config)
                await plugin.initialize()
                await asyncio.sleep(0)
                task = plugin.task
                self.assertEqual(cycles, ["cycle"])
                await plugin.terminate()
                self.assertTrue(task.done())
                self.assertIsNone(plugin.runtime)
                with self.assertRaises(sqlite3.ProgrammingError):
                    journal.db.execute("SELECT 1")
        sys.modules.pop(name, None)

    def test_config_schema_sample_are_both_disabled_and_secret_free(self):
        directory = Path(__file__).resolve().parents[2] / "plugins/astrbot_plugin_artzoo"
        schema = json.loads((directory / "_conf_schema.json").read_text())
        sample = json.loads((directory / "config.example.json").read_text())
        self.assertEqual(sample, {key: value["default"] for key, value in schema.items()})
        self.assertFalse(sample["enabled"])
        self.assertTrue(sample["simulation"])
        self.assertFalse(sample["allow_real_send"])
        self.assertEqual(sample["allow_groups"], [])
        self.assertEqual(sample["approved_test_groups"], [])
        self.assertNotIn("secret", sample)
        self.assertNotIn("token", sample)

    async def test_diagnostic_mode_logs_once_without_any_bridge_journal_poll(self):
        name = "plugins.astrbot_plugin_artzoo.main"
        sys.modules.pop(name, None)
        with patch.dict(sys.modules, modules()):
            main = importlib.import_module(name)
            logs = []
            adapter = SimpleNamespace(
                meta=lambda: SimpleNamespace(name="qq_official", id="default"),
                appid="mock_app", client=SimpleNamespace(
                    robot=SimpleNamespace(id="mock_verified"), secret="NEVER_LOG_SECRET"))
            context = SimpleNamespace(get_platform_inst=lambda platform: adapter)
            config = {"diagnostic_mode": True, "enabled": True, "platform_id": "default",
                      "app_id": "mock_app", "allow_groups": ["mock_group"]}
            with patch.object(main.logger, "info", side_effect=logs.append), patch.object(
                    main, "configured_bridge", side_effect=AssertionError("bridge created")), patch.object(
                    main, "protected_journal", side_effect=AssertionError("journal created")):
                plugin = main.ArtZooPlugin(context, config)
                await plugin.initialize()
                self.assertEqual(len(logs), 1)
                self.assertTrue(logs[0].startswith("[ArtZoo identity] "))
                result = json.loads(logs[0].split("] ", 1)[1])
                self.assertEqual(result["actual_bot_id"], "mock_verified")
                self.assertNotIn("NEVER_LOG_SECRET", logs[0])
                self.assertIsNone(plugin.task)
                self.assertIsNone(plugin.runtime)
                await plugin.terminate()
        sys.modules.pop(name, None)


class PollFailureTests(unittest.IsolatedAsyncioTestCase):
    async def run_cycles(self, outcomes, *, interval=30, management=False):
        name = "plugins.astrbot_plugin_artzoo.main"
        sys.modules.pop(name, None)
        delays, logs = [], []
        with patch.dict(sys.modules, modules()):
            main = importlib.import_module(name)
            plugin = main.ArtZooPlugin(object(), {})
            plugin.settings = SimpleNamespace(poll_seconds=interval, management_enabled=management)
            remaining = iter(outcomes)

            async def poll_once():
                outcome = next(remaining)
                if outcome is not None:
                    raise outcome

            async def sleep(delay):
                delays.append(delay)
                if len(delays) == len(outcomes):
                    raise asyncio.CancelledError()

            plugin.runtime = SimpleNamespace(poll_once=poll_once)
            with patch.object(main.asyncio, "sleep", side_effect=sleep), patch.object(
                    main.logger, "warning", side_effect=logs.append):
                with self.assertRaises(asyncio.CancelledError):
                    await plugin._poll()
        sys.modules.pop(name, None)
        return delays, logs

    async def test_failures_double_to_five_minutes_and_success_resets(self):
        outcomes = [RuntimeError("NEVER_LOG_SECRET")] * 7 + [None, RuntimeError("PRIVATE")]
        delays, logs = await self.run_cycles(outcomes)
        self.assertEqual(delays, [30, 60, 120, 240, 300, 300, 300, 30, 30])
        self.assertEqual(len(logs), 8)
        self.assertTrue(all(line.endswith("reason_code=TRANSPORT_OR_INTERNAL") for line in logs))
        self.assertNotIn("NEVER_LOG_SECRET", str(logs))
        self.assertNotIn("PRIVATE", str(logs))

    async def test_management_normal_interval_remains_capped_and_resets(self):
        delays, _ = await self.run_cycles([None, RuntimeError(), RuntimeError(), None],
                                         interval=3600, management=True)
        self.assertEqual(delays, [60, 60, 120, 60])

    async def test_long_normal_interval_only_failure_is_capped(self):
        delays, _ = await self.run_cycles([RuntimeError(), None], interval=3600)
        self.assertEqual(delays, [300, 3600])

    async def test_rejected_cycle_uses_fixed_code_and_same_backoff(self):
        core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")
        delays, logs = await self.run_cycles([
            core.Rejected("unrecognized_sdk_request"), core.Rejected("PRIVATE\nPAYLOAD"), None])
        self.assertEqual(delays, [30, 60, 30])
        self.assertTrue(logs[0].endswith("reason_code=UNRECOGNIZED_SDK_REQUEST"))
        self.assertTrue(logs[1].endswith("reason_code=LOCAL_REJECTED"))
        self.assertNotIn("PRIVATE", str(logs))
        self.assertNotIn("\n", "".join(logs))

    async def test_poll_cancellation_is_not_logged_or_delayed(self):
        name = "plugins.astrbot_plugin_artzoo.main"
        sys.modules.pop(name, None)
        with patch.dict(sys.modules, modules()):
            main = importlib.import_module(name)
            plugin = main.ArtZooPlugin(object(), {})
            async def cancel():
                raise asyncio.CancelledError()
            plugin.runtime = SimpleNamespace(poll_once=cancel)
            with patch.object(main.asyncio, "sleep") as sleep, patch.object(
                    main.logger, "warning") as warning:
                with self.assertRaises(asyncio.CancelledError):
                    await plugin._poll()
                sleep.assert_not_called()
                warning.assert_not_called()
        sys.modules.pop(name, None)

    async def test_command_rejections_never_stringify_untrusted_arguments(self):
        name = "plugins.astrbot_plugin_artzoo.main"
        sys.modules.pop(name, None)
        class Unprintable:
            def __str__(self):
                raise AssertionError("exception argument was stringified")
        with patch.dict(sys.modules, modules()):
            main = importlib.import_module(name)
            plugin = main.ArtZooPlugin(object(), {})
            for reason, code in [("group_mismatch", "GROUP_MISMATCH"),
                                 ("PRIVATE\nPAYLOAD", "LOCAL_REJECTED"),
                                 (Unprintable(), "LOCAL_REJECTED")]:
                async def reject(event):
                    raise main.Rejected(reason)
                plugin.runtime = SimpleNamespace(handle=reject)
                with patch.object(main.logger, "warning") as warning:
                    await plugin.handle_group(object())
                    warning.assert_called_once_with(
                        "[ArtZoo] deterministic command rejected; reason_code=" + code)
        sys.modules.pop(name, None)
