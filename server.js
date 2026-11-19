const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const stocks = require('./lib/stocklist');
const mis = require('./lib/twse');
const yahoo = require('./lib/yahoo');
const { forecast } = require('./lib/predict');
const { technicalRating } = require('./lib/rating');
const { marketStatus } = require('./lib/market');
const heatmap = require('./lib/heatmap');
const holidays = require('./lib/holidays');
const closureWatch = require('./lib/closure-watch');
const dividends = require('./lib/dividends');
const official = require('./lib/official/query');
const officialSync = require('./lib/official/sync');
const factors = require('./lib/factors-service'); // 因子檢驗在背景執行緒計算

const PORT = Number(process.env.PORT) || 3000;
const INDEX_CODES = ['t00', 'o00'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/lightweight-charts.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'));
});

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.message || '伺服器錯誤' });
  });

const normCode = (c) => String(c || '').trim().toUpperCase().replace(/^T00$/, 't00').replace(/^O00$/, 'o00');

async function resolve(code) {
  code = normCode(code);
  if (!code) throw Object.assign(new Error('缺少股票代號'), { status: 400 });
  let entry = stocks.get(code);
  if (!entry && /^[0-9A-Z]{4,6}$/.test(code)) {
    entry = await mis.probe(code).catch(() => null);
    if (entry) stocks.add(entry);
  }
  if (!entry) throw Object.assign(new Error(`找不到代號 ${code}`), { status: 404 });
  return entry;
}

let lastIndexDate = null;
const status = () => marketStatus(lastIndexDate);

/**
 * 日 K 的最後一天以證交所即時報價為準：
 * Yahoo 在盤中或半夜常有「當天那根收盤價為空」的情況，會被過濾掉，導致少一天。
 */
async function getDaily(entry) {
  const { candles, meta } = await yahoo.getHistory(entry, 'D');
  const q = (await mis.getQuotes([entry]).catch(() => ({})))[entry.code];
  if (!q || q.price == null || q.open == null || q.high == null || q.low == null || !/^\d{8}$/.test(q.date || '')) return { candles, meta };
  const date = `${q.date.slice(0, 4)}-${q.date.slice(4, 6)}-${q.date.slice(6, 8)}`;
  const last = candles[candles.length - 1];
  if (last && date < last.time) return { candles, meta };
  // 08:30–09:00 試撮價不是真實成交，不能寫進日 K
  if ((Math.floor(q.ts / 1000) + 8 * 3600) % 86400 < 9 * 3600) return { candles, meta };
  // 成交量：MIS 與 Yahoo 的統計口徑不同（MIS 較少）。同一天以 Yahoo 為準，與歷史 K 棒一致；
  // Yahoo 還沒有這一天時才用 MIS
  const sameDay = last && last.time === date;
  const volume = sameDay ? Math.max(last.volume || 0, q.volume || 0) : q.volume ?? 0;
  const bar = { time: date, open: q.open, high: Math.max(q.high, q.price), low: Math.min(q.low, q.price), close: q.price, volume };
  if (sameDay && last.adjClose > 0 && Math.abs(last.close - q.price) < 1e-9) bar.adjClose = last.adjClose;
  const out = candles.slice();
  if (last && last.time === date) out[out.length - 1] = bar;
  else out.push(bar);
  return { candles: out, meta };
}

/**
 * 成交量改用官方總成交股數（含盤中零股、鉅額、盤後交易）。
 * Yahoo 的歷史 K 棒只有「盤中整股」，比官方少 2–20%（零股越多的股票差越多）。
 * 日線：逐日替換；週 / 月線：以官方日成交量加總（官方資料涵蓋範圍內）。分線沒有官方資料，維持原樣。
 */
function withOfficialVolume(entry, candles, tf) {
  if (entry.type === 'index' || !candles.length || !['D', 'W', 'M'].includes(tf)) return candles;
  if (entry.market === 'otc') officialSync.syncTpexStock(entry.code).catch(() => {}); // 上櫃逐月下載官方總量（背景）
  let vols;
  try { vols = official.totalVolumes(entry.code, tf === 'D' ? candles[0].time : '0000-00-00'); } catch { return candles; }
  if (!vols.size) return candles;
  if (tf === 'D') {
    return candles.map((c) => (vols.has(c.time) ? { ...c, volume: Math.round(vols.get(c.time) / 1000), volSrc: 'official' } : c));
  }
  const firstBucket = yahoo.bucketDate([...vols.keys()].sort()[0], tf); // 第一段可能不完整，不替換
  const sums = new Map();
  for (const [d, v] of vols) {
    const b = yahoo.bucketDate(d, tf);
    sums.set(b, (sums.get(b) || 0) + v);
  }
  // 只替換「整段都在官方資料範圍內」的週 / 月
  return candles.map((c) => (c.time > firstBucket && sums.has(c.time) ? { ...c, volume: Math.round(sums.get(c.time) / 1000), volSrc: 'official' } : c));
}

