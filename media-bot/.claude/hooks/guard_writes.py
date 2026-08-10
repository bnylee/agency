#!/usr/bin/env python3
"""PreToolUse hook: constrain where media-bot may write.

Default is deny. The bot may write its run reports and its dry-run scratch space
and nothing else — not its own scripts, not its settings, not the trash-bin
manifest, and nothing in any sibling bot.

## Why this exists when settings.json already has deny rules

Because the deny rules are a list of paths somebody remembered to add, and this is
an allowlist. A deny list protects the files you thought of; an allowlist protects
the ones you did not. The two together is the pattern every bot here uses, and this
bot has the most to lose from a gap: it holds a live mail credential.

## The trash-bin manifest is denied on purpose

`state/trash-bin.json` is the record of what was moved out of the inbox and the
only thing `triage.py restore` reads to put it back. If the agent could edit it, a
bad run could silently orphan every staged message — they would still be sitting
under a Gmail label with nothing in the Agency knowing they were there. Only
triage.py writes it, and triage.py is invoked by the run script, not by the model.
"""
import json
import os
import sys

BOT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Relative to the bot root. Anything not under one of these is denied.
ALLOWED_PREFIXES = (
    os.path.join("runs", ""),
    os.path.join("state", "dryrun", ""),
)

# Denied even inside an allowed prefix.
DENIED_NAMES = {
    "trash-bin.json",
    "graph-token.json",
    ".env",
}

WRITE_TOOLS = {"Write", "Edit", "NotebookEdit", "MultiEdit"}


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"media-bot write guard: {reason}",
        }
    }))
    sys.exit(0)


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name", "") not in WRITE_TOOLS:
        sys.exit(0)

    tool_input = data.get("tool_input", {}) or {}
    target = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path")
    if not target:
        deny("the tool call names no file path, so it cannot be checked")

    # Resolved with realpath, not abspath. A symlink pointing out of the bot's tree
    # would pass an abspath prefix check and then write wherever it points; realpath
    # follows it first. This is the same reason the other bots' guards resolve
    # rather than string-compare.
    try:
        resolved = os.path.realpath(os.path.expandvars(os.path.expanduser(str(target))))
    except (ValueError, OSError) as exc:
        deny(f"could not resolve {target!r}: {exc}")

    root = os.path.realpath(BOT_ROOT)
    if not (resolved.lower() == root.lower() or resolved.lower().startswith(root.lower() + os.sep)):
        deny(f"{resolved} is outside media-bot's own tree ({root}). This bot writes its own runs/ and "
             f"nothing else — not a sibling bot, not the dashboard, not the root CLAUDE.md.")

    rel = os.path.relpath(resolved, root)
    if os.path.basename(resolved) in DENIED_NAMES:
        deny(f"{os.path.basename(resolved)} is never written by the agent. "
             f"The trash-bin manifest is written only by scripts/triage.py, and the credential files "
             f"are written only by you and by scripts/graph_login.py.")

    if not any(rel.startswith(p) for p in ALLOWED_PREFIXES):
        deny(f"{rel} is not under runs/ or state/dryrun/. Those are the only two places this bot writes. "
             f"New capability belongs in a script, added deliberately, not in an ad-hoc write.")

    sys.exit(0)


if __name__ == "__main__":
    main()
