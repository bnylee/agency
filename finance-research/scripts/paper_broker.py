#!/usr/bin/env python3
"""Simulated broker for the finance-research paper account.

NO REAL MONEY AND NO BROKERAGE. This moves numbers inside
`state/portfolio.json`. There is deliberately no order-routing code path here,
not even a disabled one, so there is nothing to accidentally enable.

Why a script rather than the agent doing arithmetic in a report: an account
ledger has to be reproducible and auditable, and a language model recomputing a
cost basis every morning is neither. The agent decides *what* to trade and says
why; this file decides what that costs and whether it is allowed.

The timing model is the part worth understanding
------------------------------------------------
The bot runs at 06:00 ET, three and a half hours before the open. An order
"placed" then has no price to fill against, and filling it at the pre-market
print would contradict this bot's own documented finding that pre-market runs on
thin liquidity and frequently does not hold through the open.

So orders are QUEUED for the next regular-session open and SETTLED on a later
run, once that session's real open price has printed:

    Mon 06:00  queue orders for Mon's open
    Tue 06:00  settle them at Mon's ACTUAL 09:30 open, then mark to Mon's close

Nothing is ever filled at a price that had not printed when the decision was
made, so the equity curve carries no look-ahead bias. That is the whole reason
for the two-phase design.

Commands
--------
    init                      create the account with the starting cash
    settle [--dry-run]        fill queued orders + stops/targets, mark to market
    queue --orders FILE       validate proposed orders against the risk limits
    status                    print a snapshot; writes nothing

`--dry-run` computes everything and prints the same JSON, but writes no file.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas_market_calendars as mcal
import yfinance as yf
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
BOT_ROOT = Path(__file__).resolve().parent.parent
STATE = BOT_ROOT / "state"

STARTING_CASH = 10_000.00
BENCHMARK = "SPY"

# ---------------------------------------------------------------- risk limits
# These are the account's constitution. They are enforced here, in code, rather
# than described in the prompt, because a limit that only exists in prose is a
# suggestion -- and this bot's whole job is to argue itself into trades.
MAX_POSITION_PCT = 0.20        # of equity, per symbol, measured at entry
MAX_POSITIONS = 8
MIN_CASH_PCT = 0.05            # never fully invested
MAX_NEW_ORDERS_PER_SESSION = 5
MIN_THESIS_CHARS = 60          # an order with no argument is not an order
SLIPPAGE_BPS = 5               # 0.05%, paid against you on every fill
COMMISSION = 0.00              # retail equities are commission-free; spread is not
EQUITY_CURVE_MAX = 750         # ~3 years of sessions, then the head is dropped
MAX_SETTLE_WALK = 90           # sessions replayed in one run after an outage

PORTFOLIO = STATE / "portfolio.json"
TRADES = STATE / "trades.jsonl"


# ------------------------------------------------------------------- helpers

def _round(x: float, n: int = 4) -> float:
    return round(float(x), n)


def load_portfolio(path: Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def new_portfolio() -> dict:
    return {
        "schema": 1,
        "account": "paper",
        "disclaimer": (
            "Simulated account. No brokerage is connected and no real money is "
            "involved. Fills are modelled against printed historical prices."
        ),
        "currency": "USD",
        "opened_at": datetime.now(ET).strftime("%Y-%m-%d"),
        "starting_cash": STARTING_CASH,
        "cash": STARTING_CASH,
        "positions": {},
        "pending_orders": [],
        "realized_pnl": 0.0,
        "fees_paid": 0.0,
        "slippage_paid": 0.0,
        "dividends_received": 0.0,
        "closed_trades": [],
        "equity_curve": [],
        "benchmark": {"symbol": BENCHMARK, "start_price": None},
        "last_settled_session": None,
        "limits": {
            "max_position_pct": MAX_POSITION_PCT,
            "max_positions": MAX_POSITIONS,
            "min_cash_pct": MIN_CASH_PCT,
            "max_new_orders_per_session": MAX_NEW_ORDERS_PER_SESSION,
            "slippage_bps": SLIPPAGE_BPS,
            "shorting": False,
            "leverage": False,
            "options": False,
        },
    }


def sessions_between(start: date, end: date) -> list[date]:
    """NYSE trading sessions in [start, end], inclusive."""
    if start > end:
        return []
    nyse = mcal.get_calendar("NYSE")
    days = nyse.valid_days(start_date=start.isoformat(), end_date=end.isoformat())
    return [d.date() for d in days]


def last_completed_session(now_et: datetime) -> date | None:
    """The most recent session whose close has printed.

    Today counts only after 16:00 ET. Before that, today's OHLC is incomplete,
    and marking a portfolio to a close that has not happened would be a
    fabricated number.
    """
    today = now_et.date()
    window = sessions_between(today - timedelta(days=14), today)
    if not window:
        return None
    if window[-1] == today and now_et.hour < 16:
        window = window[:-1]
    return window[-1] if window else None


def next_session(now_et: datetime) -> date | None:
    """The next session that can still be traded at its open.

    Today counts only before 09:30 ET; at 06:00 that is today, which is the
    normal case for this bot. After the open has passed, the next order goes to
    the following session.
    """
    today = now_et.date()
    window = sessions_between(today, today + timedelta(days=14))
    if not window:
        return None
    if window[0] == today and (now_et.hour * 60 + now_et.minute) >= 9 * 60 + 30:
        window = window[1:]
    return window[0] if window else None


class Market:
    """Price lookups, memoised for the life of one run.

    auto_adjust is off on purpose. Adjusted prices are back-corrected for splits
    and dividends and are NOT prices anything traded at; a paper fill has to use
    the print. Splits and dividends are then applied explicitly in settle(),
    which is the honest way round.
    """

    def __init__(self) -> None:
        self._bars: dict[tuple[str, date], dict | None] = {}
        self._actions: dict[str, dict] = {}

    def bar(self, symbol: str, session: date) -> dict | None:
        key = (symbol, session)
        if key in self._bars:
            return self._bars[key]
        out: dict | None = None
        try:
            frame = yf.Ticker(symbol).history(
                start=session.isoformat(),
                end=(session + timedelta(days=1)).isoformat(),
                interval="1d",
                auto_adjust=False,
            )
            if frame is not None and not frame.empty:
                row = frame.iloc[0]
                out = {
                    "open": _round(row["Open"]),
                    "high": _round(row["High"]),
                    "low": _round(row["Low"]),
                    "close": _round(row["Close"]),
                }
        except Exception as exc:  # one bad symbol must not void the settlement
            out = {"error": f"{type(exc).__name__}: {exc}"}
        self._bars[key] = out
        return out

    def last_close(self, symbol: str, session: date) -> float | None:
        """Close on `session`, walking back up to 5 sessions if it is missing."""
        for candidate in reversed(sessions_between(session - timedelta(days=10), session)[-6:]):
            bar = self.bar(symbol, candidate)
            if bar and "close" in bar:
                return bar["close"]
        return None

    def actions(self, symbol: str) -> dict:
        """Splits and dividends keyed by ISO date."""
        if symbol in self._actions:
            return self._actions[symbol]
        splits: dict[str, float] = {}
        divs: dict[str, float] = {}
        try:
            ticker = yf.Ticker(symbol)
            # `if series` raises on a pandas Series -- the truth value of a
            # non-empty one is ambiguous. Emptiness has to be asked for by name.
            raw_splits = ticker.splits
            if raw_splits is not None and not raw_splits.empty:
                for stamp, value in raw_splits.items():
                    if value:
                        splits[stamp.date().isoformat()] = float(value)
            raw_divs = ticker.dividends
            if raw_divs is not None and not raw_divs.empty:
                for stamp, value in raw_divs.items():
                    if value:
                        divs[stamp.date().isoformat()] = float(value)
        except Exception:
            # Corporate actions are an accuracy refinement, not a correctness
            # gate. Losing them degrades the ledger; failing the run over them
            # would lose the whole day.
            pass
        out = {"splits": splits, "dividends": divs}
        self._actions[symbol] = out
        return out


def fill_price(reference: float, side: str) -> float:
    """Slippage always paid against the account, both directions."""
    edge = SLIPPAGE_BPS / 10_000.0
    return _round(reference * (1 + edge) if side == "buy" else reference * (1 - edge), 4)


def equity_of(pf: dict, market: Market, session: date) -> tuple[float, float, dict]:
    """(equity, positions_value, per-symbol marks)."""
    marks: dict[str, float | None] = {}
    total = 0.0
    for symbol, pos in pf["positions"].items():
        price = market.last_close(symbol, session)
        marks[symbol] = price
        if price is not None:
            total += price * pos["shares"]
    return _round(pf["cash"] + total, 2), _round(total, 2), marks


# -------------------------------------------------------------------- settle

def settle(pf: dict, market: Market, now_et: datetime) -> dict:
    """Fill everything that the market has now made resolvable.

    Order of operations inside a session matters and is chosen to be the
    conservative reading in every ambiguous case:

      1. corporate actions (splits, dividends) -- the share count has to be
         right before anything is priced against it
      2. queued orders, at the open
      3. stops and targets, against that session's high/low

    Step 3 after step 2 is deliberate: a position opened at today's open is
    exposed to today's range, which is what would actually have happened.
    """
    session = last_completed_session(now_et)
    events: list[dict] = []
    if session is None:
        return {"status": "no_session", "events": events}

    already = pf.get("last_settled_session")
    if already and already >= session.isoformat():
        return {"status": "already_settled", "session": session.isoformat(), "events": events}

    # Where to start the walk. On the very first settlement there is no
    # watermark, so the oldest queued order sets the floor -- otherwise an order
    # queued last week would fill at today's open, which is both wrong and
    # flattering, since it is a price the decision could not have seen.
    pending_dates = [o["for_session"] for o in pf.get("pending_orders", []) if o.get("for_session")]
    if already:
        start = date.fromisoformat(already) + timedelta(days=1)
    elif pending_dates:
        start = date.fromisoformat(min(pending_dates))
    else:
        start = session
    start = min(start, session)

    unsettled = sessions_between(start, session) or [session]
    if len(unsettled) > MAX_SETTLE_WALK:
        # A long outage should not turn one morning's run into a year of price
        # requests. Older orders expire in the loop below with a stated reason.
        events.append({"date": session.isoformat(), "type": "walk_truncated",
                       "note": f"{len(unsettled)} sessions unsettled; replaying the last {MAX_SETTLE_WALK}"})
        unsettled = unsettled[-MAX_SETTLE_WALK:]

    for day in unsettled:
        _settle_session(pf, market, day, events)
        pf["last_settled_session"] = day.isoformat()

    # Mark to market on the last settled session.
    equity, positions_value, marks = equity_of(pf, market, session)

    bench = pf.setdefault("benchmark", {"symbol": BENCHMARK, "start_price": None})
    bench_price = market.last_close(BENCHMARK, session)
    if bench.get("start_price") is None and bench_price is not None:
        bench["start_price"] = bench_price
    bench_equity = None
    if bench_price is not None and bench.get("start_price"):
        bench_equity = _round(pf["starting_cash"] * (bench_price / bench["start_price"]), 2)

    curve = pf.setdefault("equity_curve", [])
    point = {
        "date": session.isoformat(),
        "equity": equity,
        "cash": _round(pf["cash"], 2),
        "positions_value": positions_value,
        "benchmark_equity": bench_equity,
    }
    if curve and curve[-1]["date"] == point["date"]:
        curve[-1] = point
    else:
        curve.append(point)
    del curve[:-EQUITY_CURVE_MAX]

    return {
        "status": "ok",
        "session": session.isoformat(),
        "sessions_settled": [d.isoformat() for d in unsettled],
        "events": events,
        "equity": equity,
        "cash": _round(pf["cash"], 2),
        "positions_value": positions_value,
        "marks": marks,
        "benchmark_equity": bench_equity,
    }


def _settle_session(pf: dict, market: Market, day: date, events: list[dict]) -> None:
    iso = day.isoformat()

    # 1. Corporate actions on held positions.
    for symbol, pos in list(pf["positions"].items()):
        actions = market.actions(symbol)
        ratio = actions["splits"].get(iso)
        if ratio and ratio > 0:
            pos["shares"] = _round(pos["shares"] * ratio, 6)
            pos["avg_cost"] = _round(pos["avg_cost"] / ratio, 4)
            if pos.get("stop"):
                pos["stop"] = _round(pos["stop"] / ratio, 4)
            if pos.get("target"):
                pos["target"] = _round(pos["target"] / ratio, 4)
            events.append({"date": iso, "type": "split", "symbol": symbol, "ratio": ratio})
        per_share = actions["dividends"].get(iso)
        if per_share:
            cash = _round(per_share * pos["shares"], 2)
            pf["cash"] = _round(pf["cash"] + cash, 2)
            pf["dividends_received"] = _round(pf.get("dividends_received", 0.0) + cash, 2)
            events.append({"date": iso, "type": "dividend", "symbol": symbol,
                           "per_share": per_share, "cash": cash})

    # 2. Queued orders, at that session's open.
    remaining: list[dict] = []
    for order in pf.get("pending_orders", []):
        target_session = order.get("for_session")
        if target_session is None or target_session > iso:
            remaining.append(order)
            continue

        bar = market.bar(order["symbol"], day)
        if not bar or "open" not in bar:
            if target_session < iso:
                events.append({"date": iso, "type": "order_expired", "order": order,
                               "reason": f"no printed bar for {target_session}"})
            else:
                remaining.append(order)
            continue

        side = order["side"]
        price = fill_price(bar["open"], side)
        limit = order.get("limit")
        if limit is not None:
            # Market-on-open with a price cap. If the open is already through
            # the cap the order is cancelled rather than chased -- filling later
            # in the day would need intraday data this account does not model.
            if (side == "buy" and price > limit) or (side == "sell" and price < limit):
                events.append({"date": iso, "type": "order_cancelled", "order": order,
                               "reason": f"open {price} through limit {limit}"})
                continue

        _apply_fill(pf, order, price, day, events, reason="queued order")

    pf["pending_orders"] = remaining

    # 3. Stops and targets against the session range.
    for symbol, pos in list(pf["positions"].items()):
        bar = market.bar(symbol, day)
        if not bar or "low" not in bar:
            continue
        stop = pos.get("stop")
        target = pos.get("target")
        hit_stop = stop is not None and bar["low"] <= stop
        hit_target = target is not None and bar["high"] >= target

        if hit_stop and hit_target:
            # Both touched in one session and there is no intraday sequence
            # here to say which came first. Take the stop: assuming the good
            # outcome would flatter every backtest this account ever produces.
            hit_target = False
            events.append({"date": iso, "type": "ambiguous_session", "symbol": symbol,
                           "note": "stop and target both touched; stop assumed first"})

        if not (hit_stop or hit_target):
            continue

        level = stop if hit_stop else target
        # A gap through the level fills at the open, not at the level. The
        # opposite assumption is the single most common way a paper account
        # invents money it never had.
        raw = bar["open"] if (hit_stop and bar["open"] < level) or (hit_target and bar["open"] > level) else level
        _apply_fill(
            pf,
            {"symbol": symbol, "side": "sell", "shares": pos["shares"],
             "thesis": f"{'stop' if hit_stop else 'target'} at {level}"},
            fill_price(raw, "sell"), day, events,
            reason="stop" if hit_stop else "target",
        )


def _apply_fill(pf: dict, order: dict, price: float, day: date, events: list[dict], reason: str) -> None:
    symbol = order["symbol"]
    side = order["side"]
    shares = float(order["shares"])
    gross = _round(price * shares, 2)
    iso = day.isoformat()

    if side == "buy":
        cost = _round(gross + COMMISSION, 2)
        if cost > pf["cash"]:
            # The risk check at queue time used an estimate; the real open can
            # gap. No leverage means the order simply does not fill.
            events.append({"date": iso, "type": "order_rejected", "order": order,
                           "reason": f"insufficient cash: needs {cost}, has {_round(pf['cash'], 2)}"})
            return
        pf["cash"] = _round(pf["cash"] - cost, 2)
        pos = pf["positions"].get(symbol)
        if pos:
            total_shares = pos["shares"] + shares
            pos["avg_cost"] = _round((pos["avg_cost"] * pos["shares"] + price * shares) / total_shares, 4)
            pos["shares"] = _round(total_shares, 6)
        else:
            pos = {
                "shares": _round(shares, 6),
                "avg_cost": price,
                "opened_at": iso,
                "thesis": order.get("thesis", ""),
                "catalyst": order.get("catalyst"),
                "conviction": order.get("conviction"),
                "stop": order.get("stop"),
                "target": order.get("target"),
                "sources": order.get("sources", []),
            }
            pf["positions"][symbol] = pos
        # A re-entry may carry a revised stop or target.
        for field in ("stop", "target"):
            if order.get(field) is not None:
                pos[field] = order[field]
    else:
        pos = pf["positions"].get(symbol)
        if not pos:
            events.append({"date": iso, "type": "order_rejected", "order": order,
                           "reason": f"no position in {symbol}; shorting is not allowed"})
            return
        held = pos["shares"]
        if shares > held + 1e-9:
            # No shorting. Sell what is held and say so, rather than silently
            # opening a short position the account is not allowed to have.
            events.append({"date": iso, "type": "order_trimmed", "order": order,
                           "reason": f"sell {shares} exceeds {held} held; filled {held}"})
            shares = held
        if shares <= 0:
            events.append({"date": iso, "type": "order_rejected", "order": order,
                           "reason": "no shares held"})
            return
        gross = _round(price * shares, 2)
        proceeds = _round(gross - COMMISSION, 2)
        realized = _round((price - pos["avg_cost"]) * shares - COMMISSION, 2)
        pf["cash"] = _round(pf["cash"] + proceeds, 2)
        pf["realized_pnl"] = _round(pf.get("realized_pnl", 0.0) + realized, 2)
        pos["shares"] = _round(pos["shares"] - shares, 6)

        if pos["shares"] <= 1e-9:
            pf.setdefault("closed_trades", []).append({
                "symbol": symbol,
                "opened_at": pos.get("opened_at"),
                "closed_at": iso,
                "avg_cost": pos["avg_cost"],
                "exit": price,
                "shares": _round(shares, 6),
                "realized_pnl": realized,
                "return_pct": _round((price / pos["avg_cost"] - 1) * 100, 3) if pos["avg_cost"] else None,
                "exit_reason": reason,
                "thesis": pos.get("thesis", ""),
                "conviction": pos.get("conviction"),
            })
            del pf["positions"][symbol]

    pf["fees_paid"] = _round(pf.get("fees_paid", 0.0) + COMMISSION, 2)
    fill = {
        "date": iso, "type": "fill", "symbol": symbol, "side": side,
        "shares": _round(shares, 6), "price": price, "gross": gross,
        "reason": reason, "thesis": order.get("thesis", ""),
    }
    events.append(fill)


# --------------------------------------------------------------------- queue

_SYMBOL_OK = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ.-")


def queue(pf: dict, market: Market, proposed: dict, now_et: datetime) -> dict:
    """Validate proposed orders against the limits and queue the survivors.

    Every rejection carries a reason and every reason goes into the report.
    A silently dropped order would let the narrative and the ledger diverge,
    which is the failure mode that makes a paper account worthless.
    """
    session = next_session(now_et)
    if session is None:
        return {"status": "no_session", "accepted": [], "rejected": []}

    mark_session = last_completed_session(now_et) or session
    equity, _, _ = equity_of(pf, market, mark_session)
    accepted: list[dict] = []
    rejected: list[dict] = []

    orders = proposed.get("orders", [])
    if not isinstance(orders, list):
        return {"status": "bad_input", "error": "orders must be a list", "accepted": [], "rejected": []}

    projected_cash = pf["cash"]
    open_symbols = set(pf["positions"])

    for raw in orders:
        if not isinstance(raw, dict):
            rejected.append({"order": {"raw": str(raw)}, "reason": "each order must be an object"})
            continue
        if len(accepted) >= MAX_NEW_ORDERS_PER_SESSION:
            rejected.append({"order": raw, "reason": f"over the {MAX_NEW_ORDERS_PER_SESSION}-order session cap"})
            continue

        problem = None
        symbol = str(raw.get("symbol", "")).upper().strip()
        side = str(raw.get("side", "")).lower().strip()
        thesis = str(raw.get("thesis", "") or "")

        if not symbol or not set(symbol) <= _SYMBOL_OK or len(symbol) > 6:
            problem = f"bad symbol {raw.get('symbol')!r}"
        elif side not in ("buy", "sell"):
            problem = f"side must be buy or sell, got {raw.get('side')!r}"
        elif len(thesis.strip()) < MIN_THESIS_CHARS:
            problem = f"thesis under {MIN_THESIS_CHARS} chars; an order needs an argument"

        if problem:
            rejected.append({"order": raw, "reason": problem})
            continue

        price = market.last_close(symbol, mark_session)
        if price is None:
            rejected.append({"order": raw, "reason": f"no recent price for {symbol}"})
            continue

        shares = raw.get("shares")
        if shares is None and raw.get("notional"):
            shares = int(float(raw["notional"]) // price)
        try:
            shares = int(shares)
        except (TypeError, ValueError):
            rejected.append({"order": raw, "reason": "shares must be a whole number, or give notional"})
            continue
        if shares <= 0:
            rejected.append({"order": raw, "reason": "shares must be positive; no shorting"})
            continue

        if side == "buy":
            # A stop above the market or a target below it fires the instant the
            # position opens, which shows up in the ledger as a round trip that
            # only ever paid slippage. Caught here rather than in settlement,
            # where it looks like a real trade.
            stop, target = raw.get("stop"), raw.get("target")
            if stop is not None and float(stop) >= price:
                rejected.append({"order": raw, "reason": (
                    f"stop {stop} is at or above the {price} reference; it would fill on entry")})
                continue
            if target is not None and float(target) <= price:
                rejected.append({"order": raw, "reason": (
                    f"target {target} is at or below the {price} reference; it would fill on entry")})
                continue

            est_cost = price * shares
            held_value = price * pf["positions"].get(symbol, {}).get("shares", 0)
            if est_cost + held_value > MAX_POSITION_PCT * equity + 1e-6:
                rejected.append({"order": raw, "reason": (
                    f"position would be {(est_cost + held_value) / equity * 100:.1f}% of equity, "
                    f"over the {MAX_POSITION_PCT * 100:.0f}% cap")})
                continue
            if symbol not in open_symbols and len(open_symbols) >= MAX_POSITIONS:
                rejected.append({"order": raw, "reason": f"already holding {MAX_POSITIONS} positions"})
                continue
            if projected_cash - est_cost < MIN_CASH_PCT * equity:
                rejected.append({"order": raw, "reason": (
                    f"would leave {(projected_cash - est_cost) / equity * 100:.1f}% cash, "
                    f"under the {MIN_CASH_PCT * 100:.0f}% floor")})
                continue
            projected_cash -= est_cost
            open_symbols.add(symbol)
        else:
            held = pf["positions"].get(symbol, {}).get("shares", 0)
            if shares > held:
                rejected.append({"order": raw, "reason": f"sell {shares} but only {held} held; no shorting"})
                continue

        conviction = raw.get("conviction")
        try:
            conviction = max(1, min(5, int(conviction)))
        except (TypeError, ValueError):
            conviction = None

        accepted.append({
            "symbol": symbol,
            "side": side,
            "shares": shares,
            "limit": raw.get("limit"),
            "stop": raw.get("stop"),
            "target": raw.get("target"),
            "conviction": conviction,
            "thesis": thesis.strip(),
            "catalyst": raw.get("catalyst"),
            "sources": raw.get("sources", []),
            "for_session": session.isoformat(),
            "queued_at": now_et.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "reference_price": price,
        })

    pf.setdefault("pending_orders", []).extend(accepted)
    return {
        "status": "ok",
        "for_session": session.isoformat(),
        "equity_at_queue": equity,
        "accepted": accepted,
        "rejected": rejected,
    }


# -------------------------------------------------------------------- output

def snapshot(pf: dict, market: Market, now_et: datetime) -> dict:
    session = last_completed_session(now_et)
    equity, positions_value, marks = equity_of(pf, market, session) if session else (pf["cash"], 0.0, {})
    positions = []
    for symbol, pos in pf["positions"].items():
        mark = marks.get(symbol)
        positions.append({
            "symbol": symbol,
            "shares": pos["shares"],
            "avg_cost": pos["avg_cost"],
            "mark": mark,
            "value": _round(mark * pos["shares"], 2) if mark else None,
            "unrealized_pnl": _round((mark - pos["avg_cost"]) * pos["shares"], 2) if mark else None,
            "return_pct": _round((mark / pos["avg_cost"] - 1) * 100, 2) if mark and pos["avg_cost"] else None,
            "stop": pos.get("stop"),
            "target": pos.get("target"),
            "opened_at": pos.get("opened_at"),
            "conviction": pos.get("conviction"),
            "thesis": pos.get("thesis"),
        })
    positions.sort(key=lambda p: p["value"] or 0, reverse=True)

    curve = pf.get("equity_curve", [])
    bench = curve[-1]["benchmark_equity"] if curve else None
    return {
        "as_of_session": session.isoformat() if session else None,
        "disclaimer": pf.get("disclaimer"),
        "starting_cash": pf["starting_cash"],
        "cash": _round(pf["cash"], 2),
        "positions_value": positions_value,
        "equity": equity,
        "total_return_pct": _round((equity / pf["starting_cash"] - 1) * 100, 3),
        "benchmark_equity": bench,
        "benchmark_return_pct": _round((bench / pf["starting_cash"] - 1) * 100, 3) if bench else None,
        "alpha_pct": _round((equity - bench) / pf["starting_cash"] * 100, 3) if bench else None,
        "realized_pnl": pf.get("realized_pnl", 0.0),
        "dividends_received": pf.get("dividends_received", 0.0),
        "positions": positions,
        "pending_orders": pf.get("pending_orders", []),
        "closed_trades": pf.get("closed_trades", [])[-20:],
        "equity_curve": curve[-90:],
        "limits": pf.get("limits", {}),
        "last_settled_session": pf.get("last_settled_session"),
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def append_trades(path: Path, events: list[dict]) -> None:
    fills = [e for e in events if e.get("type") == "fill"]
    if not fills:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        for fill in fills:
            fh.write(json.dumps(fill) + "\n")


def markdown_block(settlement: dict, queued: dict | None, snap: dict) -> str:
    """The deterministic half of the report, appended by this script.

    The agent writes its report before the broker has ruled on its orders, so
    what actually happened is appended here rather than described there. If the
    two ever disagree, this block is the one that matches the ledger.
    """
    lines = ["", "## Paper account — simulated, no real money", ""]
    lines.append(f"**Equity** ${snap['equity']:,.2f} · cash ${snap['cash']:,.2f} · "
                 f"total return {snap['total_return_pct']:+.2f}%")
    if snap.get("benchmark_return_pct") is not None:
        lines.append(f"**vs SPY buy-and-hold** {snap['benchmark_return_pct']:+.2f}% "
                     f"(alpha {snap['alpha_pct']:+.2f}%)")
    lines.append("")

    fills = [e for e in settlement.get("events", []) if e.get("type") == "fill"]
    if fills:
        lines += ["### Filled this settlement", "",
                  "| Symbol | Side | Shares | Price | Reason |", "| --- | --- | --- | --- | --- |"]
        for f in fills:
            lines.append(f"| {f['symbol']} | {f['side']} | {f['shares']:g} | ${f['price']:.2f} | {f['reason']} |")
        lines.append("")

    other = [e for e in settlement.get("events", []) if e.get("type") != "fill"]
    if other:
        lines += ["### Settlement notes", ""]
        for e in other:
            detail = e.get("reason") or e.get("note") or ""
            lines.append(f"- `{e['type']}` {e.get('symbol', '')} {detail}".rstrip())
        lines.append("")

    if snap["positions"]:
        lines += ["### Open positions", "",
                  "| Symbol | Shares | Cost | Mark | P&L | Stop | Target |",
                  "| --- | --- | --- | --- | --- | --- | --- |"]
        for p in snap["positions"]:
            mark = f"${p['mark']:.2f}" if p["mark"] else "—"
            pnl = f"{p['return_pct']:+.2f}%" if p["return_pct"] is not None else "—"
            lines.append(f"| {p['symbol']} | {p['shares']:g} | ${p['avg_cost']:.2f} | {mark} | {pnl} | "
                         f"{p['stop'] or '—'} | {p['target'] or '—'} |")
        lines.append("")
    else:
        lines += ["No open positions.", ""]

    if queued:
        acc = queued.get("accepted", [])
        rej = queued.get("rejected", [])
        lines.append(f"### Orders queued for {queued.get('for_session', 'the next open')}")
        lines.append("")
        if acc:
            lines += ["| Symbol | Side | Shares | Limit | Stop | Target | Conviction |",
                      "| --- | --- | --- | --- | --- | --- | --- |"]
            for o in acc:
                lines.append(f"| {o['symbol']} | {o['side']} | {o['shares']} | {o['limit'] or '—'} | "
                             f"{o['stop'] or '—'} | {o['target'] or '—'} | {o['conviction'] or '—'} |")
            lines.append("")
        else:
            lines += ["None.", ""]
        if rej:
            lines += ["**Rejected by the risk limits:**", ""]
            for r in rej:
                sym = r["order"].get("symbol", "?")
                lines.append(f"- {sym} — {r['reason']}")
            lines.append("")

    lines.append("_Simulated fills at printed session opens plus "
                 f"{SLIPPAGE_BPS} bps slippage. No brokerage is connected._")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["init", "settle", "queue", "status"])
    ap.add_argument("--portfolio", default=str(PORTFOLIO), help="portfolio.json path")
    ap.add_argument("--trades", default=str(TRADES), help="append-only fill log")
    ap.add_argument("--orders", help="proposed orders JSON (queue only)")
    ap.add_argument("--settlement", help="settle output to fold into the appended report block")
    ap.add_argument("--out", help="write the result JSON here as well as stdout")
    ap.add_argument("--append-report", help="append the markdown block to this report file")
    ap.add_argument("--dry-run", action="store_true", help="compute everything, write nothing")
    args = ap.parse_args()

    now_et = datetime.now(ET)
    pf_path = Path(args.portfolio)
    result: dict

    if args.command == "init":
        if pf_path.exists():
            result = {"status": "exists", "path": str(pf_path),
                      "note": "refusing to overwrite a funded account"}
        else:
            pf = new_portfolio()
            result = {"status": "created", "path": str(pf_path), "starting_cash": pf["starting_cash"]}
            if not args.dry_run:
                write_json(pf_path, pf)
        print(json.dumps(result, indent=2))
        if args.out and not args.dry_run:
            write_json(Path(args.out), result)
        return 0

    if not pf_path.exists():
        print(json.dumps({"status": "failed", "error": f"no account at {pf_path}; run init first"}), file=sys.stderr)
        return 2

    pf = load_portfolio(pf_path)
    market = Market()

    if args.command == "status":
        result = snapshot(pf, market, now_et)

    elif args.command == "settle":
        settlement = settle(pf, market, now_et)
        snap = snapshot(pf, market, now_et)
        # NOT "dry_run". Two different things are called that here, and the
        # emitted field kept reporting the wrong one: run_premarket.ps1's -DryRun
        # redirects every path under state/dryrun/ and then genuinely settles,
        # queues and writes, while THIS flag only suppresses writing. So a real
        # dry run emitted "dry_run": false into a file sitting in state/dryrun/,
        # which the 2026-08-03 and 2026-08-04 runs both flagged as a
        # contradiction. It was not wrong, it was ambiguous. Named for what it
        # actually controls, there is no contradiction left: writes were not
        # suppressed, they were redirected, and the path says where.
        result = {"settlement": settlement, "snapshot": snap, "writes_suppressed": args.dry_run}
        if not args.dry_run:
            write_json(pf_path, pf)
            append_trades(Path(args.trades), settlement.get("events", []))

    else:  # queue
        if not args.orders:
            print(json.dumps({"status": "failed", "error": "--orders is required"}), file=sys.stderr)
            return 2
        orders_path = Path(args.orders)
        if not orders_path.exists():
            # Not an error: a morning with no conviction should produce no
            # orders, and forcing a file to exist would invite an empty one
            # being written just to satisfy the pipeline.
            result = {"status": "no_orders_file", "path": str(orders_path),
                      "accepted": [], "rejected": []}
        else:
            proposed = json.loads(orders_path.read_text(encoding="utf-8"))
            result = queue(pf, market, proposed, now_et)
            if not args.dry_run and result.get("status") == "ok":
                write_json(pf_path, pf)
        # See the note on the settle branch above for why this is not "dry_run".
        result = {"queue": result, "snapshot": snapshot(pf, market, now_et), "writes_suppressed": args.dry_run}

    print(json.dumps(result, indent=2, default=str))
    if args.out:
        write_json(Path(args.out), result)

    if args.append_report:
        snap = result.get("snapshot") or result
        settlement = result.get("settlement", {})
        # The settle step runs before the agent writes its report, and the queue
        # step runs after. Only the queue step can append, so it reads back what
        # settle recorded rather than the report carrying two separate blocks.
        if not settlement and args.settlement and Path(args.settlement).exists():
            try:
                settlement = json.loads(Path(args.settlement).read_text(encoding="utf-8")).get("settlement", {})
            except (OSError, json.JSONDecodeError):
                settlement = {}
        block = markdown_block(settlement, result.get("queue"), snap)
        report = Path(args.append_report)
        if report.exists():
            with open(report, "a", encoding="utf-8") as fh:
                fh.write("\n" + block)
        else:
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(block, encoding="utf-8")

    return 0


if __name__ == "__main__":
    sys.exit(main())
