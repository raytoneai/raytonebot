#!/usr/bin/env python3
"""Safely update the existing GreenCloud VM from a trusted RaytoneBot release archive."""
from __future__ import annotations

import base64
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

APP = Path('/home/user/raytonebot')
CONFIG = Path('/home/user/.raytonebot')
BACKUPS = Path('/root/raytonebot-backups')
ALLOWED = {'dist', 'src', 'scripts', 'vendor', 'public', 'index.html', 'package.json',
           'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md'}


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, stdin=subprocess.DEVNULL)


def extract_release(archive: Path, stage: Path):
    # The archive is local and trusted, but a corrupt or hostile archive must not escape the stage.
    with tarfile.open(archive, 'r:gz') as bundle:
        seen = set()
        for member in bundle:
            name = member.name.rstrip('/')
            parts = PurePosixPath(name).parts
            if (not parts or parts[0] not in ALLOWED or name in seen or name.startswith('/')
                    or any(part in ('.', '..') for part in parts) or not (member.isfile() or member.isdir())):
                raise ValueError('unsafe release entry')
            seen.add(name)
        if not {'dist/index.html', 'package.json', 'package-lock.json', 'scripts/agentsphere/setup_isolation.py'} <= seen:
            raise ValueError('release is missing required application files')
        bundle.extractall(stage, filter='data')


def health():
    values = {}
    for line in (CONFIG / 'env').read_text().splitlines():
        name, sep, value = line.partition('=')
        if sep and name in ('RAYTONEBOT_PASSWORD', 'RAYTONEBOT_PUBLIC_ORIGIN'):
            parsed = shlex.split(value)
            if len(parsed) != 1:
                raise ValueError('invalid private environment')
            values[name] = parsed[0]
    hostname = urlsplit(values['RAYTONEBOT_PUBLIC_ORIGIN']).netloc
    password = values['RAYTONEBOT_PASSWORD']
    auth = base64.b64encode(f'raytonebot:{password}'.encode()).decode()
    connection = http.client.HTTPConnection('127.0.0.1', 5188, timeout=5)
    try:
        connection.request('GET', '/__agentcanvas/pi/health', headers={'Host': hostname, 'Authorization': f'Basic {auth}'})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('authenticated health check failed')
        state = json.loads(response.read())
        if state.get('status') != 'ok' or not isinstance(state.get('activeRuns'), int):
            raise RuntimeError('invalid health response')
        return state
    finally:
        connection.close()


def idle():
    if health()['activeRuns'] != 0:
        raise RuntimeError('Bot has active tasks; retry after they finish')


def wait_for_health():
    for _ in range(30):
        try:
            return health()
        except (OSError, ValueError, KeyError, RuntimeError, json.JSONDecodeError):
            time.sleep(1)
    raise RuntimeError('application did not become healthy')


def apply(archive: Path):
    if os.geteuid() != 0 or not APP.is_dir() or APP.is_symlink():
        raise RuntimeError('run as root on the provisioned VPS with an existing app')
    if not archive.is_file() or archive.is_symlink():
        raise RuntimeError('release archive must be a regular file')
    for binary in ('node', 'npm', 'claude', 'codex', 'fd', 'rg', 'nft', 'setfacl', 'getfacl'):
        if not shutil.which(binary):
            raise RuntimeError(f'missing VPS prerequisite: {binary}')
    idle()
    stage = Path(tempfile.mkdtemp(prefix='.rtb-release-', dir='/home/user'))
    previous = stage.with_name(stage.name + '-previous')
    moved = False
    service_stopped = False
    tunnel_stopped = False
    try:
        extract_release(archive, stage)
        account = pwd.getpwnam('user')
        run('chown', '-R', f'{account.pw_uid}:{account.pw_gid}', str(stage))
        run('sudo', '-n', '-u', 'user', '--', 'npm', 'ci', '--include=dev', '--no-audit', '--no-fund', cwd=stage)
        browsers = json.loads((stage / 'node_modules/playwright-core/browsers.json').read_text())['browsers']
        revision = next(item['revision'] for item in browsers if item['name'] == 'chromium-headless-shell')
        browser = Path(f'/opt/pw-browsers/chromium_headless_shell-{revision}/chrome-headless-shell-linux64/chrome-headless-shell')
        if not os.access(browser, os.X_OK):
            raise RuntimeError('matching Playwright Chromium is missing; install it before updating')
        run('chown', '-R', 'root:root', str(stage))
        run('chmod', '-R', 'go-w', str(stage))
        stage.chmod(0o755)  # mkdtemp starts at 0700; the bot must be able to traverse the app.
        idle()
        run('systemctl', 'stop', 'raytonebot-cloudflared')
        tunnel_stopped = True
        idle()  # Refuse to stop the bot if a task started before ingress closed.
        run('systemctl', 'stop', 'raytonebot')
        service_stopped = True
        BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
        BACKUPS.chmod(0o700)
        backup = BACKUPS / f'data-{time.time_ns()}.tgz'
        run('/usr/bin/python3', '-I', str(APP / 'scripts/agentsphere/backup_data.py'), 'create', str(backup))
        APP.rename(previous)
        moved = True
        stage.rename(APP)
        run('systemctl', 'restart', 'raytonebot-isolation')
        run('systemctl', 'start', 'raytonebot')
        service_stopped = False
        wait_for_health()
        run('sudo', '-n', '-u', 'user', '--', '/usr/bin/sudo', '-n', '/usr/local/sbin/raytonebot-check-isolation', '--check')
        for directory in ('shared', 'agents/assistant', 'agents/planner', 'agents/builder', 'agents/dsh'):
            run('sudo', '-n', '-u', 'raytone-agent', '--', 'test', '-w', f'/home/user/workspace/{directory}')
        run('systemctl', 'start', 'raytonebot-cloudflared')
        tunnel_stopped = False
        print(f'Updated; data backup: {backup}; previous application: {previous}')
    except BaseException:
        if moved:
            subprocess.run(['systemctl', 'stop', 'raytonebot'], check=False)
            if APP.exists():
                APP.rename(stage)
            previous.rename(APP)
            subprocess.run(['systemctl', 'restart', 'raytonebot-isolation'], check=False)
            service_stopped = True
        if service_stopped:
            subprocess.run(['systemctl', 'start', 'raytonebot'], check=False)
        if tunnel_stopped:
            subprocess.run(['systemctl', 'start', 'raytonebot-cloudflared'], check=False)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage: sudo python3 apply_release.py /root/release.tgz')
        apply(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f'VPS update failed: {error}')
