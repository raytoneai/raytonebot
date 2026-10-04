#!/usr/bin/env python3
"""Deploy RaytoneBot to an AgentSphere sandbox (E2B fork; needs the 1.x SDK: pip install 'e2b<2').

Usage (from the project root):
  E2B_DOMAIN=agentsphere.run E2B_API_KEY=... [DEEPSEEK_API_KEY=...] \
    ~/.venvs/agentsphere/bin/python scripts/agentsphere/deploy.py [--sandbox ID] [--timeout 86400] [--skip-build]

What it does: build locally, upload the app (never node_modules, .agentsphere or .env files),
`npm ci` only when the lockfile changed, write ~/.raytonebot/env (mode 600) inside the sandbox,
restart the protected preview under a bounded supervisor, and check authenticated health.

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
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".agentsphere"
APP_DIR = "/home/user/raytonebot"
CONFIG_DIR = "/home/user/.raytonebot"
WORKSPACE_ROOT = "/home/user/workspace"
PORT = 5188
# Official fd 10.3.0 release asset digest; Ubuntu's 8.3 lacks Pi's --no-require-git.
FD_ARCHIVE = "fd-v10.3.0-x86_64-unknown-linux-gnu"
FD_SHA256 = "c3c2bc79f838e780173fc8f18b337ec273e7ba17c7ff8f551be29fc3c19b7916"
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
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read()


def main() -> None:
    global STATE_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("--sandbox", help="sandbox id (default: .agentsphere/deployment.json)")
    parser.add_argument("--timeout", type=int, default=0, help="also extend the sandbox lifetime (seconds)")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--state-dir", type=Path, default=STATE_DIR, help="separate access/deployment state for an isolated instance")
    args = parser.parse_args()
    STATE_DIR = args.state_dir.resolve()
    STATE_DIR.mkdir(parents=True, exist_ok=True)

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
        # Stop the supervisor too: otherwise it restarts against a half-replaced app.
        "sudo -n python3 /home/user/.rtb-stage/scripts/agentsphere/backup_data.py stop",
        f"sudo -n mkdir -p {APP_DIR}",
        f"sudo -n chown -R user:user {APP_DIR}",
        f"find {APP_DIR} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {{}} +",
        f"cp -a /home/user/.rtb-stage/. {APP_DIR}/",
        f"rm -rf /home/user/.rtb-stage {upload_path}",
    ]))
    if previous_lock != lock_hash:
        print("deps: npm ci (lockfile changed)")
        run(sandbox, f"cd {APP_DIR} && npm ci --no-audit --no-fund", timeout=600)
    else:
        print("deps: unchanged, npm ci skipped")

    # Pi's grep/find must not download executables through the agent's restricted network.
    if run(sandbox, "command -v rg >/dev/null && (command -v fd >/dev/null || command -v fdfind >/dev/null) && command -v setfacl >/dev/null && command -v getfacl >/dev/null", check=False).exit_code:
        run(sandbox, "sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ripgrep fd-find acl", timeout=300)
    if run(sandbox, "command -v fd >/dev/null", check=False).exit_code:
        run(sandbox, "sudo -n ln -s /usr/bin/fdfind /usr/local/bin/fd")
    if "--no-require-git" not in run(sandbox, "fd --help").stdout:
        with urllib.request.urlopen(f"https://github.com/sharkdp/fd/releases/download/v10.3.0/{FD_ARCHIVE}.tar.gz", timeout=60) as response:
            archive = response.read()
        if hashlib.sha256(archive).hexdigest() != FD_SHA256:
            fail("fd release checksum mismatch")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            binary = bundle.extractfile(f"{FD_ARCHIVE}/fd").read()
        uploaded_fd = f"/home/user/.rtb-fd-{uuid.uuid4().hex}"
        sandbox.files.write(uploaded_fd, binary)
        try:
            run(sandbox, f"sudo -n install -m 755 {uploaded_fd} /usr/local/bin/fd")
        finally:
            run(sandbox, f"rm -f {uploaded_fd}")
        if "--no-require-git" not in run(sandbox, "fd --help").stdout:
            fail("fd version does not support the Pi find tool")

    binaries = {name: run(sandbox, f"command -v {name}").stdout.strip() for name in ("node", "claude", "codex")}
    setup = ["sudo", "-n", "python3", f"{APP_DIR}/scripts/agentsphere/setup_isolation.py",
             "--app-dir", APP_DIR, "--workspace-root", WORKSPACE_ROOT, "--config-dir", CONFIG_DIR,
             "--port", "5190"]
    for name, binary in binaries.items():
        setup.extend([f"--{name}-bin", binary])
    run(sandbox, shlex.join(setup))
    print("isolation: native boundary verified")

    # Env file inside the bot-only ~/.raytonebot directory.
    env = {
        "RAYTONEBOT_PUBLIC_ORIGIN": origin,
        "RAYTONEBOT_PASSWORD": password,
        "RAYTONEBOT_SANDBOX": "1",
        "RAYTONEBOT_WORKSPACE_ROOT": WORKSPACE_ROOT,
        "PI_CODING_AGENT_DIR": f"{CONFIG_DIR}/pi",
        "RAYTONEBOT_AGENT_USER": "raytone-agent",
        "RAYTONEBOT_AGENT_HOME": "/home/raytone-agent",
        "RAYTONEBOT_GATEWAY_PORT": "5190",
        "RAYTONEBOT_ISOLATION_READY": "1",
    }
    # Model keys: a value in this machine's environment wins; otherwise keep the sandbox's current
    # one, so a redeploy from a shell without the key does not silently disable the models.
    previous = {}
    existing = run(sandbox, f"cat {CONFIG_DIR}/env 2>/dev/null || true", check=False)
    for line in existing.stdout.splitlines():
        name, sep, value = line.partition("=")
        if sep:
            parsed = shlex.split(value)
            previous[name] = parsed[0] if parsed else ""
    for key in ("DEEPSEEK_API_KEY",):
        if os.environ.get(key):
            env[key] = os.environ[key]
        elif previous.get(key):
            env[key] = previous[key]
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

    # Fully detached: the SDK must not clean up the supervisor with its command session.
    start = (f"set -a; . {CONFIG_DIR}/env; set +a; cd {APP_DIR}; "
             "setsid nohup python3 scripts/supervisor.py > /dev/null 2>&1 < /dev/null &")
    run(sandbox, f"bash -c {shlex.quote(start)}")
    pid = ""
    for _ in range(30):
        time.sleep(1)
        listening = run(sandbox, f"ss -ltnp 2>/dev/null | grep ':{PORT} ' || true", check=False).stdout
        pid = run(sandbox, "pgrep -f 'scripts/[s]upervisor.py' | head -1", check=False).stdout.strip()
        if listening and pid:
            break
    if not pid:
        log = run(sandbox, f"tail -20 {CONFIG_DIR}/logs/supervisor.jsonl", check=False).stdout
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
    status, body = http(f"{origin}/__agentcanvas/pi/health", password)
    expect("application health", status == 200 and json.loads(body).get("status") == "ok")
    expect("unauthenticated health blocked", http(f"{origin}/__agentcanvas/pi/health", None)[0] == 401)
    status, body = http(f"{origin}/__agentcanvas/pi/state", password)
    expect("Pi state", status == 200)
    state = json.loads(body)
    expect("sandbox mode", state.get("sandboxed") is True)
    expect("per-role workspaces", state.get("workspace", {}).get("shared") == f"{WORKSPACE_ROOT}/shared")
    harnesses = {entry["id"]: entry for entry in state.get("harnesses", [])}
    expect("foreign origin blocked", http(f"{origin}/__agentcanvas/pi/state", password, {"Origin": "https://attacker.example"})[0] == 403)

    info = sandbox.get_info()
    deployment.pop("processId", None)
    deployment.update({
        "sandboxId": sandbox_id,
        "url": origin,
        "supervisorPid": int(pid),
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
