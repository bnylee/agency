#!/usr/bin/env python3
"""The trash bin. The only script in media-bot that changes anything.

    python scripts/triage.py stage   --digest state/collect-latest.json [--dry-run]
    python scripts/triage.py restore --batch 2026-08-04 [--dry-run]
    python scripts/triage.py list

## What "trash bin" means here, precisely

It means a Gmail **label**, and nothing else. `stage` moves a junk-classified
message out of the inbox and into `Agency/Trash-Candidates`; `restore` moves it
back. The message is never deleted, never moved to Gmail's own Trash (which
auto-purges after 30 days and would make this destructive on a timer), and never
marked read.

This is disk-cleanup's quarantine model applied to mail, on purpose and for the
same reason: the bot is allowed to do the reversible half of the job and the
irreversible half stays a human decision at a place where you can see what you are
about to lose. **There is deliberately no `purge` verb in this file.** Emptying the
bin is done in Gmail, by you, looking at the list.

## The manifest is the whole safety story

Every staged message is recorded in `state/trash-bin.json` with its id, its
sender, its subject, the date, and the exact rules that classified it. `restore`
reads that file — it does not re-derive anything and does not re-run the
classifier. So a restore puts back precisely what was taken, even if the rules
have since changed, which is the property that makes the operation trustworthy.

If the manifest and Gmail disagree — a message staged here but since moved by hand
— `restore` reports the mismatch and leaves that message alone rather than
guessing.

## Why IMAP COPY + STORE and not MOVE

`MOVE` (RFC 6851) is a single atomic command and would be nicer, but it is an
extension and not every server advertises it. COPY-then-flag is universally
supported, and the ORDER matters: copy first, verify, and only then remove from
the inbox. Flagging first would mean a failed copy leaves the message deleted from
the inbox and nowhere else.
"""
from __future__ import annotations

import argparse
import imaplib
import json
import os
import ssl
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from providers import iso, load_env, now_utc  # noqa: E402

TRASH_LABEL = "Agency/Trash-Candidates"
MANIFEST = os.path.join(BOT_DIR, "state", "trash-bin.json")


def read_manifest() -> dict:
    if not os.path.exists(MANIFEST):
        return {"batches": []}
    try:
        with open(MANIFEST, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"media-bot triage: manifest at {MANIFEST} is unreadable: {exc}", file=sys.stderr)
        print("Refusing to continue — writing a fresh manifest would orphan whatever is already staged.",
              file=sys.stderr)
        sys.exit(2)


def write_manifest(data: dict) -> None:
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def connect(env: dict[str, str]) -> imaplib.IMAP4_SSL:
    user = env.get("GMAIL_ADDRESS", "").strip()
    password = env.get("GMAIL_APP_PASSWORD", "").strip()
    if not user or not password:
        print("media-bot triage: GMAIL_ADDRESS and GMAIL_APP_PASSWORD are not set in media-bot/.env",
              file=sys.stderr)
        sys.exit(2)
    host = env.get("GMAIL_IMAP_HOST", "imap.gmail.com")
    conn = imaplib.IMAP4_SSL(host, 993, ssl_context=ssl.create_default_context())
    conn.login(user, password)
    return conn


def ensure_label(conn: imaplib.IMAP4_SSL, label: str) -> None:
    """Create the label if it is missing. Idempotent.

    Gmail's IMAP returns NO with ALREADYEXISTS rather than OK when the mailbox is
    already there, so a non-OK result is not on its own a failure — which is why
    this checks the text rather than the status.
    """
    typ, data = conn.create(f'"{label}"')
    if typ == "OK":
        return
    joined = b" ".join(x or b"" for x in (data or [])).decode("utf-8", "replace").upper()
    if "ALREADYEXISTS" in joined or "ALREADY EXISTS" in joined:
        return
    print(f"media-bot triage: could not create label {label}: {joined}", file=sys.stderr)
    sys.exit(1)


