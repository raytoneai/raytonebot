import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import external_jobs as jobs


class ExternalJobsTests(unittest.TestCase):
    def test_lost_submission_is_reconciled_without_resubmitting(self):
        job = {"id": "daily", "prompt": "Summarize local notes", "model": "deepseek-flash",
               "providerDefinition": {"id": "deepseek", "models": ["deepseek-flash"]}}
        submitted = []
        recovered = []

        def request(_url, path, body=None):
            if path == "/config":
                return io.BytesIO(b"{}")
            if path == "/prompt":
                submitted.append(body)
                raise OSError("response lost")
            return io.BytesIO(json.dumps({"events": recovered}).encode())

        with tempfile.TemporaryDirectory() as temporary, patch.object(jobs, "wake_and_wait", return_value="https://bot.example"), patch.object(jobs, "request", side_effect=request):
            directory = Path(temporary)
            first = jobs.run_job(job, "2026-10-04T09:00Z", directory=directory)
            self.assertEqual(first["status"], "unconfirmed")
            self.assertEqual(jobs.run_job(job, "2026-10-04T09:00Z", directory=directory)["status"], "unconfirmed")
            self.assertEqual(len(submitted), 1, "an uncertain network result must never re-execute tools")
            recovered.append({"type": "run.finished", "runId": first["requestId"], "payload": {"status": "success"}})
            self.assertEqual(jobs.run_job(job, "2026-10-04T09:00Z", directory=directory)["status"], "success")
            self.assertEqual(jobs.run_job(job, "2026-10-04T09:00Z", directory=directory)["status"], "success")
            self.assertEqual(len(submitted), 1)
            with self.assertRaises(ValueError):
                jobs.run_job({**job, "prompt": "different action"}, "2026-10-04T09:00Z", directory=directory)
            ledger = next(directory.glob("*.json"))
            self.assertNotIn(job["prompt"], ledger.read_text())
            self.assertEqual(ledger.stat().st_mode & 0o777, 0o600)

    def test_wake_waits_for_authenticated_health(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(jobs.lifecycle, "STATE", Path(temporary) / "deployment.json"), \
             patch.object(jobs.lifecycle, "state", return_value={"sandboxId": "test-instance"}), \
             patch.object(jobs.lifecycle, "api", side_effect=[(200, {"state": "paused"}), (200, {})]) as resume, \
             patch.object(jobs.lifecycle, "app_health", side_effect=[{"status": "unavailable"}, {"status": "ok"}]), \
             patch.object(jobs.time, "sleep"):
            self.assertEqual(jobs.wake_and_wait(), "https://5188-test-instance.agentsphere.run")
            self.assertEqual(resume.call_args_list[-1].args, ("POST", "/sandboxes/test-instance/resume", {"timeout": jobs.lifecycle.DEFAULT_TIMEOUT}))

    def test_wake_does_not_print_upstream_error_details(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(jobs.lifecycle, "STATE", Path(temporary) / "deployment.json"), \
             patch.object(jobs.lifecycle, "state", return_value={"sandboxId": "test"}), \
             patch.object(jobs.lifecycle, "api", return_value=(403, "TOKEN_SENTINEL")), \
             patch("sys.stderr", new_callable=io.StringIO) as errors:
            with self.assertRaisesRegex(RuntimeError, "status is unavailable"):
                jobs.wake_and_wait()
            self.assertNotIn("TOKEN_SENTINEL", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
