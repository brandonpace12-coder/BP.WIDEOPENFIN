# WideOpenFin

Public site tracking **PEG ratios for S&P 500 growth/SaaS stocks vs. their competitors**, plus **Form 4 insider buying** (open-market purchases only).

- Static site (HTML/CSS/JS, no build step) hosted free on **GitHub Pages**
- Data refreshed **once per trading day at ~9:35 AM ET** by a GitHub Actions job
- Valuation: [Financial Modeling Prep](https://site.financialmodelingprep.com/) · Insider filings: [SEC EDGAR](https://www.sec.gov/edgar)

```
index.html                  the site
assets/                     style.css, app.js
data/tickers.json           ticker universe, peer groups, competitors (edit this to change coverage)
data/snapshot.json          latest data (written by the morning job; ships with SAMPLE data)
data/form4_cache.json       parsed Form 4s, so each filing is only downloaded once (created on first run)
scripts/update_data.py      the morning data pull (Python stdlib only)
.github/workflows/update-data.yml   schedule + deploy
```

## Setup (about 10 minutes)

1. **Get an FMP API key** at financialmodelingprep.com (the free plan should cover 43 tickers × 2 calls/day; confirm the
   `ratios-ttm` endpoint is included on your plan).
2. **Create a public GitHub repo** (e.g. `wideopenfin`) and upload these files, keeping the folder structure.
3. In the repo go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `FMP_API_KEY` = your key
   - `SEC_USER_AGENT` = `WideOpenFin your-email@example.com` (SEC requires a contact email)
4. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
5. **Actions → "Update data & deploy" → Run workflow** (leave *force* checked). This replaces the sample data with real data.
   Your site is live at `https://<username>.github.io/wideopenfin/`.

After that it runs on its own every weekday morning; it skips weekends and NYSE holidays.

## How the schedule works

GitHub cron runs in UTC, so the workflow fires at 13:35 and 14:35 UTC. The script only proceeds when it's
9:00–11:00 AM New York time, on a trading day, and not already updated today — so exactly one run does the
work in both daylight and standard time. GitHub's scheduled runs can start a few minutes late under load.

**Each December:** update `NYSE_HOLIDAYS` in `scripts/update_data.py`.
**Each quarter (after the S&P rebalance in Mar/Jun/Sep/Dec):** check `data/tickers.json` against index changes.

## Data notes

- **PEG** = P/E ÷ expected EPS growth. Shown as n/a when earnings or growth are negative (PEG isn't meaningful there).
- **Forward vs. trailing** PEG both come from FMP's `ratios-ttm` endpoint; the site lets visitors switch.
- **vs. peers** = percent above/below the median PEG of the ticker's peer group.
- **Insider buys** = Form 4 non-derivative transactions with code **P** filed in the last 90 days. Grants (A),
  option exercises (M), sales (S) and tax withholding (F) are excluded.

## Running locally

```bash
python3 -m http.server 8000           # view the site at http://localhost:8000
FMP_API_KEY=... SEC_USER_AGENT="WideOpenFin you@example.com" FORCE_RUN=1 python3 scripts/update_data.py
```

Not investment advice.
