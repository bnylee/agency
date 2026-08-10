#!/usr/bin/env python3
"""One-time interactive Microsoft Graph authorisation for media-bot.

    python scripts/graph_login.py

Prints a code, you type it at microsoft.com/devicelogin, and it caches a refresh
token in `state/graph-token.json`. After that the scheduled run refreshes silently
and never needs you again — unless the token is revoked or expires, at which point
`collect.py` reports `not_configured` with a note telling you to run this.

## It refuses to run unattended, on purpose

There is a `sys.stdin.isatty()` check, and a scheduled task fails it. A device-code
flow polls for up to fifteen minutes waiting for a human to type a code; started
from a scheduler that is fifteen minutes of a hung task and a code nobody ever
sees. Same reasoning as disk-cleanup's `purge.ps1` refusing a non-interactive
console: some operations are only correct when a person is watching.

## Setting up the app registration

Only needed once, and it costs nothing:

1. portal.azure.com > App registrations > New registration.
2. Supported account types: **Accounts in any organizational directory and
   personal Microsoft accounts**. Northeastern is a tenant, so a
   single-tenant-only registration will not authorise a personal Outlook account
   and vice versa.
3. Authentication > Add a platform > **Mobile and desktop applications**, and tick
   the `https://login.microsoftonline.com/common/oauth2/nativeclient` redirect.
4. Authentication > Advanced settings > **Allow public client flows: Yes**. The
   device-code grant is rejected with `unauthorized_client` without this, and the
   error does not mention this setting.
5. Copy the Application (client) ID into `GRAPH_CLIENT_ID` in `media-bot/.env`.

The scopes requested are `Mail.Read`, `Calendars.Read`, `User.Read` and
`offline_access` — all read-only. Nothing here can send mail or change a calendar,
and if a future feature needs to, that is a capability change for Benny to approve
and not something to quietly widen here.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from providers import GRAPH_SCOPES, USER_AGENT, iso, load_env, now_utc  # noqa: E402

TOKEN_PATH = os.path.join(BOT_DIR, "state", "graph-token.json")


def post_form(url: str, fields: dict[str, str]) -> tuple[int, dict]:
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"error": "http_error", "error_description": raw[:500]}


def main() -> int:
    if not sys.stdin.isatty():
        print("media-bot graph_login: this needs an interactive console — it prints a code for you to type.",
              file=sys.stderr)
        print("Run it yourself in a terminal. A scheduled task cannot complete a device-code flow.",
              file=sys.stderr)
        return 2

    env = load_env(os.path.join(BOT_DIR, ".env"))
    client_id = env.get("GRAPH_CLIENT_ID", "").strip()
    if not client_id:
        print("media-bot graph_login: GRAPH_CLIENT_ID is not set in media-bot/.env.", file=sys.stderr)
        print("See the app-registration steps in the docstring at the top of this file.", file=sys.stderr)
        return 2
    tenant = env.get("GRAPH_TENANT", "common").strip() or "common"
    base = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"

    status, dev = post_form(f"{base}/devicecode", {"client_id": client_id, "scope": GRAPH_SCOPES})
    if "device_code" not in dev:
        print(f"media-bot graph_login: device-code request failed ({status}).", file=sys.stderr)
        print(json.dumps(dev, indent=2), file=sys.stderr)
        if dev.get("error") == "unauthorized_client":
            print("\nThat error usually means 'Allow public client flows' is still set to No on the "
                  "app registration. See step 4 in this file's docstring.", file=sys.stderr)
        return 1

    print()
    print("=" * 68)
    print(dev.get("message") or f"Go to {dev.get('verification_uri')} and enter {dev.get('user_code')}")
    print("=" * 68)
    print()
    print("Waiting… this window will finish on its own once you have entered the code.")

    interval = int(dev.get("interval", 5))
    deadline = time.time() + int(dev.get("expires_in", 900))

    while time.time() < deadline:
        time.sleep(interval)
        status, tok = post_form(f"{base}/token", {
            "client_id": client_id,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": dev["device_code"],
        })
        err = tok.get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            # The server is asking for a longer gap. Honouring it matters: ignoring
            # slow_down gets the whole flow rate-limited and the login fails with a
            # different, more confusing error.
            interval += 5
            continue
        if err == "authorization_declined":
            print("media-bot graph_login: you declined the request.", file=sys.stderr)
            return 1
        if err == "expired_token":
            print("media-bot graph_login: the code expired. Run this again.", file=sys.stderr)
            return 1
        if err:
            print(f"media-bot graph_login: {err}: {tok.get('error_description', '')[:400]}", file=sys.stderr)
            return 1

        if not tok.get("refresh_token"):
            print("media-bot graph_login: authorised, but no refresh_token came back. "
                  "`offline_access` must be in the requested scopes.", file=sys.stderr)
            return 1

        os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
        fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            # Only the refresh token is stored. The access token lives about an hour
            # and collect.py mints a fresh one every run, so persisting it would be
            # a second credential on disk with no benefit.
            json.dump({
                "refresh_token": tok["refresh_token"],
                "scope": tok.get("scope", GRAPH_SCOPES),
                "authorised_at": iso(now_utc()),
            }, fh, indent=2)
        print(f"\nAuthorised. Refresh token cached at {TOKEN_PATH}")
        print("Scheduled runs will refresh it silently from here on.")
        print("This file is a live credential — it is under state/, which is gitignored, and "
              "media-bot's own hooks refuse to read or write outside this bot's tree.")
        return 0

    print("media-bot graph_login: timed out waiting for the code.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
