/**
 * 官方資料來源：下載與解析。
 * 每個主機各自限速（證交所會封鎖過快的請求），失敗會退避重試。
 * 每個 fetch 函數回傳 null 代表「該日沒有資料」（休市），回傳陣列代表解析後的資料列。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GAP_MS = Number(process.env.OFFICIAL_GAP_MS) || 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const limiters = {};
function limited(host, fn) {
  const l = (limiters[host] ||= { chain: Promise.resolve(), last: 0 });
  const p = l.chain.then(async () => {
    const wait = l.last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { l.last = Date.now(); }
  });
  l.chain = p.catch(() => {});
  return p;
}

async function request(host, url, { binary = false } = {}) {
  return limited(host, async () => {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: binary ? '*/*' : 'application/json' }, signal: AbortSignal.timeout(40000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (binary) return Buffer.from(await r.arrayBuffer());
        const text = await r.text();
        if (!text.trim()) return null;
        try { return JSON.parse(text); } catch { throw new Error('回應不是 JSON（可能被暫時限制存取）'); }
      } catch (e) {
        lastErr = e;
        await sleep(attempt === 0 ? 15000 : 60000 * attempt); // 退避：15 秒、60 秒、120 秒
      }
    }
    throw lastErr;
  });
}

// ---------- 解析工具 ----------
const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/<[^>]*>/g, '').replace(/,/g, '').trim();
  if (!t || t === '--' || t === '---' || t === '-') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const isStockCode = (c) => /^\d{4}[A-Z]?$/.test(c) || /^00\d{2,4}[A-Z]?$/.test(c);
