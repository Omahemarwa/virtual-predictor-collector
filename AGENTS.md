# Virtual Predictor Collector — AI Build Command

## Objective
A self-contained data collection service that runs on Railway, auto-detects seasons from betPawa, collects match results for English + Spanish leagues, scrapes predictions from the dashboard URL, and saves everything to CSV.

## Architecture
- Single `collector.mjs` file with HTTP server + scraping logic
- Playwright (Firefox) for browser automation
- Railway deploy with Docker

## On Startup (auto, no buttons)
1. Detect current season from betPawa (`/matchday/0?matchday=1&leagueId=7794` redirect)
2. Scrape betPawa's season dropdown for all available seasons
3. For each season (oldest → newest), collect all 34 matchdays for English + Spanish
4. Scrape predictions from `https://virtualpredictor-production.up.railway.app/data`
5. Save to CSVs with dedup
6. Re-run every 5 minutes

## CSV Formats
- `results.csv`: season_id, matchday, league, home_team, away_team, ft_home, ft_away
- `predictions.csv`: season_id, matchday, league, row, home_team, away_team, market, pct

## Dedup Keys
- results: season_id + matchday + league
- predictions: season_id + matchday + league + row + market

## Files
- `collector.mjs` — main application
- `package.json` — Node.js deps (playwright)
- `Dockerfile` — Playwright Docker image
- `entrypoint.sh` — seeds /app/data from /app/data-backup
- `railway.toml` — single web service, port 8080
- `.dockerignore` / `.gitignore`

## Endpoints
- `/health` — health check
- `/csv/results.csv` — JSON with filters (season_id, matchday, league, offset, limit)
- `/csv/predictions.csv` — same
- `/collect-log` — plain text log
- `/view` — HTML data viewer

## Railway Setup
1. Connect GitHub repo `virtual-predictor-collector`
2. Mount volume at `/app/data`
3. Deploy — auto-collects immediately on start
