"""Run without the SDK or network: python3 -m unittest discover -s scripts/agentsphere -p test_deploy.py."""
import io
import hashlib
import json
import os
import sys
import tempfile
import tarfile
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import deploy
import setup_isolation


class ControlProbeTest(unittest.TestCase):
    def test_probe_exchanges_existing_entry_auth_and_keeps_cookie_private(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                seen.append((self.path, self.headers.get("Authorization"), self.headers.get("Cookie")))
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Set-Cookie", "raytone_control=synthetic; Path=/__agentcanvas/pi; HttpOnly")
                self.end_headers()
                self.wfile.write(b'{"authenticated":true}')
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization"), self.headers.get("Cookie")))
                self.send_response(200 if self.headers.get("Cookie") == "raytone_control=synthetic" else 401)
                self.end_headers()
                self.wfile.write(b'{"available":true}')
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/__agentcanvas/pi/state"
            with patch.dict(os.environ, {"no_proxy": "127.0.0.1,localhost"}):
                self.assertEqual(deploy.http(url, "synthetic-password", control_session=True)[0], 200)
            self.assertEqual([item[0] for item in seen], ["/__agentcanvas/pi/auth/exchange", "/__agentcanvas/pi/state"])
            self.assertIsNone(seen[0][2])
            self.assertEqual(seen[1][2], "raytone_control=synthetic")
            self.assertTrue(all(item[1].startswith("Basic ") for item in seen))
            with patch.dict(os.environ, {"no_proxy": "127.0.0.1,localhost"}):
                self.assertEqual(deploy.http(url, "synthetic-password")[0], 401, "cookie is confined to one probe")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class FirewallCheckTest(unittest.TestCase):
    def test_rejects_missing_or_modified_rules(self):
        owner = {"match": {"op": "==", "left": {"meta": {"key": "skuid"}}, "right": 1234}}
        address = {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": "127.0.0.1"}}
        port = {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 5190}}
        chain = {"family": "ip", "table": "raytone_agent", "name": "output", "type": "filter", "hook": "output", "prio": -10, "policy": "accept"}
        def rule(expr):
            return {"rule": {"family": "ip", "table": "raytone_agent", "chain": "output", "expr": expr}}
        valid = {"nftables": [{"chain": chain}, rule([owner, address, port, {"accept": None}]), rule([owner, {"drop": None}])]}
        check = lambda data: setup_isolation.verify_table(data, "ip", "raytone_agent", 1234, [("daddr", "dport", 5190)])
        check(valid)
        for modified in (
            {"nftables": valid["nftables"][:-1]},
            {"nftables": valid["nftables"] + [rule([{"accept": None}])]},
            {"nftables": [{"chain": {**chain, "prio": 10}}, *valid["nftables"][1:]]},
            {"nftables": [{"chain": chain}, rule([owner, address, {**port, "match": {**port["match"], "op": "!="}}, {"accept": None}]), valid["nftables"][-1]]},
        ):
            with self.assertRaises(RuntimeError):
                check(modified)

    def test_workspace_initialization_uses_unprivileged_account(self):
        with patch.object(setup_isolation, "run") as run:
            setup_isolation.initialize_workspace(Path("/srv/app"), Path("/srv/work"), "/usr/bin/node")
        args = run.call_args.args
        self.assertEqual(args[:6], ("sudo", "-n", "-u", "user", "--", "/usr/bin/node"))
        self.assertEqual(args[-2:], ("/srv/app", "/srv/work"))


class PackageTest(unittest.TestCase):
    def test_package_excludes_untracked_and_nested_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("scripts/app.py", "docs/observer.md", "scripts/.env.local", "scripts/id_ed25519", "scripts/private.txt", "dist/index.html", "dist/.env.production"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            with patch.object(deploy, "ROOT", root), patch.object(deploy.subprocess, "check_output", return_value=b"scripts/app.py\0docs/observer.md\0scripts/.env.local\0scripts/id_ed25519\0"):
                with tarfile.open(fileobj=io.BytesIO(deploy.package()), mode="r:gz") as archive:
                    names = archive.getnames()
                    manifest = json.load(archive.extractfile("OBSERVER-BUILD.json"))
                    canonical = json.dumps(manifest["files"], ensure_ascii=False, separators=(",", ":")).encode()
                    self.assertEqual(manifest["manifestHash"], hashlib.sha256(canonical).hexdigest())
                    for entry in manifest["files"]:
                        data = archive.extractfile(entry["path"]).read()
                        self.assertEqual(entry["hash"], hashlib.sha256(data).hexdigest())
                        self.assertEqual(entry["bytes"], len(data))
                    self.assertEqual({entry["path"] for entry in manifest["files"]}, {"scripts/app.py", "docs/observer.md", "dist/index.html"})
            self.assertIn("scripts/app.py", names)
            self.assertIn("docs/observer.md", names)
            self.assertIn("dist/index.html", names)
            self.assertFalse(any(".env" in name or "id_ed25519" in name or "private.txt" in name for name in names))


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
                        stdout = "RAYTONEBOT_BROWSER_HEADED=1\nRAYTONEBOT_DSH_ISOLATED=1\nDEEPSEEK_API_KEY=model-secret\n"
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
                self.assertIn("RAYTONEBOT_DSH_ISOLATED=1\n", env)
                self.assertIn("DEEPSEEK_API_KEY=model-secret", env)
                self.assertNotIn("team-secret", env)
                self.assertNotIn("model-secret", output.getvalue())
                self.assertNotIn("team-secret", output.getvalue())
                self.assertFalse((root / "verification.json").exists())


if __name__ == "__main__":
    unittest.main()
