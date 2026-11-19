// 官方資料查詢（給 API 與因子計算用）
const db = require('./db');

/** 官方總成交股數：Map(date → 股) */
function totalVolumes(code, fromDate = '0000-00-00') {
  const rows = db.all('SELECT date, volume FROM vol_total WHERE code = ? AND date >= ?', code, fromDate);
  return new Map(rows.map((r) => [r.date, r.volume]));
}

/** 個股籌碼與營收：最近 days 個交易日的法人、融資券，最近 months 個月營收 */
function chips(code, { days = 120, months = 36 } = {}) {
  const inst = db.all('SELECT date, foreign_net, trust_net, dealer_net, total_net FROM inst WHERE code = ? ORDER BY date DESC LIMIT ?', code, days).reverse();
  const margin = db.all('SELECT date, margin_balance, short_balance, margin_buy, margin_sell, short_sell, short_buy FROM margin WHERE code = ? ORDER BY date DESC LIMIT ?', code, days).reverse();
  const revenue = db.all('SELECT ym, revenue, mom, yoy, cum_yoy, available FROM revenue WHERE code = ? ORDER BY ym DESC LIMIT ?', code, months).reverse();
  const daily = db.all('SELECT date, close, volume FROM daily WHERE code = ? ORDER BY date DESC LIMIT ?', code, days).reverse();
  return { inst, margin, revenue, daily };
}

/**
 * 各資料集的涵蓋範圍。直接對百萬列的資料表做 MIN/MAX/COUNT 要將近 1 秒（會卡住即時推播），
 * 所以改從同步紀錄（每個日期／月份一列）計算，並在資料沒有更新時沿用上次的結果。
 */
let covCache = null;
function coverage() {
  const v = db.get('SELECT MAX(at) m, COUNT(*) n FROM sync_log') || {};
  const version = `${v.m}|${v.n}`;
  if (covCache && covCache.version === version) return covCache.value;
  const span = (datasets, unit = 'days') => {
    const r = db.get(`SELECT MIN(key) earliest, MAX(key) latest, COUNT(DISTINCT key) n FROM sync_log
                      WHERE status = 'ok' AND dataset IN (${datasets.map(() => '?').join(', ')})`, ...datasets) || {};
    return { earliest: r.earliest ?? null, latest: r.latest ?? null, [unit]: r.n || 0 };
  };
  const value = {
    daily: span(['daily_tse']),
    dailyOtc: span(['daily_otc']),
    inst: span(['inst_tse', 'inst_otc']),
    margin: span(['margin_tse', 'margin_otc']),
    revenue: span(['revenue_sii0', 'revenue_sii1', 'revenue_otc0', 'revenue_otc1'], 'months'),
    exright: db.get('SELECT MIN(date) earliest, MAX(date) latest, COUNT(*) n FROM exright') || {},
  };
  covCache = { version, value };
  return value;
}

module.exports = { totalVolumes, chips, coverage };
