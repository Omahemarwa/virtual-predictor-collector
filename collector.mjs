import { firefox } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';

const DATA_DIR = '/app/data';
const RESULTS_CSV = path.join(DATA_DIR, 'results.csv');
const UPCOMING_CSV = path.join(DATA_DIR, 'upcoming.csv');
const PREDICTIONS_CSV = path.join(DATA_DIR, 'predictions.csv');
const COLLECT_LOG = path.join(DATA_DIR, 'collect_log.txt');

const RESULTS_HEADER = 'season_id,matchday,league,home_team,away_team,ft_home,ft_away';
const UPCOMING_HEADER = 'season_id,matchday,league,row,home_team,away_team';
const PREDICTIONS_HEADER = 'season_id,matchday,league,row,home_team,away_team,market,pct';

const LEAGUES = [
  { name: 'English', leagueId: '7794' },
  { name: 'Spanish', leagueId: '7795' },
];

const DASHBOARD_URL = 'https://virtualpredictor-production.up.railway.app/data';

let currentSeasonId = null;
let currentMatchday = null;
let rescanMutex = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(COLLECT_LOG, line + '\n'); } catch (e) {}
}

function readCSV(filePath, header) {
  const rows = [];
  const keySet = new Set();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length <= 1) return { rows, keySet };
    const headers = lines[0].split(',');
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const obj = {};
      headers.forEach((h, idx) => obj[h] = vals[idx] || '');
      rows.push(obj);
    }
  } catch (e) {}
  return { rows, keySet };
}

