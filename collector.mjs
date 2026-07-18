import { firefox } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';

const DATA_DIR = '/app/data';
const RESULTS_CSV = path.join(DATA_DIR, 'results.csv');
const PREDICTIONS_CSV = path.join(DATA_DIR, 'predictions.csv');
const COLLECT_LOG = path.join(DATA_DIR, 'collect_log.txt');

const RESULTS_HEADER = 'season_id,matchday,league,home_team,away_team,ft_home,ft_away';
const PREDICTIONS_HEADER = 'season_id,matchday,league,row,home_team,away_team,market,pct';
const LEAGUES = [
  { name: 'English', leagueId: '7794' },
  { name: 'Spanish', leagueId: '7795' },
];
const DASHBOARD_DATA_URL = 'https://virtualpredictor-production.up.railway.app/data';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(COLLECT_LOG, line + '\n'); } catch (e) {}
}

function parseResultsFromText(text) {
  const matches = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  let i = 0;
  while (i < lines.length) {
    const tm = lines[i].match(/^([A-Za-z0-9\s'-]+)\s*-\s*([A-Za-z0-9\s'-]+)$/);
    if (tm && i + 1 < lines.length) {
      const sc = lines[i + 1].match(/^\((\d+)\s*-\s*(\d+)\)(\d+)\s*-\s*(\d+)$/);
      if (sc) {
        matches.push({
          home: tm[1].trim(), away: tm[2].trim(),
          ft_home: parseInt(sc[3]), ft_away: parseInt(sc[4]),
        });
        i += 2; continue;
      }
    }
    i++;
  }
  return matches;
}

function appendCSV(filePath, header, rows, existingKeys, keyFn) {
  if (rows.length === 0) return;
  const hn = !fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8').trim().length === 0;
  const newRows = rows.filter(r => {
    const k = keyFn(r);
    if (existingKeys.has(k)) return false;
    existingKeys.add(k);
    return true;
  });
  if (newRows.length === 0) return;
  fs.appendFileSync(filePath, (hn ? header + '\n' : '') + newRows.join('\n') + '\n');
}

async function fetchPredictions() {
  try {
    const resp = await fetch(DASHBOARD_DATA_URL);
    if (!resp.ok) { log(`Predictions fetch failed: HTTP ${resp.status}`); return []; }
    const data = await resp.json();
    if (!Array.isArray(data)) { log('Predictions: unexpected response format'); return []; }
    log(`Fetched ${data.length} predictions from dashboard`);
    return data;
  } catch (e) {
    log(`Predictions fetch error: ${e.message}`);
    return [];
  }
}

