#!/usr/bin/env python3
"""Deterministic triage rules for media-bot.

## Why the rules are here and not in the prompt

Same split every bot in this Agency uses: the script keeps score, the model writes
prose. A classifier that lives in a prompt gives a different answer on Tuesday than
it gave on Monday for the same message, which makes the trash bin unauditable —
you could never tell whether a message was junked because of a rule or because of a
mood. Every decision below is a pure function of the message's own headers, and
every one records WHICH rule fired.

That last part is the reason for `reasons` on the output. A trash bin you cannot
interrogate is a trash bin you will not trust, and one you do not trust you will
not empty, which makes the whole feature pointless.

## The asymmetry, which is deliberate

Being wrong in the two directions costs very different amounts. A junk message
left in the digest is mild noise. An important message routed to the trash bin can
mean a missed deadline. So:

- **Any IMPORTANT signal beats every JUNK signal.** Not "outweighs" — beats. There
  is no score in which enough marketing headers can bury a message from a
  professor.
- **Junk needs corroboration.** One weak signal is not enough; a bulk header alone
  is not junk, because mailing lists you actually read carry it too.
- **Nothing is ever deleted.** The strongest thing this bot can do is move a
  message to a label, and triage.py can move it back.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------- important

# Domains whose mail is important by default. Kept deliberately short: every
# entry here is a domain that CANNOT be junked, so a broad one (gmail.com) would
# switch the whole classifier off.
IMPORTANT_DOMAINS = {
    "northeastern.edu",
    "instructure.com",
    "canvas.instructure.com",
}

# Suffix match, so husky.neu.edu and coe.northeastern.edu are covered without
# listing every subdomain a university invents.
IMPORTANT_DOMAIN_SUFFIXES = (
    ".northeastern.edu",
    ".neu.edu",
    ".instructure.com",
)

# Words that mean "there is a date attached to this". Matched case-insensitively
# on whole words, so "duel" does not match "due".
DEADLINE_WORDS = (
    r"deadline", r"due\s+(?:today|tomorrow|by|on)", r"overdue", r"final\s+notice",
    r"last\s+chance\s+to\s+(?:submit|register|enrol|enroll)", r"expires?\s+(?:today|tomorrow)",
    r"action\s+required", r"response\s+required", r"awaiting\s+your",
    r"interview", r"offer\s+letter", r"apply\s+by",
)

# Words that mean money or account safety. These are important even from a sender
# that otherwise looks like bulk mail, because the false-negative is expensive.
#
# The sign-in group is deliberately phrased tightly — `new\s+login\b`, not
# `\bdevice\b`. A marketing mail announcing "our new device" must not be promoted
# to important, and a broad `device` pattern does exactly that. The cost of being
# slightly too narrow here is a security notice left at `normal` and still in the
# feed; the cost of being too broad is the important list filling with
# advertisements until it stops being read, which is the worse failure.
CRITICAL_WORDS = (
    r"security\s+alert", r"suspicious\s+(?:sign|login|activity)", r"password\s+(?:reset|changed)",
    r"verification\s+code", r"two-factor", r"2fa", r"unauthori[sz]ed",
    r"new\s+(?:log\s?in|login|sign[\s-]?in)\b", r"logged\s+in\s+(?:from|on)\b",
    r"(?:from|on)\s+a\s+new\s+device\b", r"new\s+device\s+(?:detected|added|signed)",
    r"payment\s+(?:failed|declined|due)", r"invoice", r"past\s+due", r"refund",
    r"financial\s+aid", r"tuition", r"bill\s+is\s+(?:ready|due)",
)

# ---------------------------------------------------------------------- junk

# Local-parts that are structurally incapable of being a person. A message from
# one of these is never a reply from someone who knows you.
NOREPLY_LOCALS = re.compile(
    r"^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|updates?|"
    r"news(?:letter)?s?|marketing|promo(?:tions?)?|offers?|deals?|info|hello|hi|team|"
    r"support|mailer|bounce|postmaster|automated|alerts?)(?:[-_.+].*)?$",
    re.IGNORECASE,
)

PROMO_WORDS = (
    r"unsubscribe", r"% off", r"\bsale\b", r"\bdeal(?:s)?\b", r"limited\s+time",
    r"act\s+now", r"free\s+trial", r"upgrade\s+(?:now|today)", r"black\s+friday",
    r"cyber\s+monday", r"flash\s+sale", r"exclusive\s+offer", r"just\s+for\s+you",
    r"you\s+(?:might|may)\s+(?:also\s+)?like", r"recommended\s+for\s+you",
    r"webinar", r"survey", r"we'?d\s+love\s+your\s+feedback", r"rate\s+your",
    r"back\s+in\s+stock", r"don'?t\s+miss", r"\bnewsletter\b", r"digest\b",
)

# Social platforms whose activity mail is the ONLY way this bot sees them at all.
# Mapped to the service name so the digest can group by service, and so a thin day
# reads as "Instagram emailed nothing" rather than as a gap in coverage. See the
# table at the top of providers.py for why there is no API path for these three.
SOCIAL_SENDERS = {
    "instagram.com": "instagram",
    "mail.instagram.com": "instagram",
    "facebookmail.com": "instagram",
    "tiktok.com": "tiktok",
    "account.tiktok.com": "tiktok",
    "info.tiktok.com": "tiktok",
    "snapchat.com": "snapchat",
    "mail.snapchat.com": "snapchat",
}

# Social mail worth surfacing rather than binning. Someone messaging you is a
# notification; "5 people you may know" is an advertisement wearing a notification's
# clothes, and treating the two the same is why social notification feeds are
# useless.
SOCIAL_REAL = (
    r"sent you a message", r"messaged you", r"message request",
    r"mentioned you", r"tagged you", r"replied to", r"commented on your",
    r"started following you", r"wants to follow you", r"friend request",
    r"login|log in|new device|security", r"streak",
)

SOCIAL_NOISE = (
    r"you may know", r"suggested for you", r"people you", r"trending",
    r"popular (?:on|with)", r"see what.*posted", r"you missed", r"back on",
    r"new (?:videos?|posts?) for you", r"we picked", r"reminder to post",
    r"is live", r"went live", r"top (?:videos?|creators?)",
)


def _any(patterns, text: str) -> str | None:
    for p in patterns:
        if re.search(p, text, re.IGNORECASE):
            return p
    return None


def _is_important_domain(domain: str) -> bool:
    if not domain:
        return False
    if domain in IMPORTANT_DOMAINS:
        return True
    return any(domain.endswith(suffix) for suffix in IMPORTANT_DOMAIN_SUFFIXES)


def classify_message(msg: dict, extra_important_domains: set[str] | None = None) -> dict:
    """Return the message with `priority`, `service` and `reasons` added.

    `priority` is one of `important`, `normal`, `junk`. Nothing here mutates the
    input; the caller gets a new dict.
    """
    out = dict(msg)
    subject = msg.get("subject") or ""
    domain = (msg.get("from_domain") or "").lower()
    local = (msg.get("from_address") or "").partition("@")[0]
    reasons: list[str] = []

    important = False
    junk_signals: list[str] = []

    # ---- important ----------------------------------------------------------
    allow = set(extra_important_domains or ())
    if _is_important_domain(domain) or domain in allow:
        important = True
        reasons.append(f"sender domain {domain} is on the important list")

    hit = _any(CRITICAL_WORDS, subject)
    if hit:
        important = True
        reasons.append(f"subject matches a security/money pattern ({hit})")

    hit = _any(DEADLINE_WORDS, subject)
    if hit:
        important = True
        reasons.append(f"subject names a deadline ({hit})")

    if msg.get("in_reply_to"):
        important = True
        reasons.append("it is a reply in a thread, so someone is talking to you")

    if msg.get("flagged_important"):
        important = True
        reasons.append("the sender marked it high importance")

    # ---- social -------------------------------------------------------------
    service = SOCIAL_SENDERS.get(domain)
    if service:
        out["service"] = service
        out["via"] = "email"
        real = _any(SOCIAL_REAL, subject)
        noise = _any(SOCIAL_NOISE, subject)
        if real and not noise:
            reasons.append(f"{service}: somebody actually did something ({real})")
            out["priority"] = "important" if _any(CRITICAL_WORDS, subject) else "normal"
            out["reasons"] = reasons
            return out
        if noise:
            junk_signals.append(f"{service} engagement bait ({noise})")
        else:
            # Unrecognised social mail is left at normal rather than binned. The
            # patterns above cannot be complete, and a new notification type
            # silently disappearing into the trash is the failure that matters.
            reasons.append(f"{service}: unrecognised notification, left in the feed rather than binned")
            out["priority"] = "normal"
            out["reasons"] = reasons
            return out
    else:
        out["service"] = msg.get("source")

    # ---- junk signals -------------------------------------------------------
    if NOREPLY_LOCALS.match(local or ""):
        junk_signals.append(f"sender local-part '{local}' is a machine, not a person")
    if msg.get("has_unsubscribe"):
        junk_signals.append("carries List-Unsubscribe")
    if msg.get("is_bulk"):
        junk_signals.append("Precedence header says bulk")
    if msg.get("is_list"):
        junk_signals.append("carries List-Id (mailing list)")
    hit = _any(PROMO_WORDS, subject)
    if hit:
        junk_signals.append(f"subject matches a promotional pattern ({hit})")

    # ---- resolve ------------------------------------------------------------
    if important:
        out["priority"] = "important"
        if junk_signals:
            # Recorded, not applied. This is the asymmetry from the docstring made
            # visible: you can see that the message looked like bulk mail AND that
            # it was kept anyway, which is what makes the rule auditable.
            reasons.append(f"had {len(junk_signals)} junk signal(s), overridden by the above: "
                           + "; ".join(junk_signals))
        out["reasons"] = reasons
        return out

    # Two signals, not one. A mailing list you read on purpose carries List-Id and
    # List-Unsubscribe and is not junk; a marketing blast carries those AND comes
    # from noreply@ AND says 40% off.
    if len(junk_signals) >= 2:
        out["priority"] = "junk"
        out["reasons"] = junk_signals
        return out

    out["priority"] = "normal"
    out["reasons"] = reasons or (junk_signals and [f"one junk signal only, not enough: {junk_signals[0]}"]) or []
    return out


# ----------------------------------------------------------------- urgency

def event_urgency(when: str | None, now: datetime | None = None) -> tuple[str, float | None]:
    """How soon an event or a deadline is. Returns (band, hours_away).

    Bands: `now` (in progress or within the hour), `today`, `soon` (48h), `week`,
    `later`, `past`, `unknown`. `unknown` is a real answer — an assignment with no
    due date must not be sorted as if it were due at the epoch, which is what
    treating a null as 0 would do.
    """
    if not when:
        return "unknown", None
    now = now or datetime.now(timezone.utc)
    text = when.strip()
    try:
        if text.endswith("Z"):
            dt = datetime.fromisoformat(text[:-1]).replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return "unknown", None

    hours = (dt - now).total_seconds() / 3600.0
    if hours < -1:
        return "past", hours
    if hours < 1:
        return "now", hours
    if hours < 24:
        return "today", hours
    if hours < 48:
        return "soon", hours
    if hours < 24 * 7:
        return "week", hours
    return "later", hours


def task_priority(task: dict, now: datetime | None = None) -> str:
    band, _ = event_urgency(task.get("due"), now)
    if band in ("now", "today", "soon", "past"):
        return "important"
    return "normal"


def summarise(messages: list[dict], events: list[dict], tasks: list[dict],
              now: datetime | None = None) -> dict:
    """The counts the report and the artifact both lead with.

    Computed here rather than in either consumer, so the run report and the HTML
    page cannot disagree about how many important things there are — which is the
    kind of discrepancy that makes a reader stop believing both of them.
    """
    now = now or datetime.now(timezone.utc)
    by_priority = {"important": 0, "normal": 0, "junk": 0}
    for m in messages:
        by_priority[m.get("priority", "normal")] = by_priority.get(m.get("priority", "normal"), 0) + 1

    soon = [e for e in events if event_urgency(e.get("start"), now)[0] in ("now", "today")]
    due = [t for t in tasks if task_priority(t, now) == "important"]
    unread_important = [m for m in messages if m.get("priority") == "important" and m.get("unread")]

    return {
        "messages": len(messages),
        "important": by_priority["important"],
        "normal": by_priority["normal"],
        "junk": by_priority["junk"],
        "unread_important": len(unread_important),
        "events_total": len(events),
        "events_today": len(soon),
        "tasks_total": len(tasks),
        "tasks_due_soon": len(due),
        # Deliberately named "needs_you" rather than "urgent": it is the count the
        # digest leads with, and it is the sum of the two things that have a clock
        # attached plus unread mail that matters.
        "needs_you": len(unread_important) + len(soon) + len(due),
    }
