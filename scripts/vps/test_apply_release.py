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
    def test_browser_apparmor_allows_only_trusted_exact_executable(self):
        browser = Path('/opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            restriction = root / 'restricted'
            restriction.write_text('1\n')
            trusted = SimpleNamespace(st_uid=0, st_mode=0o100755)
            with patch.object(apply_release, 'USERNS_RESTRICTION', restriction), \
                 patch.object(apply_release, 'APPARMOR_DIR', root), \
                 patch.object(apply_release.os, 'geteuid', return_value=0), \
                 patch.object(Path, 'lstat', return_value=trusted), \
                 patch.object(apply_release, 'run') as execute:
                apply_release.configure_browser_apparmor(browser)
                content = (root / 'raytonebot-chromium').read_text()
                self.assertIn(f'profile raytonebot-chromium "{browser}" flags=(unconfined)', content)
                self.assertIn('userns,', content)
                self.assertNotIn('**', content)
                execute.assert_called_with('/usr/sbin/apparmor_parser', '-r', str(root / 'raytonebot-chromium'))
                for unsafe in (Path('/tmp/chrome'), Path(str(browser).replace('1248', '*'))):
                    with self.assertRaisesRegex(RuntimeError, 'browser path'):
                        apply_release.configure_browser_apparmor(unsafe)
                for uid, mode in ((1000, 0o100755), (0, 0o100775), (0, 0o120777)):
                    with self.subTest(uid=uid, mode=mode), \
                         patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=uid, st_mode=mode)):
                        with self.assertRaisesRegex(RuntimeError, 'root-owned'):
                            apply_release.configure_browser_apparmor(browser)

    def test_browser_apparmor_skips_unrestricted_hosts(self):
        with patch.object(apply_release, 'USERNS_RESTRICTION', Path('/nonexistent/raytonebot-userns')), \
             patch.object(apply_release, 'run') as execute:
            apply_release.configure_browser_apparmor(Path('/unused'))
            execute.assert_not_called()

    def test_browser_apparmor_parse_failure_preserves_previous_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            restriction = root / 'restricted'
            restriction.write_text('1')
            target = root / 'raytonebot-chromium'
            target.write_text('previous')
            with patch.object(apply_release, 'USERNS_RESTRICTION', restriction), \
                 patch.object(apply_release, 'APPARMOR_DIR', root), \
                 patch.object(apply_release.os, 'geteuid', return_value=0), \
                 patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o100755)), \
                 patch.object(apply_release, 'run', side_effect=subprocess.CalledProcessError(1, 'parser')):
                with self.assertRaises(subprocess.CalledProcessError):
                    apply_release.configure_browser_apparmor(Path('/opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'))
            self.assertEqual(target.read_text(), 'previous')

    def test_browser_apparmor_load_failure_restores_previous_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            restriction = root / 'restricted'
            restriction.write_text('1')
            target = root / 'raytonebot-chromium'
            target.write_text('previous')
            with patch.object(apply_release, 'USERNS_RESTRICTION', restriction), \
                 patch.object(apply_release, 'APPARMOR_DIR', root), \
                 patch.object(apply_release.os, 'geteuid', return_value=0), \
                 patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o100755)), \
                 patch.object(apply_release, 'run', side_effect=[None, subprocess.CalledProcessError(1, 'parser'), None]) as execute:
                with self.assertRaises(subprocess.CalledProcessError):
                    apply_release.configure_browser_apparmor(Path('/opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell'))
                execute.assert_called_with('/usr/sbin/apparmor_parser', '-r', str(target))
            self.assertEqual(target.read_text(), 'previous')

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
                 patch.object(apply_release, 'idle'), patch.object(apply_release, 'configure_browser_apparmor'), \
                 patch.object(apply_release, 'run', side_effect=execute), \
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
