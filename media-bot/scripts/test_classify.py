#!/usr/bin/env python3
"""Tests for media-bot's classifier and its ICS reader.

    python scripts/test_classify.py

No network, no credentials, no fixtures on disk. Every case is a dict built in this
file, which is the point: the classifier is a pure function of a message's headers,
so it is testable exactly the way arithmetic is, and that is the whole reason it
lives in a script instead of in a prompt.

## What is being protected

The trash bin. `restore` promises to put back precisely what was taken, and that
promise is only worth anything if what gets taken is predictable. Every case below
that asserts `!= "junk"` is a message that must never reach the bin, and each of
those is a real failure somebody would notice: a professor's mail, a 2FA code, a
tuition bill, a message request from a friend.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from classify import classify_message, event_urgency, summarise, task_priority  # noqa: E402
from providers import _parse_ics, _parse_ics_dt  # noqa: E402

failures = 0
checks = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global failures, checks
    checks += 1
    if condition:
        print(f"  ok    {name}" + (f"  ({detail})" if detail else ""))
    else:
        failures += 1
        print(f"  FAIL  {name}" + (f"  ({detail})" if detail else ""))


def msg(**over) -> dict:
    base = {
        "id": "1",
        "message_id": "abc@example.com",
        "source": "gmail",
        "via": "imap",
        "from": "Someone <someone@example.com>",
        "from_address": "someone@example.com",
        "from_domain": "example.com",
        "subject": "hello",
        "date": "2026-08-04T10:00:00Z",
        "unread": True,
        "has_unsubscribe": False,
        "is_bulk": False,
        "is_list": False,
        "in_reply_to": False,
    }
    base.update(over)
    return base


def p(**over) -> str:
    return classify_message(msg(**over))["priority"]


# --------------------------------------------------------------- important

print("important — things that must never reach the bin")

check("a professor's mail is important",
      p(from_address="oet.m@northeastern.edu", from_domain="northeastern.edu", subject="your draft") == "important")

check("a university subdomain counts too",
      p(from_address="advising@coe.northeastern.edu", from_domain="coe.northeastern.edu",
        subject="registration") == "important",
      "suffix match on .northeastern.edu")

check("Canvas is important",
      p(from_address="notifications@instructure.com", from_domain="instructure.com",
        subject="Assignment graded") == "important")

check("a 2FA code is important even from a noreply sender",
      p(from_address="noreply@bank.com", from_domain="bank.com", subject="Your verification code is 448201",
        has_unsubscribe=True, is_bulk=True) == "important",
      "the important rule BEATS two junk signals")

check("a security alert survives every junk signal",
      p(from_address="no-reply@accounts.google.com", from_domain="accounts.google.com",
        subject="Security alert: new sign-in", has_unsubscribe=True, is_bulk=True, is_list=True) == "important")

check("a tuition bill is important",
      p(from_address="billing@someschool.edu", from_domain="someschool.edu",
        subject="Your tuition bill is ready", has_unsubscribe=True, is_bulk=True) == "important")

check("a named deadline is important",
      p(subject="Reminder: application deadline is Friday") == "important")

check("'due tomorrow' is important, 'duel' is not a match",
      p(subject="Problem set due tomorrow") == "important" and p(subject="A duel at dawn") != "important",
      "whole-word patterns")

check("a thread reply is important",
      p(subject="Re: lunch", in_reply_to=True) == "important",
      "somebody is talking to you")

check("Outlook high-importance flag is honoured",
      p(source="outlook", flagged_important=True, subject="quick thing") == "important")

# ------------------------------------------------------------------- junk

print("\njunk — needs two corroborating signals, never one")

check("marketing blast is junk",
      p(from_address="promotions@shop.com", from_domain="shop.com",
        subject="40% off everything — limited time", has_unsubscribe=True) == "junk")

check("noreply + promo subject is junk",
      p(from_address="noreply@brand.com", from_domain="brand.com",
        subject="Recommended for you") == "junk")

check("a newsletter with unsubscribe and a list id is junk",
      p(from_address="newsletter@site.com", from_domain="site.com",
        subject="This week's newsletter", has_unsubscribe=True, is_list=True) == "junk")

check("ONE junk signal alone is not junk",
      p(from_address="friend@example.com", from_domain="example.com",
        subject="thoughts on this?", has_unsubscribe=True) == "normal",
      "a list you read on purpose carries List-Unsubscribe too")

check("a bulk header alone is not junk",
      p(from_address="friend@example.com", from_domain="example.com", subject="notes", is_bulk=True) == "normal")

check("a plain message from a person is normal",
      p(from_address="alex@gmail.com", from_domain="gmail.com", subject="are you around") == "normal")

# ----------------------------------------------------------------- social

print("\nsocial — the three with no API, classified from their own mail")

def social(domain: str, subject: str) -> dict:
    return classify_message(msg(from_address=f"no-reply@{domain}", from_domain=domain, subject=subject,
                                has_unsubscribe=True, is_bulk=True))

r = social("instagram.com", "sam sent you a message")
check("an Instagram message request is surfaced, not binned",
      r["priority"] != "junk" and r["service"] == "instagram" and r["via"] == "email",
      f"priority={r['priority']} service={r['service']}")

r = social("instagram.com", "5 people you may know are on Instagram")
check("Instagram 'people you may know' is junk", r["priority"] == "junk")

r = social("tiktok.com", "someone commented on your video")
check("a TikTok comment is surfaced", r["priority"] != "junk", f"priority={r['priority']}")

r = social("tiktok.com", "New videos for you")
check("TikTok 'new videos for you' is junk", r["priority"] == "junk")

r = social("snapchat.com", "New login to your account from a new device")
check("a Snapchat login alert is important",
      r["priority"] == "important" and r["service"] == "snapchat",
      f"priority={r['priority']}")

r = social("instagram.com", "Something entirely new we have not seen before")
check("an UNRECOGNISED social notification stays in the feed",
      r["priority"] == "normal",
      "the pattern lists cannot be complete, so the default must be safe")

r = social("facebookmail.com", "sam mentioned you in a comment")
check("facebookmail.com maps to instagram", r["service"] == "instagram")

# --------------------------------------------------------------- auditable

print("\nauditability — every decision records the rule that made it")

r = classify_message(msg(from_address="promotions@shop.com", from_domain="shop.com",
                         subject="Flash sale", has_unsubscribe=True))
check("a junk verdict lists its signals", len(r["reasons"]) >= 2, "; ".join(r["reasons"])[:90])

r = classify_message(msg(from_address="prof@northeastern.edu", from_domain="northeastern.edu",
                         subject="40% off — limited time", has_unsubscribe=True, is_bulk=True))
check("an override RECORDS the junk signals it beat",
      r["priority"] == "important" and any("overridden" in x for x in r["reasons"]),
      "the asymmetry is visible in the output, not just in the code")

r = classify_message(msg())
check("classify_message does not mutate its input",
      "priority" not in msg(),
      "callers get a new dict")

# ----------------------------------------------------------------- urgency

print("\nurgency — bands, and the null that must not sort as the epoch")

now = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)
def band(hours: float) -> str:
    return event_urgency((now + timedelta(hours=hours)).isoformat().replace("+00:00", "Z"), now)[0]

check("in 20 minutes is 'now'", band(0.33) == "now", band(0.33))
check("in 6 hours is 'today'", band(6) == "today", band(6))
check("in 30 hours is 'soon'", band(30) == "soon", band(30))
check("in 4 days is 'week'", band(96) == "week", band(96))
check("in 3 weeks is 'later'", band(504) == "later", band(504))
check("2 hours ago is 'past'", band(-2) == "past", band(-2))
check("no date is 'unknown', not 'past'", event_urgency(None, now)[0] == "unknown",
      "a task with no due date must not sort as if it were due at the epoch")
check("an unparseable date is 'unknown'", event_urgency("next tuesday", now)[0] == "unknown")
check("a naive timestamp is read as UTC rather than crashing",
      event_urgency("2026-08-04T18:00:00", now)[0] == "today")

check("a task due in 6 hours is important", task_priority({"due": band and
      (now + timedelta(hours=6)).isoformat().replace("+00:00", "Z")}, now) == "important")
check("a task due in 3 weeks is normal",
      task_priority({"due": (now + timedelta(hours=504)).isoformat().replace("+00:00", "Z")}, now) == "normal")

# ---------------------------------------------------------------- summarise

print("\nsummary — one source of truth for the report and the page")

messages = [
    classify_message(msg(from_domain="northeastern.edu", from_address="a@northeastern.edu", unread=True)),
    classify_message(msg(from_domain="northeastern.edu", from_address="b@northeastern.edu", unread=False)),
    classify_message(msg(subject="hi there")),
    classify_message(msg(from_address="promotions@x.com", from_domain="x.com",
                         subject="50% off", has_unsubscribe=True)),
]
events = [{"start": (now + timedelta(hours=3)).isoformat().replace("+00:00", "Z")},
          {"start": (now + timedelta(days=6)).isoformat().replace("+00:00", "Z")}]
tasks = [{"due": (now + timedelta(hours=20)).isoformat().replace("+00:00", "Z")},
         {"due": None}]
s = summarise(messages, events, tasks, now)

check("counts add up", s["important"] + s["normal"] + s["junk"] == s["messages"],
      f"{s['important']}+{s['normal']}+{s['junk']} == {s['messages']}")
check("only UNREAD important mail counts toward needs_you", s["unread_important"] == 1,
      "two important messages, one already read")
check("events today counted", s["events_today"] == 1)
check("tasks due soon counted", s["tasks_due_soon"] == 1, "the null-due task is not counted as due")
check("needs_you is the sum of the three", s["needs_you"] == 1 + 1 + 1, str(s["needs_you"]))

# --------------------------------------------------------------------- ICS

print("\nICS — unfolding, all-day, and the recurrence that is not expanded")

ICS = (
    "BEGIN:VCALENDAR\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:1@x\r\n"
    "DTSTART:20260805T140000Z\r\n"
    "SUMMARY:A title that is long enough to be wrapped by the sixty-fifth octet and\r\n"
    "  therefore continues here\r\n"
    "LOCATION:Snell Library\\, room 041\r\n"
    "END:VEVENT\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:2@x\r\n"
    "DTSTART;VALUE=DATE:20260806\r\n"
    "SUMMARY:All day thing\r\n"
    "END:VEVENT\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:3@x\r\n"
    "DTSTART:20260807T090000Z\r\n"
    "RRULE:FREQ=WEEKLY;COUNT=10\r\n"
    "SUMMARY:Weekly lecture\r\n"
    "END:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)
events = _parse_ics(ICS)
check("all three VEVENTs parsed", len(events) == 3, str(len(events)))

first = next(e for e in events if e["id"] == "1@x")
check("a folded SUMMARY is unfolded into one title",
      first["title"].endswith("therefore continues here") and "\n" not in first["title"],
      first["title"][:60] + "…")
check("an escaped comma in LOCATION is unescaped",
      first["location"] == "Snell Library, room 041", first["location"])
check("a UTC DTSTART parses", first["start"] == "2026-08-05T14:00:00Z", first["start"])

allday = next(e for e in events if e["id"] == "2@x")
check("VALUE=DATE is flagged all_day", allday["all_day"] is True)

recur = next(e for e in events if e["id"] == "3@x")
check("an RRULE event is flagged recurring, not expanded", recur["recurring"] is True,
      "one entry at DTSTART — an almost-right RRULE is worse than an honest one")
check("a non-recurring event is not flagged", first.get("recurring") is False)

check("a malformed DTSTART returns None rather than raising",
      _parse_ics_dt("not-a-date", []) is None)
check("a date-only DTSTART parses", _parse_ics_dt("20260806", ["VALUE=DATE"]) is not None)
check("a floating (no-Z) DTSTART parses", _parse_ics_dt("20260806T133000", []) is not None)

# ------------------------------------------------------------------- report

print(f"\n{checks - failures}/{checks} passed")
if failures:
    print(f"{failures} FAILED")
    sys.exit(1)
