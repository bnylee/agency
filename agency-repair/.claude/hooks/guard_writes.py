#!/usr/bin/env python3
"""PreToolUse hook: what agency-repair may write, and the price of writing it.

This bot is the only one in the Agency that edits code, so its write guard does
more than the siblings' -- it does not just permit or refuse, it takes the
snapshot that makes a permitted write reversible.

Two tiers:

  own tree   runs/, state/, repairs/     -- allowed outright
  Tier A     dashboard control-plane src -- allowed ONLY after this hook has
                                            copied the current file into
                                            repairs/<UTC-date>/before/

Everything else is denied, including every sibling bot's tree, every .claude/
directory (this bot's own included -- a bot that can edit its own guard hook has
no guard hook), every CLAUDE.md, and every .env.

Snapshotting here rather than asking the agent to do it is the whole point. A
model that is instructed to back a file up before editing it will usually do so;
a hook that refuses the edit until the backup exists always does. If the copy
fails for any reason the write is denied -- this fails closed, because an
unreversible repair is worse than no repair.

AGENCY_REPAIR_DRY_RUN=1 in the environment refuses every Tier A path, which is
what makes `run_repair.ps1 -DryRun` a real dry run rather than a promise.
"""
import datetime
import json
import os
import shutil
import sys

# realpath, not abspath: the target path below is realpath'd so a symlink cannot
# aim a write out of an allowed directory, and the roots have to be normalised
# the same way or the two never compare equal. If any component of the Agency
# path were ever a junction, an abspath root would reject every write.
BOT_ROOT = os.path.realpath(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
AGENCY_ROOT = os.path.dirname(BOT_ROOT)
DASHBOARD = os.path.join(AGENCY_ROOT, "dashboard")

# Written to freely: this bot's own output.
OWN_ROOTS = [
    os.path.join(BOT_ROOT, "runs"),
    os.path.join(BOT_ROOT, "state"),
    os.path.join(BOT_ROOT, "repairs"),
]

# Tier A. The control plane's own source and nothing else. Note what is absent:
# package.json, package-lock.json, dist/, .env, and every sibling bot.
TIER_A_DIRS = [
    os.path.join(DASHBOARD, "src"),
    os.path.join(DASHBOARD, "server"),
]
TIER_A_FILES = [
    os.path.join(DASHBOARD, "index.html"),
    os.path.join(DASHBOARD, "vite.config.ts"),
]

# Checked before the allowlists, so a path that is somehow both never slips
# through on the strength of the allow.
DENIED_NAMES = {".env", ".env.local", ".env.example", "claude.md",
                "package.json", "package-lock.json"}
DENIED_SEGMENTS = {".claude", "node_modules", ".venv", "dist", ".git"}

MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024


def respond_deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"agency-repair write guard: {reason}",
        }
    }))
    sys.exit(0)


def under(target, root):
    try:
        return os.path.commonpath([target, root]) == root
    except ValueError:
        # Different drives on Windows; definitely not under root.
        return False


def batch_dir():
    """One snapshot batch per LOCAL day.

    Local, not UTC, because the batch id has to be the same string everywhere it
    appears: run_repair.ps1 names the report `runs/<local date>.md`, tells the
    agent to write proposals to `repairs/<local date>/proposed/`, and prints
    `revert.ps1 -BatchId <local date>` as the undo. This was UTC, and after 8pm
    Eastern the snapshot went into tomorrow's batch while the report pointed at
    today's -- so the printed undo command named a batch with no manifest in it.
    """
    day = datetime.datetime.now().strftime("%Y-%m-%d")
    return os.path.join(BOT_ROOT, "repairs", day)


def snapshot(target):
    """Copy the current file into the batch, once. Returns None, or a reason.

    Idempotent per file: the FIRST state seen in a batch is the one preserved,
    so several edits to the same file across one run still revert to how it
    looked before the run started rather than to an intermediate.
    """
    batch = batch_dir()
    rel = os.path.relpath(target, AGENCY_ROOT).replace("\\", "/")
    dest = os.path.join(batch, "before", rel.replace("/", os.sep))
    manifest_path = os.path.join(batch, "manifest.json")

    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.makedirs(batch, exist_ok=True)

        manifest = {"batch": os.path.basename(batch), "agency_root": AGENCY_ROOT, "entries": {}}
        if os.path.exists(manifest_path):
            with open(manifest_path, encoding="utf-8") as fh:
                manifest = json.load(fh)
        manifest.setdefault("entries", {})

        if rel in manifest["entries"]:
            return None  # already captured this batch

        exists = os.path.exists(target)
        if exists:
            size = os.path.getsize(target)
            if size > MAX_SNAPSHOT_BYTES:
                return (f"{rel} is {size} bytes, over the {MAX_SNAPSHOT_BYTES}-byte "
                        "snapshot limit; a file that large is not a repair target")
            shutil.copy2(target, dest)

        manifest["entries"][rel] = {
            # "created" means revert should remove it, because it did not exist
            # before this batch. "modified" means revert restores before/.
            "action": "modified" if exists else "created",
            "snapshot": os.path.relpath(dest, batch).replace("\\", "/") if exists else None,
            "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        manifest["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)
        return None
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return f"could not snapshot {rel}: {type(exc).__name__}: {exc}"


def main():
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        respond_deny("unreadable hook payload")
        return

    if data.get("tool_name", "") not in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        sys.exit(0)

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path:
        sys.exit(0)

    try:
        target = os.path.abspath(os.path.expandvars(file_path))
    except (ValueError, OSError):
        respond_deny(f"unresolvable path {file_path!r}")
        return

    # realpath collapses symlinks and traversal, so a link planted inside an
    # allowed directory cannot point the write somewhere denied.
    target = os.path.realpath(target)

    if not under(target, AGENCY_ROOT):
        respond_deny(f"{file_path} is outside the Agency tree")

    parts = {p.lower() for p in target.split(os.sep)}
    name = os.path.basename(target).lower()
    if name in DENIED_NAMES:
        respond_deny(f"{name} is never edited by a bot; permission, dependency and "
                     "instruction files are Benny's")
    hit = parts & DENIED_SEGMENTS
    if hit:
        respond_deny(f"path crosses {sorted(hit)[0]!r}; hooks, settings, dependencies "
                     "and build output are out of scope at every tier")

    for root in OWN_ROOTS:
        if under(target, root):
            sys.exit(0)

    tier_a = any(under(target, d) for d in TIER_A_DIRS) or target in [
        os.path.realpath(f) for f in TIER_A_FILES
    ]
    if not tier_a:
        respond_deny(
            f"{os.path.relpath(target, AGENCY_ROOT)} is Tier B: diagnose it and write "
            "the patch to repairs/<date>/proposed/ for review. Only the control "
            "plane's own source is repaired autonomously."
        )

    if os.environ.get("AGENCY_REPAIR_DRY_RUN") == "1":
        respond_deny(
            f"dry run: would have applied a Tier A repair to "
            f"{os.path.relpath(target, AGENCY_ROOT)}. Record it under Holding with "
            "the intended diff."
        )

    problem = snapshot(target)
    if problem:
        # Fail closed. An unreversible repair is worse than no repair.
        respond_deny(problem)

    sys.exit(0)


if __name__ == "__main__":
    main()
