"""Run with python3 -B -m unittest discover -s tests/qq-plugin -v（或 pnpm test:plugin）."""
import hashlib
import hmac
import importlib
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
core = importlib.import_module("plugins.astrbot_plugin_artzoo.core")


class ParsingTests(unittest.TestCase):
    def raw(self):
        return {"id": "event-1", "group_openid": "group", "content": "报名",
                "timestamp": "2026-10-26T01:00:00+08:00", "author": {"member_openid": "member"},
                "message_scene": {"ext": ["msg_idx=self", "ref_msg_idx=REFIDX_abc=="]}}

    def test_base64_padding_is_preserved(self):
        self.assertEqual(core.quote_ref(self.raw()), "REFIDX_abc==")

    def test_ext_object_missing_or_duplicate_rejected(self):
        for ext in ({}, [], ["ref_msg_idx="], ["ref_msg_idx=x", "ref_msg_idx=x"],
                    [{"ref_msg_idx": "x"}]):
            with self.subTest(ext=ext), self.assertRaises(core.Rejected):
                core.quote_ref({"message_scene": {"ext": ext}})

    def test_ordinary_message_id_is_never_quote_fallback(self):
        with self.assertRaises(core.Rejected):
            core.quote_ref({"id": "ordinary", "message_reference": {"message_id": "ordinary"}})

    def test_receipt_requires_ext_info_ref_idx(self):
        for value in (None, {"id": "ordinary"}, {"id": "ordinary", "ref_idx": "wrong"},
                      {"ext_info": {"ref_idx": "reference"}},
                      {"id": "same", "ext_info": {"ref_idx": "same"}}):
            with self.subTest(value=value), self.assertRaises(core.Rejected):
                core.receipt(value)
        self.assertEqual(core.receipt({"id": "ordinary", "ext_info": {"ref_idx": "REF=="}}),
                         {"message_id": "ordinary", "ref_idx": "REF=="})

    def test_exact_commands_and_binding(self):
        self.assertEqual(core.parse_command("报名"), "register")
        self.assertEqual(core.parse_command("取消报名"), "website_only")
        self.assertEqual(core.parse_command("绑定 ABC_def-123"), "bind")
        self.assertEqual(core.parse_command("确认绑定 ABC_def-123"), "bind")
        self.assertEqual(core.parse_command("报名 A队 H1 白魔"), "register")
        for text in ("绑定 x", "确认绑定", "绑定 ABC_def-123 extra"):
            self.assertEqual(core.parse_command(text), "invalid")
        for text in ("请报名", "/报名", "hello"):
            self.assertIsNone(core.parse_command(text), text)

    def test_command_scoped_and_event_idempotent(self):
        a = core.Scope("app", "bot", "group")
        b = core.Scope("app", "other-bot", "group")
        first = core.command_envelope(self.raw(), "报名", a)
        again = core.command_envelope(self.raw(), "报名", a)
        second = core.command_envelope(self.raw(), "报名", b)
        self.assertEqual(first, again)
        self.assertNotEqual(first["bot_id"], second["bot_id"])
        self.assertEqual(first["ref_idx"], "REFIDX_abc==")
        self.assertEqual(first["message_idx"], "self")
        self.assertEqual(first["content"], "报名")
        self.assertNotIn("command", first)
        self.assertNotIn("activityId", first)
        self.assertNotIn("accountId", first)

    def test_activity_code_without_quote_preserves_registration_arguments(self):
        scope = core.Scope("app", "bot", "group")
        for suffix in ("", " MT 骑士", " A队 H1 白魔", " C队 D4 召唤"):
            text = "报名 7K4M2Q9R" + suffix
            with self.subTest(suffix=suffix):
                raw = self.raw()
                raw["content"] = text
                raw["message_scene"]["ext"] = ["msg_idx=current-command=="]
                body = core.command_envelope(raw, text, scope)
                self.assertEqual(body["activity_code"], "7K4M2Q9R")
                self.assertEqual(body["content"], text)
                self.assertEqual(body["message_idx"], "current-command==")
                self.assertNotIn("ref_idx", body)
                self.assertNotIn("activityId", body)

    def test_activity_code_with_quote_preserves_both_independent_indices(self):
        raw = self.raw()
        raw["content"] = "报名 7K4M2Q9R MT 骑士"
        body = core.command_envelope(raw, raw["content"], core.Scope("app", "bot", "group"))
        self.assertEqual(body["activity_code"], "7K4M2Q9R")
        self.assertEqual(body["ref_idx"], "REFIDX_abc==")
        self.assertEqual(body["message_idx"], "self")
        self.assertNotEqual(body["message_idx"], body["ref_idx"])

    def test_activity_code_ascii_case_and_whitespace(self):
        for code in ("7K4M2Q9R", "7k4m2q9r", "7k4M2q9R", "23456789", "Z8Y7X6W5"):
            for separator in (" ", "\t", "\n", "\u3000"):
                text = "报名" + separator + code + " MT 骑士"
                with self.subTest(code=code, separator=repr(separator)):
                    raw = self.raw()
                    raw["content"] = text
                    raw["message_scene"]["ext"] = ["msg_idx=current"]
                    body = core.command_envelope(raw, text, core.Scope("app", "bot", "group"))
                    self.assertEqual(body["activity_code"], code.upper())
                    self.assertEqual(body["content"], text)

    def test_activity_code_rejects_unknown_chars_and_unicode_lookalikes(self):
        invalid = ("7K4M2Q9", "7K4M2Q9RR", "7K4M2Q9I", "7K4M2Q9O", "7K4M2Q90",
                   "7K4M2Q91", "7K4M2Q9_", "7K4M2Q9-", "7K4M2Q9?", "7K4M2Q9=",
                   "7Ｋ4M2Q9R", "7K4M2Q9R", "7K4M2Q9ſ", "7K4М2Q9R", "７K4M2Q9R",
                   "7K4M2Q9\u200bR", "7K4M2Q9R\x00", "7K4M2Q9R,", "activityId=test")
        for value in invalid:
            text = "报名 " + value + " MT 骑士"
            with self.subTest(value=value):
                self.assertIsNone(core.registration_activity_code(text))
                raw = self.raw()
                raw["content"] = text
                raw["message_scene"]["ext"] = ["msg_idx=current"]
                with self.assertRaises(core.Rejected):
                    core.command_envelope(raw, text, core.Scope("app", "bot", "group"))

    def test_activity_code_requires_the_complete_first_argument(self):
        for text in ("报名7K4M2Q9R MT 骑士", "报名 A队 7K4M2Q9R H1 白魔",
                     "报名 MT 骑士 7K4M2Q9R", "报名 7K4M2Q9RMT 骑士"):
            with self.subTest(text=text):
                self.assertIsNone(core.registration_activity_code(text))
                raw = self.raw()
                raw["content"] = text
                raw["message_scene"]["ext"] = ["msg_idx=current"]
                with self.assertRaises(core.Rejected):
                    core.command_envelope(raw, text, core.Scope("app", "bot", "group"))

    def test_activity_code_optional_quote_rejects_invalid_and_ambiguous_fields(self):
        invalid_ext = ({}, ["msg_idx=self", 4], ["msg_idx=self", "ref_msg_idx"],
                       ["msg_idx=self", "ref_msg_idx="],
                       ["msg_idx=self", "ref_msg_idx=x", "ref_msg_idx=x"],
                       ["msg_idx=self", "ref_msg_idx=x", "ref_msg_idx=y"],
                       ["msg_idx=self", "ref_msg_idx=x", "ref_msg_idx"],
                       ["msg_idx=self", "ref_msg_idx=bad value"])
        for ext in invalid_ext:
            with self.subTest(ext=ext):
                raw = self.raw()
                raw["content"] = "报名 7K4M2Q9R"
                raw["message_scene"]["ext"] = ext
                with self.assertRaises(core.Rejected):
                    core.command_envelope(raw, raw["content"], core.Scope("app", "bot", "group"))

    def test_activity_code_keeps_current_message_index_mandatory(self):
        for ext in ([], ["ref_msg_idx=quoted"], ["msg_idx="],
                    ["msg_idx=x", "msg_idx=x"]):
            with self.subTest(ext=ext):
                raw = self.raw()
                raw["content"] = "报名 7K4M2Q9R"
                raw["message_scene"]["ext"] = ext
                with self.assertRaises(core.Rejected):
                    core.command_envelope(raw, raw["content"], core.Scope("app", "bot", "group"))

    def test_legacy_registration_still_requires_exact_quote(self):
        for text in ("报名", "报名 MT 骑士", "报名 A队 H1 白魔"):
            raw = self.raw()
            raw["content"] = text
            with self.subTest(text=text):
                body = core.command_envelope(raw, text, core.Scope("app", "bot", "group"))
                self.assertEqual(body["ref_idx"], "REFIDX_abc==")
                self.assertNotIn("activity_code", body)
                raw["message_scene"]["ext"] = ["msg_idx=self"]
                raw["message_reference"] = {"message_id": "ordinary"}
                with self.assertRaises(core.Rejected):
                    core.command_envelope(raw, text, core.Scope("app", "bot", "group"))

    def test_activity_code_keeps_native_event_boundary_checks(self):
        scope = core.Scope("app", "bot", "group")
        changes = ({"group_openid": "other"}, {"id": ""},
                   {"author": {"user_openid": "private"}},
                   {"timestamp": "2026-10-26T01:00:00"}, {"timestamp": None},
                   {"content": "报名 Z8Y7X6W5"},
                   {"content": "<@stranger> 报名 7K4M2Q9R"})
        for change in changes:
            with self.subTest(field=next(iter(change))):
                raw = self.raw()
                raw["content"] = "报名 7K4M2Q9R"
                raw["message_scene"]["ext"] = ["msg_idx=current"]
                raw.update(change)
                with self.assertRaises(core.Rejected):
                    core.command_envelope(raw, "报名 7K4M2Q9R", scope)
        raw = self.raw()
        raw["content"] = '<qqbot-at-user id="native_self"/> 报名 7k4m2q9r'
        raw["message_scene"]["ext"] = ["msg_idx=current"]
        raw["activityId"] = "untrusted"
        raw["activity_code"] = "Z8Y7X6W5"
        body = core.command_envelope(raw, "报名 7k4m2q9r", scope,
                                     own_mention_ids=("native_self",))
        self.assertEqual(body["activity_code"], "7K4M2Q9R")
        self.assertNotIn("activityId", body)

    def test_private_openid_does_not_bind_to_member(self):
        raw = self.raw()
        raw["author"] = {"user_openid": "private-identity"}
        with self.assertRaises(core.Rejected):
            core.command_envelope(raw, "绑定 ABC_def-123", core.Scope("app", "bot", "group"))

    def test_other_group_cannot_be_rewritten(self):
        with self.assertRaises(core.Rejected):
            core.command_envelope(self.raw(), "报名", core.Scope("app", "bot", "other"))

    def test_own_mentions_normalize_both_binding_rounds_and_registration(self):
        scope=core.Scope("app","bot","group")
        commands=["绑定 Synthetic_binding_001","确认绑定 "+"p"*43,"报名 H1 白魔","报名 A队 H1 白魔","报名"]
        for command in commands:
            for prefix in ('<@bot>','<@!app>','<qqbot-at-user id="native_self"/>','<qqbot-at-user  id="native_self" />'):
                raw=self.raw();raw["content"]="  "+prefix+"  "+command+"  "
                body=core.command_envelope(raw,command,scope,own_mention_ids=("native_self",))
                self.assertEqual(body["content"],command)
                self.assertEqual(body["bot_id"],"bot")
                if command.startswith("报名"):self.assertEqual(body["ref_idx"],"REFIDX_abc==")

    def test_unverified_mentions_and_normalized_text_substitution_rejected(self):
        scope=core.Scope("app","bot","group");raw=self.raw()
        for content,text,ids in [('<@stranger> 报名','报名',()),('报名 H1 白魔','报名 H1 学者',()),('<qqbot-at-user id="native_self"/> 绑定 Synthetic_binding_001','绑定 Synthetic_binding_001',())]:
            raw["content"]=content
            with self.assertRaises(core.Rejected):core.command_envelope(raw,text,scope,own_mention_ids=ids)

    def test_hmac_known_vector_uses_raw_body_and_path(self):
        body = b'{"x":1}'
        material = "123\nnonce\nPOST\n/api/test\n" + hashlib.sha256(body).hexdigest()
        expected = hmac.new(b"k" * 32, material.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(core.sign(b"k" * 32, "123", "nonce", "POST", "/api/test", body),
                         expected)
        self.assertNotEqual(expected, core.sign(b"k" * 32, "123", "nonce", "POST",
                                               "/api/other", body))
        with self.assertRaises(core.Rejected):
            core.sign(b"short", "123", "nonce", "POST", "/api/test", body)

    def test_rate_window_scoped_and_no_burst_after_limit(self):
        now = [0]
        rate = core.RateLimiter(1, 2, lambda: now[0])
        a, b = core.Scope("a", "b", "g"), core.Scope("a", "b", "h")
        self.assertTrue(rate.acquire(a))
        self.assertFalse(rate.acquire(a))
        self.assertTrue(rate.acquire(b))
        now[0] = 61
        self.assertTrue(rate.acquire(a))
        now[0] = 122
        self.assertFalse(rate.acquire(a))

    def test_outgoing_user_text_cannot_activate_qq_markup_or_mentions(self):
        self.assertEqual(core.sanitize_qq_text('<qqbot-at-all/> @everyone\x00\u200b\n报名'),
                         '＜qqbot-at-all/＞ ＠everyone\n报名')
        with self.assertRaises(core.Rejected):
            core.sanitize_qq_text("\x00\u200b")

    def test_whitespace_variants_are_recognized_before_any_model_fallback(self):
        for separator in ("\t", "\n", "\u3000"):
            with self.subTest(separator=repr(separator)):
                self.assertEqual(core.parse_command("绑定" + separator + "mock_code123"), "bind")
                self.assertEqual(core.parse_command("确认绑定" + separator + "A" * 43), "bind")
                self.assertEqual(core.parse_command("退出" + separator + "活动"), "website_only")
                self.assertEqual(core.parse_command("绑定" + separator), "invalid")
        self.assertEqual(core.parse_command("  绑定\ttoo_short?  "), "invalid")
        self.assertEqual(core.parse_command("\u3000报名 H1 白魔"), "register")


if __name__ == "__main__":
    unittest.main()
