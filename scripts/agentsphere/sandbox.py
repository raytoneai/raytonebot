#!/usr/bin/env python3
"""Manage the RaytoneBot sandbox lifecycle on AgentSphere (E2B fork, SDK 1.x for files/commands).

  sandbox.py create [--template agentmatrix-v1] [--timeout SECONDS]
  sandbox.py status | wake | pause | renew [SECONDS]
  sandbox.py backup                 # pull conversations + workspaces to backups/<time>.tgz
  sandbox.py restore FILE           # push a backup into the sandbox and restart the app

`create` makes a sandbox that PAUSES at its timeout instead of being destroyed (full memory
snapshot: processes, files and open ports come back as they were). The platform's proxy does
not wake a paused sandbox on HTTP access, so `wake` resumes it (about 1 s); `deploy.py`
afterwards puts the app on a new sandbox. Lifecycle cannot be changed on an existing sandbox.

Needs E2B_DOMAIN=agentsphere.run and E2B_API_KEY in this machine's environment only.
State lives in the untracked .agentsphere/deployment.json.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".agentsphere" / "deployment.json"
BACKUPS = ROOT / "backups"
API = "https://api.agentsphere.run"
DATA_PATHS = ["/home/user/.raytonebot/data", "/home/user/workspace"]
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
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors="replace")[:300]


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
        fail(f"sandbox {sid}: HTTP {status} {body}")
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
        fail(f"create: HTTP {status} {body}")
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


def cmd_status(_args) -> None:
    sid = sandbox_id(state())
    details = info(sid)
    print(json.dumps({key: details.get(key) for key in ("sandboxID", "state", "endAt", "lifecycle", "cpuCount", "memoryMB", "diskSizeMB")}, indent=2))


def cmd_wake(args) -> None:
    sid = sandbox_id(state())
    current = info(sid).get("state")
    if current == "running":
        print("already running")
        return
    started = time.time()
    status, body = api("POST", f"/sandboxes/{sid}/resume", {"timeout": args.timeout})
    if status >= 300:
        fail(f"resume: HTTP {status} {body}")
    print(f"resumed in {time.time() - started:.1f}s; ends {info(sid).get('endAt')}")


def cmd_pause(_args) -> None:
    sid = sandbox_id(state())
    status, body = api("POST", f"/sandboxes/{sid}/pause")
    if status >= 300:
        fail(f"pause: HTTP {status} {body}")
    print("paused")


def cmd_renew(args) -> None:
    sid = sandbox_id(state())
    connect(sid).set_timeout(args.seconds)
    data = state()
    data["expiresAt"] = info(sid).get("endAt")
    save(data)
    print(f"ends {data['expiresAt']}")


def cmd_backup(_args) -> None:
    sid = sandbox_id(state())
    sandbox = connect(sid)
    archive = f"/home/user/.rtb-backup-{int(time.time())}.tgz"
    present = " ".join(path for path in DATA_PATHS)
    run(sandbox, f"tar czf {archive} --ignore-failed-read -C / {' '.join(p.lstrip('/') for p in DATA_PATHS)} 2>/dev/null || test -s {archive}")
    payload = sandbox.files.read(archive, format="bytes")
    run(sandbox, f"rm -f {archive}")
    BACKUPS.mkdir(exist_ok=True)
    target = BACKUPS / f"{sid}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.tgz"
    target.write_bytes(bytes(payload))
    print(f"backup: {target.relative_to(ROOT)} ({len(payload) // 1024} KB; {present})")


def cmd_restore(args) -> None:
    source = Path(args.file)
    if not source.exists():
        fail(f"no such file: {source}")
    sid = sandbox_id(state())
    sandbox = connect(sid)
    upload = f"/home/user/.rtb-restore-{int(time.time())}.tgz"
    sandbox.files.write(upload, source.read_bytes())
    run(sandbox, f"tar xzf {upload} -C / && rm -f {upload}")
    run(sandbox, "pkill -f 'scripts/[c]loud-preview.mjs' || true")
    print("restored; run deploy.py --skip-build to start the app again")


def main() -> None:
    if os.environ.get("E2B_DOMAIN") != "agentsphere.run" or not os.environ.get("E2B_API_KEY"):
        fail("set E2B_DOMAIN=agentsphere.run and E2B_API_KEY")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--template", default="agentmatrix-v1")
    create.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    create.set_defaults(handler=cmd_create)
    sub.add_parser("status").set_defaults(handler=cmd_status)
    wake = sub.add_parser("wake")
    wake.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    wake.set_defaults(handler=cmd_wake)
    sub.add_parser("pause").set_defaults(handler=cmd_pause)
    renew = sub.add_parser("renew")
    renew.add_argument("seconds", type=int, nargs="?", default=DEFAULT_TIMEOUT)
    renew.set_defaults(handler=cmd_renew)
    sub.add_parser("backup").set_defaults(handler=cmd_backup)
    restore = sub.add_parser("restore")
    restore.add_argument("file")
    restore.set_defaults(handler=cmd_restore)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
