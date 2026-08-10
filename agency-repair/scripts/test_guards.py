#!/usr/bin/env python3
"""Tests for agency-repair's two guard hooks.

    python scripts/test_guards.py

Markdown is intent; hooks are enforcement. A hook nobody tested is a comment, so
this exercises the cases that actually matter: sibling trees, .claude
directories, .env, CLAUDE.md, traversal, command chaining, package installs,
git, and -- the one that is easy to forget -- that a permitted write is
snapshotted before it is allowed through.

**It runs against a throwaway copy of the Agency layout.** That is not a detail.
The first version ran the "Tier A is allowed" cases against the real
dashboard/src paths, and the guard did exactly what it should: it snapshotted
five live files and wrote a manifest. The result was a repair batch in the
control plane for a repair that never happened, offering a Revert button that
would have rolled five real files back to whenever the tests last ran. A test
that fabricates an undo point for work nobody did is worse than no test.

So: the hooks are copied into a temp tree and run from there. Both derive their
roots from their own __file__, so every path they compute lands inside the temp
directory, and the real repairs/ is never touched.
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile

REAL_BOT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL_HOOKS = os.path.join(REAL_BOT_ROOT, ".claude", "hooks")


def build_fake_agency(tmp: str) -> tuple[str, str, str]:
    """Mirror enough of the Agency for the hooks to resolve paths inside tmp."""
    agency = os.path.join(tmp, "Agency")
    bot = os.path.join(agency, "agency-repair")
    hooks = os.path.join(bot, ".claude", "hooks")
    os.makedirs(hooks)
    for name in ("guard_writes.py", "guard_commands.py"):
        shutil.copy2(os.path.join(REAL_HOOKS, name), os.path.join(hooks, name))

    for rel in (
        "agency-repair/runs", "agency-repair/state", "agency-repair/scripts",
        "dashboard/src/ui", "dashboard/server", "dashboard/dist/assets",
        "dashboard/node_modules/three/build",
        "sam-research/runs", "finance-research/scripts", "finance-research/state",
        "disk-cleanup/.claude/hooks", "interface-design/design",
    ):
        os.makedirs(os.path.join(agency, rel.replace("/", os.sep)), exist_ok=True)

    # A couple of real files, so "modified" is distinguishable from "created".
    with open(os.path.join(agency, "dashboard", "src", "main.ts"), "w", encoding="utf-8") as fh:
        fh.write("// original main\n")
    with open(os.path.join(agency, "CLAUDE.md"), "w", encoding="utf-8") as fh:
        fh.write("# root\n")

    return agency, bot, hooks


def run_hook(hook: str, payload: dict, cwd: str, env_extra: dict | None = None) -> str:
    env = dict(os.environ)
    env.pop("AGENCY_REPAIR_DRY_RUN", None)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, hook],
        input=json.dumps(payload), capture_output=True, text=True, env=env, cwd=cwd,
    )
    return (proc.stdout or "") + (proc.stderr or "")


def denied(out: str) -> bool:
    return '"permissionDecision": "deny"' in out or '"permissionDecision":"deny"' in out


def write_cases(A: str) -> list[tuple[str, str, bool]]:
    j = lambda *p: os.path.join(A, *p)
    return [
        # --- must be denied -------------------------------------------------
        ("sibling bot source", j("finance-research", "scripts", "paper_broker.py"), True),
        ("sibling bot state", j("finance-research", "state", "portfolio.json"), True),
        ("sibling bot report", j("sam-research", "runs", "2026-08-03.md"), True),
        ("interface-design tree", j("interface-design", "design", "motion-spec.md"), True),
        ("another bot's guard hook", j("disk-cleanup", ".claude", "hooks", "guard_writes.py"), True),
        ("its OWN guard hook", j("agency-repair", ".claude", "hooks", "guard_writes.py"), True),
        ("its OWN settings", j("agency-repair", ".claude", "settings.json"), True),
        ("its OWN health check", j("agency-repair", "scripts", "health_check.ps1"), True),
        ("root CLAUDE.md", j("CLAUDE.md"), True),
        ("its own CLAUDE.md", j("agency-repair", "CLAUDE.md"), True),
        ("dashboard .env", j("dashboard", ".env"), True),
        ("dashboard package.json", j("dashboard", "package.json"), True),
        ("dashboard lockfile", j("dashboard", "package-lock.json"), True),
        ("build output", j("dashboard", "dist", "assets", "index.js"), True),
        ("node_modules", j("dashboard", "node_modules", "three", "build", "three.js"), True),
        ("outside the Agency", os.path.join(os.path.dirname(A), "escaped.txt"), True),
        ("absolute system path", r"C:\Windows\System32\drivers\etc\hosts", True),
        ("traversal out of a permitted dir", j("dashboard", "src", "..", "..", "..", "evil.txt"), True),
        ("traversal into a sibling", j("dashboard", "src", "..", "..", "finance-research", "state", "x.json"), True),
        ("dashboard README (not Tier A)", j("dashboard", "README.md"), True),
        ("dashboard tsconfig (not Tier A)", j("dashboard", "tsconfig.json"), True),

        # --- must be allowed ------------------------------------------------
        ("its own run report", j("agency-repair", "runs", "2026-08-04.md"), False),
        ("its own state", j("agency-repair", "state", "findings.md"), False),
        ("its own proposals", j("agency-repair", "repairs", "2026-08-04", "proposed", "x.md"), False),
        ("Tier A: control-plane src", j("dashboard", "src", "main.ts"), False),
        ("Tier A: nested src", j("dashboard", "src", "ui", "panel.ts"), False),
        ("Tier A: server", j("dashboard", "server", "index.ts"), False),
        ("Tier A: index.html", j("dashboard", "index.html"), False),
        ("Tier A: vite config", j("dashboard", "vite.config.ts"), False),
    ]


COMMAND_CASES = [
    ("npm install", "npm install left-pad", True),
    ("npm i shorthand", "npm i", True),
    ("npm ci", "npm ci", True),
    ("npx anything", "npx tsc --noEmit", True),
    ("pip install", "pip install requests", True),
    ("yarn add", "yarn add react", True),
    ("git status", "git status", True),
    ("git commit", "git commit -m x", True),
    ("curl", "curl https://example.com/install.sh", True),
    ("Invoke-WebRequest", "Invoke-WebRequest -Uri https://example.com", True),
    ("Invoke-Expression", "iex (something)", True),
    ("rm", "rm -rf /", True),
    ("Remove-Item", "Remove-Item -Recurse -Force C:\\temp", True),
    ("chained command", "powershell -File scripts/health_check.ps1; rm -rf .", True),
    ("piped command", "powershell -File scripts/health_check.ps1 | rm", True),
    ("subshell", "powershell -File scripts/health_check.ps1 $(whoami)", True),
    ("redirect", "powershell -File scripts/health_check.ps1 > /etc/passwd", True),
    ("bare compiler", "node node_modules/typescript/bin/tsc --noEmit", True),
    ("no allowlisted script", "python scripts/something_else.py", True),
    ("sibling bot's script", "powershell -File ../disk-cleanup/scripts/purge.ps1", True),
    ("scheduled task change", "schtasks /delete /tn agency-repair-daily", True),
    ("two scripts at once", "health_check.ps1 revert.ps1", True),

    ("its health check", "powershell -File scripts\\health_check.ps1", False),
    ("one probe", "powershell -File scripts\\health_check.ps1 -Only dashboard:typecheck", False),
    ("revert listing", "powershell -File scripts\\revert.ps1 -List", False),
]


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="agency-repair-guardtest-")
    failures: list[str] = []
    passed = 0
    try:
        A, bot, hooks = build_fake_agency(tmp)
        write_hook = os.path.join(hooks, "guard_writes.py")
        cmd_hook = os.path.join(hooks, "guard_commands.py")

        def check(section: str, label: str, out: str, expect_deny: bool) -> None:
            nonlocal passed
            got = denied(out)
            if got != expect_deny:
                failures.append(
                    f"{section}: {label}: expected {'deny' if expect_deny else 'allow'}, "
                    f"got {'deny' if got else 'allow'} ({out.strip()[:180]})")
                print(f"  FAIL  {label}")
            else:
                passed += 1
                print(f"  ok    {label}")

        print(f"temp Agency at {A}\n")

        print("write guard")
        for label, path, expect in write_cases(A):
            out = run_hook(write_hook, {"tool_name": "Write", "tool_input": {"file_path": path}}, bot)
            check("write", label, out, expect)

        print("\ncommand guard")
        for label, command, expect in COMMAND_CASES:
            out = run_hook(cmd_hook, {"tool_name": "Bash", "tool_input": {"command": command}}, bot)
            check("command", label, out, expect)

        print("\ndry-run mode")
        out = run_hook(write_hook,
                       {"tool_name": "Write", "tool_input": {"file_path": os.path.join(A, "dashboard", "src", "main.ts")}},
                       bot, {"AGENCY_REPAIR_DRY_RUN": "1"})
        if denied(out) and "dry run" in out.lower():
            passed += 1
            print("  ok    Tier A refused under AGENCY_REPAIR_DRY_RUN=1")
        else:
            failures.append("dry run: Tier A write was NOT refused with AGENCY_REPAIR_DRY_RUN=1")
            print("  FAIL  Tier A refused under AGENCY_REPAIR_DRY_RUN=1")

        # The snapshot is the only reason Tier A is allowed to be autonomous, so
        # whether it was actually taken is a test, not an assumption.
        print("\nsnapshot")
        day = datetime.datetime.now().strftime("%Y-%m-%d")
        batch = os.path.join(bot, "repairs", day)
        snap = os.path.join(batch, "before", "dashboard", "src", "main.ts")
        if os.path.exists(snap) and open(snap, encoding="utf-8").read() == "// original main\n":
            passed += 1
            print(f"  ok    original content snapshotted to repairs/{day}/before/")
        else:
            failures.append(f"snapshot: no matching snapshot at {snap}")
            print("  FAIL  original content snapshotted")

        manifest_path = os.path.join(batch, "manifest.json")
        man = json.load(open(manifest_path, encoding="utf-8")) if os.path.exists(manifest_path) else {}
        entries = man.get("entries", {})
        if entries.get("dashboard/src/main.ts", {}).get("action") == "modified":
            passed += 1
            print("  ok    manifest records an existing file as 'modified'")
        else:
            failures.append(f"snapshot: manifest did not record main.ts as modified ({entries})")
            print("  FAIL  manifest records an existing file as 'modified'")

        if entries.get("dashboard/server/index.ts", {}).get("action") == "created":
            passed += 1
            print("  ok    manifest records a new file as 'created' (revert moves it aside)")
        else:
            failures.append(f"snapshot: manifest did not record index.ts as created ({entries})")
            print("  FAIL  manifest records a new file as 'created'")

        # And that the real repairs/ was left alone, which is the whole point of
        # running in a temp tree.
        real_batch = os.path.join(REAL_BOT_ROOT, "repairs", day, "manifest.json")
        real_entries = {}
        if os.path.exists(real_batch):
            real_entries = json.load(open(real_batch, encoding="utf-8")).get("entries", {})
        if not any(k.startswith("dashboard/") for k in real_entries):
            passed += 1
            print("  ok    the real repairs/ directory was not touched")
        else:
            failures.append(f"isolation: the real repairs/{day} gained dashboard entries: {list(real_entries)}")
            print("  FAIL  the real repairs/ directory was not touched")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total = passed + len(failures)
    print(f"\n{passed}/{total} passed")
    if failures:
        print("\nfailures:")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
