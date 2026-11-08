#!/usr/bin/python3 -I
"""Root-owned fixed installer. Package code runs only as the dedicated installer UID."""
from __future__ import annotations

import ctypes
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

CATALOG = Path('/etc/raytonebot-engine-installers.json')
ROOT = Path('/opt/raytone-engines')
BIN = Path('/usr/local/bin')
WORKER = 'raytone-installer'
PATH = '/usr/local/bin:/usr/bin:/bin'


class InstallError(Exception):
    pass


def trusted(path):
    current = Path(path)
    while True:
        info = current.lstat()
        if current.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise InstallError('installer_unavailable')
        if current == current.parent:
            break
        current = current.parent


def catalog():
    trusted(CATALOG)
    data = json.loads(CATALOG.read_text())
    if data.get('schemaVersion') != 1 or not isinstance(data.get('engines'), list) or len(data['engines']) > 50:
        raise InstallError('installer_unavailable')
    ids, commands = set(), set()
    for item in data['engines']:
        if (set(item) != {'id', 'packageName', 'version', 'command', 'sourceUrl'}
                or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', item['id'])
                or not re.fullmatch(r'@[a-z0-9-]+/[a-z0-9-]+', item['packageName'])
                or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', item['version'])
                or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', item['command'])
                or not item['sourceUrl'].startswith('https://')
                or item['id'] in ids or item['command'] in commands):
            raise InstallError('installer_unavailable')
        ids.add(item['id']); commands.add(item['command'])
    return data


def emit(phase, **extra):
    print(json.dumps({'phase': phase, **extra}), flush=True)


