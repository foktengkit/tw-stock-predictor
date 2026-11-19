// Yahoo Finance 歷史 K 線（上市 .TW、上櫃 .TWO、加權指數 ^TWII）
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TPE = 8 * 3600;

const TIMEFRAMES = {
  '1m': { interval: '1m', range: '5d', sec: 60, ttl: 20e3 },
  '5m': { interval: '5m', range: '1mo', sec: 300, ttl: 30e3 },
  '15m': { interval: '15m', range: '1mo', sec: 900, ttl: 60e3 },
  '60m': { interval: '60m', range: '6mo', sec: 3600, ttl: 120e3 },
  D: { interval: '1d', range: '5y', ttl: 5 * 60e3, daily: true },
  W: { interval: '1wk', range: '10y', ttl: 30 * 60e3, daily: true },
  M: { interval: '1mo', range: 'max', ttl: 60 * 60e3, daily: true },
};

function yahooSymbol(entry) {
  if (entry.code === 't00') return '^TWII';
  if (entry.type === 'index') return null; // 櫃買指數在 Yahoo 無歷史資料
  return `${entry.code}.${entry.market === 'otc' ? 'TWO' : 'TW'}`;
}

/** 週線對齊到該週一、月線對齊到該月 1 日 */
function bucketDate(isoDate, tf) {
  if (tf === 'M') return `${isoDate.slice(0, 7)}-01`;
  if (tf === 'W') {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return isoDate;
}

const cache = new Map();

async function fetchChart(symbol, interval, range) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || `HTTP ${r.status}`);
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/**
 * @returns {Promise<{candles: {time, open, high, low, close, volume}[], meta: object}>}
 * 日線以上 time 為 'YYYY-MM-DD'；分線 time 為「台北時間」秒數（UTC 時戳 + 8h，讓圖表直接顯示台北時間）
 */
async function getHistory(entry, tf = 'D') {
  const cfg = TIMEFRAMES[tf];
  if (!cfg) throw Object.assign(new Error(`不支援的週期: ${tf}`), { status: 400 });
  const symbol = yahooSymbol(entry);
  if (!symbol) throw Object.assign(new Error(`${entry.name} 無歷史 K 線資料`), { status: 404 });

  const key = `${symbol}|${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cfg.ttl) return hit.data;

  const res = await fetchChart(symbol, cfg.interval, cfg.range);
  const ts = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  // 還原權息價格（僅日線）：給預測模型用，避免除息缺口被當成下跌；圖表仍顯示原始價格
  const adj = tf === 'D' && res.indicators.adjclose && res.indicators.adjclose[0] ? res.indicators.adjclose[0].adjclose : null;
  const byTime = new Map();
  const m0 = res.meta || {};
  for (let i = 0; i < ts.length; i++) {
    let o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    // 日線最後一根常出現「收盤價為空」（盤中或半夜），改用 meta 裡的最新價與當日高低量補上，
    // 避免整根被丟掉（成交量也才會和其他 K 棒同一個口徑）
    // 盤中實測：開盤後 meta 仍可能是「昨天」的價格與成交量，必須確認日期是同一天才能用
    const metaDay = Number.isFinite(m0.regularMarketTime) ? new Date((m0.regularMarketTime + TPE) * 1000).toISOString().slice(0, 10) : null;
    const barDay = new Date((ts[i] + TPE) * 1000).toISOString().slice(0, 10);
    if (cfg.daily && tf === 'D' && i === ts.length - 1 && c == null && metaDay === barDay && Number.isFinite(m0.regularMarketPrice)) {
      c = m0.regularMarketPrice;
      o = o ?? c;
      h = Math.max(h ?? m0.regularMarketDayHigh ?? c, c);
      l = Math.min(l ?? m0.regularMarketDayLow ?? c, c);
      if (q.volume && q.volume[i] == null && Number.isFinite(m0.regularMarketVolume)) q.volume[i] = m0.regularMarketVolume;
    }
    if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) continue;
    const local = ts[i] + TPE;
    let time;
    if (cfg.daily) time = bucketDate(new Date(local * 1000).toISOString().slice(0, 10), tf);
    else time = Math.floor(local / cfg.sec) * cfg.sec;
    const vol = q.volume && q.volume[i] != null ? Math.round(q.volume[i] / 1000) : 0; // 股 -> 張
    const prev = byTime.get(time);
    // Yahoo 會把「本週 / 本月」最新一天另外列成一根，這裡合併回同一根
    if (prev && tf !== 'D') {
      prev.high = Math.max(prev.high, h); prev.low = Math.min(prev.low, l); prev.close = c; prev.volume += vol;
    } else {
      const bar = { time, open: o, high: h, low: l, close: c, volume: vol };
      if (adj && Number.isFinite(adj[i]) && adj[i] > 0) bar.adjClose = adj[i];
      byTime.set(time, bar);
    }
  }
  const candles = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const m = res.meta || {};
  const data = {
    candles,
    meta: { symbol, currency: m.currency, exchange: m.fullExchangeName, high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow, longName: m.longName },
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { getHistory, bucketDate, TIMEFRAMES };
