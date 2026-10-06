#!/usr/bin/env python3
"""Morning data pull for WideOpenFin.

Runs once per trading day near the open (see .github/workflows/update-data.yml):
  1. Price + valuation for every ticker in data/tickers.json (Finnhub, free tier)
     PEG is computed here: trailing P/E / last-12-months EPS growth (year over year)
  2. Form 4 open-market insider PURCHASES (transaction code "P") from SEC EDGAR

Writes data/snapshot.json, which the static site reads. Standard library only.

Env vars:
  FINNHUB_API_KEY  required  - Finnhub key (GitHub secret)
  SEC_USER_AGENT   required  - "AppName contact@email" (SEC requires a contact in the User-Agent)
  FORCE_RUN=1      optional  - skip the trading-day / time-window check
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TICKERS_FILE = DATA / "tickers.json"
SNAPSHOT_FILE = DATA / "snapshot.json"
FORM4_CACHE_FILE = DATA / "form4_cache.json"

ET_TZ = ZoneInfo("America/New_York")
FINNHUB_BASE = "https://finnhub.io/api/v1"
FINNHUB_PAUSE = 1.1  # free tier: 60 calls/minute
INSIDER_LOOKBACK_DAYS = 90

# NYSE full-day closures. Update this list each December.
NYSE_HOLIDAYS = {
    # 2026
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    # 2027
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
}


# --------------------------------------------------------------------------- helpers
def log(msg: str) -> None:
    print(f"[{datetime.now(ET_TZ):%H:%M:%S}] {msg}", flush=True)


def http_json(url: str, headers: dict | None = None, retries: int = 3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers or {})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise


def http_text(url: str, headers: dict | None = None) -> str:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def num(v):
    try:
        f = float(v)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def first(d: dict, *keys):
    for k in keys:
        v = num(d.get(k))
        if v is not None:
            return v
    return None


def clean_peg(v):
    """PEG is only meaningful with positive earnings and positive growth."""
    if v is None or v <= 0 or v > 100:
        return None
    return round(v, 2)


# --------------------------------------------------------------------------- schedule gate
def should_run() -> bool:
    if os.environ.get("FORCE_RUN") == "1":
        return True
    now = datetime.now(ET_TZ)
    if now.weekday() >= 5 or now.strftime("%Y-%m-%d") in NYSE_HOLIDAYS:
        log("Market closed today - nothing to do.")
        return False
    # Cron fires at two UTC times so one lands near 9:35 ET in both EDT and EST.
    if not (9 <= now.hour < 11):
        log(f"Outside the morning window ({now:%H:%M} ET) - skipping.")
        return False
    if SNAPSHOT_FILE.exists():
        prev = json.loads(SNAPSHOT_FILE.read_text())
        if not prev.get("sample") and prev.get("trading_date") == now.strftime("%Y-%m-%d"):
            log("Already updated today - skipping.")
            return False
    return True


# --------------------------------------------------------------------------- valuation
def compute_peg(pe, growth_pct):
    """PEG = P/E / EPS growth (in percent). Meaningless for negative P/E or growth."""
    if pe is None or growth_pct is None or pe <= 0 or growth_pct <= 0:
        return None
    return clean_peg(pe / growth_pct)


def fetch_valuation(symbols: list[str], api_key: str, previous: dict[str, dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    logged_keys = False
    for sym in symbols:
        rec = {"price": None, "change_pct": None, "market_cap": None,
               "pe": None, "eps_growth": None, "growth_basis": None,
               "peg": None, "fwd_peg": None}
        q = urllib.parse.quote(sym)
        ok = False
        try:
            quote = http_json(f"{FINNHUB_BASE}/quote?symbol={q}&token={api_key}") or {}
            time.sleep(FINNHUB_PAUSE)
            price = num(quote.get("c"))
            rec["price"] = price if price else None  # Finnhub returns 0 for unknown symbols
            rec["change_pct"] = num(quote.get("dp"))

            data = http_json(f"{FINNHUB_BASE}/stock/metric?symbol={q}&metric=all&token={api_key}") or {}
            time.sleep(FINNHUB_PAUSE)
            m = data.get("metric") or {}
            if not logged_keys and m:
                keys = sorted(k for k in m if "pe" in k.lower() or "growth" in k.lower())
                log(f"  Finnhub metric fields (P/E + growth): {', '.join(keys)}")
                logged_keys = True

            cap = first(m, "marketCapitalization")
            rec["market_cap"] = cap * 1e6 if cap else None  # Finnhub reports millions
            pe = first(m, "peTTM", "peBasicExclExtraTTM", "peExclExtraTTM", "peNormalizedAnnual")
            rec["pe"] = round(pe, 1) if pe and pe > 0 else None
            # Last-12-months EPS growth vs. the prior 12 months, same basis for every stock.
            g = first(m, "epsGrowthTTMYoy", "epsGrowthTTMYoY")
            if g is not None:
                rec["eps_growth"], rec["growth_basis"] = round(g, 1), "1y"
            rec["peg"] = compute_peg(pe, rec["eps_growth"])
            ok = rec["price"] is not None
        except Exception as e:  # keep going; one bad symbol shouldn't sink the run
            log(f"  ! {sym}: {e}")
        if not ok and previous.get(sym, {}).get("price") is not None:
            rec = {**previous[sym], "fwd_peg": None, "stale": True}  # keep yesterday's numbers rather than blanking
            log(f"  ~ {sym}: using previous values")
        out[sym] = rec
    return out


# --------------------------------------------------------------------------- Form 4
def sec_headers() -> dict:
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        sys.exit("SEC_USER_AGENT is required, e.g. 'WideOpenFin you@example.com'")
    return {"User-Agent": ua, "Accept-Encoding": "identity"}


def cik_map(headers: dict) -> dict[str, int]:
    raw = http_json("https://www.sec.gov/files/company_tickers.json", headers)
    return {row["ticker"].upper().replace("-", "."): int(row["cik_str"]) for row in raw.values()}


def text_at(node, path: str) -> str | None:
    el = node.find(path)
    return el.text.strip() if el is not None and el.text else None


def parse_form4(xml_text: str) -> dict:
    root = ET.fromstring(xml_text)
    owner = root.find("reportingOwner")
    name = text_at(owner, "reportingOwnerId/rptOwnerName") if owner is not None else None
    rel = owner.find("reportingOwnerRelationship") if owner is not None else None
    roles = []
    if rel is not None:
        if text_at(rel, "isDirector") in ("1", "true"):
            roles.append("Director")
        if text_at(rel, "isOfficer") in ("1", "true"):
            roles.append(text_at(rel, "officerTitle") or "Officer")
        if text_at(rel, "isTenPercentOwner") in ("1", "true"):
            roles.append("10% Owner")
    buys = []
    for tx in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        if text_at(tx, "transactionCoding/transactionCode") != "P":
            continue  # only open-market purchases
        shares = num(text_at(tx, "transactionAmounts/transactionShares/value"))
        price = num(text_at(tx, "transactionAmounts/transactionPricePerShare/value"))
        buys.append({
            "date": text_at(tx, "transactionDate/value"),
            "shares": shares,
            "price": price,
            "value": round(shares * price, 2) if shares and price else None,
            "owned_after": num(text_at(tx, "postTransactionAmounts/sharesOwnedFollowingTransaction/value")),
        })
    return {"insider": name, "role": ", ".join(roles) or None, "buys": buys}


def fetch_insider_buys(symbols: list[str]) -> list[dict]:
    headers = sec_headers()
    cache = json.loads(FORM4_CACHE_FILE.read_text()) if FORM4_CACHE_FILE.exists() else {}
    ciks = cik_map(headers)
    cutoff = (date.today() - timedelta(days=INSIDER_LOOKBACK_DAYS)).isoformat()
    results: list[dict] = []
    fetched = 0

    for sym in symbols:
        cik = ciks.get(sym)
        if not cik:
            log(f"  ! no CIK for {sym}")
            continue
        try:
            subs = http_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", headers)
        except Exception as e:
            log(f"  ! submissions {sym}: {e}")
            continue
        time.sleep(0.15)
        recent = subs.get("filings", {}).get("recent", {})
        for form, acc, fdate, doc in zip(recent.get("form", []), recent.get("accessionNumber", []),
                                         recent.get("filingDate", []), recent.get("primaryDocument", [])):
            if form != "4" or fdate < cutoff:
                continue
            if acc not in cache:
                xml_name = doc.split("/")[-1]  # strip the xslF345X0x/ rendering prefix
                url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{xml_name}"
                try:
                    cache[acc] = parse_form4(http_text(url, headers))
                    fetched += 1
                except Exception as e:
                    log(f"  ! {sym} {acc}: {e}")
                    cache[acc] = {"insider": None, "role": None, "buys": [], "error": True}
                time.sleep(0.15)  # SEC limit is 10 req/s
            entry = cache[acc]
            for b in entry.get("buys", []):
                results.append({
                    "symbol": sym, "filed": fdate, "insider": entry.get("insider"),
                    "role": entry.get("role"), **b,
                    "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}",
                })

    # keep the cache from growing forever (dicts keep insertion order, so drop the oldest)
    if len(cache) > 5000:
        cache = dict(list(cache.items())[-5000:])
    FORM4_CACHE_FILE.write_text(json.dumps(cache))
    log(f"Form 4: parsed {fetched} new filings, {len(results)} open-market purchases in window")
    results.sort(key=lambda r: (r["filed"], r.get("value") or 0), reverse=True)
    return results


# --------------------------------------------------------------------------- main
def main() -> None:
    if not should_run():
        return
    api_key = os.environ.get("FINNHUB_API_KEY")
    if not api_key:
        sys.exit("FINNHUB_API_KEY is required")

    universe = json.loads(TICKERS_FILE.read_text())
    symbols = [t["symbol"] for t in universe["tickers"]]

    previous = {}
    if SNAPSHOT_FILE.exists():
        prev = json.loads(SNAPSHOT_FILE.read_text())
        if not prev.get("sample"):
            previous = {t["symbol"]: {k: t.get(k) for k in ("price", "change_pct", "market_cap", "pe",
                        "eps_growth", "growth_basis", "peg", "fwd_peg")} for t in prev.get("tickers", [])}

    log(f"Valuation for {len(symbols)} tickers (Finnhub, ~{len(symbols) * 2 * FINNHUB_PAUSE / 60:.0f} min)...")
    val = fetch_valuation(symbols, api_key, previous)
    log("Form 4 insider purchases...")
    buys = fetch_insider_buys(symbols)

    now = datetime.now(ET_TZ)
    snapshot = {
        "sample": False,
        "valuation_source": "Finnhub",
        "peg_method": "Trailing P/E / last-12-months EPS growth (year over year)",
        "generated_at": now.isoformat(timespec="minutes"),
        "trading_date": now.strftime("%Y-%m-%d"),
        "insider_lookback_days": INSIDER_LOOKBACK_DAYS,
        "groups": universe["groups"],
        "tickers": [{**t, **val.get(t["symbol"], {})} for t in universe["tickers"]],
        "insider_buys": buys,
    }
    SNAPSHOT_FILE.write_text(json.dumps(snapshot, indent=1))
    have = sum(1 for t in snapshot["tickers"] if t.get("peg"))
    log(f"Wrote {SNAPSHOT_FILE.name}: PEG for {have}/{len(symbols)} tickers")


if __name__ == "__main__":
    main()
