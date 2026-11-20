// 上市（TWSE）與上櫃（TPEx）股票清單，供搜尋與判斷市場別
const fs = require('fs');
const path = require('path');

const CACHE_FILE = process.env.STOCKLIST_FILE || path.join(__dirname, '..', 'data', 'stocks.json');
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

const SOURCES = {
  tse: { label: '證交所', url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL' },
  otc: { label: '櫃買中心', url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes' },
};
const RETRY_MS = Number(process.env.STOCKLIST_RETRY_MS) || 10000;
const MIN_PER_MARKET = 100; // 少於這個數量視為取得失敗（正常約 1,000 檔以上）

/** 簡單的 CSV 解析（支援雙引號欄位、Excel 的 ="0050" 寫法） */
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.replace(/^=/, '').trim()));
  }
  return rows;
}

/**
 * 下載清單並轉成 [{code, name}]。
 * 實測（2026/11 凌晨）證交所 OpenAPI 偶爾回傳 CSV 而不是 JSON，所以兩種格式都接受；失敗時隔幾秒重試一次。
 */
async function fetchList(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS));
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = (await r.text()).replace(/^﻿/, '').trim();
      if (text.startsWith('[') || text.startsWith('{')) {
        return JSON.parse(text).map((s) => ({ code: String(s.Code ?? s.SecuritiesCompanyCode ?? '').trim(), name: String(s.Name ?? s.CompanyName ?? '').trim() }));
      }
      const rows = parseCsv(text);
      const head = rows[0] || [];
      const ci = head.findIndex((h) => /代號/.test(h)), ni = head.findIndex((h) => /名稱/.test(h));
      if (ci < 0 || ni < 0) throw new Error(`無法辨識的回應：${text.slice(0, 40)}`);
      return rows.slice(1).map((c) => ({ code: String(c[ci] || '').trim(), name: String(c[ni] || '').trim() }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * 更新清單。某個市場取得失敗時，沿用該市場上一次的清單，
 * 不能讓「只拿到上櫃」的半份清單蓋掉原本完整的清單。
 */
async function refresh() {
  const markets = Object.keys(SOURCES);
  const results = await Promise.allSettled(markets.map((m) => fetchList(SOURCES[m].url)));
  const items = [];
  const seen = new Set();
  let complete = true;
  markets.forEach((market, i) => {
    const res = results[i];
    const fresh = res.status === 'fulfilled'
      ? res.value.filter((s) => keep(s.code) && s.name).map((s) => ({ code: s.code, name: s.name, market, type: 'stock' }))
      : [];
    let use = fresh;
    if (fresh.length < MIN_PER_MARKET) {
      complete = false;
      use = list.filter((s) => s.type === 'stock' && s.market === market);
      console.warn(`[stocklist] ${SOURCES[market].label}清單取得失敗${res.status === 'rejected' ? `：${res.reason.message}` : `（只有 ${fresh.length} 檔）`}；沿用上一次的 ${use.length} 檔`);
    }
    for (const s of use) if (!seen.has(s.code)) { seen.add(s.code); items.push(s); }
  });

  if (items.length > 500) {
    setList(items);
    if (complete) {
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(items));
      } catch (e) { console.warn('[stocklist] 無法寫入快取:', e.message); }
    }
    console.log(`[stocklist] 已載入 ${items.length} 檔股票${complete ? '' : '（部分沿用上一次的清單）'}`);
  }
  return { complete };
}

/** 讀取上一次成功取得的清單（沒有快取時回傳 false） */
function loadCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(cached) && cached.length) { setList(cached); return true; }
  } catch { /* 沒有快取 */ }
  return false;
}

async function init() {
  if (!loadCache()) setList(FALLBACK);
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

/** 完整清單（含指數），建置公開版用 */
const all = () => list.slice();

module.exports = { init, get, add, search, refresh, all, loadCache, parseCsv };
