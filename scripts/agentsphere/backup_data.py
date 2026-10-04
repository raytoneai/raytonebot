"""Archive only RaytoneBot data and native CLI sessions; no SDK or credentials needed."""
from __future__ import annotations

import gzip
import os
import posixpath
import pwd
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath

REQUIRED_PATHS = ["/home/user/.raytonebot/data", "/home/user/workspace"]
DATA_PATHS = [*REQUIRED_PATHS, "/home/user/.claude/projects", "/home/user/.claude/tasks", "/home/user/.codex/sessions",
              "/home/raytone-agent/.claude/projects", "/home/raytone-agent/.claude/tasks", "/home/raytone-agent/.codex/sessions"]
ARCHIVE_PATHS = [path.lstrip("/") for path in DATA_PATHS]


def allowed(name: str) -> bool:
    return any(name == root or name.startswith(root + "/") for root in ARCHIVE_PATHS)


def validate_archive(archive: Path) -> list[str]:
    # Read to EOF: tarfile can finish before gzip's checksum/truncation check.
    with gzip.open(archive, "rb") as stream:
        while stream.read(1024 * 1024):
            pass
    roots = []
    seen = set()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = member.name.rstrip("/")
            if (name in seen or name != posixpath.normpath(name) or not allowed(name) or name.startswith("/")
                    or ".." in PurePosixPath(name).parts
                    or not (member.isfile() or member.isdir() or member.issym() or member.islnk())):
                raise ValueError(f"unsafe or duplicate archive entry: {name}")
            seen.add(name)
            if name in ARCHIVE_PATHS:
                if not member.isdir():
                    raise ValueError(f"backup root must be a directory: {name}")
                roots.append(name)
            if member.issym() or member.islnk():
                target = member.linkname
                if member.issym():
                    target = posixpath.join(posixpath.dirname(name), target)
                if member.linkname.startswith("/") or not allowed(posixpath.normpath(target)):
                    raise ValueError(f"archive link escapes backup directories: {name}")
            if member.isfile():
                with bundle.extractfile(member) as stream:
                    while stream.read(1024 * 1024):
                        pass
    if any(path.lstrip("/") not in roots for path in REQUIRED_PATHS):
        raise ValueError("backup is missing required data/workspace directories")
    return roots


def create_archive(archive: Path, root: Path = Path("/")) -> None:
    paths = []
    for name in DATA_PATHS:
        source = root / name.lstrip("/")
        if source.is_symlink() or (source.exists() and not source.is_dir()):
            raise ValueError(f"backup root must be a real directory: {name}")
        if source.is_dir():
            paths.append(name.lstrip("/"))
        elif name in REQUIRED_PATHS:
            raise ValueError(f"required backup directory is missing: {name}")
    try:
        # ponytail: strict tar catches changed/read-failed files, not cross-file transactions;
        # take backups between tasks; add an app maintenance lock if online snapshots are needed.
        archive.touch(mode=0o600)
        archive.chmod(0o600)
        try:
            subprocess.run(["tar", "czf", str(archive), "-C", str(root), *paths], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           env={**os.environ, "COPYFILE_DISABLE": "1"})
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or b"").decode(errors="replace").strip()
            if "changed as we read" in detail:
                raise ValueError("a running task changed files during the backup; "
                                 "retry when no conversation is running") from error
            if detail:
                raise ValueError(f"tar failed: {detail.splitlines()[-1]}") from error
            raise
        validate_archive(archive)
    except BaseException:
        archive.unlink(missing_ok=True)
        raise


