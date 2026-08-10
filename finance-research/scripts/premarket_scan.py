#!/usr/bin/env python3
"""Pre-market scan: pull extended-hours movement for the watchlist and print JSON.

Read-only. Touches Yahoo Finance via yfinance and writes nothing to disk; the
caller is responsible for persisting anything.

maverick-mcp cannot supply this data: its Quote model exposes only regular-market
fields and its history() call omits prepost=True, so pre-market bars never reach
the MCP layer. That gap is why this script exists.
"""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pandas_market_calendars as mcal
import yfinance as yf
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
PREMARKET_OPEN = (4, 0)   # 04:00 ET, first extended-hours bar
REGULAR_OPEN = (9, 30)    # 09:30 ET


def load_watchlist(bot_root: Path) -> dict[str, list[str]]:
    path = bot_root / "state" / "watchlist.json"
    with open(path) as fh:
        return json.load(fh)["premarket"]


def is_trading_day(now_et: datetime) -> bool:
    nyse = mcal.get_calendar("NYSE")
    today = now_et.date()
    sessions = nyse.valid_days(start_date=today, end_date=today)
    return len(sessions) > 0


def previous_session_date(now_et: datetime):
    """The NYSE session that most recently closed before today.

    This is the authority the resolved previous close is checked against. It
    comes from the exchange calendar rather than from the price data, so a
    price source that has not rolled over yet cannot vote on its own freshness.
    """
    nyse = mcal.get_calendar("NYSE")
    days = nyse.valid_days(
        start_date=(now_et.date() - timedelta(days=14)), end_date=now_et.date()
    )
    prior = [d.date() for d in days if d.date() < now_et.date()]
    return prior[-1] if prior else None


def resolve_previous_close(ticker, now_et: datetime):
    """Close of the most recent COMPLETED regular session, from daily bars.

    Not `info["regularMarketPreviousClose"]`, which is what this script used
    until 2026-08-04 and which is unreliable at the hour this bot runs. Yahoo
    does not roll that field over until at or after the regular open, so the
    06:00 ET scan on 2026-08-04 read the Jul 31 close for all 11 symbols --
    a full session stale. `change_percent_vs_prev_close` was consequently wrong
    by an entire day's move, in the direction that manufactures fake gaps, and
    it disagreed in sign with Yahoo's own pre-market field for five of seven
    megacaps. Re-probed at 12:50 the same day the field read correctly, which
    confirms it is a roll-over timing problem and not a one-off.

    Daily bars carry an explicit session date, so the value can be checked
    rather than trusted. auto_adjust=False for the same reason paper_broker.py
    uses it: adjusted prices are back-corrected and are not what traded.

    Returns (close, session_date, error).
    """
    daily = ticker.history(period="1mo", interval="1d", auto_adjust=False)
    if daily is None or daily.empty:
        return None, None, "no daily bars returned"

    idx = daily.index
    dates = [d.date() if d.tzinfo is None else d.tz_convert(ET).date() for d in idx]
    # Today's row is excluded even when present: mid-session it holds the
    # running price, not a close, and at 06:00 it would be the pre-market print.
    completed = [(d, float(daily["Close"].iloc[i])) for i, d in enumerate(dates)
                 if d < now_et.date()]
    if not completed:
        return None, None, "no completed session in the last month of daily bars"

    session, close = completed[-1]
    return round(close, 4), session, None


def premarket_window(bars, now_et: datetime):
    """Slice today's 04:00-09:30 ET bars out of a 1m prepost frame."""
    if bars is None or bars.empty:
        return bars

    idx = bars.index
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    local = idx.tz_convert(ET)

    today = now_et.date()
    start_min = PREMARKET_OPEN[0] * 60 + PREMARKET_OPEN[1]
    end_min = REGULAR_OPEN[0] * 60 + REGULAR_OPEN[1]

    minutes = local.hour * 60 + local.minute
    mask = (local.date == today) & (minutes >= start_min) & (minutes < end_min)
    return bars[mask]


def minutes_elapsed_in_window(now_et: datetime) -> int:
    """Pre-market minutes available so far: 04:00 ET to min(now, 09:30).

    The denominator has to track the clock. Hardcoding the full 330-minute
    window makes a complete 6am scan look like 36% coverage.
    """
    start = PREMARKET_OPEN[0] * 60 + PREMARKET_OPEN[1]
    end = REGULAR_OPEN[0] * 60 + REGULAR_OPEN[1]
    now_min = now_et.hour * 60 + now_et.minute
    return max(0, min(now_min, end) - start)


