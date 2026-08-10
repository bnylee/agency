#!/usr/bin/env python3
"""PreToolUse hook: a bot may only write under its own runs/ or state/.

Copied verbatim from finance-research. Note this deliberately leaves policy.json
at the bot root unwritable — the never-touch list must not be editable by the
bot whose behaviour it constrains.
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
    allowed_roots = [
        os.path.join(bot_root, "runs"),
        os.path.join(bot_root, "state"),
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
                    f"{bot_name} may only write under runs/ or state/; "
                    f"blocked write to {file_path}"
                ),
            }
        }))
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