def stop_writers() -> None:
    """Stop supervisor/preview and descendants, including detached CLI process groups."""
    processes = {}
    for entry in Path("/proc").glob("[0-9]*"):
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            argv = (entry / "cmdline").read_bytes().decode(errors="replace").split("\0")
            processes[int(entry.name)] = (int(fields[1]), fields[19], argv)
        except (FileNotFoundError, ProcessLookupError):
            continue
    targets = {pid for pid, (_, _, argv) in processes.items()
               if any(arg in ("scripts/cloud-preview.mjs", "scripts/supervisor.py")
                      or arg.endswith(("/scripts/cloud-preview.mjs", "/scripts/supervisor.py"))
                      for arg in argv)}
    while True:
        children = {pid for pid, (parent, _, _) in processes.items() if parent in targets}
        if children <= targets:
            break
        targets |= children
    other_clis = [pid for pid, (_, _, argv) in processes.items() if pid not in targets
                  and any(Path(arg).name in ("claude", "codex") for arg in argv[:2])]
    if other_clis:
        raise ValueError("stop standalone Claude/Codex processes before restoring")

    def alive(pid):
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return fields[0] != "Z" and fields[19] == processes[pid][1]
        except (FileNotFoundError, ProcessLookupError):
            return False

    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in targets:
            if alive(pid):
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
        # Give the supervisor time to stop Node and reap detached CLI groups first.
        until = time.monotonic() + (20 if sig == signal.SIGTERM else 5)
        while any(alive(pid) for pid in targets) and time.monotonic() < until:
            time.sleep(0.1)
        if not any(alive(pid) for pid in targets):
            return
    raise ValueError("writers did not stop; no restored data was installed")


def restore_archive(archive: Path, root: Path = Path("/"), before_restore=None, prepare_stage=None) -> None:
    roots = validate_archive(archive)
    if not hasattr(tarfile, "data_filter"):
        raise ValueError("restore requires Python with tarfile.data_filter (3.12+ or a patched 3.11)")
    home = root / "home/user"
    home.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".rtb-restore-", dir=home))
    cleanup = True
    try:
        # Stage the entire archive before stopping anything or touching existing data.
        with tarfile.open(archive, "r:gz") as bundle:
            bundle.extractall(stage, filter="data")
        if prepare_stage:
            prepare_stage(stage, roots)
        for name in roots:
            target = root / name
            if any(parent.is_symlink() for parent in target.parents
                   if parent != root and root in parent.parents):
                raise ValueError(f"restore parent is a symbolic link: {name}")
        if before_restore:
            before_restore()
        replaced = []
        try:
            for name in roots:
                target, source, previous = root / name, stage / name, stage / "previous" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                previous.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    target.rename(previous)
                replaced.append((target, source, previous))
                source.rename(target)
        except BaseException:
            try:
                for target, source, previous in reversed(replaced):
                    if target.exists() or target.is_symlink():
                        target.rename(source)
                    if previous.exists() or previous.is_symlink():
                        previous.rename(target)
            except BaseException as error:
                cleanup = False
                raise OSError(f"restore rollback failed; original data retained under {stage}/previous") from error
            raise
        # Keep exactly one undo: the replaced data stays private under the bot's home until the next
        # restore, instead of being deleted with the stage.
        undo = home / ".rtb-restore-previous"
        if undo.exists():
            shutil.rmtree(undo)
        (stage / "previous").rename(undo)
        undo.chmod(0o700)
    finally:
        if cleanup:
            shutil.rmtree(stage)


def restore_owners(stage: Path, roots: list[str]) -> None:
    """Privileged restore keeps bot data private and gives native sessions to their UID."""
    if os.geteuid() != 0:
        return
    user = pwd.getpwnam("user")
    try:
        agent = pwd.getpwnam("raytone-agent")
    except KeyError:
        agent = None
    for name in roots:
        native = name.startswith("home/raytone-agent/")
        if native and agent is None:
            raise ValueError("deploy isolation before restoring isolated agent sessions")
        owner = agent if native else user
        shared = name == "home/user/workspace" and agent is not None
        source = stage / name
        for path in [source, *source.rglob("*")]:
            os.chown(path, owner.pw_uid, user.pw_gid, follow_symlinks=False)
            if shared and not path.is_symlink():
                path.chmod(path.stat().st_mode | (0o2070 if path.is_dir() else 0o060))


if __name__ == "__main__":
    operation = sys.argv[1]
    try:
        if operation == "stop":
            stop_writers()
        elif operation == "create":
            create_archive(Path(sys.argv[2]))
        elif operation == "restore":
            restore_archive(Path(sys.argv[2]), before_restore=stop_writers, prepare_stage=restore_owners)
        else:
            raise ValueError("unknown backup operation")
    except (OSError, ValueError, tarfile.TarError, EOFError, subprocess.CalledProcessError) as error:
        sys.exit(f"backup {operation} failed: {error}")