def clean_extremes(pre, prev_close):
    """(high, low, anchored_count) over the window, minus yfinance's anchor.

    Some extended-hours bars carry a Low -- or, for a stock gapping down, a High
    -- pinned EXACTLY at the previous regular-session close, while that bar's
    open, high and close all sit well away from it. SPY on 2026-08-04 at 08:47
    reads O=760.35 H=760.36 C=760.25 L=757.67 against an Aug 3 close of 757.67
    exactly. A 2.7-point one-minute wick landing precisely on the prior close, on
    zero volume, and then recovering, is an artifact of how the series is
    anchored, not a print.

    It is NOT confined to the opening bar, which is the trap here: SPY carried it
    on three separate bars that morning (04:00, 07:00, 08:47) and TSLA on exactly
    one, at 07:00. A version of this fix that cleaned only the first bar left
    both still reporting a low equal to the prior close, which is how the
    scope of it was found.

    The artifact only binds on the side the stock has gapped away from, so it
    inflates the low of a name trading up and depresses the high of one trading
    down -- and it is invisible on any name that genuinely traded through its
    prior close. That is why it originally showed up on exactly the four names
    that were up.

    A bar is treated as anchored only when the suspect extreme is exactly the
    previous close AND lies outside that bar's own open/close range. A bar that
    genuinely traded at the prior close has that value as its open or close, or
    somewhere inside the range, and is left untouched.
    """
    highs, lows, anchored = [], [], 0
    for i in range(len(pre)):
        o = float(pre["Open"].iloc[i])
        c = float(pre["Close"].iloc[i])
        h = float(pre["High"].iloc[i])
        lo = float(pre["Low"].iloc[i])
        hit = False
        if prev_close is not None:
            if abs(lo - prev_close) < 1e-4 and lo < min(o, c) - 1e-6:
                lo = min(o, c)
                hit = True
            if abs(h - prev_close) < 1e-4 and h > max(o, c) + 1e-6:
                h = max(o, c)
                hit = True
        if hit:
            anchored += 1
        highs.append(h)
        lows.append(lo)
    return max(highs), min(lows), anchored


def scan_ticker(symbol: str, now_et: datetime, expected_session) -> dict:
    out: dict = {"symbol": symbol}
    try:
        ticker = yf.Ticker(symbol)

        info = ticker.info or {}

        prev_close, prev_session, prev_err = resolve_previous_close(ticker, now_et)
        out["previous_close"] = prev_close
        out["previous_close_session"] = prev_session.isoformat() if prev_session else None
        out["previous_close_source"] = "daily bars, auto_adjust=False"
        # Kept visible rather than dropped: when these two disagree it is worth
        # seeing in the JSON, because that disagreement IS the bug this field
        # used to cause silently.
        out["yahoo_info_previous_close"] = info.get("regularMarketPreviousClose")

        if prev_err:
            out["error"] = f"could not resolve previous close: {prev_err}"
            return out

        # The assert. A previous close that is not the session the exchange
        # calendar says most recently closed is refused outright -- no
        # previous_close-derived field is emitted from it. Emitting a stale one
        # is the failure mode being prevented: on 2026-08-04 it was catchable
        # only because a second field happened to disagree, and had the scan
        # emitted just its own computed number the report would have described a
        # 4% megacap rally that never happened.
        if expected_session and prev_session != expected_session:
            out["error"] = (
                f"previous close is stale: daily bars report {prev_session}, but "
                f"the NYSE calendar's last completed session is {expected_session}. "
                "Refusing to emit change-vs-previous-close fields."
            )
            out["previous_close"] = None
            return out

        # Yahoo's own pre-market fields; often None outside the window.
        out["yahoo_premarket_price"] = info.get("preMarketPrice")
        out["yahoo_premarket_change_percent"] = info.get("preMarketChangePercent")

        bars = ticker.history(period="1d", interval="1m", prepost=True)
        pre = premarket_window(bars, now_et)

        if pre is None or pre.empty:
            out["premarket_bars"] = 0
            out["note"] = "no pre-market bars for today"
            return out

        last = float(pre["Close"].iloc[-1])
        out["premarket_bars"] = int(len(pre))
        out["premarket_last"] = round(last, 4)

        high, low, anchored = clean_extremes(pre, prev_close)
        out["premarket_high"] = round(high, 4)
        out["premarket_low"] = round(low, 4)
        if anchored:
            out["anchored_bars_ignored"] = anchored
        # Yahoo does not populate volume on extended-hours 1m bars: every
        # pre-market bar reports 0 while regular-hours bars report normally.
        # Emit null rather than a 0 that would read as "nobody traded".
        vol = int(pre["Volume"].sum())
        out["premarket_volume"] = vol if vol > 0 else None
        # Bar count is the usable activity proxy instead: a bar exists only for
        # minutes that printed a trade, so 313/330 is dense and 40/330 is thin.
        # Denominator is minutes elapsed so far, not the full window.
        elapsed = minutes_elapsed_in_window(now_et)
        out["premarket_minutes_covered"] = f"{len(pre)}/{elapsed}"
        out["first_bar_et"] = pre.index[0].tz_convert(ET).strftime("%Y-%m-%d %H:%M")
        out["last_bar_et"] = pre.index[-1].tz_convert(ET).strftime("%Y-%m-%d %H:%M")

        if prev_close:
            out["change_vs_prev_close"] = round(last - prev_close, 4)
            out["change_percent_vs_prev_close"] = round(
                (last - prev_close) / prev_close * 100, 3
            )
    except Exception as exc:  # one bad ticker must not kill the scan
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def emit(result: dict, out_path: str | None) -> None:
    """Write JSON to a file, or stdout when no path is given.

    The script owns this write rather than letting the caller pipe stdout:
    PowerShell 5.1's `Out-File -Encoding utf8` prepends a BOM, which makes the
    result fail a plain json.load.
    """
    text = json.dumps(result, indent=2)
    if out_path:
        Path(out_path).write_text(text, encoding="utf-8")
    else:
        print(text)


