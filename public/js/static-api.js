/**
 * 公開版（GitHub Pages）的資料來源。
 * 私人版的前端打到伺服器的 /api/*；公開版沒有伺服器，改讀每日建置的靜態 JSON（data/），
 * 預測與技術評等直接在瀏覽器計算（js/lib/ 是建置時從伺服器端複製過來的同一份程式）。
 * 資料全部來自證交所、櫃買中心、公開資訊觀測站的盤後公開資料。
 */
import predictLib from './lib/predict.js';
import ratingLib from './lib/rating.js';
import { dailyCandles, aggregate } from './static-data.js';

const CFG = window.TWS_CONFIG || {};
const VERSION = encodeURIComponent(CFG.builtAt || '');
const INTRADAY = ['1m', '5m', '15m', '60m'];

/** 網路錯誤或伺服器暫時錯誤（5xx）時重試一次；GitHub Pages 剛部署完的幾分鐘偶爾會這樣 */
async function fetchData(rel) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`data/${rel}?v=${VERSION}`);
    } catch (e) {
      if (attempt < 1) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
      throw new Error('網路連線失敗，請稍後再試');
    }
    if (r.status >= 500 && attempt < 1) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    if (!r.ok) throw Object.assign(new Error(r.status === 404 ? '沒有這檔的資料' : `讀取資料失敗（HTTP ${r.status}）`), { status: r.status });
    return r.json();
  }
}

const memo = new Map();
function load(rel) {
  if (!memo.has(rel)) {
    // 失敗的結果不留在快取裡，下次切換到這檔時會重新下載
    memo.set(rel, fetchData(rel).catch((e) => { memo.delete(rel); throw e; }));
  }
  return memo.get(rel);
}

const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');
const norm = (c) => {
  const s = String(c || '').trim().toUpperCase();
  return s === 'T00' || s === 'O00' ? s.toLowerCase() : s;
};

/** 公開版沒有盤中狀態：一律顯示「盤後資料（日期）」 */
const status = () => ({ code: 'closed', label: `盤後資料 ${md(CFG.dataDate)}`, active: false, date: CFG.dataDate, static: true });

async function candlesOf(code, tf = 'D') {
  if (INTRADAY.includes(tf)) throw Object.assign(new Error('公開版只提供日、週、月線（分線沒有官方公開的歷史資料）'), { status: 400 });
  const k = await load(`k/${code}.json`);
  const daily = dailyCandles(k);
  return { symbol: { code: k.code, name: k.name, market: k.market, type: k.type }, candles: tf === 'D' ? daily : aggregate(daily, tf), k };
}

async function calendarObj() {
  const c = await load('calendar.json');
  const years = new Set((c.officialYears || []).map(String));
  return { ...c, holidayOf: (iso) => c.closed[iso] || null, hasOfficialYear: (y) => years.has(String(y)) };
}

function stockFactors(r, code) {
  if (!r) return null;
  const v = r.latest.vals[code];
  return {
    date: r.latest.date,
    inUniverse: !!v,
    factors: r.factors.map((f) => ({ key: f.key, value: v ? v[f.key] : null, percentile: r.latest.pct[code] ? r.latest.pct[code][f.key] ?? null : null })),
  };
}

const routes = {
  async search(q) {
    const s = String(q.get('q') || '').trim().toUpperCase();
    if (!s) return [];
    const list = await load('stocks.json');
    const starts = [], names = [];
    for (const [code, name, market, type] of list) {
      const e = { code, name, market, type };
      if (code.toUpperCase().startsWith(s)) starts.push(e);
      else if (name.toUpperCase().includes(s)) names.push(e);
    }
    starts.sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
    return [...starts, ...names].slice(0, 20);
  },

  async quotes(q) {
    const all = await load('quotes.json');
    const quotes = {};
    for (const c of String(q.get('codes') || '').split(',').map(norm)) if (all[c]) quotes[c] = all[c];
    return { status: status(), quotes };
  },

  async market() {
    const all = await load('quotes.json');
    return { status: status(), indices: { ...(all.t00 && { t00: all.t00 }), ...(all.o00 && { o00: all.o00 }) } };
  },

  async history(q) {
    const tf = q.get('tf') || 'D';
    const { symbol, candles } = await candlesOf(norm(q.get('code')), tf);
    return { symbol, tf, candles, meta: { static: true } };
  },

  async predict(q) {
    const code = norm(q.get('code'));
    const [{ symbol, candles }, cal, div] = await Promise.all([candlesOf(code, 'D'), calendarObj(), load('dividends.json')]);
    if (!candles.length) throw new Error('沒有 K 線資料');
    const last = candles[candles.length - 1].time;
    const result = predictLib.forecast(candles, Number(q.get('h')) || 20, cal, {
      lastBarPartial: false,
      exEvents: (div[code] || []).filter((e) => e.date > last),
      cacheKey: `${code}|${CFG.builtAt}`,
    });
    let technical = null;
    try { technical = ratingLib.technicalRating(candles).summary; } catch { /* K 線太少 */ }
    return { symbol, ...result, technical };
  },

  async rating(q) {
    const tf = q.get('tf') || 'D';
    const { symbol, candles } = await candlesOf(norm(q.get('code')), tf);
    return { symbol, tf, ...ratingLib.technicalRating(candles) };
  },

  async heatmap() {
    return { status: status(), items: await load('heatmap.json') };
  },

  async calendar() {
    const cal = await calendarObj();
    const today = taipeiToday();
    const wd = new Date(`${today}T00:00:00Z`).getUTCDay();
    const h = wd === 0 || wd === 6 ? { name: '週末', source: 'weekend' } : cal.holidayOf(today);
    const end = new Date(Date.now() + 8 * 3600e3 + 90 * 86400e3).toISOString().slice(0, 10);
    const upcoming = Object.entries(cal.closed).filter(([d]) => d >= today && d <= end).sort().map(([date, x]) => ({ date, ...x }));
    return { static: true, today: { date: today, tradingDay: !h, reason: h }, status: status(), upcoming, calendar: cal, dataDate: CFG.dataDate, builtAt: CFG.builtAt };
  },

  async chips(q) {
    const code = norm(q.get('code'));
    if (code === 't00' || code === 'o00') throw Object.assign(new Error('指數沒有個股籌碼資料'), { status: 404 });
    const [c, rep, meta] = await Promise.all([
      load(`chips/${code}.json`).catch(() => { throw new Error('這檔沒有籌碼與營收資料（ETF、特別股或新上市股票）'); }),
      load('factors.json').catch(() => null),
      load('meta.json'),
    ]);
    const quotes = await load('quotes.json');
    const qt = quotes[code] || {};
    return { symbol: { code, name: qt.name, market: qt.market, type: 'stock' }, ...c, factors: stockFactors(rep, code), coverage: meta.coverage };
  },

  async factors() {
    const [rep, meta] = await Promise.all([load('factors.json'), load('meta.json')]);
    const { latest, ...rest } = rep;
    return { ...rest, latest: { date: latest.date, universe: latest.universe }, coverage: meta.coverage };
  },
};

/** 與伺服器 API 相同的介面：path 例如 /api/history?code=2330&tf=D */
export async function staticApi(path) {
  const u = new URL(path, location.href);
  const name = u.pathname.split('/api/')[1];
  const fn = routes[name];
  if (!fn) throw new Error(`公開版不支援 ${name}`);
  return fn(u.searchParams);
}
