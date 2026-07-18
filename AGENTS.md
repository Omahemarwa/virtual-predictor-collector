# Virtual Predictor Collector — Final Build Spec

## GitHub Account
- Username: `Omahemarwa`
- New repo: `virtual-predictor-collector`
- Remote: `git@github.com:Omahemarwa/virtual-predictor-collector.git`

## Objective
Single Node.js service that:
1. Scrapes live results + upcoming matches from betPawa
2. Polls predictions from the dashboard API every 10 seconds
3. Saves all to CSVs with dedup + overwrite
4. Serves a data viewer + health endpoint

## 4 Sources / Endpoints

| Endpoint | What | How Often |
|---|---|---|
| `https://www.betpawa.co.tz/virtual-sports?virtualTab=results` | **Detect season ID** from dropdown or page content | Startup + every 5 min re-scan |
| `https://www.betpawa.co.tz/virtual-sports?virtualTab=upcoming` | **Upcoming matches** (team codes, no scores) | Startup + re-scan |
| `https://www.betpawa.co.tz/virtual-sports?virtualTab=live` | **Current/recent results** — refreshed every ~5 min after timer ends | Startup + re-scan |
| `https://virtualpredictor-production.up.railway.app/data` | **Predictions** for current matchday | Every **10 seconds** (lightweight HTTP) |

**betPawa load order:**
1. `?virtualTab=results` → detect season
2. `?virtualTab=upcoming` → upcoming matches
3. `?virtualTab=live` → current results (load after upcoming, otherwise header may render empty)

## CSV Formats

### `results.csv`
```
season_id,matchday,league,home_team,away_team,ft_home,ft_away
```
- **Save ALL English + Spanish matches shown on Live** — regardless of whether they had predictions
- Preserve team values exactly as betPawa displays them (3-letter codes)

### `upcoming.csv` (NEW)
```
season_id,matchday,league,row,home_team,away_team
```
- `row` = the row number the match appears in on the upcoming tab (1–10)
- No scores — matches haven't been played yet

### `predictions.csv`
```
season_id,matchday,league,row,home_team,away_team,market,pct
```
- `home_team` = `team1` from API (full name like "Brentford")
- `away_team` = `team2` from API

## Season ID Strategy
- **Derive from results tab** — on startup, navigate to `https://www.betpawa.co.tz/virtual-sports?virtualTab=results` and extract season_id from the season dropdown (`[data-test-id="auto-matches-results-select"] select`) or from page text/URL links.
- **Fallback methods:** matchday/0 redirect, upcoming tab links.
- **Last resort:** hardcoded fallback `138444`.
- This preserves CSV compatibility with existing consumers.

## Dedup + Update Rules

| File | Key | On Change |
|---|---|---|
| `results.csv` | `season_id + matchday + league + home_team + away_team` | Overwrite score |
| `upcoming.csv` | `season_id + matchday + league + row` | Overwrite teams |
| `predictions.csv` | `season_id + matchday + league + row + market` | Overwrite pct |

All CSVs are **overwritten entirely** on each save (read → modify in memory → write).

## Execution Flow

```
STARTUP:
  1. Start HTTP server
  2. Detect season_id via `?virtualTab=results`
  3. Load Upcoming tab → scrape upcoming matches
  4. Activate Live tab → scrape live results
  5. Fetch predictions from API
  6. Save all CSVs

EVERY 10 SECONDS (lightweight, no browser):
  1. HTTP GET predictions endpoint
  2. If data returned → merge into predictions.csv
  3. If no data → skip (predictions may be between cycles)

ON EACH TIMER TRANSITION (betPawa timer hits 0):
  1. Launch browser
  2. Load Upcoming tab → activate Live tab
  3. Scrape live results + upcoming matches
  4. Merge into CSVs
  5. Close browser

EVERY 5 MINUTES (full re-scan, mutex-guarded):
  1. Same as timer transition (full browser scrape)
  2. Catches any score corrections

MUTEX: If a 5-min re-scan is already running when next one triggers → skip it.
Prediction polling (10s) is INDEPENDENT and NEVER skipped.
```

