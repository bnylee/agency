#!/usr/bin/env python3
"""PreToolUse hook: constrain what shell commands agency-repair may run.

This bot needs a shell for a real reason -- Tier A requires re-running a health
probe to prove a fix turned it green, and that means running a compiler. But
"needs to run a compiler" is one step away from "runs anything", and the step in
between is where a supply-chain compromise lives.

So the primary control is an ALLOWLIST of exactly two of this bot's own scripts,
not a denylist of dangerous verbs. A denylist over shell strings is evaded by
quoting, aliasing or chaining, and a guard that can be evaded is decoration.
`health_check.ps1` is what invokes tsc and vite; the bot invokes the script, and
the script is unwritable (settings.json denies Edit(./scripts/**)). New
capability goes in a script, not in an ad-hoc command.

The denylist below is secondary defence and a source of better error messages.
Correctness does not depend on it.
"""
import json
import os
import re
import sys

ALLOWED_SCRIPTS = {
    "health_check.ps1",   # every probe, or one at a time with -Only
    "revert.ps1",         # undo a repair batch
}

# Chaining, redirection and substitution would let an allowed script name sit in
# front of an arbitrary command. A single leading "&" is stripped first: it is
# PowerShell's call operator and the normal way to invoke a script by path.
FORBIDDEN_CHARS = ("&", ";", "|", "`", "$(", "${", ">", "<", "\n", "\r")

# Secondary defence. Whole-word, case-insensitive. The first group is the
# supply-chain boundary and is the reason this bot exists in the shape it does:
# it may read about a package all day and may never install one.
DANGEROUS_PATTERNS = (
    (r"\bnpm\s+(i|install|ci|add|exec|update)\b", "installing a dependency is never autonomous"),
    (r"\bnpx\b", "npx resolves and executes packages from the registry"),
    (r"\b(pip|pip3|uv|poetry|pipx)\s+install\b", "installing a dependency is never autonomous"),
    (r"\byarn\b|\bpnpm\b|\bbun\s+(add|install)\b", "installing a dependency is never autonomous"),
    (r"\bgit\b", "this bot never runs git; reversibility is the repairs/ snapshot batch"),
    (r"\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|start-bitstransfer)\b",
     "fetching from the network happens through WebFetch, which is domain-locked"),
    (r"\b(iex|invoke-expression)\b", "executing a constructed string defeats every guard above"),
    (r"\b(rm|del|remove-item|erase|rmdir|rd|unlink|clear-recyclebin)\b",
     "this bot never deletes; revert.ps1 moves files aside instead"),
    (r"\b(format|diskpart|vssadmin|cipher|sdelete)\b", "destructive system command"),
    (r"\b(stop-process|stop-service|taskkill|sc\.exe|net\s+stop)\b", "process and service control is out of scope"),
    (r"\breg\s+(add|delete)\b|\bset-itemproperty\b", "registry writes are out of scope"),
    (r"\b(schtasks|register-scheduledtask|unregister-scheduledtask|set-scheduledtask)\b",
     "changing a schedule is Benny's; propose it under Holding"),
    (r"\bpurge\.ps1\b", "purge is terminal-only and belongs to disk-cleanup"),
)

TOKEN_RE = re.compile(r'"([^"]*)"' r"|'([^']*)'" r"|(\S+)")


def deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"agency-repair command guard: {reason}",
        }
    }))
    sys.exit(0)


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name", "") not in ("Bash", "PowerShell"):
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command.strip():
        sys.exit(0)

    bot_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    normalized = command.strip()
    if normalized.startswith("&"):
        normalized = normalized[1:].strip()

    for char in FORBIDDEN_CHARS:
        if char in normalized:
            deny(f"command contains {char!r}; chaining, redirection and substitution "
                 "are blocked so an allowed script cannot prefix an arbitrary command")

    lowered = normalized.lower()

    for pattern, why in DANGEROUS_PATTERNS:
        if re.search(pattern, lowered):
            deny(f"{why} (matched {pattern!r})")

    # Every path token must land inside this bot's own tree. The scripts take no
    # path arguments, so anything path-shaped pointing elsewhere is either a
    # mistake or an attempt to run a script from another bot's folder.
    for match in TOKEN_RE.finditer(normalized):
        token = next((g for g in match.groups() if g is not None), "")
        if "\\" not in token and "/" not in token:
            continue
        try:
            resolved = os.path.realpath(os.path.abspath(os.path.expandvars(token)))
        except (ValueError, OSError):
            continue
        if resolved.lower().endswith(".exe"):
            continue  # powershell.exe / python.exe live outside the tree
        if not resolved.lower().startswith(bot_root.lower()):
            deny(f"path {token} is outside this bot's own folder; its scripts take "
                 "no paths from outside and read the Agency layout themselves")

    matched = [s for s in ALLOWED_SCRIPTS if s.lower() in lowered]
    if not matched:
        deny("no allowlisted script in command. This bot may only invoke "
             f"{', '.join(sorted(ALLOWED_SCRIPTS))}. Compilers and build tools are "
             "run BY health_check.ps1, not directly -- that script is the audited "
             "surface and it is not editable by this bot.")
    if len(matched) > 1:
        deny(f"command references multiple scripts {matched}; run one at a time")

    sys.exit(0)


if __name__ == "__main__":
    main()