async function getCandles(entry, tf) {
  const res = tf === 'D' ? await getDaily(entry) : await yahoo.getHistory(entry, tf);
  return { ...res, candles: withOfficialVolume(entry, res.candles, tf) };
}

app.get('/api/search', wrap(async (req, res) => {
  res.json(stocks.search(req.query.q));
}));

app.get('/api/quotes', wrap(async (req, res) => {
  const codes = String(req.query.codes || '').split(',').map(normCode).filter(Boolean).slice(0, 100);
  const entries = (await Promise.all(codes.map((c) => resolve(c).catch(() => null)))).filter(Boolean);
  res.json({ status: status(), quotes: await mis.getQuotes(entries) });
}));

app.get('/api/history', wrap(async (req, res) => {
  const entry = await resolve(req.query.code);
  const tf = String(req.query.tf || 'D');
  const { candles, meta } = await getCandles(entry, tf);
  res.json({ symbol: entry, tf, candles, meta });
}));

app.get('/api/predict', wrap(async (req, res) => {
  const entry = await resolve(req.query.code);
  const { candles } = await getCandles(entry, 'D');
  // 盤中最後一根是「目前價」不是收盤價，不能拿來當回測答案
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const lastBarPartial = status().active && candles.length > 0 && candles[candles.length - 1].time === today;
  const result = forecast(candles, Number(req.query.h) || 20, holidays, {
    lastBarPartial,
    // 以「最後一根 K 棒」為界：今天除息但今天還沒有 K 棒時，今天的除息仍在預測期間內
    exEvents: candles.length ? dividends.upcoming(entry.code, candles[candles.length - 1].time, '9999-12-31') : [],
    cacheKey: entry.code,
  });
  // 技術面評等只當參考資訊附上，不再與預測混成「買進／賣出」的綜合評等：
  // 實測台灣 50 成分股，評等「強力賣出」之後 20 日平均仍上漲，買賣字眼沒有根據
  const rating = technicalRating(candles);
  res.json({ symbol: entry, ...result, technical: rating.summary });
}));

app.get('/api/rating', wrap(async (req, res) => {
  const entry = await resolve(req.query.code);
  const tf = String(req.query.tf || 'D');
  const { candles } = await getCandles(entry, tf);
  res.json({ symbol: entry, tf, ...technicalRating(candles, { pivotFromPrevious: status().active }) });
}));

app.get('/api/heatmap', wrap(async (req, res) => {
  const entries = heatmap.CODES.map((code) => stocks.get(code) || { code, market: 'tse' });
  const quotes = await mis.getQuotes(entries, { maxAge: 8000 });
  const items = heatmap.CODES.filter((c) => quotes[c]).map((c) => {
    const q = quotes[c];
    return { code: c, name: q.name, sector: heatmap.SECTOR_OF[c], price: q.price, changePct: q.changePct, value: (q.price || 0) * (q.volume || 0) * 1000 };
  });
  res.json({ status: status(), items });
}));

app.get('/api/calendar', wrap(async (req, res) => {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const h = holidays.isWeekend(today) ? { name: '週末', source: 'weekend' } : holidays.holidayOf(today);
  res.json({
    today: { date: today, tradingDay: !h, reason: h },
    status: status(),
    upcoming: holidays.upcoming(90),
    calendar: holidays.info(),
    checks: closureWatch.info(),
  });
}));

// ---------------- 官方資料：籌碼、營收、因子檢驗 ----------------
app.get('/api/chips', wrap(async (req, res) => {
  const entry = await resolve(req.query.code);
  if (entry.type === 'index') throw Object.assign(new Error('指數沒有個股籌碼資料'), { status: 404 });
  const data = official.chips(entry.code);
  let fac = null;
  try { fac = factors.stockFactors(await factors.report(), entry.code); } catch (e) { console.warn('[factors]', e.message); }
  res.json({ symbol: entry, ...data, factors: fac, coverage: official.coverage() });
}));

