#!/usr/bin/env python3
"""PreToolUse hook: constrain what shell commands disk-cleanup may run.

The sibling bots only read external sources, so guarding Write|Edit is enough for
them. This bot moves files, and its risk therefore lives in shell commands, not
file writes — guard_writes.py alone would let `Remove-Item -Recurse` straight
through.

The primary control is an ALLOWLIST of this bot's own scripts, not a denylist of
dangerous verbs. A denylist over shell strings is evaded by quoting, aliasing or
chaining, and a guard that can be evaded is decoration. The denylist below is
secondary defence only; correctness does not depend on it.

Default is deny. New capability goes in a script, not in an ad-hoc command.
"""
import json
import os
import re
import sys

# Scripts the bot may invoke unattended. All are Tier A (read-only) except
# quarantine.ps1 and restore.ps1, which are Tier B (reversible, manifest-backed).
ALLOWED_SCRIPTS = {
    "scan_disk.ps1",
    "scan_installed.ps1",
    "scan_duplicates.ps1",
    "quarantine.ps1",
    "restore.ps1",
    "install_tools.ps1",
}

# Tier C. purge.ps1 permanently deletes and is Benny's to run. It also refuses
# non-interactive execution on its own, so this is the outer of two locks.
DENIED_SCRIPTS = {"purge.ps1"}

# Read-only cmdlets the report may need so it can state current free space even
# if the scan JSON is stale. Matched as a whole-command prefix.
READONLY_PREFIXES = (
    "get-psdrive",
    "get-volume",
    "get-ciminstance win32_logicaldisk",
)

# Shell metacharacters that would let an allowed script prefix an arbitrary
# command. A single leading "&" is stripped first — it is PowerShell's call
# operator and the normal way to invoke a script by path.
FORBIDDEN_CHARS = ("&", ";", "|", "`", "$(", "${", ">", "<", "\n", "\r")

# Secondary defence only. Whole-word matched, case-insensitive.
DANGEROUS_PATTERNS = (
    r"\bremove-item\b", r"\bremove-itemproperty\b", r"\bri\b", r"\brm\b",
    r"\bdel\b", r"\berase\b", r"\brmdir\b", r"\brd\b", r"\bunlink\b",
    r"\bclear-recyclebin\b", r"\bformat-volume\b", r"\bformat\b",
    r"\bcipher\b", r"\bsdelete\b", r"\bvssadmin\b", r"\bdiskpart\b",
    r"\bmsiexec\b", r"\bwinget\s+uninstall\b", r"\bchoco\s+uninstall\b",
    r"\buninstall-package\b", r"\buninstall-windowsfeature\b",
    r"steam://uninstall", r"\bunins\d*\.exe\b", r"\bpowercfg\b",
    r"\bdism\b", r"\breg\s+delete\b", r"\bsc\.exe\b", r"\bnet\s+stop\b",
    r"\bset-itemproperty\b", r"\bnew-itemproperty\b",
    r"\bstop-process\b", r"\bstop-service\b",
)

TOKEN_RE = re.compile(r'"([^"]*)"' r"|'([^']*)'" r"|(\S+)")


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"disk-cleanup command guard: {reason}",
        }
    }))
    sys.exit(0)


def path_tokens(command):
    """Yield every token in the command that looks like a filesystem path."""
    for match in TOKEN_RE.finditer(command):
        token = next((g for g in match.groups() if g is not None), "")
        if "\\" in token or "/" in token:
            yield token


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name", "") not in ("Bash", "PowerShell"):
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command.strip():
        sys.exit(0)

    bot_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    onedrive_root = os.path.join(os.path.expanduser("~"), "OneDrive")

    # Strip one leading call operator, then any remaining "&" is chaining.
    normalized = command.strip()
    if normalized.startswith("&"):
        normalized = normalized[1:].strip()

    for char in FORBIDDEN_CHARS:
        if char in normalized:
            deny(
                f"command contains {char!r}; chaining, redirection and substitution "
                "are blocked so an allowed script cannot prefix an arbitrary command"
            )

    lowered = normalized.lower()

    for script in DENIED_SCRIPTS:
        if script.lower() in lowered:
            deny(
                f"{script} permanently deletes and is never run by the bot — "
                "Benny runs it interactively"
            )

    # This bot's own tree lives under OneDrive, so its scripts are the sole
    # permitted OneDrive paths. Any other OneDrive path is a deletion candidate
    # whose local removal would propagate to the cloud and every synced device.
    for token in path_tokens(normalized):
        expanded = os.path.expandvars(token.strip('"').strip("'"))
        try:
            resolved = os.path.abspath(expanded)
        except (ValueError, OSError):
            continue
        if resolved.lower().startswith(onedrive_root.lower()):
            if not resolved.lower().startswith(bot_root.lower()):
                deny(
                    f"path {token} is under OneDrive; a local delete there "
                    "propagates to the cloud and every synced device"
                )

    # czkawka must never be given a destructive delete method. NONE is its
    # default (report only); anything else groups-and-deletes.
    if "czkawka" in lowered:
        method = re.search(r"(?:-D|--delete-method)\s+(\S+)", normalized, re.IGNORECASE)
        if method and method.group(1).strip('"\'').upper() != "NONE":
            deny(
                f"czkawka delete-method {method.group(1)!r} is destructive; "
                "only -D NONE (report only) is permitted"
            )

    for prefix in READONLY_PREFIXES:
        if lowered.startswith(prefix):
            sys.exit(0)

    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, lowered):
            deny(
                f"command matches dangerous pattern {pattern!r}; deletion, "
                "uninstall and system reconfiguration are never autonomous"
            )

    matched = [s for s in ALLOWED_SCRIPTS if s.lower() in lowered]
    if not matched:
        deny(
            "no allowlisted script in command. This bot may only invoke "
            f"{', '.join(sorted(ALLOWED_SCRIPTS))}. New capability belongs in a "
            "script, not an ad-hoc command."
        )
    if len(matched) > 1:
        deny(f"command references multiple scripts {matched}; run one at a time")

    sys.exit(0)


if __name__ == "__main__":
    main()