## Endpoints (HTTP Server)

| Route | Description |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /collect-log` | Plain text of collect_log.txt |
| `GET /csv/results.csv` | Filtered + paginated results JSON |
| `GET /csv/upcoming.csv` | Filtered + paginated upcoming JSON |
| `GET /csv/predictions.csv` | Filtered + paginated predictions JSON |
| `GET /view` | HTML index with links to all 3 viewers |
| `GET /view/results` | HTML results viewer (filters + log panel) |
| `GET /view/upcoming` | HTML upcoming viewer |
| `GET /view/predictions` | HTML predictions viewer |

### CSV endpoint response shape (preserved):
```json
{ "headers": [...], "rows": N, "offset": 0, "limit": 100, "page": [...] }
```
Filters: `season_id`, `matchday`, `league` (optional query params).
Sort: season_id DESC, matchday DESC.

### Log panel
Auto-polls `/collect-log` every 2s on `/view/results` page. Hidden when log is empty, appears when data arrives.

## Scraping Details

### betPawa page scraper (Playwright Firefox)
```
async function scrapeBetPawa(seasonId, page):
  # ═══ RESULTS TAB — detect season ═══
  # (season_id already detected by collectAll() before this call)

  # ═══ UPCOMING TAB ═══
  # Load first — live tab won't render correctly otherwise
  await page.goto('https://www.betpawa.co.tz/virtual-sports?virtualTab=upcoming', ...)
  await page.waitForTimeout(3000)

  # Switch to English league tab
  click English league tab
  await page.waitForTimeout(1000)
  extract matchday from page text (regex: /Matchday\s*(\d+)/i)
  upcomingEnglish = parseMatchLines(await page.innerText('body'), hasScores=false)

  # Switch to Spanish league tab
  click Spanish league tab
  await page.waitForTimeout(1000)
  upcomingSpanish = parseMatchLines(..., hasScores=false)

  # ═══ LIVE TAB ═══
  # Activate Live — current/recent results (refreshed ~every 5 min)
  click Live tab control
  await page.waitForTimeout(3000)

  # English league on Live tab
  click English league tab
  await page.waitForTimeout(1000)
  liveEnglish = parseMatchLines(await page.innerText('body'), hasScores=true)

  # Spanish league on Live tab
  click Spanish league tab
  await page.waitForTimeout(1000)
  liveSpanish = parseMatchLines(..., hasScores=true)

  return { live: [...], upcoming: [...] }
```

### `parseMatchLines(text, hasScores)`
```
Scan lines for: /^([A-Z]{3})\s*-\s*([A-Z]{3})$/
If hasScores == true:
  next line should match /^\((\d+)-(\d+)\)(\d+)-(\d+)$/
  return { home, away, ft_home, ft_away }
If hasScores == false:
  return { home, away }  (no scores)
```

If hasScores is true but no score line follows → skip (match hasn't finished yet).

## Files

- `collector.mjs` — complete application
- `package.json` — `{ "type": "module", "dependencies": { "playwright": "^1.52.0" } }`
- `Dockerfile` — `FROM mcr.microsoft.com/playwright:focal`, copies app, CMD via entrypoint
- `entrypoint.sh` — creates `/app/data`, seeds from `/app/data-backup` if exists
- `railway.toml` — single web service, port 8080, build from Dockerfile
- `.dockerignore` / `.gitignore`

## Deployment
1. `git push` to `Omahemarwa/virtual-predictor-collector`
2. Railway: New Project → Deploy from GitHub repo
3. Add volume at `/app/data` (persistent storage)
4. Deploy — auto-starts immediately

## Start Execution Now
All requirements finalized. Build `collector.mjs` with the spec above, update all supporting files, and commit.
