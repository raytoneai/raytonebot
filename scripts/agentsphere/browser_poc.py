#!/usr/bin/env python3
"""Browser proof of concept on a THROWAWAY AgentSphere sandbox (docs/headless-browser-research.md).

  browser_poc.py [--template agentmatrix-v1] [--keep]

Creates a new sandbox (30 minutes, destroyed at the end unless --keep; the deployed bot's
sandbox is never touched), installs playwright-core 1.64.0 and Chromium headless shell with its
system packages, creates a `raytone-browser` user, runs browser_poc.mjs and writes the JSON
report to .agentsphere/browser-poc.json. Needs E2B_DOMAIN=agentsphere.run and E2B_API_KEY in
the environment (reuse the one deploy.py runs with; do not type the key into a command line).
Exits non-zero when the browser could not be measured or the test sandbox could not be deleted.

Not measured here: login, backup and restore (profileMB is after two public pages only), and the
egress proxy / firewall of ADR-040, so this does not verify the isolation design.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from deploy import run
from sandbox import api, fail, info

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / ".agentsphere" / "browser-poc.json"
PLAYWRIGHT = "1.64.0"
BROWSERS = "/opt/pw-browsers"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--template", default="agentmatrix-v1")
    parser.add_argument("--keep", action="store_true", help="leave the test sandbox running to inspect it")
    args = parser.parse_args()
    if os.environ.get("E2B_DOMAIN") != "agentsphere.run":
        fail("set E2B_DOMAIN=agentsphere.run (otherwise the SDK talks to e2b.dev)")
    if not os.environ.get("E2B_API_KEY"):
        fail("set E2B_API_KEY")
    from e2b import Sandbox  # imported late so --help works without the SDK

    status, body = api("POST", "/sandboxes", {"templateID": args.template, "timeout": 1800})
    if status >= 300 or not isinstance(body, dict):
        fail(f"create: HTTP {status}")
    sid = body["sandboxID"]
    print(f"test sandbox {sid} (destroyed at the end{'; --keep set' if args.keep else ''})")
    failure: str | None = None
    try:
        sandbox = Sandbox.connect(sid)
        print("installing playwright-core and Chromium headless shell…")
        run(sandbox, "sudo useradd --create-home --shell /usr/sbin/nologin raytone-browser"
                     " && sudo -u raytone-browser mkdir -p /home/raytone-browser/profile /home/raytone-browser/downloads")
        run(sandbox, f"mkdir -p /tmp/poc && cd /tmp/poc && npm init -y >/dev/null && npm install --silent playwright-core@{PLAYWRIGHT}", timeout=300)
        run(sandbox, f"cd /tmp/poc && sudo env PLAYWRIGHT_BROWSERS_PATH={BROWSERS} npx playwright-core install --with-deps chromium-headless-shell"
                     f" && sudo chmod -R a+rX {BROWSERS}", timeout=900)
        shell = run(sandbox, f"find {BROWSERS} -type f -name chrome-headless-shell | head -1").stdout.strip()
        if not shell:
            fail("headless shell not found after install")
        sandbox.files.write("/tmp/poc/browser_poc.mjs", (Path(__file__).parent / "browser_poc.mjs").read_text())
        print("measuring…")
        result = run(sandbox, f"cd /tmp/poc && POC_SHELL={shell} node browser_poc.mjs", timeout=600, check=False)
        output = result.stdout.strip()
        try:
            report = json.loads(output[output.index("{"):])
        except ValueError:
            fail(f"no report (exit {result.exit_code}):\n{output[-1500:]}\n{result.stderr[-1500:]}")
        report["sandboxTemplate"] = args.template
        # The platform's quotas; free/df inside only show what the VM sees.
        report["platform"] = {key: info(sid).get(key) for key in ("cpuCount", "memoryMB", "diskSizeMB")}
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(report, indent=2, ensure_ascii=False))
        print(f"\nsaved {REPORT.relative_to(ROOT)}")
        if result.exit_code != 0 or report.get("fatal") or report.get("invalidSamples"):
            failure = (f"browser measurement failed (exit {result.exit_code}): "
                       f"{report.get('fatal') or str(report.get('invalidSamples')) + ' unreadable memory samples'}")
    finally:
        if not args.keep:
            code, _ = api("DELETE", f"/sandboxes/{sid}")
            if code in (200, 204, 404):
                print(f"test sandbox {sid} deleted (HTTP {code})", file=sys.stderr)
            else:
                print(f"CLEANUP FAILED: test sandbox {sid} may still be running and billing (HTTP {code}). "
                      f"Delete it: DELETE {sid} via the AgentSphere API.", file=sys.stderr)
                sys.exit(3)
    if failure:
        fail(failure + f" (diagnostics saved in {REPORT.relative_to(ROOT)})")


if __name__ == "__main__":
    main()