def main() -> int:
    bot_root = Path(__file__).resolve().parent.parent
    now_et = datetime.now(ET)
    out_path = None
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]

    result = {
        "generated_at_et": now_et.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "trading_day": is_trading_day(now_et),
        "data_caveats": [
            "Pre-market volume is unavailable: Yahoo reports 0 on every "
            "extended-hours 1m bar, so premarket_volume is null. Use "
            "premarket_minutes_covered (bars printed out of minutes elapsed "
            "since 04:00 ET) as the activity proxy instead. Its denominator "
            "is elapsed minutes, not the full 330-minute window, so a scan "
            "run before 09:30 is not missing data.",
            "Pre-market moves happen on far thinner liquidity than regular "
            "hours and frequently do not hold through the open. Treat them as "
            "a signal about sentiment, not a prediction of the session.",
            "previous_close comes from daily bars and is checked against the "
            "NYSE calendar's last completed session; a symbol whose close does "
            "not match that session is refused rather than reported. Yahoo's "
            "info['regularMarketPreviousClose'] is NOT used -- it does not roll "
            "over until at or after the regular open, so at 06:00 ET it returns "
            "the session before last. It is still reported as "
            "yahoo_info_previous_close for comparison only.",
            "premarket_high/low ignore bars whose extreme sits exactly on the "
            "previous close while the rest of the bar trades away from it -- a "
            "yfinance anchoring artifact, not a print, appearing on scattered "
            "bars through the window rather than only the 04:00 one. It "
            "inflates the low of a stock gapping up and depresses the high of "
            "one gapping down. anchored_bars_ignored reports how many were "
            "cleaned per symbol. premarket_last is unaffected.",
        ],
    }

    if not result["trading_day"]:
        result["status"] = "market_closed"
        result["note"] = "NYSE is closed today (weekend or holiday); no scan run."
        emit(result, out_path)
        return 0

    expected_session = previous_session_date(now_et)
    result["previous_session_expected"] = (
        expected_session.isoformat() if expected_session else None
    )

    groups = load_watchlist(bot_root)
    result["groups"] = {
        group: [scan_ticker(sym, now_et, expected_session) for sym in symbols]
        for group, symbols in groups.items()
    }

    # A symbol that could not produce a trustworthy previous close is a failed
    # scan, not a quiet omission. run_premarket.ps1 throws on a non-zero exit
    # and writes a failed run report, so this surfaces instead of reaching the
    # agent as a gap it would then reason about.
    failed = [t["symbol"] for syms in result["groups"].values() for t in syms
              if t.get("error")]
    if failed:
        result["status"] = "failed"
        result["failed_symbols"] = failed
        result["note"] = (
            f"{len(failed)} symbols did not produce a verified previous close: "
            f"{', '.join(failed)}. See each symbol's error field."
        )
        emit(result, out_path)
        return 1

    # A scan that starts at or after 09:30 ET is not a pre-market scan, however
    # clean its own bars are. The bars themselves stay honest -- the window filter
    # keeps them all before 09:30 -- but everything ELSE in a post-open run has
    # already seen the session: every live tool call the agent makes returns
    # today's prices, and the 13:12 dry run on 2026-08-04 had NVDA's actual Aug 4
    # open (211.49) come back inside an error string. An order queued in that run
    # fills at that same open, which is look-ahead bias of exactly the kind the
    # queue-then-settle timing model exists to prevent. Nothing reached the ledger
    # that day only because no order was proposed, which is luck rather than a
    # guarantee.
    #
    # So the status says so, and run_premarket.ps1 refuses to queue on it.
    now_min = now_et.hour * 60 + now_et.minute
    if now_min >= REGULAR_OPEN[0] * 60 + REGULAR_OPEN[1]:
        result["status"] = "stale_premarket"
        result["note"] = (
            f"Scan started at {now_et.strftime('%H:%M')} ET, at or after the 09:30 "
            "open. The pre-market bars below are still correct and contain no "
            "look-ahead, but this session's prices are already public, so any live "
            "tool call in this run can see them. Treat this as inspection only: no "
            "order may be queued from it, and run_premarket.ps1 will refuse to. "
            "The scheduled run is 06:00 ET; if this fired on the schedule, find out "
            "why before trusting the next one."
        )
        emit(result, out_path)
        return 0

    result["status"] = "ok"
    emit(result, out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
