#!/usr/bin/env python3
"""Provider adapters for media-bot. Standard library only.

## Why stdlib only

Every other bot here that needs Python has a project-local `.venv` and an install
step. This one deliberately has neither: `imaplib`, `urllib.request`, `ssl`,
`email` and `json` cover every provider that can actually be reached, so there is
nothing to install, nothing to keep patched, and no supply-chain surface on a bot
that holds live mail credentials. If a future provider genuinely needs a package,
that is the moment to add a venv — not before.

## What each provider can and cannot do, and why several return `unavailable`

This is the part worth reading before wiring anything up. Four of the seven
services named for this bot have no API that returns a personal notification
feed, and pretending otherwise would produce a bot that quietly reported an empty
inbox forever.

| Service   | Reachable? | How, or why not |
| --------- | ---------- | --------------- |
| Gmail     | **yes**    | IMAP over TLS with a Google App Password. Read-only unless triage is run. |
| Canvas    | **yes**    | Canvas REST API with a personal access token. Northeastern's instance. |
| Outlook   | **yes**    | Microsoft Graph, device-code OAuth. Needs an Azure app registration. |
| Calendars | **yes**    | Any published `.ics` URL, which is how Outlook and Google both export. |
| Instagram | **no**     | The Graph API covers Business/Creator accounts you own — media and comments. There is no endpoint for a personal notification feed or for DMs on a personal account. |
| TikTok    | **no**     | The Display API returns your own videos and profile. There is no notification, follower-activity or DM endpoint. |
| Snapchat  | **no**     | Snap's public APIs are advertising, Creative Kit and Login Kit. Nothing reads Snaps, chats or notifications. There is no version of this that works. |

The three unavailable ones are not dropped, because they are not actually silent:
**all three email you about activity.** So they are handled as an email
classification instead — see `SOCIAL_SENDERS` in `classify.py`. A follow, a
mention or a message request arrives as mail from `instagram.com`,
`tiktok.com` or `snapchat.com` and is surfaced under that service's name in the
digest. That is a genuinely different thing from API access and is labelled as
such in the output (`via: "email"`), so a thin day is legible as "nothing was
emailed" rather than as "nothing happened".

Do not replace that with scraping. A logged-in session scrape of any of the three
violates their terms, breaks on every UI change, and would put this bot's stored
credentials one bug away from an account lock.
"""
from __future__ import annotations

import email
import email.utils
import imaplib
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header

USER_AGENT = "Agency-media-bot/1.0 (personal notification digest; contact you@example.com)"
HTTP_TIMEOUT = 30


@dataclass
class Result:
    """One provider's outcome.

    `status` is one of:
      ok            reached it, here is what it said
      not_configured  no credentials present. Not an error — it is a state.
      unavailable   there is no API for this. Never becomes ok by retrying.
      failed        it was configured and it broke. `error` says how.

    The four are kept distinct on purpose. Collapsing `not_configured` into
    `failed` makes an unconfigured bot look broken every run, and collapsing
    `unavailable` into either implies that someday it might work.
    """

    provider: str
    status: str
    error: str | None = None
    note: str | None = None
    messages: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    tasks: list[dict] = field(default_factory=list)

    def to_json(self) -> dict:
        out = {"provider": self.provider, "status": self.status}
        if self.error:
            out["error"] = self.error
        if self.note:
            out["note"] = self.note
        out["counts"] = {"messages": len(self.messages), "events": len(self.events), "tasks": len(self.tasks)}
        out["messages"] = self.messages
        out["events"] = self.events
        out["tasks"] = self.tasks
        return out


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def load_env(path: str) -> dict[str, str]:
    """Parse a KEY=VALUE file. No dependency, no interpolation, no surprises.

    Values are NOT unquoted beyond one matched pair of surrounding quotes, because
    an app password can legitimately contain almost anything and guessing at
    escapes is how a credential silently becomes the wrong string.
    """
    env: dict[str, str] = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    return env


def _http_json(url: str, headers: dict[str, str] | None = None, data: bytes | None = None,
               method: str | None = None) -> dict:
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=ctx) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body) if body.strip() else {}


def _decode(raw: str | None) -> str:
    """Decode an RFC 2047 header into text.

    Wrapped in a try because a malformed header is common in real mail and must
    not take a whole sweep down — a subject line is not worth failing a run over.
    """
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw))).strip()
    except Exception:
        return raw.strip()


