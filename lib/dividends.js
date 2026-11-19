/**
 * 除權除息預告（證交所 TWT48U、櫃買中心 tpex_exright_prepost），每 6 小時同步。
 * 預測模型用還原權息價格（總報酬）估計走勢；畫面上的預測價是「原始股價」，
 * 所以預測期間若遇到已公告的除權息日，要從該日起扣掉股利，否則原始價預測會偏高。
 */
const REFRESH_MS = 6 * 3600 * 1000;
let byCode = new Map(); // code -> [{ date, cash, stockRatio, pending }]
let fetchedAt = null;

const rocToIso = (s) => {
  const m = String(s).match(/(\d{2,3})\D*(\d{2})\D*(\d{2})/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
};
const num = (s) => {
  const v = parseFloat(String(s).replace(/<[^>]*>/g, '').replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function refresh() {
  const next = new Map();
  const add = (code, e) => { if (!e.date) return; if (!next.has(code)) next.set(code, []); next.get(code).push(e); };
  const [tse, otc] = await Promise.allSettled([
    getJson('https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json'),
    getJson('https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost'),
  ]);
  if (tse.status === 'fulfilled' && Array.isArray(tse.value.data)) {
    // 欄位：除權除息日期, 股票代號, 名稱, 除權息, 無償配股率, 現金增資配股率, 現金增資認購價, 現金股利, ...
    for (const row of tse.value.data) {
      const cash = num(row[7]);
      add(String(row[1]).trim(), { date: rocToIso(row[0]), cash: cash ?? 0, stockRatio: num(row[4]) || 0, pending: cash == null });
    }
  } else if (tse.status === 'rejected') console.warn('[dividends] 證交所除權息預告取得失敗:', tse.reason.message);
  if (otc.status === 'fulfilled' && Array.isArray(otc.value)) {
    for (const row of otc.value) {
      const cash = num(row.CashDividend);
      add(String(row.SecuritiesCompanyCode).trim(), { date: rocToIso(row.ExRrightsExDividendDate), cash: cash ?? 0, stockRatio: num(row.StockDividendRatio) || 0, pending: cash == null });
    }
  } else if (otc.status === 'rejected') console.warn('[dividends] 櫃買除權息預告取得失敗:', otc.reason.message);
  if (next.size) { byCode = next; fetchedAt = new Date().toISOString(); }
}

function init() {
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), REFRESH_MS).unref();
}

/** 某檔股票在 (afterDate, untilDate] 之間已公告的除權息事件 */
function upcoming(code, afterDate, untilDate) {
  return (byCode.get(code) || []).filter((e) => e.date > afterDate && e.date <= untilDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

module.exports = { init, refresh, upcoming, info: () => ({ fetchedAt, codes: byCode.size }) };