function writeCSV(filePath, header, rows) {
  const lines = [header];
  for (const row of rows) {
    const vals = header.split(',').map(h => row[h] || '');
    lines.push(vals.join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function getResultKey(row) {
  return `${row.season_id}-${row.matchday}-${row.league}-${row.home_team}-${row.away_team}`;
}

function getUpcomingKey(row) {
  return `${row.season_id}-${row.matchday}-${row.league}-${row.row}`;
}

function getPredictionKey(row) {
  return `${row.season_id}-${row.matchday}-${row.league}-${row.row}-${row.market}`;
}

function parseMatchLines(text, hasScores) {
  const matches = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  let i = 0;
  while (i < lines.length) {
    const teamMatch = lines[i].match(/^([A-Z]{3})\s*-\s*([A-Z]{3})$/);
    if (teamMatch && i + 1 < lines.length) {
      const home = teamMatch[1];
      const away = teamMatch[2];
      if (hasScores) {
        const scoreMatch = lines[i + 1].match(/^\((\d+)\s*-\s*(\d+)\)(\d+)\s*-\s*(\d+)$/);
        if (scoreMatch) {
          matches.push({
            home, away,
            ft_home: parseInt(scoreMatch[3]),
            ft_away: parseInt(scoreMatch[4])
          });
          i += 2;
          continue;
        }
      } else {
        matches.push({ home, away });
        i++;
        continue;
      }
    }
    i++;
  }
  return matches;
}

async function detectSeasonId(page) {
  // Method 1: matchday/0 redirect
  try {
    await page.goto('https://www.betpawa.co.tz/virtual-sports/matchday/0?matchday=1&leagueId=7794', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await page.waitForTimeout(4000);
    const m = page.url().match(/\/matchday\/(\d{5,})/);
    if (m) return m[1];
    log(`Method 1: URL after redirect: ${page.url()}`);
  } catch (e) { log('Method 1 error: ' + e.message); }

  // Method 2: try upcoming tab and extract from league links or page content
  try {
    await page.goto('https://www.betpawa.co.tz/virtual-sports?virtualTab=upcoming', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await page.waitForTimeout(4000);
    const text = await page.innerText('body');
    // Look for season ID in page text (e.g., "Season 138444" or similar)
    const m = text.match(/Season\s*(\d{5,})/i) || text.match(/season[_-]?(\d{5,})/i) || text.match(/(\d{5,})\s*[-–]\s*20/);
    if (m) return m[1];
    // Check if any links contain season IDs
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => a.href));
    for (const href of hrefs) {
      const m2 = href.match(/\/matchday\/(\d{5,})/);
      if (m2) return m2[1];
    }
    log(`Method 2: No season found in upcoming tab`);
  } catch (e) { log('Method 2 error: ' + e.message); }

  // Method 3: try the results tab season dropdown
  try {
    await page.goto('https://www.betpawa.co.tz/virtual-sports?virtualTab=results&resultsTab=matches', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await page.waitForTimeout(4000);
    const seasons = await page.evaluate(() => {
      const sel = document.querySelector('[data-test-id="auto-matches-results-select"] select');
      if (!sel) return [];
      return Array.from(sel.options).map(o => o.value);
    });
    if (seasons.length) return seasons[0];
  } catch (e) { log('Method 3 error: ' + e.message); }

  // Fallback: use a known recent season (will be updated on next successful run)
  log('All methods failed, using fallback season 138444');
  return '138444';
}

function extractMatchday(text) {
  const m = text.match(/Matchday\s*(\d+)/i);
  if (m) return parseInt(m[1]);
  return null;
}

async function scrapeBetPawa(page, seasonId) {
  const liveResults = [];
  const upcomingMatches = [];

  // 1. Upcoming tab first (required for Live tab to render correctly)
  try {
    await page.goto('https://www.betpawa.co.tz/virtual-sports?virtualTab=upcoming', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await page.waitForTimeout(3000);
  } catch (e) {
    log('Upcoming tab load error: ' + e.message);
  }

  // 2. Get matchday from upcoming page
  const pageText = await page.innerText('body');
  const md = extractMatchday(pageText);
  if (md) currentMatchday = md;

  // 3. Scrape upcoming for each league
  for (const { name: league, leagueId } of LEAGUES) {
    try {
      // Try clicking the league tab or using URL param
      const leagueTab = await page.$(`[data-test-id*="${leagueId}"]`) || await page.$(`button:has-text("${league}")`) || await page.$(`a:has-text("${league}")`);
      if (leagueTab) {
        await leagueTab.click();
        await page.waitForTimeout(1500);
      }
      const text = await page.innerText('body');
      const matches = parseMatchLines(text, false);
      let row = 1;
      for (const m of matches) {
        upcomingMatches.push({
          season_id: seasonId,
          matchday: currentMatchday || '',
          league,
          row: row++,
          home_team: m.home,
          away_team: m.away
        });
      }
      log(`Upcoming ${league}: ${matches.length} matches`);
    } catch (e) {
      log(`Upcoming ${league} error: ${e.message}`);
    }
  }

  // 4. Now activate Live tab
  try {
    const liveTab = await page.$('[data-test-id*="live"]') || await page.$('button:has-text("Live")') || await page.$('a:has-text("Live")');
    if (liveTab) {
      await liveTab.click();
      await page.waitForTimeout(3000);
    } else {
      // Try direct navigation if tab click fails
      await page.goto('https://www.betpawa.co.tz/virtual-sports?virtualTab=live', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
    }
  } catch (e) {
    log('Live tab activation error: ' + e.message);
  }

  // 5. Scrape live results for each league
  for (const { name: league, leagueId } of LEAGUES) {
    try {
      const leagueTab = await page.$(`[data-test-id*="${leagueId}"]`) || await page.$(`button:has-text("${league}")`) || await page.$(`a:has-text("${league}")`);
      if (leagueTab) {
        await leagueTab.click();
        await page.waitForTimeout(1500);
      }
      const text = await page.innerText('body');
      const matches = parseMatchLines(text, true);
      for (const m of matches) {
        liveResults.push({
          season_id: seasonId,
          matchday: currentMatchday || '',
          league,
          home_team: m.home,
          away_team: m.away,
          ft_home: m.ft_home,
          ft_away: m.ft_away
        });
      }
      log(`Live ${league}: ${matches.length} results`);
    } catch (e) {
      log(`Live ${league} error: ${e.message}`);
    }
  }

  return { liveResults, upcomingMatches };
}

async function fetchPredictions() {
  try {
    const resp = await fetch(DASHBOARD_URL);
    if (!resp.ok) { log(`Predictions fetch failed: HTTP ${resp.status}`); return []; }
    const data = await resp.json();
    if (!Array.isArray(data)) { log('Predictions: unexpected response format'); return []; }
    return data;
  } catch (e) {
    log(`Predictions fetch error: ${e.message}`);
    return [];
  }
}

async function savePredictions(predictions) {
  if (!currentSeasonId || !currentMatchday) return;
  const { rows: existing } = readCSV(PREDICTIONS_CSV, PREDICTIONS_HEADER);
  const keySet = new Set(existing.map(getPredictionKey));
  let updated = 0, added = 0;

  for (const p of predictions) {
    const row = {
      season_id: currentSeasonId,
      matchday: currentMatchday,
      league: p.league,
      row: p.row,
      home_team: p.team1,
      away_team: p.team2,
      market: p.market,
      pct: p.pct
    };
    const key = getPredictionKey(row);
    const existingIdx = existing.findIndex(r => getPredictionKey(r) === key);
    if (existingIdx >= 0) {
      existing[existingIdx] = row;
      updated++;
    } else {
      existing.push(row);
      added++;
    }
  }
  writeCSV(PREDICTIONS_CSV, PREDICTIONS_HEADER, existing);
  if (updated + added > 0) log(`Predictions: +${added} updated ${updated}`);
}

async function saveResults(liveResults) {
  if (!currentSeasonId || !currentMatchday) return;
  const { rows: existing } = readCSV(RESULTS_CSV, RESULTS_HEADER);
  let updated = 0, added = 0;

  for (const r of liveResults) {
    const key = getResultKey(r);
    const existingIdx = existing.findIndex(x => getResultKey(x) === key);
    if (existingIdx >= 0) {
      existing[existingIdx] = r;
      updated++;
    } else {
      existing.push(r);
      added++;
    }
  }
  writeCSV(RESULTS_CSV, RESULTS_HEADER, existing);
  if (updated + added > 0) log(`Results: +${added} updated ${updated}`);
}

async function saveUpcoming(upcomingMatches) {
  if (!currentSeasonId || !currentMatchday) return;
  const { rows: existing } = readCSV(UPCOMING_CSV, UPCOMING_HEADER);
  let updated = 0, added = 0;

  for (const m of upcomingMatches) {
    const key = getUpcomingKey(m);
    const existingIdx = existing.findIndex(x => getUpcomingKey(x) === key);
    if (existingIdx >= 0) {
      existing[existingIdx] = m;
      updated++;
    } else {
      existing.push(m);
      added++;
    }
  }
  writeCSV(UPCOMING_CSV, UPCOMING_HEADER, existing);
  if (updated + added > 0) log(`Upcoming: +${added} updated ${updated}`);
}

async function collectAll() {
  try { fs.writeFileSync(COLLECT_LOG, ''); } catch (e) {}
  log('=== COLLECTION START ===');

  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0' });

  // Detect season
  currentSeasonId = await detectSeasonId(page);
  if (!currentSeasonId) {
    log('FATAL: could not detect season');
    await browser.close();
    return;
  }
  log(`Season: ${currentSeasonId}`);

  // Scrape live + upcoming
  const { liveResults, upcomingMatches } = await scrapeBetPawa(page, currentSeasonId);
  await browser.close();

  // Save
  await saveResults(liveResults);
  await saveUpcoming(upcomingMatches);

  // Fetch predictions
  const predictions = await fetchPredictions();
  await savePredictions(predictions);

  log('=== COLLECTION COMPLETE ===');
}

function filterRows(rows, url) {
  let data = [...rows];
  if (url.searchParams.get('season_id')) data = data.filter(r => r.season_id === url.searchParams.get('season_id'));
  if (url.searchParams.get('matchday')) data = data.filter(r => r.matchday === url.searchParams.get('matchday'));
  if (url.searchParams.get('league')) data = data.filter(r => (r.league || '').toLowerCase() === url.searchParams.get('league').toLowerCase());
  data.sort((a, b) => b.season_id.localeCompare(a.season_id, void 0, { numeric: true }) || b.matchday - a.matchday);
  return data;
}

function csvEndpoint(filePath, header) {
  return (req, res, url) => {
    const { rows } = readCSV(filePath, header);
    const filtered = filterRows(rows, url);
    const offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit')) || 100), 500);
    const page = filtered.slice(offset, offset + limit);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ headers: header.split(','), rows: filtered.length, offset, limit, page }));
  };
}

function startServer(port) {
  const getResults = csvEndpoint(RESULTS_CSV, RESULTS_HEADER);
  const getUpcoming = csvEndpoint(UPCOMING_CSV, UPCOMING_HEADER);
  const getPredictions = csvEndpoint(PREDICTIONS_CSV, PREDICTIONS_HEADER);

  http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (p === '/collect-log') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      try { res.end(fs.readFileSync(COLLECT_LOG, 'utf-8')); } catch (e) { res.end(''); }
      return;
    }

    if (p === '/csv/results.csv') { getResults(req, res, url); return; }
    if (p === '/csv/upcoming.csv') { getUpcoming(req, res, url); return; }
    if (p === '/csv/predictions.csv') { getPredictions(req, res, url); return; }

    if (p === '/view' || p.startsWith('/view/')) {
      const name = p === '/view' ? '' : path.basename(p);
      const valid = ['results', 'upcoming', 'predictions'];
      res.writeHead(200, { 'Content-Type': 'text/html' });

      if (!name) {
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data Viewer</title><style>body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;max-width:600px;margin:40px auto;padding:0 20px}a{color:#58a6ff;text-decoration:none;display:block;padding:12px;background:#161b22;border-radius:6px;margin:8px 0;font-size:16px}h1{color:#f0f6fc}</style></head><body><h1>Data Viewer</h1>${valid.map(n => `<a href="/view/${n}">${n.charAt(0).toUpperCase() + n.slice(1)}</a>`).join('')}</body></html>`);
        return;
      }

      if (!valid.includes(name)) { res.writeHead(302, { Location: '/view' }); res.end(); return; }

      const isResults = name === 'results';
      const isUpcoming = name === 'upcoming';
      const csvName = name + '.csv';

      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name.charAt(0).toUpperCase() + name.slice(1)}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;font-size:13px}
.nav{background:#161b22;border-bottom:1px solid #30363d;padding:10px 16px;display:flex;gap:14px;align-items:center}
.nav h2{font-size:15px;color:#f0f6fc;font-weight:600}
.nav a{color:#58a6ff;text-decoration:none;font-size:12px}
.filters{padding:8px 16px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #21262d}
.filters input,.filters select{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:5px 8px;color:#c9d1d9;font-size:12px}
.filters input:focus{border-color:#58a6ff;outline:none}
.btn{padding:5px 14px;border:none;border-radius:5px;cursor:pointer;font-size:12px;background:#238636;color:#fff}
.btn:hover{background:#2ea043}
.clear{color:#8b949e;font-size:11px;cursor:pointer;padding:5px}
.clear:hover{color:#58a6ff}
.stats{padding:8px 16px;font-size:12px;color:#8b949e;border-bottom:1px solid #21262d}
.stats .pg{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px;margin-left:4px}
.stats .pg:disabled{opacity:.4;cursor:default}
.wrap{overflow-x:auto;padding:8px}
table{border-collapse:collapse;font-size:12px;white-space:nowrap;width:100%}
th{background:#161b22;color:#f0f6fc;padding:8px 10px;text-align:left;border-bottom:2px solid #30363d;position:sticky;top:0}
td{padding:6px 10px;border-bottom:1px solid #21262d}
tr:hover td{background:#161b22}
.log-panel{background:#0d1117;border:1px solid #30363d;border-radius:6px;margin:10px 16px;display:none;max-height:300px;overflow-y:auto}
.log-panel.show{display:block}
.log-header{background:#161b22;padding:8px 12px;border-bottom:1px solid #30363d;font-size:12px;font-weight:600;color:#f0f6fc}
.log-body{font-family:monospace;font-size:11px;color:#8b949e;padding:8px 12px;white-space:pre-wrap;line-height:1.6}
</style></head><body>
<div class="nav"><h2>${name.charAt(0).toUpperCase() + name.slice(1)}</h2><a href="/view">Tables</a></div>
${(isResults || isUpcoming) ? '<div class="filters"><input id="fSeason" placeholder="Season" size="8"><input id="fMD" placeholder="MD" size="4"><select id="fLeague"><option value="">All</option><option value="English">English</option><option value="Spanish">Spanish</option></select><button class="btn" onclick="applyF()">Apply</button><span class="clear" onclick="clearF()">Clear</span></div><div class="log-panel" id="logPanel"><div class="log-header">Collection Log</div><div class="log-body" id="logBody">Waiting for logs...</div></div>' : ''}
<div class="stats" id="stats">Loading...</div>
<div class="wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
<script>
var csv='${csvName}',off=0,lim=100;
function qs(){var s=location.search.substring(1),o={};s.split('&').forEach(function(p){var kv=p.split('=');if(kv[0])o[kv[0]]=decodeURIComponent(kv[1]||'')});return o}
var params=qs();
function applyF(){
  var s=document.getElementById('fSeason'),m=document.getElementById('fMD'),l=document.getElementById('fLeague');
  var q='?offset=0&limit='+lim;
  if(s&&s.value)q+='&season_id='+encodeURIComponent(s.value);
  if(m&&m.value)q+='&matchday='+encodeURIComponent(m.value);
  if(l&&l.value)q+='&league='+encodeURIComponent(l.value);
  history.replaceState(null,'','/view/'+csv.replace('.csv','')+q);params=qs();load(0);
}
function clearF(){
  var s=document.getElementById('fSeason'),m=document.getElementById('fMD'),l=document.getElementById('fLeague');
  if(s)s.value='';if(m)m.value='';if(l)l.value='';
  history.replaceState(null,'','/view/'+csv.replace('.csv',''));params=qs();load(0);
}
function load(o){off=o;
  var q='?offset='+o+'&limit='+lim;
  if(params.season_id)q+='&season_id='+encodeURIComponent(params.season_id);
  if(params.matchday)q+='&matchday='+encodeURIComponent(params.matchday);
  if(params.league)q+='&league='+encodeURIComponent(params.league);
  fetch('/csv/'+csv+q).then(function(r){return r.json()}).then(function(d){
    if(d.rows===0){document.getElementById('stats').textContent='0 rows';document.getElementById('thead').innerHTML='';document.getElementById('tbody').innerHTML='<tr><td style="text-align:center;padding:40px;color:#8b949e">No data</td></tr>';return}
    var s=d.offset+1,e=d.offset+d.page.length;
    document.getElementById('stats').innerHTML=d.rows+' rows | showing '+s+'-'+e+' <button class="pg" onclick="load(off-'+lim+')" '+(o===0?'disabled':'')+'>&larr; Prev</button><button class="pg" onclick="load(off+'+lim+')" '+(e>=d.rows?'disabled':'')+'>Next &rarr;</button>';
    document.getElementById('thead').innerHTML='<tr>'+d.headers.map(function(c){return '<th>'+c+'</th>'}).join('')+'</tr>';
    document.getElementById('tbody').innerHTML=d.page.map(function(r){return '<tr>'+d.headers.map(function(h){return '<td>'+(r[h]||'')+'</td>'}).join('')+'</tr>'}).join('');
  }).catch(function(){document.getElementById('stats').textContent='Error'})}
if(document.getElementById('fSeason')){document.getElementById('fSeason').value=params.season_id||'';document.getElementById('fMD').value=params.matchday||'';document.getElementById('fLeague').value=params.league||''}
load(0);
${(isResults || isUpcoming) ? 'setInterval(function(){fetch("/collect-log").then(function(r){return r.text()}).then(function(t){if(t){var b=document.getElementById("logBody");b.textContent=t;b.scrollTop=b.scrollHeight;document.getElementById("logPanel").classList.add("show")}}).catch(function(){})},2000);' : ''}
</script></body></html>`);
      return;
    }

    res.writeHead(404); res.end('Not found');
  }).listen(port, () => {
    log(`Server running on port ${port}`);
  });
}

// ─── Main ───
const args = process.argv.slice(2);
if (args.includes('--serve')) {
  const idx = args.indexOf('--serve');
  const port = parseInt(process.env.PORT || args[idx + 1] || '3000', 10);
  startServer(port);

  // Initial collect
  collectAll().catch(e => log('Collect error: ' + e.message));

  // 10-second prediction polling
  setInterval(async () => {
    const predictions = await fetchPredictions();
    if (predictions.length > 0) await savePredictions(predictions);
  }, 10000);

  // 5-minute full re-scan with mutex
  setInterval(() => {
    if (rescanMutex) { log('Re-scan skipped (mutex)'); return; }
    rescanMutex = true;
    collectAll().catch(e => log('Collect error: ' + e.message)).finally(() => { rescanMutex = false; });
  }, 300000);
} else {
  collectAll().catch(e => { console.error(e); process.exit(1); });
}