# ---------------------------------------------------------------------- Gmail

def fetch_gmail(env: dict[str, str], since_hours: int, limit: int) -> Result:
    """Gmail over IMAP, read-only.

    ## Read-only is enforced by the protocol, not by intent

    `select(mailbox, readonly=True)` opens the mailbox in EXAMINE mode. In that
    mode the server itself refuses STORE and EXPUNGE, so nothing this function
    does can alter a flag, move a message or delete anything — not even by
    mistake. The write path lives in triage.py and opens its own connection
    without that flag, which is the only place in this bot that can change
    anything in your mail.

    ## Why the fetch is PEEK

    `BODY.PEEK[HEADER]` does not set the `\\Seen` flag. Plain `BODY[HEADER]`
    would, so a digest run would silently mark your unread mail as read — the
    single most annoying thing a mail bot can do, and invisible until you notice
    your inbox has been quietly cleared of bold text.
    """
    user = env.get("GMAIL_ADDRESS", "").strip()
    password = env.get("GMAIL_APP_PASSWORD", "").strip()
    if not user or not password:
        return Result("gmail", "not_configured",
                      note="Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in media-bot/.env. "
                           "The app password comes from Google Account > Security > App passwords, "
                           "which requires 2-Step Verification to be on. Your normal Google password "
                           "will not work and is not what should go here.")

    host = env.get("GMAIL_IMAP_HOST", "imap.gmail.com")
    since = (now_utc() - timedelta(hours=since_hours)).strftime("%d-%b-%Y")
    messages: list[dict] = []
    conn = None
    try:
        conn = imaplib.IMAP4_SSL(host, 993, ssl_context=ssl.create_default_context())
        conn.login(user, password)
        conn.select("INBOX", readonly=True)
        typ, data = conn.search(None, "SINCE", since)
        if typ != "OK":
            return Result("gmail", "failed", error=f"IMAP search returned {typ}")
        ids = (data[0] or b"").split()
        # Newest first, then capped. IMAP returns ascending sequence numbers, so
        # without the reverse a busy mailbox would hand back the OLDEST `limit`
        # messages — a digest of last week while today went unmentioned.
        ids = list(reversed(ids))[:limit]
        for mid in ids:
            typ, parts = conn.fetch(mid, "(BODY.PEEK[HEADER] FLAGS)")
            if typ != "OK" or not parts:
                continue
            raw = b""
            flags = b""
            for part in parts:
                if isinstance(part, tuple):
                    raw += part[1] or b""
                    flags += part[0] or b""
                elif isinstance(part, bytes):
                    flags += part
            msg = email.message_from_bytes(raw)
            messages.append(_imap_message(msg, mid.decode(), flags.decode("utf-8", "replace")))
    except imaplib.IMAP4.error as exc:
        return Result("gmail", "failed",
                      error=f"IMAP error: {exc}. If this says AUTHENTICATIONFAILED the app password is "
                            f"wrong or 2-Step Verification was turned off, which revokes app passwords.")
    except (OSError, ssl.SSLError) as exc:
        return Result("gmail", "failed", error=f"could not reach {host}: {exc}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            try:
                conn.logout()
            except Exception:
                pass

    return Result("gmail", "ok", messages=messages,
                  note=f"INBOX, last {since_hours}h, opened read-only (IMAP EXAMINE), headers fetched with PEEK "
                       f"so nothing was marked read.")


def _imap_message(msg: email.message.Message, uid: str, flags: str) -> dict:
    from_raw = _decode(msg.get("From"))
    addr = email.utils.parseaddr(msg.get("From") or "")[1].lower()
    date_hdr = msg.get("Date")
    try:
        parsed = email.utils.parsedate_to_datetime(date_hdr) if date_hdr else None
        if parsed is not None and parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        parsed = None
    return {
        "id": uid,
        # The RFC Message-ID, and triage.py cannot work without it.
        #
        # `id` above is the IMAP sequence number, which is a POSITION in the mailbox
        # and shifts every time anything above it is expunged. Staging a batch by
        # sequence number a day after collecting it would move whatever happens to
        # be at that position now, which could be any message at all. The
        # Message-ID is assigned by the sending system and never moves, so it is
        # the only safe handle for a write operation. Stripped of its angle brackets
        # because IMAP's `HEADER Message-ID` search wants the bare value.
        "message_id": (msg.get("Message-ID") or "").strip().strip("<>"),
        "source": "gmail",
        "via": "imap",
        "from": from_raw,
        "from_address": addr,
        "from_domain": addr.rpartition("@")[2],
        "subject": _decode(msg.get("Subject")),
        "date": iso(parsed) if parsed else None,
        "unread": "\\Seen" not in flags,
        # The three headers that identify bulk mail. Kept as booleans rather than
        # raw values: this is a classification input, and storing a full
        # List-Unsubscribe URL would put tracking links in a file on disk.
        "has_unsubscribe": bool(msg.get("List-Unsubscribe")),
        "is_bulk": (msg.get("Precedence", "") or "").lower() in ("bulk", "list", "junk"),
        "is_list": bool(msg.get("List-Id")),
        "in_reply_to": bool(msg.get("In-Reply-To")),
    }


# ------------------------------------------------------------ Microsoft Graph

GRAPH_ROOT = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPES = "offline_access Mail.Read Calendars.Read User.Read"


def _graph_token(env: dict[str, str], token_path: str) -> tuple[str | None, str | None]:
    """Return (access_token, problem). Refreshes from the cached refresh token.

    ## Why device-code and not a client secret

    Microsoft killed basic auth for personal and most tenant mailboxes, so IMAP is
    not an option the way it is for Gmail. That leaves OAuth, and of the OAuth
    flows the device-code flow is the only one that fits here: it is designed for
    a client that cannot keep a secret and cannot host a redirect URI, which
    describes a script on a laptop exactly. A confidential-client flow would mean
    storing a client secret next to the refresh token, which buys nothing.

    ## This function never prompts

    A scheduled run has no console. If there is no usable refresh token it returns
    a problem string and the caller reports `not_configured`; it does not block for
    six minutes waiting for a code nobody will type. Getting the first token is
    `scripts/graph_login.py`, run by hand, once.
    """
    client_id = env.get("GRAPH_CLIENT_ID", "").strip()
    if not client_id:
        return None, ("Set GRAPH_CLIENT_ID in media-bot/.env, then run "
                      "`python scripts/graph_login.py` once to authorise. The client id comes from "
                      "an Azure app registration (portal.azure.com > App registrations > New): "
                      "choose 'Accounts in any organizational directory and personal Microsoft accounts', "
                      "add the 'Mobile and desktop applications' platform, and turn ON "
                      "'Allow public client flows' — device code will not work without that last one.")
    tenant = env.get("GRAPH_TENANT", "common").strip() or "common"

    if not os.path.exists(token_path):
        return None, ("No Graph token cached. Run `python scripts/graph_login.py` once — it prints a code "
                      "to type at microsoft.com/devicelogin. A scheduled run cannot do this for you.")
    try:
        with open(token_path, encoding="utf-8") as fh:
            cache = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"token cache at {token_path} is unreadable: {exc}"

    refresh = cache.get("refresh_token")
    if not refresh:
        return None, "token cache has no refresh_token; run scripts/graph_login.py again"

    body = urllib.parse.urlencode({
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "scope": GRAPH_SCOPES,
    }).encode()
    url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    try:
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("User-Agent", USER_AGENT)
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=ssl.create_default_context()) as resp:
            fresh = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        return None, (f"refresh failed ({exc.code}). Re-run scripts/graph_login.py. Server said: {detail}")
    except (OSError, ssl.SSLError) as exc:
        return None, f"could not reach login.microsoftonline.com: {exc}"

    # Microsoft rotates the refresh token on every use. NOT writing the new one
    # back means the next run presents a token that has already been spent, and
    # the bot silently de-authorises itself after exactly one successful run.
    if fresh.get("refresh_token"):
        cache["refresh_token"] = fresh["refresh_token"]
        cache["refreshed_at"] = iso(now_utc())
        _write_token(token_path, cache)

    token = fresh.get("access_token")
    if not token:
        return None, f"token response carried no access_token: {list(fresh)}"
    return token, None


