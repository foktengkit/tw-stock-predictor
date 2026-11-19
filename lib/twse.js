// 證交所「基本市況報導」MIS 即時報價（涵蓋上市、上櫃與指數）。盤中實測：快照約 25 秒更新一次、比實際時間延遲 30–60 秒，
// 且多台伺服器回傳的快照新舊不一，所以要比對快照時間
const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const MIN_GAP_MS = 1000; // 對 MIS 的請求間隔下限，避免被封鎖
const BATCH = 60;
const FRESH_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
let lastRequestAt = 0;

function throttled(fn) {
  const p = chain.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  chain = p.catch(() => {});
  return p;
}

const num = (v) => {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function levels(prices, vols) {
  const ps = String(prices || '').split('_').filter(Boolean).map(num);
  const vs = String(vols || '').split('_').filter(Boolean).map(num);
  return ps.map((price, i) => ({ price, volume: vs[i] ?? null })).filter((x) => x.price);
}

const isTime = (s) => /^\d{2}:\d{2}:\d{2}$/.test(s || '');

/**
 * @param m    MIS 原始資料
 * @param last 同一檔股票上一次的報價（同一天才會用到）
 *
 * 盤中實測：這個區間剛好沒成交時 z 會是 "-"，而 trade.z 有時是好幾分鐘前的舊成交價。
 * 所以在「本次 z、trade.z、上一次的價格」之中，取最後成交時間最新的那個。
 */
function parseQuote(m, last) {
  const isIndex = m.c === 't00' || m.c === 'o00' || /idx/.test(m.i || '');
  const bids = levels(m.b, m.g);
  const asks = levels(m.a, m.f);
  const prev = num(m.y);
  const cands = [];
  if (num(m.z) != null) cands.push({ price: num(m.z), t: m.t });
  if (m.trade && num(m.trade.z) != null && isTime(m.trade.t)) cands.push({ price: num(m.trade.z), t: m.trade.t });
  if (last && last.date === m.d && last.price != null && isTime(last.time) && last.hasTrade) cands.push({ price: last.price, t: last.time });
  cands.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0)); // 成交時間新的優先
  let price = cands.length ? cands[0].price : null;
  let tradeTime = cands.length ? cands[0].t : m.t;
  const hasTrade = cands.length > 0;
  if (price == null) price = num(m.pz);
  if (price == null && bids[0] && asks[0]) price = (bids[0].price + asks[0].price) / 2;
  if (price == null) price = prev;
  const change = price != null && prev != null ? price - prev : null;
  // tlong 是資料更新時間（盤後定價時段會變成 14:30），K 線用「最後成交時間」
  let ts = Number(m.tlong) || Date.now();
  if (/^\d{8}$/.test(m.d || '') && isTime(tradeTime)) {
    const [hh, mm, ss] = tradeTime.split(':').map(Number);
    ts = Date.UTC(+m.d.slice(0, 4), +m.d.slice(4, 6) - 1, +m.d.slice(6, 8), hh, mm, ss) - 8 * 3600e3;
  }
  return {
    code: m.c,
    name: m.n,
    fullName: m.nf || m.n,
    market: m.ex,
    isIndex,
    price,
    prev,
    open: num(m.o),
    high: num(m.h),
    low: num(m.l),
    volume: isIndex ? null : num(m.v), // 單位：張
    limitUp: num(m.u),
    limitDown: num(m.w),
    change,
    changePct: change != null && prev ? (change / prev) * 100 : null,
    bids,
    asks,
    date: m.d,
    time: tradeTime,      // 最後成交時間
    hasTrade,
    ts,
    snapshotAt: Number(m.tlong) || 0, // 這份資料的產生時間，用來排除較舊的快照
  };
}

const cache = new Map(); // channel -> { quote, at }

async function fetchChannels(channels) {
  const out = [];
  for (let i = 0; i < channels.length; i += BATCH) {
    const batch = channels.slice(i, i + BATCH);
    const url = `${MIS_URL}?ex_ch=${batch.join('|')}&json=1&delay=0&_=${Date.now()}`;
    const data = await throttled(async () => {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json', Referer: 'https://mis.twse.com.tw/stock/index.jsp' },
      });
      if (!r.ok) throw new Error(`MIS HTTP ${r.status}`);
      return JSON.parse((await r.text()).trim());
    });
    for (const m of data.msgArray || []) {
      const ch = `${m.ex}_${m.c}.tw`;
      const prior = cache.get(ch);
      const q = parseQuote(m, prior && prior.quote);
      // MIS 背後有多台伺服器，連續兩次請求可能拿到較舊的快照：比本機已有的還舊就不採用
      if (prior && prior.quote.date === q.date && prior.quote.snapshotAt > q.snapshotAt) {
        prior.at = Date.now();
        prior.quote.fetchedAt = Date.now();
        out.push(prior.quote);
        continue;
      }
      q.fetchedAt = Date.now(); // 讓使用端分辨「剛抓到的」與「失敗時退回的舊快取」
      cache.set(ch, { quote: q, at: Date.now() });
      out.push(q);
    }
  }
  return out;
}

const channelOf = (s) => `${s.market}_${s.code}.tw`;

/**
 * @param {{code:string, market:'tse'|'otc'}[]} symbols
 * @returns {Promise<Record<string, object>>} code -> quote
 */
async function getQuotes(symbols, { maxAge = FRESH_MS } = {}) {
  const result = {};
  const stale = [];
  for (const s of symbols) {
    const c = cache.get(channelOf(s));
    if (c && Date.now() - c.at < maxAge) result[s.code] = c.quote;
    else stale.push(channelOf(s));
  }
  if (stale.length) {
    try {
      for (const q of await fetchChannels([...new Set(stale)])) result[q.code] = q;
    } catch (e) {
      console.warn('[mis] 取得報價失敗:', e.message);
      // 失敗時退回舊快取
      for (const s of symbols) {
        if (!result[s.code]) { const c = cache.get(channelOf(s)); if (c) result[s.code] = c.quote; }
      }
    }
  }
  return result;
}

/** 對清單中沒有的代號，同時查上市/上櫃判斷市場別 */
async function probe(code) {
  const qs = await fetchChannels([`tse_${code}.tw`, `otc_${code}.tw`]);
  const q = qs.find((x) => x.code === code && x.name);
  return q ? { code, name: q.name, market: q.market, type: 'stock' } : null;
}

module.exports = { getQuotes, probe, parseQuote };
