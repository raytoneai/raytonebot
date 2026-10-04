#!/usr/bin/env python3
"""Small bounded Linux supervisor; lifecycle logs deliberately contain no child output."""
from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path


def log_event(path: Path, event: str, **fields) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 2 * 1024 * 1024:
        path.replace(path.with_suffix(".jsonl.1"))
    with path.open("a") as output:
        path.chmod(0o600)
        output.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "event": event, **fields}) + "\n")


def signal_group(pid: int, sig: int) -> None:
    try:
        group = os.getpgid(pid)
        if group == os.getpgrp():
            os.kill(pid, sig)
        else:
            os.killpg(group, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        # The Linux agent has a separate UID; only signal this supervised group.
        target = str(pid) if group == os.getpgrp() else f"-{group}"
        subprocess.run(["sudo", "-n", "/bin/kill", f"-{sig}", "--", target],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def clean_children() -> None:
    # Linux subreaping keeps detached CLI children ours when Node crashes.
    children_file = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children")
    if not children_file.exists():
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        until = time.monotonic() + 3
        while True:
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0:
                        break
                except ChildProcessError:
                    break
            children = [int(pid) for pid in children_file.read_text().split()]
            if not children:
                return
            for pid in children:
                signal_group(pid, sig)
            if time.monotonic() >= until:
                break
            time.sleep(0.1)
    raise RuntimeError("child cleanup failed")


def supervise(command: list[str], log: Path, *, max_restarts=3, window=300, delay=1) -> int:
    if sys.platform == "linux":
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError("cannot enable child cleanup")
    stopping = False
    child = None

    def stop(signum, _frame):
        nonlocal stopping
        stopping = True
        if child is not None:
            signal_group(child.pid, signal.SIGTERM)

    old_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    failures = deque()
    try:
        while not stopping:
            try:
                child = subprocess.Popen(command, start_new_session=True,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                log_event(log, "process_started", pid=child.pid)
                if stopping:
                    signal_group(child.pid, signal.SIGTERM)
                while child.poll() is None and not stopping:
                    time.sleep(0.1)
                if stopping:
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        signal_group(child.pid, signal.SIGKILL)
                        child.wait()
                code = child.wait()
                log_event(log, "process_exited", pid=child.pid, exitCode=code, stopping=stopping)
            except OSError as error:
                code = 1
                log_event(log, "spawn_failed", errorType=type(error).__name__)
            finally:
                child = None
                try:
                    clean_children()
                except (OSError, RuntimeError, subprocess.CalledProcessError):
                    log_event(log, "cleanup_failed")
                    raise
            if stopping:
                return 0
            now = time.monotonic()
            while failures and now - failures[0] >= window:
                failures.popleft()
            failures.append(now)
            if len(failures) > max_restarts:
                log_event(log, "restart_limit", restarts=max_restarts, windowSeconds=window)
                return code or 1
            log_event(log, "restart_scheduled", attempt=len(failures), delaySeconds=delay)
            until = now + delay
            while not stopping and time.monotonic() < until:
                time.sleep(min(0.1, max(0, until - time.monotonic())))
        return 0
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    os.umask(0o077)
    sys.exit(supervise(["node", "scripts/cloud-preview.mjs"],
                       Path.home() / ".raytonebot/logs/supervisor.jsonl"))