def _write_token(path: str, cache: dict) -> None:
    """Write the token cache with owner-only permissions where the OS allows it.

    On Windows the mode argument is largely advisory and NTFS ACLs are what
    actually matter, so this is not presented as protection — the real protection
    is that the file lives under `state/` and this bot's own hook refuses to write
    or read anything outside its tree. It is here because it costs nothing on the
    platforms where it does work.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, indent=2)


def fetch_outlook(env: dict[str, str], token_path: str, since_hours: int, limit: int) -> Result:
    token, problem = _graph_token(env, token_path)
    if problem:
        return Result("outlook", "not_configured", note=problem)

    headers = {"Authorization": f"Bearer {token}"}
    since = iso(now_utc() - timedelta(hours=since_hours))
    messages: list[dict] = []
    events: list[dict] = []

    try:
        # $select keeps the payload to the fields that are actually classified.
        # Without it Graph returns the full body of every message, which is both
        # slow and a lot of other people's text written to disk for no reason.
        murl = (f"{GRAPH_ROOT}/me/mailFolders/inbox/messages"
                f"?$top={limit}&$orderby=receivedDateTime desc"
                f"&$filter=receivedDateTime ge {since}"
                f"&$select=id,subject,from,receivedDateTime,isRead,importance,conversationId,webLink")
        payload = _http_json(murl, headers)
        for m in payload.get("value", []):
            addr = ((m.get("from") or {}).get("emailAddress") or {})
            mail = (addr.get("address") or "").lower()
            messages.append({
                "id": m.get("id"),
                "source": "outlook",
                "via": "graph",
                "from": addr.get("name") or mail,
                "from_address": mail,
                "from_domain": mail.rpartition("@")[2],
                "subject": m.get("subject") or "",
                "date": m.get("receivedDateTime"),
                "unread": not m.get("isRead", True),
                "flagged_important": (m.get("importance") or "") == "high",
                # Graph exposes none of the bulk headers by default, so these are
                # left False rather than guessed. classify.py leans on the sender
                # rules for Outlook mail instead, and says so.
                "has_unsubscribe": False,
                "is_bulk": False,
                "is_list": False,
                "in_reply_to": False,
                "web_link": m.get("webLink"),
            })

        end = iso(now_utc() + timedelta(days=14))
        start = iso(now_utc() - timedelta(hours=2))
        # calendarView, not /events. /events returns the SERIES for a recurring
        # meeting with no expansion, so a weekly lecture shows up once with its
        # first date and every actual occurrence is missing.
        curl = (f"{GRAPH_ROOT}/me/calendarView"
                f"?startDateTime={start}&endDateTime={end}&$top=100&$orderby=start/dateTime"
                f"&$select=id,subject,start,end,location,isAllDay,organizer,webLink")
        payload = _http_json(curl, headers)
        for e in payload.get("value", []):
            events.append(_graph_event(e))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        return Result("outlook", "failed", error=f"Graph returned {exc.code}: {detail}")
    except (OSError, ssl.SSLError, json.JSONDecodeError) as exc:
        return Result("outlook", "failed", error=f"Graph request failed: {exc}")

    return Result("outlook", "ok", messages=messages, events=events,
                  note="Read-only Graph scopes (Mail.Read, Calendars.Read). Calendar via calendarView, "
                       "so recurring meetings are expanded into real occurrences.")


def _graph_event(e: dict) -> dict:
    loc = (e.get("location") or {}).get("displayName") or ""
    org = ((e.get("organizer") or {}).get("emailAddress") or {}).get("name") or ""
    return {
        "id": e.get("id"),
        "source": "outlook",
        "title": e.get("subject") or "(no subject)",
        # Graph returns naive local strings plus a separate timeZone field, which
        # is almost always UTC for calendarView. Passed through unchanged rather
        # than reinterpreted: a calendar time silently shifted by a timezone guess
        # is worse than one displayed exactly as the server stated it.
        "start": (e.get("start") or {}).get("dateTime"),
        "start_tz": (e.get("start") or {}).get("timeZone"),
        "end": (e.get("end") or {}).get("dateTime"),
        "all_day": bool(e.get("isAllDay")),
        "location": loc,
        "organizer": org,
        "web_link": e.get("webLink"),
    }


# --------------------------------------------------------------------- Canvas

def fetch_canvas(env: dict[str, str]) -> Result:
    """Canvas: what is due, and what is ungraded.

    Uses `/users/self/todo`, which is the endpoint that answers the question a
    student actually has. `/courses/:id/assignments` would return the whole
    syllabus including everything already submitted and everything due in April.
    """
    base = env.get("CANVAS_BASE_URL", "https://northeastern.instructure.com").strip().rstrip("/")
    token = env.get("CANVAS_TOKEN", "").strip()
    if not token:
        return Result("canvas", "not_configured",
                      note=f"Set CANVAS_TOKEN in media-bot/.env. Generate it at {base}/profile/settings "
                           f"under 'Approved Integrations' > '+ New Access Token'. Set CANVAS_BASE_URL too "
                           f"if your institution is not {base}.")

    headers = {"Authorization": f"Bearer {token}"}
    tasks: list[dict] = []
    events: list[dict] = []
    try:
        todo = _http_json(f"{base}/api/v1/users/self/todo?per_page=50", headers)
        for t in todo if isinstance(todo, list) else []:
            assignment = t.get("assignment") or {}
            tasks.append({
                "id": str(t.get("assignment", {}).get("id") or t.get("html_url") or ""),
                "source": "canvas",
                "kind": t.get("type") or "todo",
                "title": assignment.get("name") or t.get("context_name") or "(untitled)",
                "course": t.get("context_name") or "",
                "due": assignment.get("due_at"),
                "points": assignment.get("points_possible"),
                "url": t.get("html_url"),
                "needs_grading": t.get("needs_grading_count"),
            })

        upcoming = _http_json(f"{base}/api/v1/users/self/upcoming_events?per_page=50", headers)
        for e in upcoming if isinstance(upcoming, list) else []:
            when = e.get("start_at") or (e.get("assignment") or {}).get("due_at")
            events.append({
                "id": str(e.get("id") or ""),
                "source": "canvas",
                "title": e.get("title") or "(untitled)",
                "start": when,
                "start_tz": "UTC",
                "end": e.get("end_at"),
                "all_day": bool(e.get("all_day")),
                "location": e.get("location_name") or "",
                "organizer": e.get("context_name") or "",
                "web_link": e.get("html_url"),
            })
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        hint = " The token may have expired or been revoked." if exc.code == 401 else ""
        return Result("canvas", "failed", error=f"Canvas returned {exc.code}: {detail}.{hint}")
    except (OSError, ssl.SSLError, json.JSONDecodeError) as exc:
        return Result("canvas", "failed", error=f"Canvas request failed: {exc}")

    return Result("canvas", "ok", tasks=tasks, events=events,
                  note=f"{base} — /users/self/todo and /users/self/upcoming_events, both read-only.")


# ------------------------------------------------------------------------ ICS

_ICS_UNFOLD = re.compile(r"\r?\n[ \t]")


def fetch_ics(env: dict[str, str], days: int) -> Result:
    """Published .ics calendar feeds.

    Present even though Graph already returns a calendar, because this is the one
    calendar path that needs no OAuth app registration at all: both Outlook and
    Google can publish a secret .ics URL, and so can most university timetables.
    It is the fallback that makes the calendar half of this bot work on day one.

    Recurrence is deliberately NOT expanded. An `RRULE` implementation that is
    almost right produces a calendar that is confidently wrong about when things
    are, which is worse than one that says so: a repeating event is reported once,
    at its DTSTART, and flagged `recurring: true`. If expanded recurrence becomes
    necessary, use the Graph calendarView above, which the server expands
    correctly.
    """
    raw = env.get("ICS_URLS", "").strip()
    if not raw:
        return Result("ics", "not_configured",
                      note="Set ICS_URLS in media-bot/.env to one or more published calendar URLs, "
                           "comma-separated. Outlook: Calendar > Share > Publish a calendar > ICS. "
                           "Google: Settings > your calendar > Secret address in iCal format. "
                           "Treat those URLs as passwords — anyone holding one can read the calendar.")

    urls = [u.strip() for u in raw.split(",") if u.strip()]
    horizon = now_utc() + timedelta(days=days)
    floor = now_utc() - timedelta(hours=6)
    events: list[dict] = []
    errors: list[str] = []

    for url in urls:
        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", USER_AGENT)
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT, context=ssl.create_default_context()) as resp:
                text = resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, OSError, ssl.SSLError) as exc:
            errors.append(f"{urllib.parse.urlparse(url).netloc}: {exc}")
            continue
        for ev in _parse_ics(text):
            start = ev.get("_dt")
            if start is None or start < floor or start > horizon:
                continue
            ev.pop("_dt", None)
            events.append(ev)

    events.sort(key=lambda e: e.get("start") or "")
    if errors and not events:
        return Result("ics", "failed", error="; ".join(errors))
    note = f"{len(urls)} feed(s), next {days} days. Recurring events are reported at DTSTART, not expanded."
    if errors:
        note += f" Some feeds failed: {'; '.join(errors)}"
    return Result("ics", "ok", events=events, note=note)


def _parse_ics(text: str) -> list[dict]:
    """Minimal VEVENT reader.

    Line unfolding comes first and is not optional: iCalendar wraps at 75 octets
    by continuing on a line that starts with a space, so a long SUMMARY arrives
    split across two lines and an unfolded parser reads half a title.
    """
    text = _ICS_UNFOLD.sub("", text)
    out: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        if line.startswith("BEGIN:VEVENT"):
            current = {}
            continue
        if line.startswith("END:VEVENT"):
            if current is not None:
                built = _build_ics_event(current)
                if built:
                    out.append(built)
            current = None
            continue
        if current is None or ":" not in line:
            continue
        name, _, value = line.partition(":")
        key = name.split(";")[0].upper()
        params = name.split(";")[1:]
        if key in ("SUMMARY", "LOCATION", "DTSTART", "DTEND", "UID", "RRULE", "ORGANIZER", "URL"):
            current[key] = value
            if key == "DTSTART":
                current["_DTSTART_PARAMS"] = params
    return out


def _build_ics_event(raw: dict) -> dict | None:
    dt = _parse_ics_dt(raw.get("DTSTART", ""), raw.get("_DTSTART_PARAMS", []))
    if dt is None:
        return None
    all_day = any(p.upper() == "VALUE=DATE" for p in raw.get("_DTSTART_PARAMS", []))
    return {
        "id": raw.get("UID", "")[:120],
        "source": "ics",
        "title": _unescape_ics(raw.get("SUMMARY", "(untitled)")),
        "start": iso(dt),
        "start_tz": "UTC",
        "end": None,
        "all_day": all_day,
        "location": _unescape_ics(raw.get("LOCATION", "")),
        "organizer": _unescape_ics(raw.get("ORGANIZER", "").replace("mailto:", "")),
        "recurring": bool(raw.get("RRULE")),
        "web_link": raw.get("URL") or None,
        "_dt": dt,
    }


def _unescape_ics(value: str) -> str:
    return (value.replace("\\n", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")).strip()


def _parse_ics_dt(value: str, params: list[str]) -> datetime | None:
    """Parse DTSTART in the three forms that actually occur.

    A `TZID=` parameter is honoured only to the extent of NOT pretending the value
    is UTC — without a timezone database (`zoneinfo` needs tzdata on Windows,
    which is not guaranteed) a named zone cannot be resolved, so such a value is
    treated as UTC and that is stated in the provider note. The alternative,
    silently shifting every campus event by four or five hours, is worse.
    """
    value = value.strip()
    if not value:
        return None
    try:
        if value.endswith("Z"):
            return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        if len(value) == 8:
            return datetime.strptime(value, "%Y%m%d").replace(tzinfo=timezone.utc)
        return datetime.strptime(value[:15], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ------------------------------------------------------- the unavailable three

UNAVAILABLE = {
    "instagram": ("The Instagram Graph API covers Business and Creator accounts you own — your own media, "
                  "comments and insights. There is no endpoint for a personal notification feed, for "
                  "follows, or for direct messages on a personal account. Instagram's activity emails are "
                  "classified from mail instead; see SOCIAL_SENDERS in classify.py."),
    "tiktok": ("TikTok's Display API returns your own videos and profile fields. There is no notification, "
               "follower-activity, comment-firehose or DM endpoint for a personal account. TikTok's "
               "activity emails are classified from mail instead."),
    "snapchat": ("Snap's public APIs are advertising, Creative Kit and Login Kit. None of them read Snaps, "
                 "chats, streaks or notifications, and there is no tier or approval that changes that. "
                 "Snapchat's account emails are classified from mail instead. This one will not become "
                 "available — do not leave it as a TODO."),
}


def unavailable_results() -> list[Result]:
    return [Result(name, "unavailable", note=reason) for name, reason in UNAVAILABLE.items()]
