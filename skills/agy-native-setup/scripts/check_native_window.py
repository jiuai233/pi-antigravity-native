"""Read-only: report the context budget agy actually recorded for a conversation.

Reads one native conversation database (default: the newest) and prints the
token limits stored by agy itself, so you can tell whether the saved 512K
window is in effect. It never writes to the database.

  python -I check_native_window.py                 # newest conversation
  python -I check_native_window.py --conversation <id>
  python -I check_native_window.py --data-dir <agy data dir>

Interpretation
  generation_window   ContextWindowMetadata.max_context_tokens of recent model
                      calls: the budget agy really used. 512000 = patch working,
                      256000 = stock budget.
  executor_checkpoint checkpoint_config.max_token_limit. The Pi plugin rewrites
                      256K -> 512K here before resuming an old conversation, so
                      on a resumed conversation it is NOT proof by itself. Judge
                      by generation_window, or by a brand-new conversation.
"""
import argparse
import json
import os
import sqlite3
from pathlib import Path

WINDOWS = {98_304, 256_000, 512_000, 840_000, 1_000_000}
EXECUTOR_CHECKPOINT_PATH = (10, 2, 5)


def varint(buf, pos):
    value, shift = 0, 0
    while True:
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def fields(buf):
    pos = 0
    while pos < len(buf):
        tag, pos = varint(buf, pos)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("field 0")
        if wire == 0:
            value, pos = varint(buf, pos)
        elif wire == 1:
            value, pos = buf[pos:pos + 8], pos + 8
        elif wire == 5:
            value, pos = buf[pos:pos + 4], pos + 4
        elif wire == 2:
            length, pos = varint(buf, pos)
            value, pos = buf[pos:pos + length], pos + length
        else:
            raise ValueError(f"wire type {wire}")
        if pos > len(buf):
            raise ValueError("truncated")
        yield number, wire, value


def window_hits(buf, path=(), depth=0):
    """Paths of varint fields whose value looks like a context window."""
    hits = []
    try:
        parsed = list(fields(buf))
    except (ValueError, IndexError):
        return hits
    for number, wire, value in parsed:
        here = path + (number,)
        if wire == 0 and value in WINDOWS:
            hits.append((here, value))
        elif wire == 2 and depth < 8 and len(value) > 1:
            hits.extend(window_hits(value, here, depth + 1))
    return hits


def value_at(buf, path):
    try:
        for number, wire, value in fields(buf):
            if number != path[0]:
                continue
            if len(path) == 1:
                return value if wire == 0 else None
            if wire == 2:
                found = value_at(value, path[1:])
                if found is not None:
                    return found
    except (ValueError, IndexError):
        return None
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", default=os.environ.get("JETSKI_APP_DATA_DIR")
                        or str(Path.home() / ".gemini" / "antigravity-cli"))
    parser.add_argument("--conversation", help="native conversation id (default: newest .db)")
    args = parser.parse_args()
    conversations = Path(args.data_dir) / "conversations"
    if args.conversation:
        db = conversations / f"{args.conversation}.db"
    else:
        dbs = sorted(conversations.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not dbs:
            raise SystemExit(f"no conversation databases under {conversations}")
        db = dbs[0]
    con = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True)
    try:
        executor = con.execute("SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 1").fetchone()
        gens = con.execute("SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 20").fetchall()
    finally:
        con.close()
    checkpoint = value_at(bytes(executor[0]), EXECUTOR_CHECKPOINT_PATH) if executor else None
    generation = {}
    for idx, data in gens:
        for path, value in window_hits(bytes(data)):
            slot = generation.setdefault(".".join(map(str, path)), {}).setdefault(
                str(value), {"rows": 0, "latest_row": idx})
            slot["rows"] += 1
            slot["latest_row"] = max(slot["latest_row"], idx)
    print(json.dumps({
        "database": str(db),
        "executor_checkpoint": checkpoint,
        "generation_window_candidates": generation,
        "generation_rows_read": len(gens),
    }, indent=2))


if __name__ == "__main__":
    main()