app.get('/api/factors', wrap(async (req, res) => {
  const r = await factors.report();
  if (!r) throw Object.assign(new Error('官方資料尚未下載，請先執行 npm run sync'), { status: 404 });
  const { latest, ...rest } = r;
  res.json({ ...rest, latest: { date: latest.date, universe: latest.universe }, coverage: official.coverage() });
}));

app.get('/api/official/status', wrap(async (req, res) => {
  res.json({ ...officialSync.status(), coverage: official.coverage() });
}));

app.get('/api/market', wrap(async (req, res) => {
  const quotes = await mis.getQuotes(INDEX_CODES.map((c) => stocks.get(c)));
  res.json({ status: status(), indices: quotes });
}));

// ---------------- WebSocket 即時推播 ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.subs = new Set();
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'subscribe' && Array.isArray(msg.codes)) {
      ws.subs = new Set(msg.codes.map(normCode).filter(Boolean).slice(0, 100));
      await Promise.all([...ws.subs].map((c) => resolve(c).catch(() => null)));
      pushTo(ws, await fetchAll([ws])).catch(() => {});
    }
  });
});

async function fetchAll(clients) {
  const codes = new Set(INDEX_CODES);
  for (const ws of clients) for (const c of ws.subs) codes.add(c);
  const entries = [...codes].map((c) => stocks.get(c)).filter(Boolean);
  const quotes = await mis.getQuotes(entries);
  if (quotes.t00 && quotes.t00.date) lastIndexDate = quotes.t00.date;
  closureWatch.checkMis(quotes.t00);
  return quotes;
}

async function pushTo(ws, quotes) {
  if (ws.readyState !== ws.OPEN) return;
  const subset = {};
  for (const c of [...INDEX_CODES, ...ws.subs]) if (quotes[c]) subset[c] = quotes[c];
  ws.send(JSON.stringify({ type: 'quotes', status: status(), quotes: subset, calendar: holidays.getVersion(), at: Date.now() }));
}

// 官方資料有新進度（盤後行情、法人、融資券、月營收、上櫃個股成交量）→ 通知瀏覽器重新整理相關區塊
let factorWarmTimer = null;
officialSync.events.on('update', ({ dataset, key, code }) => {
  const msg = JSON.stringify({ type: 'official', dataset, key, code: code || null });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  // 籌碼、營收、行情更新後，等同步告一段落（1 分鐘沒有新進度）再在背景重算因子檢驗
  if (dataset !== 'voltotal_otc') {
    clearTimeout(factorWarmTimer);
    factorWarmTimer = setTimeout(factors.warm, 60e3);
  }
});

// 盤後定時同步官方資料：平日 14:00–23:30 每 30 分鐘、每天早上 7 點（補月營收）
function scheduleOfficialSync() {
  const run = () => officialSync.syncRecent().catch((e) => console.warn('[official]', e.message));
  setTimeout(run, 20000);
  setInterval(() => {
    const n = new Date(Date.now() + 8 * 3600e3);
    const wd = n.getUTCDay(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if ((wd >= 1 && wd <= 5 && m >= 14 * 60 && m <= 23 * 60 + 30) || (m >= 7 * 60 && m < 7 * 60 + 30)) run();
  }, 30 * 60e3).unref();
}

// 休市日曆一有變動（颱風停班、確認未開盤、官方日曆更新）就立即通知所有瀏覽器
holidays.events.on('change', ({ version, reason }) => {
  const msg = JSON.stringify({ type: 'calendar', version, reason, status: status() });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
});

async function loop() {
  const clients = [...wss.clients].filter((ws) => ws.readyState === ws.OPEN);
  try {
    // 沒有人連線時也持續取加權指數，才能確認今天是否開盤
    const quotes = await fetchAll(clients);
    await Promise.all(clients.map((ws) => pushTo(ws, quotes)));
  } catch (e) {
    console.warn('[ws] 推播失敗:', e.message);
  }
  // 盤中每 5 秒輪詢（MIS 公開資料實測約 25 秒更新一次、延遲 30–60 秒），收盤後每 30 秒
  setTimeout(loop, status().active || status().code === 'post' ? 5000 : 30000);
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();

Promise.all([stocks.init(), holidays.init()]).then(() => {
  server.listen(PORT, () => {
    console.log(`台股觀測站已啟動： http://localhost:${PORT}`);
    closureWatch.start();
    dividends.init();
    scheduleOfficialSync();
    setTimeout(factors.warm, 5000); // 先在背景算好因子檢驗，第一次打開「籌碼・營收」不用等
    loop();
  });
});
