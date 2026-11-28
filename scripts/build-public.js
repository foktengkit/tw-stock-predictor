/**
 * 公開版（GitHub Pages）建置：把官方盤後資料轉成靜態 JSON，連同前端一起輸出到 dist/
 *   node scripts/build-public.js [--out dist]
 *
 * 公開版只使用官方開放資料（證交所、櫃買中心、公開資訊觀測站），不含即時報價與 Yahoo 資料。
 * 預測模型與技術評等在瀏覽器裡計算（與私人版相同的程式）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, argOf('--out', 'dist'));
const DATA = path.join(OUT, 'data');

const db = require('../lib/official/db');
const official = require('../lib/official/query');
const stocks = require('../lib/stocklist');
const holidays = require('../lib/holidays');
const dividends = require('../lib/dividends');
const heatmap = require('../lib/heatmap');
const factors = require('../lib/factors');
const { fingerprint } = require('../lib/official/fingerprint');

const t0 = Date.now();
const log = (msg) => console.log(`[build ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const writeJson = (rel, obj) => {
  const f = path.join(DATA, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const s = JSON.stringify(obj);
  fs.writeFileSync(f, s);
  return s.length;
};
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const ymd = (iso) => iso.replace(/-/g, '');

// ════════════════════════════════════════════════════════════════
// 1. 前端檔案
// ════════════════════════════════════════════════════════════════
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/**
 * 公開版的資料模組打包成單一檔案（js/static-api.js）：
 * static-api.js + static-data.js + 伺服器端的 predict.js、rating.js（CommonJS 包成函式）。
 * 一個檔案比四個檔案少了「其中一個剛好載入失敗」的機會（GitHub Pages 剛部署完偶爾會回 503）。
 */
function bundleStaticApi() {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const cjs = (name, src, preamble = '') => `const ${name} = (() => {\n${preamble}const module = { exports: {} };\n${src}\nreturn module.exports;\n})();\n`;
  const data = read('public/js/static-data.js').replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, '');
  const api = read('public/js/static-api.js').replace(/^import\s.*;\r?\n/gm, '');
  if (/^import\s/m.test(api)) throw new Error('static-api.js 有無法處理的 import 寫法');
  return [
    '// 自動產生（scripts/build-public.js）：公開版的資料模組，請勿直接修改',
    cjs('predictLib', read('lib/predict.js')),
    cjs('ratingLib', read('lib/rating.js'), 'const require = () => self.TA; // 指標函式庫已由頁面載入成 window.TA\n'),
    data,
    api,
  ].join('\n');
}

function buildFrontend(config) {
  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'public'), OUT);
  fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'), path.join(OUT, 'vendor/lightweight-charts.js'));
  fs.writeFileSync(path.join(OUT, 'js/static-api.js'), bundleStaticApi());
  fs.rmSync(path.join(OUT, 'js/static-data.js')); // 已併入上面的單一檔案
  fs.writeFileSync(path.join(OUT, 'config.js'), `window.TWS_CONFIG = ${JSON.stringify(config)};\n`);
  const indexFile = path.join(OUT, 'index.html');
  const html = fs.readFileSync(indexFile, 'utf8')
    .replace('<script type="module" src="js/app.js"></script>', '<script src="config.js"></script>\n  <script type="module" src="js/app.js"></script>');
  if (!html.includes('config.js')) throw new Error('index.html 找不到 app.js 的 <script>，無法插入設定');
  fs.writeFileSync(indexFile, html);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
}

