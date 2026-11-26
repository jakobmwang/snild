#!/usr/bin/env python3
"""Fetch the third-party code listed in vendor.json into tests/vendor/ and verify its SHA-256 digests.

Usage:
    python3 scripts/fetch_vendor.py          # download what is missing or wrong; fail on any mismatch
    python3 scripts/fetch_vendor.py --check  # verify only; never download
    python3 scripts/fetch_vendor.py --pin    # also fetch entries whose digest is "PIN_ON_FIRST_FETCH" and
                                             # print the digest to put in vendor.json (a deliberate act)

Standard library only. A file reaches its final place only after its digest matches. Every URL must use the
allowed scheme, and every path must stay inside tests/vendor/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "vendor.json"
DEST = ROOT / "tests" / "vendor"
PLACEHOLDER = "PIN_ON_FIRST_FETCH"
TIMEOUT_S = 60


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, target: Path) -> tuple[str, Path]:
    """Download url to a temporary file next to target; return its digest and the temporary path."""
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "snild-fetch-vendor"})
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
        path = Path(tmp.name)
        try:
            digest = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                for block in iter(lambda: response.read(1 << 20), b""):
                    digest.update(block)
                    tmp.write(block)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
    path.chmod(0o644)  # temporary files start private; the server runs as another user and must read them
    return digest.hexdigest(), path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="verify only, never download")
    mode.add_argument("--pin", action="store_true", help="fetch unpinned entries and print their digests")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    problems = 0
    for library in manifest["libraries"]:
        for entry in library["files"]:
            target = DEST / entry["path"]
            expected = entry["sha256"]
            label = f"{library['name']} {library['version']}: {entry['path']}"
            if not entry["url"].startswith("https://") or not target.resolve().is_relative_to(DEST.resolve()):
                print(f"REFUSED   {label} (the URL scheme is not allowed, or the path leaves tests/vendor)")
                problems += 1
                continue
            if expected == PLACEHOLDER and not args.pin:
                print(f"UNPINNED  {label} (run with --pin to fetch it and print its digest)")
                problems += 1
                continue
            if expected != PLACEHOLDER and target.is_file() and sha256_of(target) == expected:
                print(f"ok        {label}")
                continue
            if args.check:
                print(f"MISSING   {label}" if not target.exists() else f"WRONG     {label}")
                problems += 1
                continue
            actual, tmp = download(entry["url"], target)
            if expected == PLACEHOLDER:
                tmp.replace(target)
                print(f"pinned    {label}\n          sha256 {actual}  <- put this in vendor.json")
            elif actual == expected:
                tmp.replace(target)
                print(f"fetched   {label}")
            else:
                tmp.unlink()
                print(f"MISMATCH  {label}\n          expected {expected}\n          got      {actual}")
                problems += 1
    if problems:
        print(f"\n{problems} problem(s).", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
