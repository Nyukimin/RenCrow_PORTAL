"""Tests for packages_root resolution in inspect_avatar.py (stdlib unittest)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path, PureWindowsPath

sys.path.insert(0, str(Path(__file__).resolve().parent))

import inspect_avatar  # noqa: E402


class ResolvePackagesRootTest(unittest.TestCase):
    def test_relative_is_resolved_against_portal_repo_root(self) -> None:
        config = {"packages_root": "avatar-packages", "purupuru_root": "/legacy"}
        self.assertEqual(
            inspect_avatar.resolve_packages_root(config),
            inspect_avatar.PORTAL_REPO_ROOT / "avatar-packages",
        )

    def test_repo_root_contains_this_skill(self) -> None:
        skill = inspect_avatar.PORTAL_REPO_ROOT / "skills" / "rencrow-avatar-manager"
        self.assertTrue(skill.is_dir())

    def test_posix_absolute_is_used_as_written(self) -> None:
        config = {"packages_root": "/srv/packages", "purupuru_root": "/legacy"}
        self.assertEqual(
            inspect_avatar.resolve_packages_root(config), Path("/srv/packages")
        )

    def test_windows_absolute_is_used_as_written(self) -> None:
        value = "C:\\packages\\root"
        config = {"packages_root": value, "purupuru_root": "/legacy"}
        self.assertEqual(inspect_avatar.resolve_packages_root(config), Path(value))

    def test_missing_key_falls_back_to_purupuru_root(self) -> None:
        config = {"purupuru_root": "/legacy"}
        self.assertEqual(
            inspect_avatar.resolve_packages_root(config), Path("/legacy")
        )

    def test_committed_registry_uses_relative_packages_root(self) -> None:
        config = inspect_avatar.load_config()
        configured = config["packages_root"]
        self.assertFalse(Path(configured).is_absolute())
        self.assertFalse(PureWindowsPath(configured).is_absolute())
        self.assertTrue(inspect_avatar.resolve_packages_root(config).is_dir())


if __name__ == "__main__":
    unittest.main()
