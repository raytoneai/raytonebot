#!/usr/bin/env python3
"""Install the sandbox's native agent boundary. Run only as root inside the Linux VM."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

AGENT = "raytone-agent"
AGENT_HOME = Path("/home/raytone-agent")
MARKER = Path("/etc/raytonebot-isolation.json")


def run(*args: str) -> str:
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} exited {result.returncode}")
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-dir", default="/home/user/raytonebot")
    parser.add_argument("--workspace-root", default="/home/user/workspace")
    parser.add_argument("--config-dir", default="/home/user/.raytonebot")
    parser.add_argument("--port", type=int, default=5190)
    parser.add_argument("--node-bin", default="node")
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("--codex-bin", default="codex")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("run with sudo inside the Linux sandbox; this script never configures macOS")
    if not 1024 <= args.port <= 65535:
        parser.error("invalid gateway port")
    app, workspace, config = map(Path, (args.app_dir, args.workspace_root, args.config_dir))
    if any(not path.is_absolute() or path.is_symlink() for path in (app, workspace, config, AGENT_HOME)):
        parser.error("deployment paths must be absolute real directories")
    # Remove a stale claim before making any change; a partially configured VM cannot start tools.
    MARKER.unlink(missing_ok=True)
    for binary in ("sudo", "setpriv", "nft", "setfacl", "getfacl"):
        if not shutil.which(binary):
            raise RuntimeError(f"Missing native isolation prerequisite: {binary}")
    try:
        account = pwd.getpwnam(AGENT)
    except KeyError:
        run("useradd", "--create-home", "--home-dir", str(AGENT_HOME), "--shell", "/bin/bash", AGENT)
        account = pwd.getpwnam(AGENT)
    if account.pw_uid == 0 or account.pw_dir != str(AGENT_HOME):
        raise RuntimeError("Unexpected agent account")
    # 'user' is the bot's primary group in the AgentSphere template. Both identities can use
    # workspace files; only the bot owns its configuration/data and neither can alter the app.
    run("usermod", "-G", "user", AGENT)
    run("passwd", "--lock", AGENT)
    bot_uid = pwd.getpwnam("user").pw_uid
    for target in (app, config):
        if target.resolve() != target:
            raise RuntimeError("Application/config parents must not contain symlinks")
        for parent in target.parents:
            if parent.stat().st_uid not in (0, bot_uid):
                raise RuntimeError("Application/config parent is not bot- or root-owned")
            run("chmod", "go-w", str(parent))
    for path in (workspace, AGENT_HOME, config):
        path.mkdir(parents=True, exist_ok=True)
    run("chown", "user:user", str(config))
    run("chmod", "700", str(config))
    if (config / "env").exists():
        run("chmod", "600", str(config / "env"))
    run("chown", "-R", "root:root", str(app))
    run("chmod", "-R", "go-w", str(app))
    # Vite bundles its trusted config here. Agent still has no write permission.
    vite_temp = app / "node_modules/.vite-temp"
    vite_temp.mkdir(parents=True, exist_ok=True)
    run("chown", "user:user", str(vite_temp))
    run("chmod", "700", str(vite_temp))
    run("chown", "-R", f"{AGENT}:user", str(workspace), str(AGENT_HOME))
    for root in (workspace, AGENT_HOME):
        run("chmod", "-R", "g+rwX,o-rwx", str(root))
        run("find", str(root), "-type", "d", "-exec", "chmod", "g+s", "{}", "+")
    # Move, never merge/overwrite, the old native context. Backup supports both legacy and new roots.
    for relative in (".claude/projects", ".claude/tasks", ".codex/sessions"):
        source, target = Path("/home/user") / relative, AGENT_HOME / relative
        if source.parent.is_symlink() or target.parent.is_symlink():
            raise RuntimeError("Native session parents must not be symlinks")
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink() or target.is_symlink():
            raise RuntimeError("Native session roots must not be symlinks")
        if source.exists() and any(source.iterdir()):
            if target.exists() and any(target.iterdir()):
                raise RuntimeError("Both legacy and isolated sessions exist; reconcile them before setup")
            if target.exists():
                target.rmdir()
            shutil.move(str(source), str(target))
        target.mkdir(exist_ok=True)
    run("chown", "-R", f"{AGENT}:user", str(AGENT_HOME))
    run("chmod", "-R", "g+rwX,o-rwx", str(AGENT_HOME))
    run("find", str(AGENT_HOME), "-type", "d", "-exec", "chmod", "g+s", "{}", "+")
    # Allow-list the bot's home instead of deny-listing known secrets: the agent may only traverse
    # to the app, the workspace and the runtime binaries. Everything else (logs, dotfiles, uploads)
    # loses group/other access, and the home itself cannot be listed.
    home = Path("/home/user")
    executables = [shutil.which(binary) if not os.path.isabs(binary) else binary
                   for binary in (args.node_bin, args.claude_bin, args.codex_bin)]
    shared = {home / Path(path).relative_to(home).parts[0]
              for path in [app, workspace, *(Path(item).resolve() for item in executables if item)]
              if home in Path(path).parents}
    for entry in home.iterdir():
        if entry not in shared and not entry.is_symlink():
            run("chmod", "go-rwx", str(entry))
    run("chmod", "710", str(home))
    # resolved's public D-Bus/Varlink sockets can perform DNS for another UID, bypassing packet
    # ownership rules. Deny only the agent at their stable parent directories; other services keep
    # their existing access, and recreating a socket inside these directories cannot reopen it.
    for broker_dir in (Path("/run/dbus"), Path("/run/systemd")):
        if broker_dir.exists():
            if broker_dir.is_symlink() or not broker_dir.is_dir() or broker_dir.stat().st_uid == account.pw_uid:
                raise RuntimeError("Unexpected system broker directory")
            run("setfacl", "-m", f"u:{account.pw_uid}:---,d:u:{account.pw_uid}:---", str(broker_dir))
            acl = run("getfacl", "-cpn", str(broker_dir))
            if f"user:{account.pw_uid}:---" not in acl.splitlines():
                raise RuntimeError("System broker ACL verification failed")
    # Native ip/ip6 tables avoid this template's absent inet/reject/xt_owner extensions. One
    # atomic transaction replaces both owned tables; platform tables and policy stay untouched.
    rules = ""
    for family in ("ip", "ip6"):
        if subprocess.run(["nft", "list", "table", family, "raytone_agent"], capture_output=True).returncode == 0:
            rules += f"delete table {family} raytone_agent\n"
        allowed = f"meta skuid {account.pw_uid} ip daddr 127.0.0.1 tcp dport {args.port} accept\n" if family == "ip" else ""
        rules += f"""table {family} raytone_agent {{
  chain output {{
    type filter hook output priority -10; policy accept;
    {allowed}meta skuid {account.pw_uid} drop
  }}
}}
"""
    result = subprocess.run(["nft", "-f", "-"], input=rules, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"nft dual-stack firewall transaction exited {result.returncode}")
    def matched(rule: dict, left: dict, right) -> bool:
        return any(item.get("match", {}).get("left") == left and item["match"].get("right") == right
                   for item in rule["expr"])
    for family in ("ip", "ip6"):
        installed = json.loads(run("nft", "-j", "-n", "list", "table", family, "raytone_agent"))["nftables"]
        chain = next((item["chain"] for item in installed if "chain" in item), {})
        actual_rules = [item["rule"] for item in installed if "rule" in item]
        if chain.get("hook") != "output" or chain.get("prio") != -10 or len(actual_rules) != (2 if family == "ip" else 1):
            raise RuntimeError("Native firewall verification failed")
        for rule in actual_rules:
            if not matched(rule, {"meta": {"key": "skuid"}}, account.pw_uid):
                raise RuntimeError("Native firewall UID verification failed")
        if family == "ip":
            if not matched(actual_rules[0], {"payload": {"protocol": "ip", "field": "daddr"}}, "127.0.0.1") or not matched(actual_rules[0], {"payload": {"protocol": "tcp", "field": "dport"}}, args.port) or "accept" not in actual_rules[0]["expr"][-1]:
                raise RuntimeError("Native gateway exception verification failed")
        if "drop" not in actual_rules[-1]["expr"][-1]:
            raise RuntimeError("Native firewall verdict verification failed")
    launch = ["sudo", "-n", "-u", AGENT, "--", "setpriv", "--no-new-privs"]
    run(*launch, "test", "!", "-w", str(app))
    run(*launch, "test", "!", "-r", str(config))
    run(*launch, "test", "!", "-r", str(home))
    for binary in (args.node_bin, args.claude_bin, args.codex_bin):
        executable = shutil.which(binary) if not os.path.isabs(binary) else binary
        if not executable:
            raise RuntimeError(f"Runtime executable unavailable: {binary}")
        run(*launch, executable, "--version")
    MARKER.write_text(json.dumps({"user": AGENT, "uid": account.pw_uid, "port": args.port, "network": "nft-dual-stack"}) + "\n")
    MARKER.chmod(0o644)
    print("Agent UID, filesystem permissions, no-new-privileges launcher and IPv4/IPv6 egress rules installed.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        # Never echo arbitrary command output: future commands may contain private paths/config.
        print(f"Isolation setup failed: {error if isinstance(error, RuntimeError) else type(error).__name__}", file=sys.stderr)
        sys.exit(1)