def find_uid(conn: imaplib.IMAP4_SSL, message_id_header: str) -> bytes | None:
    """Locate a message by its RFC Message-ID header.

    ## Why not by the IMAP sequence number the digest recorded

    Because sequence numbers are not stable. They are positions in the mailbox, and
    they shift every time a message above them is deleted or expunged. Staging a
    batch by sequence number a day after collecting it would move whatever happens
    to be sitting at that position now — which could be anything, including the
    message you most wanted to keep. The Message-ID is assigned by the sending mail
    system and does not move.
    """
    # Searched WITHOUT angle brackets, matching how providers.py stores it. IMAP's
    # HEADER search is a substring match on the header value, so the bare form
    # matches whether or not the server kept the brackets — the bracketed form does
    # not match a server that stripped them.
    typ, data = conn.search(None, "HEADER", "Message-ID", f'"{message_id_header}"')
    if typ != "OK":
        return None
    ids = (data[0] or b"").split()
    return ids[-1] if ids else None


def stage(args: argparse.Namespace, env: dict[str, str]) -> int:
    digest_path = args.digest if os.path.isabs(args.digest) else os.path.join(BOT_DIR, args.digest)
    try:
        with open(digest_path, encoding="utf-8-sig") as fh:
            digest = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"media-bot triage: cannot read digest {digest_path}: {exc}", file=sys.stderr)
        return 2

    # Only Gmail messages can be staged: the label move is an IMAP operation and
    # the Outlook adapter holds read-only Graph scopes by design. Outlook junk is
    # reported in the digest and left where it is, which is stated in the run
    # report rather than silently skipped.
    candidates = [m for m in digest.get("trash_candidates", []) if m.get("source") == "gmail"]
    skipped_other = [m for m in digest.get("trash_candidates", []) if m.get("source") != "gmail"]

    batch_id = args.batch or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if args.dry_run:
        print(f"media-bot triage: DRY RUN — nothing moved.")
        print(f"  would create label   {TRASH_LABEL}")
        print(f"  would stage          {len(candidates)} message(s) as batch {batch_id}")
        if skipped_other:
            print(f"  would leave in place {len(skipped_other)} non-Gmail message(s) "
                  f"(the Outlook adapter is read-only)")
        for m in candidates[:20]:
            print(f"    - {(m.get('from') or '')[:38]:<38} {(m.get('subject') or '')[:52]}")
            print(f"      because: {'; '.join(m.get('reasons', []))[:150]}")
        if len(candidates) > 20:
            print(f"    ... and {len(candidates) - 20} more")
        print("  nothing would be deleted; restore with: python scripts/triage.py restore --batch " + batch_id)
        return 0

    if not candidates:
        print("media-bot triage: nothing classified as junk. Bin unchanged.")
        return 0

    cap = args.cap
    if len(candidates) > cap:
        print(f"media-bot triage: {len(candidates)} candidates exceeds the per-run cap of {cap}; "
              f"staging the first {cap} and leaving the rest for the next run.")
        candidates = candidates[:cap]

    conn = connect(env)
    staged: list[dict] = []
    problems: list[dict] = []
    try:
        ensure_label(conn, TRASH_LABEL)
        conn.select("INBOX")  # writable this time, unlike the collector
        for m in candidates:
            mid_header = m.get("message_id") or ""
            if not mid_header:
                problems.append({"subject": m.get("subject"), "why": "the digest recorded no Message-ID header"})
                continue
            uid = find_uid(conn, mid_header)
            if uid is None:
                problems.append({"subject": m.get("subject"), "why": "no longer in INBOX (already moved by hand?)"})
                continue
            # COPY first. If this fails the message is untouched.
            typ, _ = conn.copy(uid, f'"{TRASH_LABEL}"')
            if typ != "OK":
                problems.append({"subject": m.get("subject"), "why": f"COPY to {TRASH_LABEL} returned {typ}"})
                continue
            # Only now remove it from the inbox. On Gmail's IMAP, \Deleted plus
            # EXPUNGE against INBOX removes the INBOX label and leaves every other
            # label — including the one just added — so the message survives. This
            # is Gmail-specific behaviour and the reason this script is Gmail-only.
            typ, _ = conn.store(uid, "+FLAGS", "\\Deleted")
            if typ != "OK":
                problems.append({"subject": m.get("subject"),
                                 "why": f"copied to {TRASH_LABEL} but could not remove from INBOX ({typ}); "
                                        f"it is now in both places"})
                continue
            staged.append({
                "message_id": mid_header,
                "from": m.get("from"),
                "from_address": m.get("from_address"),
                "subject": m.get("subject"),
                "date": m.get("date"),
                "reasons": m.get("reasons", []),
            })
        conn.expunge()
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            conn.logout()
        except Exception:
            pass

    manifest = read_manifest()
    manifest["batches"] = [b for b in manifest.get("batches", []) if b.get("batch_id") != batch_id] + [{
        "batch_id": batch_id,
        "staged_at": iso(now_utc()),
        "label": TRASH_LABEL,
        "count": len(staged),
        "restored_at": None,
        "messages": staged,
        "problems": problems,
    }]
    write_manifest(manifest)

    print(f"media-bot triage: staged {len(staged)} message(s) to {TRASH_LABEL} as batch {batch_id}")
    print(f"  manifest {MANIFEST}")
    print(f"  restore with: python scripts/triage.py restore --batch {batch_id}")
    if skipped_other:
        print(f"  left {len(skipped_other)} non-Gmail junk message(s) in place (Outlook access is read-only)")
    for p in problems:
        print(f"  PROBLEM {p['why']}: {(p.get('subject') or '')[:60]}")
    return 1 if problems else 0


