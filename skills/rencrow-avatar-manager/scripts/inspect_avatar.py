#!/usr/bin/env python3
"""Inspect configured PuruPuru packages against RenCrow PORTAL assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = SKILL_ROOT / "references" / "locations.json"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
REQUIRED_PACKAGE_FILES = {
    "avatar/back-hair.png",
    "avatar/front-hair.png",
    "avatar/eyes-open-mouth-closed.png",
    "avatar/eyes-open-mouth-half.png",
    "avatar/eyes-open-mouth-open.png",
    "avatar/eyes-closed-mouth-closed.png",
    "avatar/eyes-closed-mouth-half.png",
    "avatar/eyes-closed-mouth-open.png",
    "settings.json",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def output_name(package_name: str) -> str | None:
    normalized = package_name.replace("\\", "/")
    lower = normalized.lower()
    if normalized.startswith("avatar/") and lower.endswith(".png"):
        return normalized.removeprefix("avatar/")
    if normalized.startswith("items/") and lower.endswith(".png"):
        return normalized
    return {
        "settings.json": "default-settings.json",
        "thumbnail.png": "package-thumbnail.png",
        "manifest.json": "package-manifest.json",
    }.get(normalized)


def inspect_character(config: dict[str, Any], actor: str) -> dict[str, Any]:
    character = config["characters"][actor]
    purupuru_root = Path(config["purupuru_root"])
    portal_root = Path(config["portal_root"])
    package_path = (
        purupuru_root
        / Path(character["source_directory"])
        / character["package"]
    )
    portal_dir = (
        portal_root
        / Path(config["portal_assets_relative"])
        / character["portal_directory"]
    )

    result: dict[str, Any] = {
        "actor": actor,
        "display_name": character["display_name"],
        "package": str(package_path),
        "portal_directory": str(portal_dir),
        "chat": character["chat"],
        "idle_chat": character["idle_chat"],
        "errors": [],
        "matches": [],
        "mismatches": [],
        "missing": [],
        "unexpected": [],
        "item_layers": [],
    }
    if not package_path.is_file():
        result["errors"].append("package is missing")
        return result
    if not portal_dir.is_dir():
        result["errors"].append("PORTAL character directory is missing")
        return result

    package_bytes = package_path.read_bytes()
    result["package_sha256"] = sha256_bytes(package_bytes)

    expected_outputs: set[str] = set()
    with zipfile.ZipFile(package_path) as archive:
        archive_names = {name.replace("\\", "/") for name in archive.namelist()}
        absent = sorted(REQUIRED_PACKAGE_FILES - archive_names)
        if absent:
            result["errors"].append(
                "required package entries missing: " + ", ".join(absent)
            )

        try:
            settings = json.loads(archive.read("settings.json").decode("utf-8"))
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            result["errors"].append(f"invalid settings.json: {exc}")
            settings = {}

        for layer in settings.get("itemLayers", []):
            file_name = layer.get("file")
            result["item_layers"].append(
                {
                    "id": layer.get("id"),
                    "name": layer.get("name"),
                    "file": file_name,
                }
            )
            if file_name and file_name not in archive_names:
                result["errors"].append(
                    f"item layer {layer.get('id')} references missing {file_name}"
                )

        for archive_name in sorted(archive_names):
            relative = output_name(archive_name)
            if relative is None:
                continue
            expected_outputs.add(relative)
            source_data = archive.read(archive_name)
            if relative.lower().endswith(".png") and not source_data.startswith(
                PNG_SIGNATURE
            ):
                result["errors"].append(f"{archive_name} is not a PNG")
            destination = portal_dir / Path(relative)
            if not destination.is_file():
                result["missing"].append(relative)
                continue
            destination_data = destination.read_bytes()
            entry = {
                "file": relative,
                "package_sha256": sha256_bytes(source_data),
                "portal_sha256": sha256_bytes(destination_data),
            }
            if source_data == destination_data:
                result["matches"].append(entry)
            else:
                result["mismatches"].append(entry)

    actual_outputs = {
        path.relative_to(portal_dir).as_posix()
        for path in portal_dir.rglob("*")
        if path.is_file()
    }
    result["unexpected"] = sorted(actual_outputs - expected_outputs)
    result["ok"] = not any(
        result[key] for key in ("errors", "mismatches", "missing", "unexpected")
    )
    return result


def print_human(results: list[dict[str, Any]]) -> None:
    for result in results:
        status = "OK" if result.get("ok") else "DIFF"
        print(f"[{status}] {result['display_name']} ({result['actor']})")
        print(f"  package: {result['package']}")
        print(f"  portal:  {result['portal_directory']}")
        print(
            "  placement:"
            f" chat={result['chat'].get('placement')}"
            f" idle={result['idle_chat'].get('placement')}"
        )
        print(
            "  files:"
            f" match={len(result['matches'])}"
            f" mismatch={len(result['mismatches'])}"
            f" missing={len(result['missing'])}"
            f" unexpected={len(result['unexpected'])}"
        )
        for error in result["errors"]:
            print(f"  error: {error}")
        for entry in result["mismatches"]:
            print(
                f"  mismatch: {entry['file']}\n"
                f"    package={entry['package_sha256']}\n"
                f"    portal ={entry['portal_sha256']}"
            )
        for name in result["missing"]:
            print(f"  missing: {name}")
        for name in result["unexpected"]:
            print(f"  unexpected: {name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("locations")
    inspect_parser = subparsers.add_parser("inspect")
    target = inspect_parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--character")
    target.add_argument("--all", action="store_true")
    inspect_parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    config = load_config()
    if args.command == "locations":
        print(json.dumps(config, ensure_ascii=False, indent=2))
        return 0

    if args.all:
        actors = list(config["characters"])
    else:
        actor = args.character.strip().lower()
        if actor not in config["characters"]:
            parser.error(
                f"unknown character {args.character!r}; "
                f"choose from {', '.join(config['characters'])}"
            )
        actors = [actor]

    results = [inspect_character(config, actor) for actor in actors]
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print_human(results)
    return 0 if all(result.get("ok") for result in results) else 2


if __name__ == "__main__":
    sys.exit(main())