async function detectCurrentSeason(page) {
  try {
    await page.goto('https://www.betpawa.co.tz/virtual-sports/matchday/0?matchday=1&leagueId=7794',
      { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const m = page.url().match(/\/matchday\/(\d{5,})/);
    if (m) return m[1];
  } catch (e) { log('Season detection error: ' + e.message); }
  return null;
}

async function getAvailableSeasons(page) {
  try {
    await page.goto('https://www.betpawa.co.tz/virtual-sports?virtualTab=results&resultsTab=matches',
      { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const seasons = await page.evaluate(() => {
      const sel = document.querySelector('[data-test-id="auto-matches-results-select"] select');
      if (!sel) return [];
      return Array.from(sel.options).map(o => o.value);
    });
    return seasons;
  } catch (e) { log('Season list error: ' + e.message); return []; }
}

async function collectAll() {
  try { fs.writeFileSync(COLLECT_LOG, ''); } catch (e) {}
  log('=== AUTO COLLECTION START ===');

  // Load existing data for dedup
  const existingResults = new Set();
  try {
    const c = fs.readFileSync(RESULTS_CSV, 'utf-8');
    c.trim().split('\n').slice(1).forEach(l => {
      const p = l.split(',');
      if (p.length >= 3) existingResults.add(`${p[0]}-${p[1]}-${p[2]}`);
    });
  } catch (e) {}
  log(`Existing results: ${existingResults.size} entries`);

  const existingPredictions = new Set();
  try {
    const c = fs.readFileSync(PREDICTIONS_CSV, 'utf-8');
    c.trim().split('\n').slice(1).forEach(l => {
      const p = l.split(',');
      if (p.length >= 5) existingPredictions.add(`${p[0]}-${p[1]}-${p[2]}-${p[3]}-${p[4]}`);
    });
  } catch (e) {}
  log(`Existing predictions: ${existingPredictions.size} entries`);

  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0' });

  // Detect current season
  const currentSeason = await detectCurrentSeason(page);
  if (!currentSeason) { log('FATAL: could not detect current season'); await browser.close(); return; }
  log(`Current season: ${currentSeason}`);

  // Get available seasons
  const availableSeasons = await getAvailableSeasons(page);
  if (availableSeasons.length === 0) {
    log('No seasons available from betPawa, using current season only');
    availableSeasons.push(currentSeason);
  }
  log(`Available seasons: ${availableSeasons[0]} → ${availableSeasons[availableSeasons.length - 1]} (${availableSeasons.length} seasons)`);

  // Collect results for each season
  let totalResults = 0;
  for (const sid of availableSeasons) {
    let seasonTotal = 0;
    for (let md = 1; md <= 34; md++) {
      let foundAny = false;
      for (const { name: league, leagueId: lid } of LEAGUES) {
        const key = `${sid}-${md}-${league}`;
        if (existingResults.has(key)) { foundAny = true; continue; }
        let matches = [];
        try {
          await page.goto(`https://www.betpawa.co.tz/virtual-sports/matchday/${sid}?matchday=${md}&leagueId=${lid}`,
            { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
          matches = parseResultsFromText(await page.innerText('body'));
        } catch (e) {}
        if (matches.length === 0) continue;
        const newRows = matches.map(m => `${sid},${md},${league},${m.home},${m.away},${m.ft_home},${m.ft_away}`);
        appendCSV(RESULTS_CSV, RESULTS_HEADER, newRows, existingResults, r => `${sid}-${md}-${league}`);
        seasonTotal += matches.length;
        totalResults += matches.length;
        foundAny = true;
        log(`  ${league} ${sid} MD ${md}: ${matches.length} results`);
      }
      if (!foundAny && md > 3) break;
    }
    if (seasonTotal > 0) log(`  Season ${sid}: +${seasonTotal} total`);
  }
  log(`Results collection done: ${totalResults} new rows`);

  await browser.close();

  // Collect predictions
  log('Fetching predictions...');
  const predictions = await fetchPredictions();
  if (predictions.length > 0) {
    const newPredRows = predictions.map(p =>
      `${p.season_id || p.seasonId || ''},${p.matchday || p.md || ''},${p.league || ''},${p.row || ''},"${(p.team1 || p.home_team || '').replace(/"/g,'""')}","${(p.team2 || p.away_team || '').replace(/"/g,'""')}",${p.market || ''},${p.pct || ''}`
    );
    appendCSV(PREDICTIONS_CSV, PREDICTIONS_HEADER, newPredRows, existingPredictions,
      r => `${r.split(',')[0]}-${r.split(',')[1]}-${r.split(',')[2]}-${r.split(',')[3]}-${r.split(',')[6]}`
    );
    log(`Predictions: ${newPredRows.length} new rows`);
  }

  log(`=== COLLECTION COMPLETE: ${totalResults} results, ${predictions.length} predictions ===`);
}

// ─── HTTP Server ───
function startServer(port) {
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

    if (p.startsWith('/csv/')) {
      const name = path.basename(p.slice(5));
      const csvPath = path.join(DATA_DIR, name);
      if (!name.endsWith('.csv') || !fs.existsSync(csvPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: 0, page: [] }));
        return;
      }
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.trim().split('\n');
      const headers = lines.length > 0 ? lines[0].split(',') : [];
      let data = lines.length > 1 ? lines.slice(1).map(l => {
        const vals = l.split(',');
        const obj = {};
        headers.forEach((h, i) => obj[h] = vals[i] || '');
        return obj;
      }) : [];

      const fSeason = url.searchParams.get('season_id');
      const fMD = url.searchParams.get('matchday');
      const fLeague = url.searchParams.get('league');
      if (fSeason) data = data.filter(r => r.season_id === fSeason);
      if (fMD) data = data.filter(r => r.matchday === fMD);
      if (fLeague) data = data.filter(r => (r.league || '').toLowerCase() === fLeague.toLowerCase());

      data.sort((a, b) => b.season_id.localeCompare(a.season_id, void 0, { numeric: true }) || b.matchday - a.matchday);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
      const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit')) || 100), 500);
      const page = data.slice(offset, offset + limit);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers, rows: data.length, offset, limit, page }));
      return;
    }

    if (p === '/view' || p.startsWith('/view/')) {
      const name = p === '/view' ? '' : path.basename(p);
      const valid = ['results', 'predictions'];
      res.writeHead(200, { 'Content-Type': 'text/html' });

      if (!name) {
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data Viewer</title><style>body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;max-width:600px;margin:40px auto;padding:0 20px}a{color:#58a6ff;text-decoration:none;display:block;padding:12px;background:#161b22;border-radius:6px;margin:8px 0;font-size:16px}h1{color:#f0f6fc}</style></head><body><h1>Data Viewer</h1>${valid.map(n => `<a href="/view/${n}">${n.charAt(0).toUpperCase() + n.slice(1)}</a>`).join('')}</body></html>`);
        return;
      }

      if (!valid.includes(name)) {
        res.writeHead(302, { Location: '/view' }); res.end();
        return;
      }

      const isResults = name === 'results';
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
${isResults ? '<div class="filters"><input id="fSeason" placeholder="Season" size="8"><input id="fMD" placeholder="MD" size="4"><select id="fLeague"><option value="">All</option><option value="English">English</option><option value="Spanish">Spanish</option></select><button class="btn" onclick="applyF()">Apply</button><span class="clear" onclick="clearF()">Clear</span></div><div class="log-panel" id="logPanel"><div class="log-header">Collection Log</div><div class="log-body" id="logBody">Auto-collecting...</div></div>' : ''}
<div class="stats" id="stats">Loading...</div>
<div class="wrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
<script>
var csv='${name}.csv',off=0,lim=100;
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
${isResults ? 'setInterval(function(){fetch("/collect-log").then(function(r){return r.text()}).then(function(t){if(t){var b=document.getElementById("logBody");b.textContent=t;b.scrollTop=b.scrollHeight;document.getElementById("logPanel").classList.add("show")}}).catch(function(){})},2000);' : ''}
</script></body></html>`);
      return;
    }

    res.writeHead(404); res.end('Not found');
  }).listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`  /health  /view  /csv/results.csv  /csv/predictions.csv  /collect-log`);
  });
}

// ─── Startup ───
const args = process.argv.slice(2);
if (args.includes('--serve')) {
  const idx = args.indexOf('--serve');
  const port = parseInt(process.env.PORT || args[idx + 1] || '3000', 10);
  startServer(port);
  // Auto-collect immediately on startup
  collectAll().catch(e => log('Collect error: ' + e.message));
  // Re-collect every 5 minutes
  setInterval(() => collectAll().catch(e => log('Collect error: ' + e.message)), 300000);
} else {
  collectAll().catch(e => { console.error(e); process.exit(1); });
}
