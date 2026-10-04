#!/usr/bin/env python3
"""Manage the RaytoneBot sandbox lifecycle on AgentSphere (E2B fork, SDK 1.x for files/commands).

  sandbox.py create [--template agentmatrix-v1] [--timeout SECONDS]
  sandbox.py status | wake | pause | renew [SECONDS]
  sandbox.py backup                 # pull data, workspaces and native CLI sessions
  sandbox.py restore FILE           # validate, stop writers, restore; deploy again to restart

`create` makes a sandbox that PAUSES at its timeout instead of being destroyed (full memory
snapshot: processes, files and open ports come back as they were). The platform's proxy does
not wake a paused sandbox on HTTP access, so `wake` resumes it (about 1 s); `deploy.py`
afterwards puts the app on a new sandbox. Lifecycle cannot be changed on an existing sandbox.

Needs E2B_DOMAIN=agentsphere.run and E2B_API_KEY in this machine's environment only.
State lives in the untracked .agentsphere/deployment.json.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shlex
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from backup_data import DATA_PATHS, validate_archive
from deploy import http

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".agentsphere" / "deployment.json"
BACKUPS = ROOT / "backups"
API = "https://api.agentsphere.run"
DEFAULT_TIMEOUT = 50 * 3600  # the platform maximum ("Timeout cannot be greater than 50 hours")


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def api(method: str, path: str, body: dict | None = None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": os.environ["E2B_API_KEY"], "Content-Type": "application/json"},
    )
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        return code, None


def state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(data: dict) -> None:
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(data, indent=2))


def sandbox_id(data: dict) -> str:
    sid = data.get("sandboxId")
    if not sid:
        fail("no sandbox in .agentsphere/deployment.json; run `create` first")
    return sid


def info(sid: str) -> dict:
    status, body = api("GET", f"/sandboxes/{sid}")
    if status != 200 or not isinstance(body, dict):
        fail(f"sandbox {sid}: HTTP {status}")
    return body


def connect(sid: str):
    from e2b import Sandbox
    return Sandbox.connect(sid)


def run(sandbox, command: str, timeout: int = 300):
    from e2b.sandbox.commands.command_handle import CommandExitException
    try:
        return sandbox.commands.run(command, timeout=timeout)
    except CommandExitException as error:
        fail(f"remote command failed ({error.exit_code}): {command[:80]}\n{error.stderr[-600:]}")


def cmd_create(args) -> None:
    status, body = api("POST", "/sandboxes", {
        "templateID": args.template,
        "timeout": args.timeout,
        "autoPause": True,
        "autoResume": {"enabled": True},
    })
    if status >= 300 or not isinstance(body, dict):
        fail(f"create: HTTP {status}")
    sid = body["sandboxID"]
    details = info(sid)
    data = state()
    if data.get("sandboxId"):
        data.setdefault("previousSandboxes", []).append(data["sandboxId"])
    data.update({
        "sandboxId": sid,
        "template": args.template,
        "url": f"https://5188-{sid}.agentsphere.run",
        "lifecycle": details.get("lifecycle"),
        "expiresAt": details.get("endAt"),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    })
    save(data)
    print(f"created {sid}  lifecycle={details.get('lifecycle')}  ends {details.get('endAt')}")
    print("next: scripts/agentsphere/deploy.py  (deploys to this sandbox)")


def app_health(sid: str) -> dict:
    try:
        access = STATE.parent / "access.json"
        password = json.loads(access.read_text()).get("password") if access.exists() else None
        if not password:
            return {"status": "unavailable", "reason": "missing access password"}
        status, body = http(f"https://5188-{sid}.agentsphere.run/__agentcanvas/pi/health", password)
        data = json.loads(body) if status == 200 else {}
        if not isinstance(data, dict) or data.get("status") != "ok" or type(data.get("activeRuns")) is not int:
            return {"status": "unavailable", "httpStatus": status}
        return {key: data[key] for key in ("status", "activeRuns", "maxConcurrentRuns", "uptimeSeconds") if key in data}
    except (OSError, ValueError):
        return {"status": "unreachable"}


def cmd_status(args) -> None:
    sid = sandbox_id(state())
    details = info(sid)
    result = {key: details.get(key) for key in ("sandboxID", "state", "endAt", "lifecycle", "cpuCount", "memoryMB", "diskSizeMB")}
    result["app"] = app_health(sid) if details.get("state") == "running" else {"status": "paused"}
    print(json.dumps(result, indent=2))
    if args.logs and details.get("state") == "running":
        logs = run(connect(sid), f"tail -n {args.logs} /home/user/.raytonebot/logs/supervisor.jsonl "
                                "/home/user/.raytonebot/logs/runtime.jsonl 2>/dev/null || true")
        print(logs.stdout.rstrip())


def cmd_wake(args) -> None:
    sid = sandbox_id(state())
    current = info(sid).get("state")
    if current == "running":
        print("already running")
        return
    started = time.time()
    status, body = api("POST", f"/sandboxes/{sid}/resume", {"timeout": args.timeout})
    if status >= 300:
        fail(f"resume: HTTP {status}")
    print(f"resumed in {time.time() - started:.1f}s; ends {info(sid).get('endAt')}")


def cmd_pause(_args) -> None:
    sid = sandbox_id(state())
    status, body = api("POST", f"/sandboxes/{sid}/pause")
    if status >= 300:
        fail(f"pause: HTTP {status}")
    print("paused")


def cmd_renew(args) -> None:
    sid = sandbox_id(state())
    connect(sid).set_timeout(args.seconds)
    data = state()
    data["expiresAt"] = info(sid).get("endAt")
    save(data)
    print(f"ends {data['expiresAt']}")


def archive_worker(sandbox, operation: str, archive: str) -> None:
    worker = f"/home/user/.rtb-backup-worker-{uuid.uuid4().hex}.py"
    sandbox.files.write(worker, Path(__file__).with_name("backup_data.py").read_bytes())
    try:
        run(sandbox, f"sudo -n python3 {shlex.quote(worker)} {operation} {shlex.quote(archive)}")
        if operation == "create":
            run(sandbox, f"sudo -n chown user:user {shlex.quote(archive)}")
    finally:
        run(sandbox, f"rm -f {shlex.quote(worker)}")


def cmd_backup(args) -> None:
    sid = sandbox_id(state())
    if getattr(args, "scheduled", False):
        scheduled_backup(sid)
        return
    backup(sid)


def backup(sid: str, *, quiet=False) -> Path:
    sandbox = connect(sid)
    archive = f"/home/user/.rtb-backup-{uuid.uuid4().hex}.tgz"
    present = " ".join(path for path in DATA_PATHS)
    try:
        archive_worker(sandbox, "create", archive)
        payload = bytes(sandbox.files.read(archive, format="bytes"))
    finally:
        run(sandbox, f"rm -f {shlex.quote(archive)}")
    BACKUPS.mkdir(exist_ok=True)
    target = BACKUPS / f"{sid}-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.tgz"
    partial = target.with_suffix(".partial")
    try:
        with partial.open("xb") as output:
            partial.chmod(0o600)
            output.write(payload)
        validate_archive(partial)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    if not quiet:
        print(f"backup: {target.relative_to(ROOT)} ({len(payload) // 1024} KB; {present})")
    return target


def scheduled_backup(sid: str) -> None:
    """Native cron/launchd entry point: never wake a paused host or overlap another backup."""
    STATE.parent.mkdir(exist_ok=True)
    with (STATE.parent / "backup.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            backup_event("backup_skipped", reason="already running")
            return
        if info(sid).get("state") != "running":
            backup_event("backup_skipped", reason="sandbox paused")
            return
        health = app_health(sid)
        if health.get("status") != "ok":
            backup_event("backup_failed", reason="app health unavailable")
            raise SystemExit(1)
        if health["activeRuns"]:
            backup_event("backup_skipped", reason="active tasks")
            return
        try:
            target = backup(sid, quiet=True)
        except (Exception, SystemExit):
            backup_event("backup_failed", reason="archive or transfer failed")
            raise
        backup_event("backup_completed", archive=target.name)


def backup_event(event: str, **fields) -> None:
    print(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "event": event, **fields}))


def cmd_restore(args) -> None:
    source = Path(args.file)
    if not source.exists():
        fail(f"no such file: {source}")
    validate_archive(source)
    sid = sandbox_id(state())
    sandbox = connect(sid)
    # The archive holds every conversation: it lands in a bot-only directory, never readable by
    # the agent UID while writers are still running.
    private = f"/home/user/.rtb-upload-{uuid.uuid4().hex}"
    upload = f"{private}/restore.tgz"
    run(sandbox, f"mkdir -m 700 {shlex.quote(private)}")
    try:
        sandbox.files.write(upload, source.read_bytes())
        archive_worker(sandbox, "restore", upload)
    finally:
        run(sandbox, f"rm -rf {shlex.quote(private)}")
    print("restored; replaced data kept in /home/user/.rtb-restore-previous until the next restore")
    print("run deploy.py --skip-build to start the app again")


def main() -> None:
    if os.environ.get("E2B_DOMAIN") != "agentsphere.run" or not os.environ.get("E2B_API_KEY"):
        fail("set E2B_DOMAIN=agentsphere.run and E2B_API_KEY")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--template", default="agentmatrix-v1")
    create.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    create.set_defaults(handler=cmd_create)
    status = sub.add_parser("status")
    status.add_argument("--logs", type=int, choices=range(1, 201), metavar="1..200", help="tail bounded operational logs")
    status.set_defaults(handler=cmd_status)
    wake = sub.add_parser("wake")
    wake.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    wake.set_defaults(handler=cmd_wake)
    sub.add_parser("pause").set_defaults(handler=cmd_pause)
    renew = sub.add_parser("renew")
    renew.add_argument("seconds", type=int, nargs="?", default=DEFAULT_TIMEOUT)
    renew.set_defaults(handler=cmd_renew)
    backup_parser = sub.add_parser("backup")
    backup_parser.add_argument("--scheduled", action="store_true", help="skip paused/busy hosts and overlapping backups; never wakes")
    backup_parser.set_defaults(handler=cmd_backup)
    restore = sub.add_parser("restore")
    restore.add_argument("file")
    restore.set_defaults(handler=cmd_restore)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
