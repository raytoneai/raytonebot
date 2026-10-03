#!/usr/bin/env python3
"""Deploy RaytoneBot to an AgentSphere sandbox (E2B fork; needs the 1.x SDK: pip install 'e2b<2').

Usage (from the project root):
  E2B_DOMAIN=agentsphere.run E2B_API_KEY=... [DEEPSEEK_API_KEY=...] \
    ~/.venvs/agentsphere/bin/python scripts/agentsphere/deploy.py [--sandbox ID] [--timeout 86400] [--skip-build]

What it does: build locally, upload the app (never node_modules, .agentsphere or .env files),
`npm ci` only when the lockfile changed, write ~/.raytonebot/env (mode 600) inside the sandbox,
restart the protected preview with `exec`, and check the public URL.

Credentials come only from this machine's environment and the untracked .agentsphere/ folder;
nothing secret is printed. The E2B team key never enters the sandbox.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import shlex
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".agentsphere"
APP_DIR = "/home/user/raytonebot"
CONFIG_DIR = "/home/user/.raytonebot"
WORKSPACE_ROOT = "/home/user/workspace"
PORT = 5188
UPLOAD = ["dist", "src", "scripts", "vendor", "public", "index.html", "package.json",
          "package-lock.json", "tsconfig.json", "vite.config.ts", "LICENSE", "THIRD_PARTY_NOTICES.md"]


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def load_json(name: str) -> dict:
    path = STATE_DIR / name
    return json.loads(path.read_text()) if path.exists() else {}


def package() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for entry in UPLOAD:
            path = ROOT / entry
            if path.exists():
                tar.add(path, arcname=entry, filter=lambda info: None if "node_modules" in info.name else info)
    return buffer.getvalue()


def run(sandbox, command: str, timeout: int = 120, check: bool = True):
    from e2b.sandbox.commands.command_handle import CommandExitException
    try:
        result = sandbox.commands.run(command, timeout=timeout)
    except CommandExitException as error:  # the SDK raises on any non-zero exit
        result = error
    if check and result.exit_code != 0:
        fail(f"remote command failed ({result.exit_code}): {command.split(';')[0][:80]}\n{result.stderr[-800:]}")
    return result


def http(url: str, password: str | None, extra: dict | None = None) -> tuple[int, bytes]:
    headers = dict(extra or {})
    if password is not None:
        headers["Authorization"] = "Basic " + base64.b64encode(f"raytonebot:{password}".encode()).decode()
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sandbox", help="sandbox id (default: .agentsphere/deployment.json)")
    parser.add_argument("--timeout", type=int, default=0, help="also extend the sandbox lifetime (seconds)")
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()

    if os.environ.get("E2B_DOMAIN") != "agentsphere.run":
        fail("set E2B_DOMAIN=agentsphere.run (otherwise the SDK talks to e2b.dev)")
    if not os.environ.get("E2B_API_KEY"):
        fail("set E2B_API_KEY")
    from e2b import Sandbox  # imported late so --help works without the SDK

    deployment = load_json("deployment.json")
    access = load_json("access.json")
    sandbox_id = args.sandbox or deployment.get("sandboxId")
    password = access.get("password")
    if not sandbox_id:
        fail("no sandbox id; pass --sandbox")
    if not password or len(password) < 24:
        fail(".agentsphere/access.json must hold the access password (24+ characters)")
    origin = f"https://{PORT}-{sandbox_id}.agentsphere.run"

    if not args.skip_build:
        print("build: npm run build")
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)

    sandbox = Sandbox.connect(sandbox_id)
    if args.timeout:
        sandbox.set_timeout(args.timeout)
    bundle = package()
    lock_hash = hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest()
    print(f"upload: {len(bundle) // 1024} KB to {sandbox_id}")
    upload_path = f"/home/user/.rtb-upload-{int(time.time())}.tgz"
    sandbox.files.write(upload_path, bundle)

    previous_lock = run(sandbox, f"cat {CONFIG_DIR}/lock.sha256 2>/dev/null || true", check=False).stdout.strip()
    run(sandbox, " && ".join([
        "rm -rf /home/user/.rtb-stage && mkdir -p /home/user/.rtb-stage",
        f"tar xzf {upload_path} -C /home/user/.rtb-stage",
        f"mkdir -p {APP_DIR}",
        f"find {APP_DIR} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {{}} +",
        f"cp -a /home/user/.rtb-stage/. {APP_DIR}/",
        f"rm -rf /home/user/.rtb-stage {upload_path}",
    ]))
    if previous_lock != lock_hash:
        print("deps: npm ci (lockfile changed)")
        run(sandbox, f"cd {APP_DIR} && npm ci --no-audit --no-fund", timeout=600)
    else:
        print("deps: unchanged, npm ci skipped")

    # Env file inside the protected ~/.raytonebot directory; agents cannot read it without asking.
    env = {
        "RAYTONEBOT_PUBLIC_ORIGIN": origin,
        "RAYTONEBOT_PASSWORD": password,
        "RAYTONEBOT_SANDBOX": "1",
        "RAYTONEBOT_WORKSPACE_ROOT": WORKSPACE_ROOT,
        "PI_CODING_AGENT_DIR": f"{CONFIG_DIR}/pi",
    }
    for key in ("DEEPSEEK_API_KEY",):
        if os.environ.get(key):
            env[key] = os.environ[key]
    env_text = "".join(f"{key}={shlex.quote(value)}\n" for key, value in env.items())
    run(sandbox, f"mkdir -p {CONFIG_DIR}/pi && chmod 700 {CONFIG_DIR}")
    sandbox.files.write(f"{CONFIG_DIR}/env", env_text)
    run(sandbox, " && ".join([
        f"chmod 600 {CONFIG_DIR}/env",
        f"echo {lock_hash} > {CONFIG_DIR}/lock.sha256",
        # The pre-layout deployment kept its env file in $HOME, outside the protected directory.
        "rm -f /home/user/.raytonebot.env",
        f"mkdir -p {WORKSPACE_ROOT}",
    ]))
    print(f"env: written ({', '.join(sorted(env))})")

    # Stop the old server (every instance), then start one whose PID is the node process itself.
    run(sandbox, "pkill -f 'scripts/[c]loud-preview.mjs' || true; sleep 1", check=False)
    # Fully detached (setsid + nohup): a process left attached to the SDK's command session is
    # killed when that session is cleaned up after this script exits. setsid and nohup exec, so
    # the recorded PID is node itself.
    start = (f"set -a; . {CONFIG_DIR}/env; set +a; cd {APP_DIR}; "
             f"setsid nohup node scripts/cloud-preview.mjs >> /home/user/raytonebot-preview.log 2>&1 < /dev/null &")
    run(sandbox, f"bash -c {shlex.quote(start)}")
    pid = ""
    for _ in range(30):
        time.sleep(1)
        listening = run(sandbox, f"ss -ltnp 2>/dev/null | grep ':{PORT} ' || true", check=False).stdout
        pid = run(sandbox, "pgrep -f 'scripts/[c]loud-preview.mjs' | head -1", check=False).stdout.strip()
        if listening and pid:
            break
    if not pid:
        log = run(sandbox, "tail -20 /home/user/raytonebot-preview.log", check=False).stdout
        fail(f"server did not start\n{log}")
    print(f"start: pid {pid}")

    checks: list[str] = []

    def expect(name: str, condition: bool) -> None:
        checks.append(name)
        if not condition:
            fail(f"check failed: {name}")

    status, body = http(f"{origin}/", password)
    expect("authenticated page", status == 200 and b"RaytoneBot" in body)
    expect("unauthenticated page blocked", http(f"{origin}/", None)[0] == 401)
    expect("wrong password blocked", http(f"{origin}/", "x" * 24)[0] == 401)
    status, body = http(f"{origin}/__agentcanvas/pi/state", password)
    expect("Pi state", status == 200)
    state = json.loads(body)
    expect("sandbox mode", state.get("sandboxed") is True)
    expect("per-role workspaces", state.get("workspace", {}).get("shared") == f"{WORKSPACE_ROOT}/shared")
    harnesses = {entry["id"]: entry for entry in state.get("harnesses", [])}
    expect("foreign origin blocked", http(f"{origin}/__agentcanvas/pi/state", password, {"Origin": "https://attacker.example"})[0] == 403)

    info = sandbox.get_info()
    deployment.update({
        "sandboxId": sandbox_id,
        "url": origin,
        "processId": int(pid),
        "expiresAt": info.end_at.isoformat() if hasattr(info.end_at, "isoformat") else str(info.end_at),
        "deployedAt": datetime.now(timezone.utc).isoformat(),
    })
    (STATE_DIR / "deployment.json").write_text(json.dumps(deployment, indent=2))
    (STATE_DIR / "verification.json").write_text(json.dumps({
        "checks": checks,
        "harnesses": {key: {"available": value.get("available"), "version": value.get("version")} for key, value in harnesses.items()},
        "workspace": state.get("workspace"),
        "defaultPermissionMode": state.get("defaultPermissionMode"),
        "verifiedAt": deployment["deployedAt"],
    }, indent=2))
    print("checks: " + "; ".join(checks))
    for key, value in harnesses.items():
        print(f"harness {key}: {'available ' + str(value.get('version') or '') if value.get('available') else 'unavailable'}")
    print(f"url: {origin}  (expires {deployment['expiresAt']})")


if __name__ == "__main__":
    main()
