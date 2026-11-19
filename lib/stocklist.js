// 上市（TWSE）與上櫃（TPEx）股票清單，供搜尋與判斷市場別
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'stocks.json');
const REFRESH_MS = 12 * 3600 * 1000;

const INDICES = [
  { code: 't00', name: '加權指數', market: 'tse', type: 'index' },
  { code: 'o00', name: '櫃買指數', market: 'otc', type: 'index' },
];

// 網路無法取得清單時的最小備援
const FALLBACK = [
  ['2330', '台積電', 'tse'], ['2317', '鴻海', 'tse'], ['2454', '聯發科', 'tse'], ['2308', '台達電', 'tse'],
  ['2382', '廣達', 'tse'], ['2881', '富邦金', 'tse'], ['2603', '長榮', 'tse'], ['0050', '元大台灣50', 'tse'],
  ['0056', '元大高股息', 'tse'], ['00878', '國泰永續高股息', 'tse'], ['6488', '環球晶', 'otc'], ['5347', '世界', 'otc'],
].map(([code, name, market]) => ({ code, name, market, type: 'stock' }));

let list = [];
const map = new Map();

function keep(code) {
  // 一般股票（4 碼，可帶英文字尾）與 ETF（00 開頭）；排除權證等 6 碼商品
  return /^\d{4}[A-Z]?$/.test(code) || /^00\d{2,4}[A-Z]?$/.test(code);
}

function setList(items) {
  list = [...INDICES, ...items];
  map.clear();
  for (const s of list) map.set(s.code, s);
}

function add(entry) {
  if (!map.has(entry.code)) { list.push(entry); map.set(entry.code, entry); }
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function refresh() {
  const [tse, otc] = await Promise.allSettled([
    fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'),
  ]);
  const items = [];
  const seen = new Set();
  if (tse.status === 'fulfilled') {
    for (const s of tse.value) {
      const code = String(s.Code || '').trim();
      if (keep(code) && !seen.has(code)) { seen.add(code); items.push({ code, name: String(s.Name).trim(), market: 'tse', type: 'stock' }); }
    }
  } else console.warn('[stocklist] TWSE 清單取得失敗:', tse.reason.message);
  if (otc.status === 'fulfilled') {
    for (const s of otc.value) {
      const code = String(s.SecuritiesCompanyCode || '').trim();
      if (keep(code) && !seen.has(code)) { seen.add(code); items.push({ code, name: String(s.CompanyName).trim(), market: 'otc', type: 'stock' }); }
    }
  } else console.warn('[stocklist] TPEx 清單取得失敗:', otc.reason.message);

  if (items.length > 500) {
    setList(items);
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(items));
    } catch (e) { console.warn('[stocklist] 無法寫入快取:', e.message); }
    console.log(`[stocklist] 已載入 ${items.length} 檔股票`);
  }
}

async function init() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(cached) && cached.length) setList(cached);
  } catch { setList(FALLBACK); }
  refresh().catch((e) => console.warn('[stocklist] 更新失敗:', e.message));
  setInterval(() => refresh().catch(() => {}), REFRESH_MS).unref();
}

function get(code) {
  return map.get(code) || null;
}

function search(q, limit = 20) {
  q = String(q || '').trim().toUpperCase();
  if (!q) return [];
  const starts = [], nameHits = [];
  for (const s of list) {
    if (s.code.toUpperCase().startsWith(q)) starts.push(s);
    else if (s.name.toUpperCase().includes(q)) nameHits.push(s);
  }
  starts.sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
  return [...starts, ...nameHits].slice(0, limit);
}

module.exports = { init, get, add, search, refresh };
