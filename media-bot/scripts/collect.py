#!/usr/bin/env python3
"""media-bot collector. Read-only across every provider.

    python scripts/collect.py --out state/collect-latest.json
    python scripts/collect.py --out state/collect-latest.json --dry-run

Writes one JSON file: the classified digest, the calendar, the task list and the
trash-bin candidates. Nothing here can change anything at any provider — the only
write path in this bot is triage.py, and it is a separate script for exactly that
reason.

## Exit codes

    0  every configured provider answered
    1  at least one CONFIGURED provider failed
    2  bad usage

`not_configured` and `unavailable` are NOT failures and do not affect the exit
code. A bot with no credentials yet should report that clearly every run and be
green about it; a bot whose Gmail password was revoked should go red. Collapsing
those two states is how an unconfigured bot ends up permanently red and therefore
permanently ignored.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from classify import classify_message, event_urgency, summarise, task_priority  # noqa: E402
from providers import (  # noqa: E402
    Result,
    fetch_canvas,
    fetch_gmail,
    fetch_ics,
    fetch_outlook,
    iso,
    load_env,
    now_utc,
    unavailable_results,
)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Collect and classify notifications. Read-only.")
    ap.add_argument("--out", required=True, help="where to write the digest JSON")
    ap.add_argument("--dry-run", action="store_true",
                    help="do everything including the network reads, and print the digest instead of writing it")
    ap.add_argument("--since-hours", type=int, default=48,
                    help="how far back to read mail (default 48)")
    ap.add_argument("--limit", type=int, default=120,
                    help="max messages per mail provider (default 120)")
    ap.add_argument("--calendar-days", type=int, default=14,
                    help="calendar horizon in days (default 14)")
    ap.add_argument("--only", default="",
                    help="comma-separated provider ids to run, for debugging one at a time")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    env = load_env(os.path.join(BOT_DIR, ".env"))
    token_path = os.path.join(BOT_DIR, "state", "graph-token.json")
    only = {p.strip() for p in args.only.split(",") if p.strip()}

    def wanted(name: str) -> bool:
        return not only or name in only

    results: list[Result] = []

    # A provider raising rather than returning a Result is a bug in that adapter,
    # but it must not take the whole sweep down: three working providers and one
    # crash should still produce a digest that reports the crash. Each is therefore
    # wrapped, and the wrapper reports `failed` with the exception text — which is
    # the failure-handling rule from the root CLAUDE.md, applied per provider.
    def run(name: str, fn) -> None:
        if not wanted(name):
            return
        try:
            results.append(fn())
        except Exception as exc:  # noqa: BLE001 - deliberate: see above
            results.append(Result(name, "failed", error=f"adapter raised {type(exc).__name__}: {exc}"))

    run("gmail", lambda: fetch_gmail(env, args.since_hours, args.limit))
    run("outlook", lambda: fetch_outlook(env, token_path, args.since_hours, args.limit))
    run("canvas", lambda: fetch_canvas(env))
    run("ics", lambda: fetch_ics(env, args.calendar_days))
    for res in unavailable_results():
        if wanted(res.provider):
            results.append(res)

    # ---- classify -----------------------------------------------------------
    extra = {d.strip().lower() for d in env.get("IMPORTANT_DOMAINS", "").split(",") if d.strip()}
    messages: list[dict] = []
    events: list[dict] = []
    tasks: list[dict] = []
    for res in results:
        for m in res.messages:
            messages.append(classify_message(m, extra))
        for e in res.events:
            band, hours = event_urgency(e.get("start"))
            events.append({**e, "urgency": band, "hours_away": None if hours is None else round(hours, 2)})
        for t in res.tasks:
            band, hours = event_urgency(t.get("due"))
            tasks.append({**t, "urgency": band, "hours_away": None if hours is None else round(hours, 2),
                          "priority": task_priority(t)})

    # Newest first within each priority. Sorted with an explicit empty-string
    # fallback because a message with no parseable Date must not crash the sort —
    # real mail contains malformed Date headers more often than you would expect.
    order = {"important": 0, "normal": 1, "junk": 2}
    messages.sort(key=lambda m: (order.get(m.get("priority", "normal"), 1), m.get("date") or ""), reverse=False)
    messages.sort(key=lambda m: order.get(m.get("priority", "normal"), 1))
    events.sort(key=lambda e: e.get("start") or "")
    tasks.sort(key=lambda t: (t.get("due") is None, t.get("due") or ""))

    trash = [m for m in messages if m.get("priority") == "junk"]
    feed = [m for m in messages if m.get("priority") != "junk"]

    configured_failures = [r for r in results if r.status == "failed"]

    digest = {
        "generated_at": iso(now_utc()),
        "window_hours": args.since_hours,
        "calendar_days": args.calendar_days,
        "status": "partial" if configured_failures else "ok",
        "providers": [r.to_json() for r in results],
        "summary": summarise(messages, events, tasks),
        # The feed and the trash bin are separate keys rather than one list with a
        # flag, because every consumer wants one or the other and never both mixed.
        "feed": feed,
        "trash_candidates": trash,
        "calendar": events,
        "tasks": tasks,
        "unavailable": [r.provider for r in results if r.status == "unavailable"],
        "not_configured": [r.provider for r in results if r.status == "not_configured"],
        "failed": [{"provider": r.provider, "error": r.error} for r in configured_failures],
        "disclaimer": (
            "Read-only collection. Nothing was marked read, moved, archived or deleted. "
            "Instagram, TikTok and Snapchat have no personal notification API; what appears for them "
            "is their own activity EMAIL, classified from mail, and is labelled via: email."
        ),
    }

    body = json.dumps(digest, indent=2, ensure_ascii=False)

    if args.dry_run:
        s = digest["summary"]
        print("media-bot collect: DRY RUN — nothing written.")
        print(f"  would write {args.out} ({len(body.encode('utf-8'))} bytes)")
        for r in results:
            line = f"  {r.provider:<10} {r.status:<15}"
            if r.status == "ok":
                line += f"{len(r.messages)} msg / {len(r.events)} events / {len(r.tasks)} tasks"
            elif r.error:
                line += r.error[:110]
            print(line)
        print(f"  needs_you={s['needs_you']}  important={s['important']}  junk={s['junk']}  "
              f"events_today={s['events_today']}  tasks_due_soon={s['tasks_due_soon']}")
        return 1 if configured_failures else 0

    out_path = args.out if os.path.isabs(args.out) else os.path.join(BOT_DIR, args.out)
    # Refuse to write outside this bot's tree. Same rule as every other script
    # here, and cheap enough that there is no reason to leave it out.
    real_out = os.path.abspath(out_path)
    if not real_out.lower().startswith(os.path.abspath(BOT_DIR).lower() + os.sep):
        print(f"media-bot collect: --out must be inside {BOT_DIR}", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(real_out), exist_ok=True)
    # Written without a BOM. PowerShell's Out-File and Set-Content add one, and
    # json.load rejects it with an error that points at character 0 and explains
    # nothing — the same trap the other bots' report writers document.
    with open(real_out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)

    s = digest["summary"]
    print(f"media-bot collect: wrote {real_out}")
    print(f"  needs_you={s['needs_you']} important={s['important']} normal={s['normal']} junk={s['junk']} "
          f"events_today={s['events_today']} tasks_due_soon={s['tasks_due_soon']}")
    for r in results:
        if r.status != "ok":
            print(f"  {r.provider}: {r.status}{' — ' + r.error if r.error else ''}")
    return 1 if configured_failures else 0


if __name__ == "__main__":
    sys.exit(main())