def kill_workers(uid):
    for _ in range(5):
        live = []
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid == uid and entry.joinpath('stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z':
                    live.append(int(entry.name))
            except (FileNotFoundError, ProcessLookupError):
                pass
        if not live:
            return
        for pid in live:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        time.sleep(0.05)
    raise InstallError('cleanup_failed')


def validate_tree(root):
    base = root.resolve()
    links = {}
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(folder) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                if os.path.isabs(os.readlink(path)) or not path.resolve().is_relative_to(base):
                    raise InstallError('verification_failed')
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise InstallError('verification_failed')
            elif stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                key = (info.st_dev, info.st_ino)
                count, total = links.get(key, (0, info.st_nlink))
                links[key] = (count + 1, total)
    # Official native wrappers may hardlink a binary within their own package tree.
    # Every link to the inode must be inside this staged tree before root owns it.
    if any(count != total for count, total in links.values()):
        raise InstallError('verification_failed')


def freeze_tree(root):
    validate_tree(root)
    for folder, dirs, files in os.walk(root, followlinks=False):
        for path in [Path(folder), *(Path(folder) / name for name in [*dirs, *files])]:
            info = path.lstat()
            os.chown(path, 0, 0, follow_symlinks=False)
            if not stat.S_ISLNK(info.st_mode):
                path.chmod(0o755 if stat.S_ISDIR(info.st_mode) or info.st_mode & 0o111 else 0o644)


def install(plan, cancelled):
    account = pwd.getpwnam(WORKER)
    if account.pw_uid == 0 or account.pw_gid == pwd.getpwnam('user').pw_gid:
        raise InstallError('installer_unavailable')
    ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    trusted(ROOT); trusted(BIN)
    ROOT.chmod(0o755)
    lock = os.open('/run/lock/raytonebot-engine-install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_nlink != 1:
        os.close(lock); raise InstallError('installer_unavailable')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock); raise InstallError('installer_busy')
    container = Path(tempfile.mkdtemp(prefix='.stage-', dir=ROOT)); container.chmod(0o711)
    payload, home = container / 'payload', container / 'home'
    for path, mode in ((payload, 0o755), (home, 0o700)):
        path.mkdir(mode=mode); os.chown(path, account.pw_uid, account.pw_gid)
    # npm rejects loading one path as both user and global configuration.
    for name in ('user.npmrc', 'global.npmrc'):
        path = home / name; path.write_text(''); path.chmod(0o644)
    package_file = payload / 'package.json'
    package_file.write_text(json.dumps({'name': 'raytonebot-managed-engine', 'version': '0.0.0', 'private': True,
                                        'allowScripts': {plan['packageName']: True}}))
    os.chown(package_file, account.pw_uid, account.pw_gid)
    destination = ROOT / f"{plan['id']}-{plan['version']}-{uuid.uuid4().hex}"
    target = BIN / plan['command']
    previous = os.readlink(target) if target.is_symlink() else None
    activated = False
    moved = False
    backup = None
    if target.exists() and not target.is_symlink():
        shutil.rmtree(container); os.close(lock); raise InstallError('activation_failed')

    def run(args, timeout, code):
        env = {'PATH': PATH, 'HOME': str(home), 'LANG': 'C.UTF-8', 'USER': WORKER, 'LOGNAME': WORKER,
               'NPM_CONFIG_USERCONFIG': str(home / 'user.npmrc'), 'NPM_CONFIG_GLOBALCONFIG': str(home / 'global.npmrc'),
               'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org', 'NPM_CONFIG_CACHE': str(home / 'cache')}
        child = subprocess.Popen(args, cwd=payload if payload.exists() else destination, env=env,
                                 user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                if cancelled.is_set(): raise InstallError('interrupted')
                if time.monotonic() >= deadline: raise InstallError('install_timeout')
                time.sleep(0.2)
            if child.returncode != 0: raise InstallError(code)
        finally:
            kill_workers(account.pw_uid)
            child.wait(timeout=5)

    try:
        kill_workers(account.pw_uid)
        emit('downloading')
        npm = shutil.which('npm', path=PATH)
        if not npm: raise InstallError('installer_unavailable')
        trusted(Path(npm).resolve())
        run([npm, 'install', '--prefix', str(payload), '--registry=https://registry.npmjs.org', '--save-exact',
             '--include=optional', '--no-audit', '--no-fund', f"{plan['packageName']}@{plan['version']}"], 300, 'download_failed')
        container.chmod(0o700)
        emit('verifying')
        validate_tree(payload)
        package = json.loads((payload / 'node_modules' / plan['packageName'] / 'package.json').read_text())
        if package.get('name') != plan['packageName'] or package.get('version') != plan['version']:
            raise InstallError('verification_failed')
        freeze_tree(payload)
        container.chmod(0o711)
        run([str(payload / 'node_modules/.bin' / plan['command']), '--version'], 15, 'verification_failed')
        if cancelled.is_set(): raise InstallError('interrupted')
        emit('activating')
        payload.rename(destination)
        moved = True
        if previous is not None:
            backup_path = BIN / f".raytonebot-{plan['command']}-previous-{uuid.uuid4().hex}"
            backup_path.symlink_to(previous)
            backup = backup_path
        pending = BIN / f".raytonebot-{plan['command']}-{uuid.uuid4().hex}"
        try:
            pending.symlink_to(destination / 'node_modules/.bin' / plan['command'])
            os.replace(pending, target); activated = True
        finally:
            pending.unlink(missing_ok=True)
        if cancelled.is_set(): raise InstallError('interrupted')
        emit('complete')
    except BaseException:
        if activated:
            if previous is None: target.unlink()
            else:
                rollback = BIN / f'.raytonebot-rollback-{uuid.uuid4().hex}'
                rollback.symlink_to(previous)
                try:
                    os.replace(rollback, target)
                finally:
                    rollback.unlink(missing_ok=True)
        if backup is not None: backup.unlink(missing_ok=True)
        if moved: shutil.rmtree(destination)
        raise
    finally:
        kill_workers(account.pw_uid)
        shutil.rmtree(container)
        os.close(lock)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise InstallError('invalid_request')
        data = catalog()
        if sys.argv[1] == '--catalog':
            print(json.dumps(data)); sys.exit(0)
        if os.geteuid() != 0: raise InstallError('installer_unavailable')
        plan = next((item for item in data['engines'] if item['id'] == sys.argv[1]), None)
        if plan is None: raise InstallError('invalid_request')
        # Inherited by children; avoid Python preexec_fn in this threaded parent.
        if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
            raise InstallError('installer_unavailable')
        cancelled = threading.Event()
        def watch_parent():
            os.read(0, 1); cancelled.set()
        threading.Thread(target=watch_parent, daemon=True).start()
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda *_: cancelled.set())
        install(plan, cancelled)
    except BaseException as error:
        if isinstance(error, SystemExit): raise
        try: emit('failed', code=str(error) if isinstance(error, InstallError) else 'install_failed')
        except BrokenPipeError: pass
        sys.exit(1)
