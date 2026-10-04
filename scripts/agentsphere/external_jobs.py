#!/usr/bin/env python3
"""Entry points for a trusted external web server / scheduler; no listener or scheduler installed.

The caller authenticates the user and selects this bot's private deployment/access files.
  external_jobs.py wake
  external_jobs.py run job.json --occurrence 2026-10-04T09:00:00Z
Retries MUST reuse the occurrence ID. Unknown submissions are reconciled, never resubmitted.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import sandbox as lifecycle


def wake_and_wait(timeout: float = 60) -> str:
    """Return the bot URL only after authenticated health succeeds. No browser receives E2B keys."""
    sid = lifecycle.sandbox_id(lifecycle.state())
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", sid):
        raise ValueError("Invalid sandbox ID")
    lifecycle.STATE.parent.mkdir(exist_ok=True)
    with (lifecycle.STATE.parent / "wake.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        status, details = lifecycle.api("GET", f"/sandboxes/{sid}")
        if status != 200 or not isinstance(details, dict):
            raise RuntimeError("Sandbox status is unavailable")
        if details.get("state") != "running":
            status, _ = lifecycle.api("POST", f"/sandboxes/{sid}/resume", {"timeout": lifecycle.DEFAULT_TIMEOUT})
            if status >= 300:
                raise RuntimeError("Sandbox resume failed")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if lifecycle.app_health(sid).get("status") == "ok":
                return f"https://5188-{sid}.agentsphere.run"
            time.sleep(1)
    raise TimeoutError("Sandbox resumed but its application is not healthy")


def request(url: str, path: str, body: dict | None = None):
    access = json.loads((lifecycle.STATE.parent / "access.json").read_text())
    headers = {"Authorization": "Basic " + base64.b64encode(f"raytonebot:{access['password']}".encode()).decode()}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url + "/__agentcanvas/pi" + path,
                                 data=json.dumps(body).encode() if body is not None else None, headers=headers)
    # No redirect may carry the bot's password to a different origin.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    return urllib.request.build_opener(NoRedirect).open(req, timeout=20)


def save(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def run_job(job: dict, occurrence: str, *, directory: Path | None = None) -> dict:
    if not re.fullmatch(r"[a-zA-Z0-9._:-]{1,160}", str(job.get("id", ""))):
        raise ValueError("A stable job id is required")
    if not occurrence or len(occurrence) > 160:
        raise ValueError("An external scheduler occurrence ID is required")
    if not isinstance(job.get("prompt"), str) or not job["prompt"].strip():
        raise ValueError("A prompt is required")
    if job.get("agentPreset", "assistant") not in ("assistant", "planner", "builder"):
        raise ValueError("Unknown agent preset")
    if job.get("permissionMode", "auto") not in ("request", "auto", "allow-all"):
        raise ValueError("Unknown permission mode")
    definition = job.get("providerDefinition")
    if not isinstance(definition, dict) or not definition.get("id") or not job.get("model"):
        raise ValueError("Provide the configured providerDefinition and model; no model is chosen implicitly")
    if job["model"] not in definition.get("models", []):
        raise ValueError("Model must belong to the configured provider")
    if any(key in job or key in definition for key in ("apiKey", "password", "token")):
        raise ValueError("Job files must reference a server API key env name, never embed credentials")
    digest = hashlib.sha256(json.dumps(job, sort_keys=True).encode()).hexdigest()
    identifier = "scheduled_" + hashlib.sha256(f"{job['id']}\0{occurrence}".encode()).hexdigest()
    conversation = job.get("conversationId", "job_" + hashlib.sha256(job["id"].encode()).hexdigest())
    if not isinstance(conversation, str) or not re.fullmatch(r"[a-zA-Z0-9._:-]{1,160}", conversation):
        raise ValueError("Invalid conversation ID")
    directory = directory or lifecycle.STATE.parent / "jobs"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    ledger = directory / f"{identifier}.json"
    # ponytail: local file lock and ledger suit one external host; use its existing durable
    # job store before running scheduler replicas or migrating the scheduler host.
    with ledger.with_suffix(".lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = json.loads(ledger.read_text()) if ledger.exists() else None
        if previous and previous["jobHash"] != digest:
            raise ValueError("This occurrence was already used with a different job definition")
        if previous and previous["status"] in ("success", "cancelled", "error"):
            return previous
        url = wake_and_wait()
        if previous:
            # A lost HTTP response says nothing about whether tools ran. Read saved events only.
            try:
                with request(url, "/conversations/" + urllib.parse.quote(conversation)) as response:
                    saved = json.load(response)
                events = saved.get("events", saved.get("conversation", {}).get("events", []))
                terminal = next((event for event in reversed(events) if event.get("runId") == identifier
                                 and event.get("type") in ("run.finished", "run.error")), None)
                if terminal:
                    previous["status"] = terminal_status(terminal)
                    save(ledger, previous)
            except (OSError, ValueError):
                pass
            return previous
        with request(url, "/config", {"conversationId": conversation, "providerDefinition": definition,
                                      "provider": definition["id"], "model": job["model"]}) as response:
            response.read()
        result = {"requestId": identifier, "conversationId": conversation, "jobHash": digest, "status": "unconfirmed"}
        save(ledger, result)  # durable BEFORE the only submission; a crash here intentionally requires review
        payload = {key: job[key] for key in ("prompt", "agentPreset", "permissionMode", "model") if key in job}
        payload.update(conversationId=conversation, requestId=identifier, provider=definition["id"])
        payload.setdefault("permissionMode", "auto")
        try:
            with request(url, "/prompt", payload) as response:
                for line in response:
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if event.get("runId") == identifier and event.get("type") in ("run.finished", "run.error"):
                        result["status"] = terminal_status(event)
            save(ledger, result)
        except (OSError, ValueError):
            # Caller must reconcile this same ID or ask a human; never submit again automatically.
            pass
        return result


def terminal_status(event: dict) -> str:
    return "error" if event["type"] == "run.error" else event.get("payload", {}).get("status", "success")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=lifecycle.STATE.parent,
                        help="private deployment/access files and durable occurrence ledger for this bot")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("wake")
    run = sub.add_parser("run")
    run.add_argument("job", type=Path)
    run.add_argument("--occurrence", required=True)
    args = parser.parse_args()
    lifecycle.STATE = args.state_dir.resolve() / "deployment.json"
    try:
        result = {"url": wake_and_wait()} if args.command == "wake" else run_job(json.loads(args.job.read_text()), args.occurrence)
        print(json.dumps(result))
        if result.get("status") in ("unconfirmed", "error", "cancelled"):
            raise SystemExit(1)
    except Exception:
        # Raw urllib errors and provider replies may contain URLs/credentials; report no payloads.
        print('{"error":"External bot operation failed; inspect private configuration and health."}')
        raise SystemExit(1)
