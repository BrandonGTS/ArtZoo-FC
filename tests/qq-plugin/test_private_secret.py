import os
import tempfile
import unittest
from pathlib import Path
from plugins.astrbot_plugin_artzoo.runtime import Settings, configured_bridge
from plugins.astrbot_plugin_artzoo.core import Rejected

class PrivateSecretTests(unittest.TestCase):
    def settings(self):
        return Settings({"bridge_secret_from_data_file": True, "bridge_origin": "http://127.0.0.1:3101", "allow_loopback_http": True})

    def test_private_fixed_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/"bridge.secret";p.write_bytes(b"synthetic-file-only-secret-00000000");p.chmod(0o600)
            self.assertIsNotNone(configured_bridge(self.settings(),root))
            p.chmod(0o400)
            self.assertIsNotNone(configured_bridge(self.settings(),root))
            for mode in (0o644,0o660,0o700):
                p.chmod(mode)
                with self.assertRaises(Rejected):configured_bridge(self.settings(),root)
            p.chmod(0o600)
            for value in (b"short",b"x"*257,b"x"*32+b"\n"):
                p.write_bytes(value)
                with self.assertRaises(Rejected):configured_bridge(self.settings(),root)

    def test_missing_symlink_and_unsafe_directory(self):
        with self.assertRaises(Rejected):configured_bridge(self.settings())
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/"bridge.secret"
            with self.assertRaises(Rejected):configured_bridge(self.settings(),root)
            target=root/"other";target.write_bytes(b"synthetic-file-only-secret-00000000");target.chmod(0o600);p.symlink_to(target)
            with self.assertRaises(Rejected):configured_bridge(self.settings(),root)
            p.unlink();p.write_bytes(b"synthetic-file-only-secret-00000000");p.chmod(0o600);root.chmod(0o777)
            with self.assertRaises(Rejected):configured_bridge(self.settings(),root)
            root.chmod(0o700)
