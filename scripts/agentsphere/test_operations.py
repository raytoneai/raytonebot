"""Local-only operation checks; no credentials, network, cloud resources or OS-user changes."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from unittest.mock import patch

import sandbox
from deploy import http
from backup_data import restore_owners

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from supervisor import supervise


class OperationsTest(unittest.TestCase):
    def test_http_credentials_are_not_forwarded_through_redirects(self):
        requested = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requested.append(self.path)
                self.send_response(302 if self.path == "/start" else 200)
                self.send_header("Location", "/sink")
                self.end_headers()
                self.wfile.write(b"{}")

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            with patch.dict(os.environ, {"E2B_API_KEY": "test-sentinel", "no_proxy": "*", "NO_PROXY": "*"}), \
                    patch.object(sandbox, "API", origin):
                self.assertEqual(sandbox.api("GET", "/start"), (302, None))
                self.assertEqual(http(origin + "/start", "test-password")[0], 302)
            self.assertEqual(requested, ["/start", "/start"])
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    @unittest.skipUnless(sys.platform == "linux", "Linux subreaper check")
    def test_supervisor_reaps_detached_children_after_host_crash(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            code = ("import subprocess,sys; from pathlib import Path; "
                    "p=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True); "
                    f"Path({str(base / 'child.pid')!r}).write_text(str(p.pid)); raise SystemExit(7)")
            self.assertEqual(supervise([sys.executable, "-c", code], base / "log.jsonl", max_restarts=0), 7)
            pid = int((base / "child.pid").read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    @unittest.skipUnless(sys.platform == "linux", "Linux isolated-UID subreaper check")
    def test_supervisor_stops_orphans_owned_by_the_agent(self):
        import pwd
        try:
            pwd.getpwnam("raytone-agent")
        except KeyError:
            self.skipTest("isolated agent not installed")
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            base.chmod(0o770)
            agent_code = ("import os,time; from pathlib import Path; "
                          f"Path({str(base / 'agent.pid')!r}).write_text(str(os.getpid())); time.sleep(30)")
            command = ["sudo", "-n", "-u", "raytone-agent", "--", "setpriv", "--no-new-privs", sys.executable, "-c", agent_code]
            host_code = ("import subprocess,time; from pathlib import Path; "
                         f"subprocess.Popen({command!r}, start_new_session=True); "
                         f"p=Path({str(base / 'agent.pid')!r}); "
                         "\nfor _ in range(100):\n if p.exists(): break\n time.sleep(0.02)\n"
                         "assert p.exists(); raise SystemExit(7)")
            self.assertEqual(supervise([sys.executable, "-c", host_code], base / "log.jsonl", max_restarts=0), 7)
            pid = int((base / "agent.pid").read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_supervisor_bounds_restarts_and_does_not_record_child_output(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "supervisor.jsonl"
            result = supervise([sys.executable, "-c", "print('SECRET'); raise SystemExit(7)"], log, delay=0)
            self.assertEqual(result, 7)
            events = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(sum(item["event"] == "process_started" for item in events), 4)
            self.assertEqual(events[-1]["event"], "restart_limit")
            self.assertNotIn("SECRET", log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_supervisor_stops_without_restarting(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "supervisor.jsonl"
            code = (f"import sys; sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r}); "
                    "from supervisor import supervise; from pathlib import Path; "
                    f"raise SystemExit(supervise([sys.executable, '-c', 'import time; time.sleep(30)'], Path({str(log)!r})))")
            process = subprocess.Popen([sys.executable, "-c", code])
            try:
                until = time.monotonic() + 5
                while not log.exists() and time.monotonic() < until:
                    time.sleep(0.02)
                self.assertTrue(log.exists())
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=15), 0)
                events = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertEqual([item["event"] for item in events], ["process_started", "process_exited"])
                self.assertTrue(events[-1]["stopping"])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    def test_scheduled_backup_skips_paused_busy_and_overlapping_runs(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(sandbox, "STATE", Path(directory) / "state.json"), \
                patch.object(sandbox, "info") as info, patch.object(sandbox, "app_health") as health, \
                patch.object(sandbox, "backup", return_value=Path("backup.tgz")) as backup, \
                patch.object(sandbox, "backup_event") as event:
            info.return_value = {"state": "paused"}
            sandbox.scheduled_backup("test")
            health.assert_not_called()
            info.return_value = {"state": "running"}
            health.return_value = {"status": "ok", "activeRuns": 1}
            sandbox.scheduled_backup("test")
            backup.assert_not_called()
            health.return_value = {"status": "unreachable"}
            with self.assertRaises(SystemExit):
                sandbox.scheduled_backup("test")
            with patch.object(sandbox.fcntl, "flock", side_effect=BlockingIOError):
                sandbox.scheduled_backup("test")
            event.assert_called_with("backup_skipped", reason="already running")
            backup.assert_not_called()
            health.return_value = {"status": "ok", "activeRuns": 0}
            sandbox.scheduled_backup("test")
            backup.assert_called_once_with("test", quiet=True)

    def test_privileged_restore_keeps_bot_and_agent_ownership_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ["home/user/.raytonebot/data", "home/user/workspace", "home/raytone-agent/.codex/sessions"]
            for name in names:
                (root / name).mkdir(parents=True)
                (root / name / "state").write_text("data")
            users = {"user": SimpleNamespace(pw_uid=1000, pw_gid=1000),
                     "raytone-agent": SimpleNamespace(pw_uid=1001, pw_gid=1001)}
            with patch("backup_data.os.geteuid", return_value=0), \
                    patch("backup_data.pwd.getpwnam", side_effect=users.__getitem__), \
                    patch("backup_data.os.chown") as chown:
                restore_owners(root, names)
                chown.assert_any_call(root / names[0], 1000, 1000, follow_symlinks=False)
                chown.assert_any_call(root / names[1], 1000, 1000, follow_symlinks=False)
                chown.assert_any_call(root / names[2], 1001, 1000, follow_symlinks=False)
                self.assertTrue((root / names[1]).stat().st_mode & 0o2000)


if __name__ == "__main__":
    unittest.main()
