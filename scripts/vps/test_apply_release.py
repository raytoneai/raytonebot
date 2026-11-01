import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import apply_release


def release(path, extra=None):
    with tarfile.open(path, 'w:gz') as archive:
        for name in ('dist/index.html', 'package.json', 'package-lock.json', 'scripts/agentsphere/setup_isolation.py'):
            data = b'fixture'
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        if extra:
            archive.addfile(extra)


class ReleaseTest(unittest.TestCase):
    def test_extracts_valid_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'release.tgz'
            release(archive)
            stage = root / 'stage'
            stage.mkdir()
            apply_release.extract_release(archive, stage)
            self.assertTrue((stage / 'dist/index.html').is_file())

    def test_rejects_traversal_links_and_private_roots(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('src/link', tarfile.SYMTYPE), ('.env', tarfile.REGTYPE)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'release.tgz'
                entry = tarfile.TarInfo(name)
                entry.type = kind
                if kind == tarfile.SYMTYPE:
                    entry.linkname = '/etc/passwd'
                release(archive, entry)
                stage = root / 'stage'
                stage.mkdir()
                with self.assertRaisesRegex(ValueError, 'unsafe'):
                    apply_release.extract_release(archive, stage)
                self.assertFalse((root / 'escape').exists())

    def test_busy_tasks_refuse_update(self):
        with patch.object(apply_release, 'health', return_value={'activeRuns': 1}):
            with self.assertRaisesRegex(RuntimeError, 'active tasks'):
                apply_release.idle()

    def test_failed_activation_restores_previous_app_and_services(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'release.tgz'
            release(archive)
            app = root / 'app'
            app.mkdir()
            (app / 'old-version').write_text('keep')
            stage = root / 'stage'
            stage.mkdir()
            calls = []
            def execute(*args, cwd=None):
                calls.append(args)
                if 'npm' in args:
                    browser_list = stage / 'node_modules/playwright-core/browsers.json'
                    browser_list.parent.mkdir(parents=True)
                    browser_list.write_text(json.dumps({'browsers': [{'name': 'chromium-headless-shell', 'revision': '1'}]}))
                if args == ('systemctl', 'restart', 'raytonebot-isolation'):
                    raise subprocess.CalledProcessError(1, args)
            with patch.object(apply_release, 'APP', app), patch.object(apply_release, 'BACKUPS', root / 'backups'), \
                 patch.object(apply_release.os, 'geteuid', return_value=0), patch.object(apply_release.os, 'access', return_value=True), \
                 patch.object(apply_release.shutil, 'which', return_value='/bin/true'), \
                 patch.object(apply_release.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1, pw_gid=1)), \
                 patch.object(apply_release.tempfile, 'mkdtemp', return_value=str(stage)), \
                 patch.object(apply_release, 'idle'), patch.object(apply_release, 'run', side_effect=execute), \
                 patch.object(apply_release.subprocess, 'run') as rollback:
                with self.assertRaises(subprocess.CalledProcessError):
                    apply_release.apply(archive)
            self.assertEqual((app / 'old-version').read_text(), 'keep')
            self.assertIn(('systemctl', 'stop', 'raytonebot-cloudflared'), calls)
            rollback_calls = [call.args[0] for call in rollback.call_args_list]
            self.assertIn(['systemctl', 'start', 'raytonebot'], rollback_calls)
            self.assertIn(['systemctl', 'start', 'raytonebot-cloudflared'], rollback_calls)


if __name__ == '__main__':
    unittest.main()
