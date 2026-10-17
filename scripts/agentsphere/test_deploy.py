"""Run without the SDK or network: python3 -m unittest discover -s scripts/agentsphere -p test_deploy.py."""
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import deploy


class BrowserModeTest(unittest.TestCase):
    def test_cli_distinguishes_unspecified_headed_and_headless(self):
        for flags, expected in (([], None), (["--headed-browser"], "headed"),
                                (["--headless-browser"], "headless")):
            with self.subTest(flags=flags):
                self.assertEqual(deploy.parse_args(flags).browser_mode, expected)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            deploy.parse_args(["--headed-browser", "--headless-browser"])

    def test_explicit_choice_overrides_saved_and_remote_modes(self):
        for mode in ("headed", "headless"):
            other = "headless" if mode == "headed" else "headed"
            self.assertEqual(deploy.resolve_browser_mode(mode, {
                "sandboxId": "same", "browserMode": other,
            }, "same", {"RAYTONEBOT_BROWSER_HEADED": "1"}), mode)

    def test_same_sandbox_state_wins_over_remote_env(self):
        self.assertEqual(deploy.resolve_browser_mode(None, {
            "sandboxId": "same", "browserMode": "headed",
        }, "same", {"RAYTONEBOT_BROWSER_HEADED": "0"}), "headed")

    def test_other_sandbox_state_is_not_reused(self):
        state = {"sandboxId": "other", "browserMode": "headed"}
        self.assertEqual(deploy.resolve_browser_mode(None, state, "new", {}), "headless")
        self.assertEqual(deploy.resolve_browser_mode(None, state, "new", {
            "RAYTONEBOT_BROWSER_HEADED": "1",
        }), "headed")

    def test_legacy_env_modes_and_no_information_default(self):
        for value, expected in (("1", "headed"), ("0", "headless")):
            self.assertEqual(deploy.resolve_browser_mode(None, {"sandboxId": "same"}, "same", {
                "RAYTONEBOT_BROWSER_HEADED": value,
            }), expected)
        self.assertEqual(deploy.resolve_browser_mode(None, {}, "new", {}), "headless")

    def test_invalid_modes_fail_without_echoing_values(self):
        for value in ("SECRET", "", None, False, []):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "invalid browserMode") as error:
                    deploy.resolve_browser_mode(None, {"sandboxId": "same", "browserMode": value}, "same", {})
                self.assertNotIn("SECRET", str(error.exception))
        with self.assertRaisesRegex(ValueError, "invalid explicit"):
            deploy.resolve_browser_mode("invalid", {}, "same", {})
        with self.assertRaisesRegex(ValueError, "invalid RAYTONEBOT_BROWSER_HEADED"):
            deploy.resolve_browser_mode(None, {}, "same", {"RAYTONEBOT_BROWSER_HEADED": "true"})
        self.assertEqual(deploy.resolve_browser_mode("headless", {
            "sandboxId": "same", "browserMode": "invalid",
        }, "same", {}), "headless")

    def test_remember_mode_preserves_last_verified_metadata_only_for_same_sandbox(self):
        original = {"sandboxId": "same", "deployedAt": "last-verified", "supervisorPid": 10}
        with tempfile.TemporaryDirectory() as temporary, patch.object(deploy, "STATE_DIR", Path(temporary)):
            remembered = deploy.remember_browser_mode(original, "same", "headed")
            self.assertEqual(remembered, {**original, "browserMode": "headed"})
            self.assertNotIn("browserMode", original)
            self.assertEqual(json.loads((Path(temporary) / "deployment.json").read_text()), remembered)
            self.assertFalse((Path(temporary) / "deployment.json.tmp").exists())
            self.assertEqual(deploy.remember_browser_mode(original, "new", "headless"), {
                "sandboxId": "new", "browserMode": "headless",
            })

    def test_remote_env_read_and_parse_failures_hide_credentials(self):
        for result in (SimpleNamespace(exit_code=1, stdout="SECRET"),
                       SimpleNamespace(exit_code=0, stdout="DEEPSEEK_API_KEY='SECRET"),
                       SimpleNamespace(exit_code=0, stdout="RAYTONEBOT_BROWSER_HEADED=1 SECRET")):
            captured = io.StringIO()
            with patch.object(deploy, "run", return_value=result), redirect_stderr(captured):
                with self.assertRaises(SystemExit):
                    deploy.read_previous_env(object())
            self.assertNotIn("SECRET", captured.getvalue())

    def test_tls_failure_still_remembers_legacy_mode_before_public_verification(self):
        # No deployment.json models the old deploy that failed its final public TLS check.
        for flags, expected in (([], "headed"), (["--headless-browser"], "headless")):
            with self.subTest(flags=flags), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "access.json").write_text(json.dumps({"password": "password-" * 4}))
                (root / "package-lock.json").write_text("lock")
                commands = []
                writes = {}
                sandbox = SimpleNamespace(files=SimpleNamespace(write=lambda name, data: writes.update({name: data})))

                def remote(_sandbox, command, **_kwargs):
                    commands.append(command)
                    stdout = ""
                    if command.startswith("if [ -e"):
                        stdout = "RAYTONEBOT_BROWSER_HEADED=1\nDEEPSEEK_API_KEY=model-secret\n"
                    elif command == "fd --help":
                        stdout = "--no-require-git"
                    elif command.startswith("node -p"):
                        stdout = "1248"
                    elif command.startswith("command -v "):
                        stdout = "/usr/bin/node"
                    elif command.startswith("ss -ltnp"):
                        stdout = "listening"
                    elif command.startswith("pgrep"):
                        stdout = "123"
                    return SimpleNamespace(exit_code=0, stdout=stdout)

                def tls_failure(*_args):
                    self.assertEqual(json.loads((root / "deployment.json").read_text()), {
                        "sandboxId": "test", "browserMode": expected,
                    })
                    raise urllib.error.URLError("TLS unavailable")

                output = io.StringIO()
                with patch.dict(sys.modules, {"e2b": SimpleNamespace(Sandbox=SimpleNamespace(connect=Mock(return_value=sandbox)))}), \
                        patch.dict(deploy.os.environ, {"E2B_DOMAIN": "agentsphere.run", "E2B_API_KEY": "team-secret"}, clear=True), \
                        patch.object(sys, "argv", ["deploy.py", "--sandbox", "test", "--skip-build", "--state-dir", temporary, *flags]), \
                        patch.object(deploy, "ROOT", root), patch.object(deploy, "STATE_DIR", root), \
                        patch.object(deploy, "run", side_effect=remote), patch.object(deploy, "package", return_value=b"bundle"), \
                        patch.object(deploy.time, "sleep"), patch.object(deploy, "http", side_effect=tls_failure), \
                        redirect_stdout(output), redirect_stderr(output):
                    with self.assertRaises(urllib.error.URLError):
                        deploy.main()
                self.assertTrue(commands[0].startswith("if [ -e"))
                self.assertTrue(any("backup_data.py stop" in command for command in commands))
                env = writes[f"{deploy.CONFIG_DIR}/env"]
                self.assertIn(f"RAYTONEBOT_BROWSER_HEADED={'1' if expected == 'headed' else '0'}\n", env)
                self.assertIn("DEEPSEEK_API_KEY=model-secret", env)
                self.assertNotIn("team-secret", env)
                self.assertNotIn("model-secret", output.getvalue())
                self.assertNotIn("team-secret", output.getvalue())
                self.assertFalse((root / "verification.json").exists())


if __name__ == "__main__":
    unittest.main()
