"""Run: python3 -m unittest discover -s scripts/agentsphere -p 'test_*.py'."""
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backup_data import DATA_PATHS, REQUIRED_PATHS, create_archive, restore_archive, validate_archive


class BackupRecoveryTest(unittest.TestCase):
    def test_native_sessions_round_trip_without_credentials_and_replace_after_stop(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source, target, archive = base / "source", base / "target", base / "data.tgz"
            for index, name in enumerate(DATA_PATHS):
                directory = source / name.lstrip("/")
                directory.mkdir(parents=True)
                (directory / "session.json").write_text(f"session-{index}")
            task = 'tasks/native-session/2.json'
            for home in ("home/user", "home/raytone-agent"):
                native_task = source / home / ".claude" / task
                native_task.parent.mkdir(parents=True)
                native_task.write_text('{"id":"2","subject":"Verify","status":"pending","blockedBy":["1"]}')
            for name in (".raytonebot/env", ".claude/.credentials.json", ".codex/auth.json"):
                (source / "home/user" / name).write_text("SECRET")
            (source / "home/user/workspace/session-link").symlink_to("session.json")
            create_archive(archive, source)
            with tarfile.open(archive) as bundle:
                self.assertFalse(any(name.endswith(("/env", "/.credentials.json", "/auth.json"))
                                     for name in bundle.getnames()))
            old_workspace = target / "home/user/workspace"
            old_workspace.mkdir(parents=True)
            (old_workspace / "stale.txt").write_text("old")
            env = target / "home/user/.raytonebot/env"
            env.parent.mkdir()
            env.write_text("keep-existing-secret")
            stopped = []

            def stop():
                self.assertTrue((old_workspace / "stale.txt").exists())
                stopped.append(True)

            restore_archive(archive, target, before_restore=stop)
            self.assertEqual(stopped, [True])
            self.assertFalse((old_workspace / "stale.txt").exists())
            self.assertEqual(env.read_text(), "keep-existing-secret")
            for index, name in enumerate(DATA_PATHS):
                self.assertEqual((target / name.lstrip("/") / "session.json").read_text(), f"session-{index}")
            self.assertTrue((old_workspace / "session-link").is_symlink())
            for home in ("home/user", "home/raytone-agent"):
                self.assertEqual((target / home / ".claude" / task).read_bytes(),
                                 (source / home / ".claude" / task).read_bytes())

    def test_legacy_optional_directories_missing_but_required_and_failed_reads_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "backup.tgz"
            for name in REQUIRED_PATHS:
                (root / name.lstrip("/")).mkdir(parents=True)
            create_archive(archive, root)
            self.assertEqual(set(validate_archive(archive)), {name.lstrip("/") for name in REQUIRED_PATHS})
            restore_archive(archive, root / "fresh")
            with patch("backup_data.subprocess.run", side_effect=subprocess.CalledProcessError(1, "tar")):
                with self.assertRaises(subprocess.CalledProcessError):
                    create_archive(archive, root)
            changed = subprocess.CalledProcessError(1, "tar", stderr=b"tar: home/user/workspace/a: file changed as we read it\n")
            with patch("backup_data.subprocess.run", side_effect=changed):
                with self.assertRaisesRegex(ValueError, "retry when no conversation is running"):
                    create_archive(archive, root)
            self.assertFalse(archive.exists())
            self.assertFalse(archive.exists())
            (root / REQUIRED_PATHS[0].lstrip("/")).rmdir()
            with self.assertRaises(ValueError):
                create_archive(archive, root)

    def test_bad_archives_do_not_stop_writers_or_change_existing_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marker = base / "restore/home/user/workspace/keep.txt"
            marker.parent.mkdir(parents=True)
            marker.write_text("untouched")
            archive = base / "bad.tgz"
            cases = [
                ("home/user/.raytonebot/env", None),
                ("home/user/workspace/../../escape", None),
                ("/home/user/workspace/absolute", None),
                ("home/user/workspace/link", "../.raytonebot/env"),
                ("home/user/workspace/link", "/etc/passwd"),
            ]
            for name, link in cases:
                with self.subTest(name=name, link=link):
                    with tarfile.open(archive, "w:gz") as bundle:
                        for required in REQUIRED_PATHS:
                            directory = tarfile.TarInfo(required.lstrip("/"))
                            directory.type = tarfile.DIRTYPE
                            bundle.addfile(directory)
                        item = tarfile.TarInfo(name)
                        if link:
                            item.type, item.linkname = tarfile.SYMTYPE, link
                            bundle.addfile(item)
                        else:
                            item.size = 3
                            bundle.addfile(item, io.BytesIO(b"bad"))
                    with patch("backup_data.stop_writers") as stop:
                        with self.assertRaises(ValueError):
                            restore_archive(archive, base / "restore", before_restore=stop)
                        stop.assert_not_called()
                    self.assertEqual(marker.read_text(), "untouched")
            archive.write_bytes(archive.read_bytes()[:-8])
            with patch("backup_data.stop_writers") as stop:
                with self.assertRaises(EOFError):
                    restore_archive(archive, base / "restore", before_restore=stop)
                stop.assert_not_called()
            self.assertEqual(marker.read_text(), "untouched")

    def test_restore_rejects_existing_parent_link_and_rolls_back_install_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source, target, archive = base / "source", base / "target", base / "data.tgz"
            for name in REQUIRED_PATHS:
                for root in (source, target):
                    directory = root / name.lstrip("/")
                    directory.mkdir(parents=True)
                    (directory / "value.txt").write_text(root.name)
            create_archive(archive, source)
            rename = Path.rename

            def fail_install(path, destination):
                if ".rtb-restore-" in str(path) and path.name == "workspace" and "previous" not in path.parts:
                    raise OSError("simulated installation failure")
                return rename(path, destination)

            with patch.object(Path, "rename", fail_install):
                with self.assertRaises(OSError):
                    restore_archive(archive, target)
            for name in REQUIRED_PATHS:
                self.assertEqual((target / name.lstrip("/") / "value.txt").read_text(), "target")
            config = target / "home/user/.raytonebot"
            config.rename(base / "outside")
            config.symlink_to(base / "outside", target_is_directory=True)
            with patch("backup_data.stop_writers") as stop:
                with self.assertRaisesRegex(ValueError, "parent is a symbolic link"):
                    restore_archive(archive, target, before_restore=stop)
                stop.assert_not_called()
            self.assertEqual((base / "outside/data/value.txt").read_text(), "target")


if __name__ == "__main__":
    unittest.main()
