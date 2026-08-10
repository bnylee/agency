#!/usr/bin/env python3
"""PreToolUse hook: constrain where interface-design may write.

Same shape as the sibling bots' guard, with one deliberate difference: this bot
produces a shared deliverable, so its allowlist includes Agency/dashboard/ as
well as its own design/, runs/ and state/.

What it still blocks is the thing that matters -- writes into another bot's
folder. A design agent has no business editing disk-cleanup's guard hooks or
finance-research's watchlist, and this bot runs interactively with a human
approving edits, which is exactly when a stray path is easiest to miss.
"""
import json
import os
import sys


def main():
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    if tool not in ("Write", "Edit"):
        sys.exit(0)

    file_path = data.get("tool_input", {}).get("file_path", "")
    if not file_path:
        sys.exit(0)

    bot_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bot_name = os.path.basename(bot_root)
    agency_root = os.path.dirname(bot_root)

    allowed_roots = [
        os.path.join(bot_root, "design"),
        os.path.join(bot_root, "runs"),
        os.path.join(bot_root, "state"),
        os.path.join(bot_root, ".claude", "skills"),
        os.path.join(agency_root, "dashboard"),
    ]

    target = os.path.abspath(file_path)

    allowed = False
    for root in allowed_roots:
        try:
            if os.path.commonpath([target, root]) == root:
                allowed = True
                break
        except ValueError:
            # different drives on Windows; definitely not under root
            continue

    if not allowed:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"{bot_name} may only write under its own design/, runs/, state/, "
                    f".claude/skills/, or Agency/dashboard/; blocked write to {file_path}"
                ),
            }
        }))
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
