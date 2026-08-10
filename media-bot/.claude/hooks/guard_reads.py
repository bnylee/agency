#!/usr/bin/env python3
"""PreToolUse hook: keep media-bot's credentials out of the agent's context.

This is the one hook in the Agency that guards READS, and the reason is specific:
this is the only bot that holds live credentials for accounts that are not its own.
A Gmail app password, a Canvas access token and a Microsoft refresh token all sit
in this folder.

## The threat is not theft, it is transcription

The agent has no shell and no network, so it cannot exfiltrate anything. What it
CAN do is read `.env` and then quote it — into a run report, into a facts file,
into `runs/scheduler-log.txt` via its own stdout. Every one of those is a file that
persists, and one of them is rendered by the control plane in a browser. A
credential that lands in `runs/2026-08-04.md` is a credential you now have to
rotate and cannot un-write.

So the guard is at the read, before the value ever enters the context. Denying the
read is the only version of this that works: once the string is in the transcript,
no later rule can take it back out.

## Why a hook and not just a deny rule

Both are present, and they fail differently. `settings.json` has
`Read(./.env)` denied, which is a path somebody wrote down. This hook denies by
PATTERN — any `.env*`, any file whose name contains `token`, `secret`, `credential`
or `password`, anywhere under this bot — so a future `state/canvas-token.json`
added by a later change is covered on the day it is created rather than on the day
someone remembers to add a rule for it.
"""
import json
import os
import re
import sys

BOT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Matched against the file's BASENAME, case-insensitively.
SECRET_NAMES = re.compile(
    r"(^\.env($|\.)|token|secret|credential|password|app[-_]?pass|\.pem$|\.key$|id[-_]?rsa)",
    re.IGNORECASE,
)

# Named explicitly as well as by pattern, because these are the two that exist today
# and an explicit entry gives a better error message than a regex hit does.
KNOWN_SECRETS = {
    os.path.join("state", "graph-token.json"): "the Microsoft Graph refresh token",
    ".env": "the Gmail app password and the Canvas access token",
}

READ_TOOLS = {"Read", "NotebookRead"}


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"media-bot read guard: {reason}",
        }
    }))
    sys.exit(0)


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name", "") not in READ_TOOLS:
        sys.exit(0)

    tool_input = data.get("tool_input", {}) or {}
    target = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path")
    if not target:
        sys.exit(0)

    try:
        resolved = os.path.realpath(os.path.expandvars(os.path.expanduser(str(target))))
    except (ValueError, OSError):
        sys.exit(0)

    root = os.path.realpath(BOT_ROOT)
    rel = os.path.relpath(resolved, root) if resolved.lower().startswith(root.lower()) else None

    if rel is not None:
        for known, what in KNOWN_SECRETS.items():
            if rel.lower() == known.lower():
                deny(f"{rel} holds {what}. The agent never needs a credential to write a digest — "
                     f"scripts/collect.py reads these and hands you only the classified result. "
                     f"Reading it here would put the secret in the transcript, and from there into "
                     f"whatever this run writes.")

    if SECRET_NAMES.search(os.path.basename(resolved)):
        deny(f"{os.path.basename(resolved)} looks like a credential file. Denied by pattern rather than "
             f"by name so that a secret added later is covered on the day it is created. If this is a "
             f"false positive, the fix is to rename the file, not to widen this rule.")

    sys.exit(0)


if __name__ == "__main__":
    main()