def restore(args: argparse.Namespace, env: dict[str, str]) -> int:
    manifest = read_manifest()
    batch = next((b for b in manifest.get("batches", []) if b.get("batch_id") == args.batch), None)
    if batch is None:
        have = ", ".join(b.get("batch_id", "?") for b in manifest.get("batches", [])) or "none"
        print(f"media-bot triage: no batch {args.batch} in the manifest. Have: {have}", file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"media-bot triage: DRY RUN — nothing moved.")
        print(f"  would restore {batch['count']} message(s) from batch {args.batch} back to INBOX")
        for m in batch.get("messages", [])[:20]:
            print(f"    - {(m.get('from') or '')[:38]:<38} {(m.get('subject') or '')[:52]}")
        return 0

    conn = connect(env)
    restored = 0
    problems: list[str] = []
    try:
        conn.select(f'"{batch["label"]}"')
        for m in batch.get("messages", []):
            uid = find_uid(conn, m.get("message_id", ""))
            if uid is None:
                problems.append(f"not in {batch['label']} any more: {(m.get('subject') or '')[:60]}")
                continue
            typ, _ = conn.copy(uid, "INBOX")
            if typ != "OK":
                problems.append(f"COPY back to INBOX returned {typ}: {(m.get('subject') or '')[:60]}")
                continue
            conn.store(uid, "+FLAGS", "\\Deleted")
            restored += 1
        conn.expunge()
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            conn.logout()
        except Exception:
            pass

    batch["restored_at"] = iso(now_utc())
    batch["restored_count"] = restored
    write_manifest(manifest)

    print(f"media-bot triage: restored {restored} of {batch['count']} message(s) from batch {args.batch}")
    for p in problems:
        print(f"  PROBLEM {p}")
    return 1 if problems else 0


def list_batches(_args: argparse.Namespace, _env: dict[str, str]) -> int:
    manifest = read_manifest()
    batches = manifest.get("batches", [])
    if not batches:
        print("media-bot triage: the trash bin is empty. Nothing has ever been staged.")
        return 0
    print(f"media-bot triage: {len(batches)} batch(es) in {MANIFEST}")
    for b in sorted(batches, key=lambda x: x.get("batch_id", "")):
        state = "restored" if b.get("restored_at") else "staged"
        print(f"  {b.get('batch_id'):<12} {b.get('count', 0):>4} message(s)  {state:<9} {b.get('staged_at', '')}")
        if b.get("problems"):
            print(f"               {len(b['problems'])} problem(s) recorded")
    print(f"\nNothing above is deleted. Everything is under the Gmail label {TRASH_LABEL}.")
    print("Emptying the bin is done in Gmail, by you. This script has no purge verb, deliberately.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage junk mail to a label, or put it back. Never deletes.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("stage", help="move junk-classified Gmail messages to the trash label")
    s.add_argument("--digest", default="state/collect-latest.json")
    s.add_argument("--batch", default="", help="batch id, defaults to today's date")
    s.add_argument("--cap", type=int, default=200, help="max messages per run (default 200)")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=stage)

    r = sub.add_parser("restore", help="move a batch back to the inbox")
    r.add_argument("--batch", required=True)
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(fn=restore)

    l = sub.add_parser("list", help="show what is in the bin")
    l.set_defaults(fn=list_batches)

    args = ap.parse_args()
    env = load_env(os.path.join(BOT_DIR, ".env"))
    return args.fn(args, env)


if __name__ == "__main__":
    sys.exit(main())
