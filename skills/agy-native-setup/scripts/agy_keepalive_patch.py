#!/usr/bin/env python3
"""Enable native cache keepalive in a separate macOS arm64 AGY 1.4.12 512K copy.

Only the verified 512K build is accepted. The source is never modified.
Keepalive sends up to six real model requests, 270 seconds apart, while AGY lives.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

BASE_SHA256 = "4a313dca845e8ceb77ae11288d80281622e94930ed8c8848750edf684a7177f9"
PATCH_OFFSET = 37700016
ORIGINAL = bytes.fromhex("900b40f9ff6330eb")
# Go ABIInternal returns integers in x0: mov x0, #6; ret.
PATCH = bytes.fromhex("c00080d2c0035fd6")
MACH_HEADER = bytes.fromhex("cffaedfe0c000001")


def patch_bytes(data):
    if hashlib.sha256(data).hexdigest() != BASE_SHA256:
        raise ValueError("Unsupported binary: expected the verified macOS arm64 1.4.12 512K build")
    if data[:8] != MACH_HEADER or data[PATCH_OFFSET:PATCH_OFFSET + 8] != ORIGINAL:
        raise ValueError("Mach-O header or keepAlivePings entry differs from the recipe")
    return data[:PATCH_OFFSET] + PATCH + data[PATCH_OFFSET + 8:]


def status(path):
    data = path.read_bytes()
    entry = data[PATCH_OFFSET:PATCH_OFFSET + 8]
    original = hashlib.sha256(data).hexdigest() == BASE_SHA256
    # Signing changes other bytes: this detects the entry only, not full provenance.
    patched = data[:8] == MACH_HEADER and entry == PATCH
    return {"binary": str(path), "sha256": hashlib.sha256(data).hexdigest(),
            "state": "supported_source" if original else "patched_entry" if patched else "unknown",
            "max_pings": 6 if patched else None}


def apply(source, output):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("Applying and signing require macOS arm64")
    if source.resolve() == output.resolve():
        raise ValueError("Output must be a separate file")
    patched = patch_bytes(source.read_bytes())
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    # A failed signature or startup must not leave an auto-selected broken copy.
    fd, temporary = tempfile.mkstemp(prefix=".agy-keepalive-", dir=output.parent)
    candidate = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(patched)
        candidate.chmod(source.stat().st_mode & 0o777)
        subprocess.run(["codesign", "--force", "--sign", "-", "--options", "runtime", str(candidate)], check=True)
        subprocess.run(["codesign", "--verify", "--strict", str(candidate)], check=True)
        if candidate.read_bytes()[PATCH_OFFSET:PATCH_OFFSET + 8] != PATCH:
            raise ValueError("Patched entry changed during signing")
        version = subprocess.check_output([str(candidate), "--version"], text=True, timeout=10).strip()
        if version != "1.4.12":
            raise ValueError(f"Unexpected version after signing: {version}")
        # Hard-link creation is atomic and cannot overwrite an existing target.
        os.link(candidate, output)
    finally:
        candidate.unlink()
    return {**status(output), "source": str(source), "version": version,
            "signature": "ad-hoc", "interval_seconds": 270}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "apply"):
        command = sub.add_parser(name)
        command.add_argument("--agy", type=Path, default=Path.home() / ".gemini/bin/agy-512k")
        if name == "apply":
            command.add_argument("--output", type=Path, default=Path.home() / ".gemini/bin/agy-512k-keepalive")
    args = parser.parse_args()
    try:
        result = status(args.agy) if args.command == "status" else apply(args.agy, args.output)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
