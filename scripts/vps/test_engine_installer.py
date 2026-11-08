import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('engine_installer', Path(__file__).with_name('engine_installer.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def test_tree_rejects_escape_links_hardlinks_and_special_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)/'payload'; root.mkdir()
            (root/'file').write_text('public')
            (root/'inside').symlink_to('file')
            installer.validate_tree(root)
            for destination in ('/etc/passwd', '../escape'):
                link = root/'escape'; link.symlink_to(destination)
                with self.assertRaises(installer.InstallError): installer.validate_tree(root)
                link.unlink()
            os.link(root/'file', root/'hardlink')
            installer.validate_tree(root)
            os.link(root/'file', Path(temp)/'external-hardlink')
            with self.assertRaises(installer.InstallError): installer.validate_tree(root)
            (Path(temp)/'external-hardlink').unlink()
            (root/'hardlink').unlink()
            os.mkfifo(root/'pipe')
            with self.assertRaises(installer.InstallError): installer.validate_tree(root)

    def test_catalog_rejects_command_and_package_injection(self):
        data = json.loads(Path(__file__).with_name('engine-installers.json').read_text())
        with tempfile.TemporaryDirectory() as temp, patch.object(installer, 'trusted'):
            path = Path(temp)/'catalog.json'
            with patch.object(installer, 'CATALOG', path):
                path.write_text(json.dumps(data)); self.assertEqual(len(installer.catalog()['engines']),3)
                for field, value in [('packageName','@openai/codex;bad'),('command','../../sh'),('version','latest'),('id','codex --shell')]:
                    changed = json.loads(json.dumps(data)); changed['engines'][0][field] = value
                    path.write_text(json.dumps(changed))
                    with self.assertRaises(installer.InstallError): installer.catalog()

    def test_download_failure_preserves_existing_entry_and_uses_clean_low_uid_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); binary=root/'bin'; binary.mkdir(); installs=root/'engines'
            (binary/'dsh').symlink_to('/old/installed/dsh')
            real_open=os.open
            def lock_open(path,*args,**kwargs):
                return real_open(root/'lock' if str(path).startswith('/run/lock/') else path,*args,**kwargs)
            account=SimpleNamespace(pw_uid=12345,pw_gid=12345)
            def launch_worker(*args,**kwargs):
                package=json.loads((Path(kwargs['cwd'])/'package.json').read_text())
                self.assertEqual(package['allowScripts'],{'@deepseek-ai/dsh':True})
                for kind in ['USERCONFIG','GLOBALCONFIG']:
                    self.assertEqual(Path(kwargs['env']['NPM_CONFIG_'+kind]).read_text(),'')
                return SimpleNamespace(returncode=1,poll=lambda:1,wait=lambda **_:1)
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            with patch.object(installer,'ROOT',installs),patch.object(installer,'BIN',binary),patch.object(installer,'trusted'), \
                 patch.object(installer,'kill_workers'),patch.object(installer.os,'chown'),patch.object(installer.os,'open',side_effect=lock_open), \
                 patch.object(installer.fcntl,'flock'),patch.object(installer.pwd,'getpwnam',side_effect=lambda name:account if name==installer.WORKER else SimpleNamespace(pw_gid=999)), \
                 patch.object(installer.shutil,'which',return_value='/usr/bin/npm'),patch.object(installer.subprocess,'Popen',side_effect=launch_worker) as launch:
                with self.assertRaisesRegex(installer.InstallError,'download_failed'): installer.install(plan,threading.Event())
                argv=launch.call_args.args[0]; env=launch.call_args.kwargs['env']
                self.assertIn('--registry=https://registry.npmjs.org',argv)
                self.assertIn('@deepseek-ai/dsh@0.2.1-rc.2',argv)
                self.assertTrue(env['NPM_CONFIG_USERCONFIG'].endswith('/home/user.npmrc'))
                self.assertTrue(env['NPM_CONFIG_GLOBALCONFIG'].endswith('/home/global.npmrc'))
                self.assertNotEqual(env['NPM_CONFIG_USERCONFIG'],env['NPM_CONFIG_GLOBALCONFIG'])
                self.assertNotIn('DEEPSEEK_API_KEY',env)
                self.assertEqual(launch.call_args.kwargs['user'],account.pw_uid)
                self.assertEqual(launch.call_args.kwargs['group'],account.pw_gid)
                self.assertEqual(launch.call_args.kwargs['extra_groups'],[])
                self.assertEqual(os.readlink(binary/'dsh'),'/old/installed/dsh')

class ActivationTest(unittest.TestCase):
    def _install_fixture(self, root, plan, target_path=None, cancelled=None, emit_hook=None, replace=None):
        binary = root/'bin'; binary.mkdir()
        installs = root/'engines'; installs.mkdir(exist_ok=True)
        if target_path is not None:
            (binary/plan['command']).symlink_to(target_path)
        real_open=os.open
        def lock_open(path,*args,**kwargs):
            return real_open(root/'lock' if str(path).startswith('/run/lock/') else path,*args,**kwargs)
        account=SimpleNamespace(pw_uid=12345,pw_gid=12345)
        cancelled = cancelled or threading.Event()
        phases=[]
        def emit(phase,**_):
            phases.append(phase)
            if emit_hook is not None: emit_hook(phase)
        def launch(args,**kwargs):
            if args[0]=='/usr/bin/npm':
                payload=Path(kwargs['cwd']); package=payload/'node_modules'/plan['packageName']; package.mkdir(parents=True)
                (package/'package.json').write_text(json.dumps({'name':plan['packageName'],'version':plan['version']}))
                (package/'bin.js').write_text('fixture')
                (payload/'node_modules/.bin').mkdir()
                (payload/'node_modules/.bin'/plan['command']).symlink_to('../'+plan['packageName']+'/bin.js')
            return SimpleNamespace(returncode=0,poll=lambda:0,wait=lambda **_:0)
        replacement = patch.object(installer.os,'replace',side_effect=replace) if replace is not None else patch.object(installer.os,'replace',wraps=os.replace)
        with patch.object(installer,'ROOT',installs),patch.object(installer,'BIN',binary),patch.object(installer,'trusted'), \
             patch.object(installer,'kill_workers'),patch.object(installer.os,'chown'),patch.object(installer.os,'open',side_effect=lock_open), \
             patch.object(installer.fcntl,'flock'),patch.object(installer.pwd,'getpwnam',side_effect=lambda name:account if name==installer.WORKER else SimpleNamespace(pw_gid=999)), \
             patch.object(installer.shutil,'which',return_value='/usr/bin/npm'),patch.object(installer.subprocess,'Popen',side_effect=launch),patch.object(installer,'emit',side_effect=emit),replacement:
            installer.install(plan,cancelled)
        return binary, installs, phases

    def test_cancellation_after_switch_restores_existing_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); old=root/'old'/'dsh'; old.parent.mkdir(parents=True); old.write_text('old')
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            cancelled=threading.Event()
            phases=[]
            def emit_hook(phase):
                phases.append(phase)
                if phase=='activating': cancelled.set()
            binary = root/'bin'; installs = root/'engines'
            with self.assertRaisesRegex(installer.InstallError,'interrupted'):
                self._install_fixture(root, plan, old, cancelled, emit_hook)
            self.assertEqual(os.readlink(binary/'dsh'),str(old))
            self.assertEqual(phases,['downloading','verifying','activating'])
            self.assertEqual(list(installs.glob('dsh-*')),[])
            self.assertEqual(list(installs.glob('.stage-*')),[])

    def test_success_keeps_new_and_old_versions(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); old=root/'old'/'dsh'; old.parent.mkdir(parents=True); old.write_text('old')
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            binary, installs, phases = self._install_fixture(root, plan, old)
            self.assertEqual(phases,['downloading','verifying','activating','complete'])
            new_entry = Path(os.readlink(binary/'dsh'))
            new_root = new_entry.parents[2]
            self.assertTrue(new_entry.is_symlink())
            self.assertEqual(new_entry.resolve().read_text(),'fixture')
            self.assertTrue(new_root.is_dir())
            self.assertEqual(old.read_text(),'old')
            self.assertEqual(list(installs.glob('.stage-*')),[])

    def test_cancellation_without_existing_entry_removes_new_entry_and_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            cancelled=threading.Event()
            def emit_hook(phase):
                if phase=='activating': cancelled.set()
            binary = root/'bin'; installs = root/'engines'
            with self.assertRaisesRegex(installer.InstallError,'interrupted'):
                self._install_fixture(root, plan, cancelled=cancelled, emit_hook=emit_hook)
            self.assertFalse((binary/'dsh').exists())
            self.assertFalse((binary/'dsh').is_symlink())
            self.assertEqual(list(installs.glob('dsh-*')),[])
            self.assertEqual(list(installs.glob('.stage-*')),[])

    def test_switch_failure_cleans_new_directory_and_keeps_existing_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); old=root/'old'/'dsh'; old.parent.mkdir(parents=True); old.write_text('old')
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            def fail_switch(source, destination):
                raise OSError('switch failed')
            binary = root/'bin'; installs = root/'engines'
            with self.assertRaisesRegex(OSError,'switch failed'):
                self._install_fixture(root, plan, old, replace=fail_switch)
            self.assertEqual(os.readlink(binary/'dsh'),str(old))
            self.assertEqual(old.read_text(),'old')
            self.assertEqual(list(installs.glob('dsh-*')),[])
            self.assertEqual(list(installs.glob('.stage-*')),[])

    def test_rollback_failure_keeps_directory_still_referenced_by_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); old=root/'old'/'dsh'; old.parent.mkdir(parents=True); old.write_text('old')
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            cancelled=threading.Event()
            def emit_hook(phase):
                if phase=='activating': cancelled.set()
            real_replace = os.replace
            def fail_rollback(source, destination):
                if Path(source).name.startswith('.raytonebot-rollback-'):
                    raise OSError('rollback failed')
                return real_replace(source, destination)
            binary = root/'bin'; installs = root/'engines'
            with self.assertRaisesRegex(OSError,'rollback failed'):
                self._install_fixture(root, plan, old, cancelled, emit_hook, fail_rollback)
            new_entry = Path(os.readlink(binary/'dsh'))
            self.assertTrue(new_entry.resolve().is_file())
            self.assertTrue(new_entry.parents[2].is_dir())
            self.assertEqual(old.read_text(),'old')
            self.assertEqual(list(installs.glob('.stage-*')),[])

    def test_rename_failure_does_not_remove_existing_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); existing=root/'engines'/'dsh-0.2.1-rc.2-fixed'; existing.mkdir(parents=True)
            (existing/'sentinel').write_text('existing')
            plan=json.loads(Path(__file__).with_name('engine-installers.json').read_text())['engines'][2]
            installs = root/'engines'
            def fail_rename(destination):
                raise OSError('rename failed')
            with patch.object(installer.uuid,'uuid4',return_value=SimpleNamespace(hex='fixed')):
                with patch.object(installer.Path,'rename',side_effect=fail_rename):
                    with self.assertRaisesRegex(OSError,'rename failed'):
                        self._install_fixture(root, plan)
            self.assertEqual((existing/'sentinel').read_text(),'existing')
            self.assertEqual(list(installs.glob('.stage-*')),[])


if __name__=='__main__': unittest.main()