const ymd = (iso) => iso.replace(/-/g, '');
const roc = (iso, sep = '/') => `${Number(iso.slice(0, 4)) - 1911}${sep}${iso.slice(5, 7)}${sep}${iso.slice(8, 10)}`;
const slashDate = (iso) => encodeURIComponent(iso.replace(/-/g, '/'));
const fromRoc = (s) => {
  const m = String(s).match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const findTable = (j, test) => (j && Array.isArray(j.tables) ? j.tables.find((t) => t && Array.isArray(t.fields) && Array.isArray(t.data) && test(t)) : null);

// ---------- 每日行情 ----------
/** 證交所每日收盤行情：成交股數為官方總量（一般 + 零股 + 鉅額 + 盤後） */
async function twseDaily(iso) {
  const j = await request('twse', `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(iso)}&type=ALLBUT0999&response=json`);
  const t = findTable(j, (x) => x.fields[0] === '證券代號' && x.fields.includes('成交股數'));
  if (!t || !t.data.length) return null;
  return t.data.filter((r) => isStockCode(String(r[0]).trim())).map((r) => ({
    date: iso, code: String(r[0]).trim(), market: 'tse',
    volume: num(r[2]), trades: num(r[3]), value: num(r[4]), open: num(r[5]), high: num(r[6]), low: num(r[7]), close: num(r[8]),
  }));
}

/** 櫃買每日收盤行情：成交股數只含一般交易（整股） */
async function tpexDaily(iso) {
  const j = await request('tpex', `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${slashDate(iso)}&type=EW&response=json`);
  const t = findTable(j, (x) => String(x.fields[0]).trim() === '代號');
  if (!t || !t.data.length) return null;
  return t.data.filter((r) => isStockCode(String(r[0]).trim())).map((r) => ({
    date: iso, code: String(r[0]).trim(), market: 'otc',
    close: num(r[2]), open: num(r[4]), high: num(r[5]), low: num(r[6]), volume: num(r[7]), value: num(r[8]), trades: num(r[9]),
  }));
}

/** 櫃買個股日成交資訊（單一股票、單月）：官方總成交股數 */
async function tpexStockMonth(code, ym) {
  const j = await request('tpex', `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${encodeURIComponent(`${ym.slice(0, 4)}/${ym.slice(5, 7)}/01`)}&response=json`);
  const t = j && j.tables && j.tables[0];
  if (!t || !Array.isArray(t.data) || !t.data.length) return null;
  return t.data.map((r) => ({ date: fromRoc(r[0]), code, volume: num(r[1]) == null ? null : Math.round(num(r[1]) * 1000) })).filter((r) => r.date && r.volume != null);
}

// ---------- 三大法人 ----------
async function twseInst(iso) {
  const j = await request('twse', `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd(iso)}&selectType=ALLBUT0999&response=json`);
  if (!j || !Array.isArray(j.data) || !j.data.length) return null;
  // 欄位：外陸資(不含外資自營商) 買/賣/超 = 2..4、外資自營商 5..7、投信 8..10、自營商合計 11、…、三大法人 18
  return j.data.filter((r) => isStockCode(String(r[0]).trim())).map((r) => ({
    date: iso, code: String(r[0]).trim(),
    foreign_net: (num(r[4]) || 0) + (num(r[7]) || 0), trust_net: num(r[10]), dealer_net: num(r[11]), total_net: num(r[18]),
  }));
}

async function tpexInst(iso) {
  const j = await request('tpex', `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${roc(iso)}&o=json`);
  const t = j && j.tables && j.tables[0];
  if (!t || !Array.isArray(t.data) || !t.data.length) return null;
  // 欄位：外資及陸資合計 8..10、投信 11..13、自營商合計 20..22、三大法人合計 23
  return t.data.filter((r) => isStockCode(String(r[0]).trim())).map((r) => ({
    date: iso, code: String(r[0]).trim(),
    foreign_net: num(r[10]), trust_net: num(r[13]), dealer_net: num(r[22]), total_net: num(r[23]),
  }));
}

// ---------- 融資融券 ----------
async function twseMargin(iso) {
  const j = await request('twse', `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(iso)}&selectType=ALL&response=json`);
  const t = findTable(j, (x) => x.fields[0] === '代號' && x.data.length > 10);
  if (!t) return null;
  // 融資：買進 2、賣出 3、今日餘額 6；融券：買進(回補) 8、賣出 9、今日餘額 12
  return t.data.filter((r) => isStockCode(String(r[0]).trim())).map((r) => ({
    date: iso, code: String(r[0]).trim(),
    margin_buy: num(r[2]), margin_sell: num(r[3]), margin_balance: num(r[6]),
    short_buy: num(r[8]), short_sell: num(r[9]), short_balance: num(r[12]),
  }));
}

async function tpexMargin(iso) {
  const j = await request('tpex', `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${roc(iso)}`);
  const t = j && j.tables && j.tables[0];
  if (!t || !Array.isArray(t.data) || !t.data.length) return null;
  // 資買 3、資賣 4、資餘額 6；券賣 11、券買 12、券餘額 14
  return t.data.filter((r) => isStockCode(String(r[0]).trim())).map((r) => ({
    date: iso, code: String(r[0]).trim(),
    margin_buy: num(r[3]), margin_sell: num(r[4]), margin_balance: num(r[6]),
    short_sell: num(r[11]), short_buy: num(r[12]), short_balance: num(r[14]),
  }));
}

// ---------- 除權除息（區間） ----------
async function twseExright(fromIso, toIso) {
  const j = await request('twse', `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${ymd(fromIso)}&endDate=${ymd(toIso)}&response=json`);
  if (!j || !Array.isArray(j.data)) return [];
  return j.data.map((r) => ({ date: fromRoc(r[0]), code: String(r[1]).trim(), prev_close: num(r[3]), ref_price: num(r[4]) }))
    .filter((r) => r.date && isStockCode(r.code) && r.prev_close > 0 && r.ref_price > 0);
}

async function tpexExright(fromIso, toIso) {
  const j = await request('tpex', `https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=${roc(fromIso)}&ed=${roc(toIso)}&o=json`);
  const t = j && j.tables && j.tables[0];
  if (!t || !Array.isArray(t.data)) return [];
  return t.data.map((r) => ({ date: fromRoc(r[0]), code: String(r[1]).trim(), prev_close: num(r[3]), ref_price: num(r[4]) }))
    .filter((r) => r.date && isStockCode(r.code) && r.prev_close > 0 && r.ref_price > 0);
}

// ---------- 月營收（公開資訊觀測站，big5 編碼 HTML） ----------
/**
 * @param ym     'YYYY-MM'（營收所屬月份）
 * @param market 'sii' 上市、'otc' 上櫃；kind 0 = 國內公司、1 = 國外（KY）公司
 * 依法須於次月 10 日前申報 → available 設為次月 11 日（之後才能拿來用，避免前視偏差）
 */
async function mopsRevenue(ym, market, kind) {
  const y = Number(ym.slice(0, 4)) - 1911, m = Number(ym.slice(5, 7));
  const buf = await request('mops', `https://mopsov.twse.com.tw/nas/t21/${market}/t21sc03_${y}_${m}_${kind}.html`, { binary: true });
  if (!buf || buf.length < 2000) return null;
  const html = new TextDecoder('big5').decode(buf);
  const next = new Date(Date.UTC(Number(ym.slice(0, 4)), m, 11)); // 次月 11 日
  const available = next.toISOString().slice(0, 10);
  const out = [];
  for (const tr of html.split(/<tr[^>]*>/i)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (cells.length < 10 || !isStockCode(cells[0])) continue;
    // 代號、名稱、當月營收、上月營收、去年當月營收、上月比較%、去年同月%、當月累計、去年累計、前期比較%
    out.push({ ym, code: cells[0], revenue: num(cells[2]), last_month: num(cells[3]), last_year: num(cells[4]), mom: num(cells[5]), yoy: num(cells[6]), cum_yoy: num(cells[9]), available });
  }
  return out.length ? out : null;
}

// ---------- 指數（月資料） ----------
/** 加權指數：證交所「發行量加權股價指數歷史資料」，ym = 'YYYY-MM' */
async function twseIndexMonth(ym) {
  const j = await request('twse', `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym.replace('-', '')}01&response=json`);
  if (!j || j.stat !== 'OK' || !Array.isArray(j.data)) return null;
  return j.data.map((r) => ({ date: fromRoc(r[0]), code: 't00', open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]) }))
    .filter((r) => r.date && r.close > 0);
}

/** 櫃買指數：櫃買中心「櫃買指數（月查詢）」 */
async function tpexIndexMonth(ym) {
  const j = await request('tpex', `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${ym.replace('-', '%2F')}%2F01&response=json`);
  const t = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!t || !Array.isArray(t.data) || !t.data.length) return null;
  return t.data.map((r) => {
    const m = String(r[0]).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    return { date: m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null, code: 'o00', open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]) };
  }).filter((r) => r.date && r.close > 0);
}

module.exports = {
  twseIndexMonth, tpexIndexMonth,
  twseDaily, tpexDaily, tpexStockMonth, twseInst, tpexInst, twseMargin, tpexMargin,
  twseExright, tpexExright, mopsRevenue, num, fromRoc, isStockCode,
};