// ════════════════════════════════════════════════════════════════
// 2. 資料
// ════════════════════════════════════════════════════════════════
async function main() {
  const dataDate = (db.get("SELECT MAX(date) d FROM daily WHERE market = 'tse'") || {}).d;
  if (!dataDate) throw new Error('資料庫沒有每日行情，請先執行同步');
  const config = { static: true, dataDate, builtAt: new Date().toISOString() };
  buildFrontend(config);
  log(`前端完成；資料日期 ${dataDate}`);

  // 先載入上一次成功的清單（存在 data/，雲端由 Actions 快取保存）：證交所偶爾回傳錯誤格式時可以沿用
  stocks.loadCache();
  await stocks.refresh();
  const list = stocks.all();
  const byCode = new Map(list.map((s) => [s.code, s]));
  // 清單取得失敗或只拿到一個市場時中止：建置失敗就不會發布，網站維持前一版，而不是變成空白
  const nTse = list.filter((s) => s.market === 'tse' && s.type === 'stock').length;
  const nOtc = list.filter((s) => s.market === 'otc' && s.type === 'stock').length;
  if (nTse < 1000 || nOtc < 700) throw new Error(`股票清單不完整（上市 ${nTse}、上櫃 ${nOtc} 檔），中止建置`);
  log(`股票清單 ${list.length} 檔（上市 ${nTse}、上櫃 ${nOtc}）`);

  // 除權息（還原權息與「參考價」用）
  const exByCode = new Map();
  for (const r of db.open().prepare('SELECT date, code, prev_close, ref_price FROM exright WHERE prev_close > 0 AND ref_price > 0 ORDER BY date').iterate()) {
    if (!exByCode.has(r.code)) exByCode.set(r.code, []);
    exByCode.get(r.code).push([r.date, Math.round((r.ref_price / r.prev_close) * 1e6) / 1e6, r.ref_price]);
  }

  // ---- 每檔 K 線（逐列串流，依代號分組寫檔） ----
  const quotes = {};
  const lastValue = new Map(); // 熱力圖用的成交金額
  let files = 0, bytes = 0;
  const flush = (code, market, rows) => {
    const s = byCode.get(code);
    if (!s || !rows.length) return;
    const ex = (exByCode.get(code) || []).filter((e) => e[0] >= rows[0][0]);
    bytes += writeJson(`k/${code}.json`, {
      code, name: s.name, market, type: s.type,
      volSrc: market === 'tse' ? 'official' : 'boardlot',
      rows, ex: ex.map((e) => [e[0], e[1]]),
    });
    files++;
    const last = rows[rows.length - 1], prevRow = rows[rows.length - 2];
    // 漲跌以「參考價」計算：除權息當天的參考價不是前一天收盤價
    const exToday = ex.find((e) => e[0] === last[0]);
    const prev = exToday ? exToday[2] : prevRow ? prevRow[4] : null;
    quotes[code] = makeQuote(s, market, last, prev);
  };
  let cur = null, curMarket = null, rows = [];
  const it = db.open().prepare('SELECT date, code, market, open, high, low, close, volume, value FROM daily WHERE close > 0 ORDER BY code, date').iterate();
  for (const r of it) {
    if (r.code !== cur) { if (cur) flush(cur, curMarket, rows); cur = r.code; curMarket = r.market; rows = []; }
    rows.push([r.date, r.open ?? r.close, r.high ?? r.close, r.low ?? r.close, r.close, Math.round((r.volume || 0) / 1000)]);
    if (r.date === dataDate) lastValue.set(r.code, r.value);
  }
  if (cur) flush(cur, curMarket, rows);
  log(`個股 K 線 ${files} 檔，${(bytes / 1e6).toFixed(1)} MB`);

  // ---- 指數 ----
  for (const code of ['t00', 'o00']) {
    const ir = db.all('SELECT date, open, high, low, close FROM index_daily WHERE code = ? ORDER BY date', code)
      .map((r) => [r.date, r.open ?? r.close, r.high ?? r.close, r.low ?? r.close, r.close, 0]);
    if (!ir.length) { log(`⚠ 沒有 ${code} 指數資料`); continue; }
    const s = byCode.get(code);
    writeJson(`k/${code}.json`, { code, name: s.name, market: s.market, type: 'index', volSrc: null, rows: ir, ex: [] });
    quotes[code] = makeQuote(s, s.market, ir[ir.length - 1], ir.length > 1 ? ir[ir.length - 2][4] : null);
  }
  writeJson('quotes.json', quotes);
  writeJson('stocks.json', list.filter((s) => quotes[s.code]).map((s) => [s.code, s.name, s.market, s.type]));
  log(`報價 ${Object.keys(quotes).length} 檔`);

  // ---- 籌碼與營收 ----
  let chipFiles = 0;
  for (const s of list) {
    if (s.type !== 'stock' || !/^\d{4}$/.test(s.code) || !quotes[s.code]) continue;
    const c = official.chips(s.code);
    if (!c.inst.length && !c.margin.length && !c.revenue.length) continue;
    writeJson(`chips/${s.code}.json`, c);
    chipFiles++;
  }
  log(`籌碼・營收 ${chipFiles} 檔`);

  // ---- 因子檢驗 ----
  const rep = factors.computeReport();
  if (rep) writeJson('factors.json', rep);
  log(`因子檢驗${rep ? `完成（${rep.seconds.toFixed(1)} 秒）` : '：資料不足，略過'}`);

  // ---- 熱力圖（台灣 50 主要成分股） ----
  writeJson('heatmap.json', heatmap.CODES.filter((c) => quotes[c]).map((c) => ({
    code: c, name: quotes[c].name, sector: heatmap.SECTOR_OF[c], price: quotes[c].price, changePct: quotes[c].changePct,
    value: lastValue.get(c) ?? (quotes[c].price || 0) * (quotes[c].volume || 0) * 1000,
  })));

  // ---- 休市日曆（預測日期要跳過休市日） ----
  await holidays.init();
  await holidays.refreshOfficial().catch((e) => log(`⚠ 休市日曆更新失敗，用快取：${e.message}`));
  const closed = {};
  for (const h of holidays.upcoming(430)) closed[h.date] = { name: h.name, estimated: !!h.estimated, source: h.source, sourceLabel: h.sourceLabel };
  writeJson('calendar.json', { closed, ...holidays.info() });

  // ---- 已公告的除權息（預測期間扣除股利用） ----
  await dividends.refresh();
  const div = {};
  for (const code of Object.keys(quotes)) {
    const ev = dividends.upcoming(code, dataDate, '9999-12-31');
    if (ev.length) div[code] = ev;
  }
  writeJson('dividends.json', div);
  log(`休市日曆、除權息預告（${Object.keys(div).length} 檔）完成`);

  // dataFingerprint、commit：下次排程用來判斷「有沒有新資料、線上是不是目前的程式」（scripts/check-new-data.js）
  writeJson('meta.json', {
    ...config, dataFingerprint: fingerprint(), commit: process.env.GITHUB_SHA || null,
    coverage: official.coverage(), files: { candles: files, chips: chipFiles },
  });
  log(`完成：${OUT}`);
}

function makeQuote(s, market, last, prev) {
  const [date, open, high, low, close, volume] = last;
  const change = prev != null ? r2(close - prev) : null;
  return {
    code: s.code, name: s.name, fullName: s.name, market, isIndex: s.type === 'index',
    price: close, prev, open, high, low, volume: s.type === 'index' ? null : volume,
    change, changePct: prev ? r2(((close - prev) / prev) * 100) : null,
    limitUp: null, limitDown: null, bids: [], asks: [],
    date: ymd(date), time: '13:30:00', static: true,
  };
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
