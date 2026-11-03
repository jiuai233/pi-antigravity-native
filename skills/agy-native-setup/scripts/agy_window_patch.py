"""Apply, check or restore the AGY context-window patch (Windows x64, exact builds only).

Stock agy 1.4.12 keeps the saved `contextWindow: "512K"` in settings.json but
still budgets 256K natively: Store.ContextWindow never reads the saved choice.
The patch turns the first 5 bytes of Store.ContextWindow into a jump to
Store.ContextWindowChoice, the getter that reads the saved setting.

  python -I agy_window_patch.py status              read-only report
  python -I agy_window_patch.py set-512k            write contextWindow "512K" (backs up settings.json)
  python -I agy_window_patch.py apply   [--agy PATH]
  python -I agy_window_patch.py restore [--agy PATH]

A file is only touched when its full SHA256 equals a recipe's `base` (apply)
or `result` (restore); any other build is refused. Recipes live in ./recipes.
Standard library only.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

RECIPES = Path(__file__).resolve().parent / "recipes"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def locate_agy(explicit):
    """Same order as the plugin (AGY_BINARY, PATH, ~/.gemini/bin), plus the Windows installer path."""
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            raise SystemExit(f"--agy {explicit} is not a file")
        return path.resolve()
    exe = "agy.exe" if os.name == "nt" else "agy"
    candidates = [os.environ.get("AGY_BINARY"), shutil.which("agy"), str(Path.home() / ".gemini" / "bin" / exe)]
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(str(Path(os.environ["LOCALAPPDATA"]) / "agy" / "bin" / exe))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate).resolve()
    raise SystemExit("agy not found: pass --agy PATH or set AGY_BINARY")


def load_recipes():
    recipes = []
    for path in sorted(RECIPES.glob("*.json")):
        recipe = json.loads(path.read_text(encoding="utf-8"))
        for target in recipe["targets"]:
            pins = target["files"]["agy.exe"]
            recipes.append({"file": path.name, "recipe": recipe, "target": target,
                            "base": pins["base"], "result": pins["result"]})
    return recipes


def match(digest, recipes):
    for recipe in recipes:
        if digest == recipe["base"]:
            return "not_applied", recipe
        if digest == recipe["result"]:
            return "applied", recipe
    return "unknown", None


def agy_version(path):
    try:
        run = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (run.stdout or run.stderr or "").strip()
    return text.splitlines()[0] if text else None


def data_dir():
    return Path(os.environ.get("JETSKI_APP_DATA_DIR") or Path.home() / ".gemini" / "antigravity-cli")


def saved_window():
    settings = data_dir() / "settings.json"
    if not settings.is_file():
        return None
    try:
        return json.loads(settings.read_text(encoding="utf-8-sig")).get("contextWindow")
    except (OSError, ValueError):
        return "unreadable"


def edit(data, target, forward):
    out = bytearray(data)
    for replacement in target["byte_replacements"]:
        old, new = bytes.fromhex(replacement["before"]), bytes.fromhex(replacement["after"])
        if not forward:
            old, new = new, old
        offset = replacement["offset"]
        if bytes(out[offset:offset + len(old)]) != old:
            raise SystemExit(f"bytes at offset {offset} are not {old.hex()}; refusing")
        out[offset:offset + len(old)] = new
    return bytes(out)


def swap_in(target, data, keep_original):
    """Write next to the target, move the old file aside, move the new one in.

    Windows allows renaming a running exe but not overwriting it, so this works
    while agy runs; running processes keep using the old bytes until restarted.
    """
    tmp = target.with_name(target.name + ".patch-tmp")
    tmp.write_bytes(data)
    original = target.with_name(target.name + ".orig")
    aside = original if keep_original and not original.exists() else target.with_name(
        f"{target.name}.{time.strftime('%Y%m%d-%H%M%S')}.old")
    try:
        os.replace(target, aside)
    except OSError as error:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"cannot move {target} aside ({error}); close Pi sessions and agy, then retry")
    try:
        os.replace(tmp, target)
    except OSError as error:
        os.replace(aside, target)
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"cannot place the new file ({error}); original put back")
    if aside == original:
        return {"original_backup": str(original)}
    try:
        aside.unlink()
        return {}
    except OSError:
        return {"leftover": str(aside), "note": "still used by a running agy; delete it after agy exits"}


def report(path, digest, extra=None):
    state, recipe = match(digest, load_recipes())
    window = saved_window()
    hints = []
    if state == "unknown":
        hints.append("no recipe for this build: use the 256K route (references/modifications.md) "
                     "or relocate the patch (references/window-patch.md)")
    elif state == "not_applied":
        hints.append("patchable: run set-512k, close Pi and agy, then apply")
    elif window != "512K":
        hints.append('patched, but contextWindow is not "512K": run set-512k')
    out = {"agy": str(path), "sha256": digest, "state": state,
           "recipe": recipe and f"{recipe['file']} (recipe {recipe['recipe']['version']}, agy {recipe['target']['version']})",
           "saved_contextWindow": window, "settings": str(data_dir() / "settings.json"), "next": hints}
    out.update(extra or {})
    print(json.dumps(out, indent=2, ensure_ascii=False))


def cmd_status(args):
    path = locate_agy(args.agy)
    report(path, sha256_file(path), {"version": agy_version(path)})


def change(args, forward):
    path = locate_agy(args.agy)
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    state, recipe = match(digest, load_recipes())
    done, start, goal = ("applied", "not_applied", "result") if forward else ("not_applied", "applied", "base")
    if state == done:
        report(path, digest, {"action": "nothing to do"})
        return
    if state != start:
        raise SystemExit(f"refusing: no recipe has {digest} as its {'base' if forward else 'result'}. "
                         "See references/window-patch.md")
    new = edit(data, recipe["target"], forward)
    if hashlib.sha256(new).hexdigest() != recipe[goal]:
        raise SystemExit("new file fingerprint does not match the recipe; nothing written")
    kept = swap_in(path, new, keep_original=forward)
    report(path, sha256_file(path), {"action": "applied" if forward else "restored", **kept})


def cmd_set_512k(args):
    settings = data_dir() / "settings.json"
    current = {}
    if settings.is_file():
        current = json.loads(settings.read_text(encoding="utf-8-sig"))
        if current.get("contextWindow") == "512K":
            print(json.dumps({"settings": str(settings), "contextWindow": "512K", "action": "nothing to do"}))
            return
        backup = settings.with_name(f"settings.json.{time.strftime('%Y%m%d-%H%M%S')}.bak")
        shutil.copy2(settings, backup)
    else:
        backup = None
    current["contextWindow"] = "512K"
    settings.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.with_name("settings.json.tmp")
    tmp.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, settings)
    print(json.dumps({"settings": str(settings), "contextWindow": "512K",
                      "backup": backup and str(backup), "action": "written"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "apply", "restore"):
        sub.add_parser(name).add_argument("--agy", help="agy executable (default: AGY_BINARY, PATH, usual install paths)")
    sub.add_parser("set-512k")
    args = parser.parse_args()
    {"status": cmd_status, "apply": lambda a: change(a, True), "restore": lambda a: change(a, False),
     "set-512k": cmd_set_512k}[args.command](args)


if __name__ == "__main__":
    main()
