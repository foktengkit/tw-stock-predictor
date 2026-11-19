/**
 * 因子檢驗：股價以外的資料（三大法人、融資融券、月營收）能不能預測「相對」報酬
 *
 * 做法（橫斷面）：每 5 個交易日，在當時成交值前 300 大的股票中，
 *   1. 用「當天收盤後已公布」的資料算因子（月營收要過了申報期限才能用）
 *   2. 量「隔天收盤」起算 20 個交易日的還原權息報酬（多留一天成交時間，避免前視）
 *   3. 計算因子與報酬的等級相關（IC）、前 20% 減後 20% 的報酬差
 * 再把所有日期的 IC 平均，用重疊調整後的有效樣本數做 t 檢定。
 */

const LOOKBACK = 120;   // 價格動能需要的歷史
const FWD = 20;         // 預測期間（交易日）
const STEP = 5;         // 每 5 日檢驗一次（區間重疊 4 倍）
const TOP_N = 300;      // 依 20 日平均成交值取前 300 大
const MIN_STOCKS = 50;
const LIMIT_JUMP = Math.log(1.105); // 漲跌幅限制 10%：單日超過代表有未還原的公司行動（減資、分割…），視為資料斷點
const TESTS = 12;       // 主檢驗 8 個因子 ＋ 長期檢驗 4 個因子
const MULTI_T = 2.87;   // 12 個檢定同時做的 Bonferroni 門檻（雙尾 5%：Φ⁻¹(1 − 0.05 / 24) ≈ 2.865）

const FACTORS = [
  { key: 'foreign20', name: '外資買超強度（20 日）', group: '籌碼', desc: '近 20 日外資買賣超股數 ÷ 成交股數' },
  { key: 'trust20', name: '投信買超強度（20 日）', group: '籌碼', desc: '近 20 日投信買賣超股數 ÷ 成交股數' },
  { key: 'margin20', name: '融資增減（20 日）', group: '籌碼', desc: '融資餘額 20 日變化率' },
  { key: 'shortRatio', name: '券資比', group: '籌碼', desc: '融券餘額 ÷ 融資餘額' },
  { key: 'revYoY', name: '月營收年增率', group: '基本面', desc: '最新一期（已過申報期限）營收年增率' },
  { key: 'revAccel', name: '營收年增率加速', group: '基本面', desc: '最新年增率 − 前 3 期平均年增率' },
  { key: 'mom', name: '價格動能（6 個月）', group: '股價（對照組）', desc: '120 日前到 20 日前的還原報酬' },
  { key: 'rev20', name: '短期反轉（20 日）', group: '股價（對照組）', desc: '近 20 日還原報酬' },
];

const LONG_KEYS = ['revYoY', 'revAccel', 'mom', 'rev20']; // 不需要籌碼資料、可以用更長歷史檢驗的因子

// 檢驗母體只用 4 碼普通股（排除 00 開頭的 ETF、5–6 碼的特別股與 ETF）；也讓面板的記憶體用量小很多
const isStock = (code) => /^[1-9]\d{3}$/.test(code);

// ════════════════════════════════════════════════════════════════
// 面板資料：每檔股票一組與交易日對齊的序列
// ════════════════════════════════════════════════════════════════
const nanArray = (T) => new Float64Array(T).fill(NaN);

/** 籌碼序列（foreign、trust、marginBal、shortBal）用到才配置：長期檢驗的面板沒有籌碼資料 */
function emptySeries(code, market, T) {
  return { code, market, close: nanArray(T), volume: nanArray(T), value: nanArray(T), exLog: new Float64Array(T),
    foreign: null, trust: null, marginBal: null, shortBal: null, revenue: [] };
}

/**
 * @param {{dates: string[], daily, inst, margin, exright, revenue}} raw 依表格的原始資料列（daily 可附 market）
 * @returns panel：dates、codes Map、instDates / marginDates（各市場有資料的日期）
 */
function buildPanel(raw) {
  const dates = raw.dates;
  const T = dates.length;
  const di = new Map(dates.map((d, i) => [d, i]));
  const codes = new Map();
  for (const r of raw.daily) {
    const i = di.get(r.date);
    if (i === undefined || r.close == null || !isStock(r.code)) continue;
    let s = codes.get(r.code);
    if (!s) codes.set(r.code, (s = emptySeries(r.code, r.market || 'tse', T)));
    s.close[i] = r.close; s.volume[i] = r.volume ?? NaN; s.value[i] = r.value ?? NaN;
  }
  // 上市、上櫃的資料分開記錄有哪些日期：回補進度不同時，不能把「另一個市場有資料」當成這檔沒有法人進出
  const instDates = { tse: new Set(), otc: new Set() }, marginDates = { tse: new Set(), otc: new Set() };
  for (const r of raw.inst) {
    const i = di.get(r.date), s = codes.get(r.code);
    if (i === undefined || !s) continue;
    instDates[s.market].add(r.date);
    if (!s.foreign) { s.foreign = nanArray(T); s.trust = nanArray(T); }
    s.foreign[i] = r.foreign_net ?? NaN; s.trust[i] = r.trust_net ?? NaN;
  }
  for (const r of raw.margin) {
    const i = di.get(r.date), s = codes.get(r.code);
    if (i === undefined || !s) continue;
    marginDates[s.market].add(r.date);
    if (!s.marginBal) { s.marginBal = nanArray(T); s.shortBal = nanArray(T); }
    s.marginBal[i] = r.margin_balance ?? NaN; s.shortBal[i] = r.short_balance ?? NaN;
  }
  // 除權息調整：L[i] = ln(收盤) − Σ_{除權息日 ≤ i} ln(參考價 / 前收)，L 的差就是還原權息報酬
  for (const r of raw.exright) {
    const i = di.get(r.date), s = codes.get(r.code);
    if (i === undefined || !s || !(r.prev_close > 0) || !(r.ref_price > 0)) continue;
    s.exLog[i] += Math.log(r.ref_price / r.prev_close);
  }
  for (const s of codes.values()) {
    s.L = new Float64Array(T).fill(NaN);
    s.brk = new Int32Array(T + 1); // 斷點的前綴和
    let cum = 0, prevL = NaN;
    for (let i = 0; i < T; i++) {
      cum += s.exLog[i];
      if (s.close[i] > 0) {
        s.L[i] = Math.log(s.close[i]) - cum;
        const jump = Number.isFinite(prevL) && Math.abs(s.L[i] - prevL) > LIMIT_JUMP;
        s.brk[i + 1] = s.brk[i] + (jump ? 1 : 0);
        prevL = s.L[i];
      } else s.brk[i + 1] = s.brk[i];
    }
    s.exLog = null; // 已併入 L
  }
  for (const r of raw.revenue) {
    const s = codes.get(r.code);
    if (s) s.revenue.push(r);
  }
  for (const s of codes.values()) s.revenue.sort((a, b) => (a.ym < b.ym ? -1 : 1));
  return { dates, codes, instDates, marginDates, di };
}

/** 區間 (a, b] 的還原報酬；含斷點或缺價則為 NaN */
function ret(s, a, b) {
  if (a < 0 || b >= s.L.length || !Number.isFinite(s.L[a]) || !Number.isFinite(s.L[b])) return NaN;
  if (s.brk[b + 1] - s.brk[a + 1] > 0) return NaN;
  return s.L[b] - s.L[a];
}

function sumWindow(arr, t, n, missingAsZero) {
  let sum = 0, cnt = 0;
  for (let i = t - n + 1; i <= t; i++) {
    if (i < 0) return NaN;
    const v = arr ? arr[i] : NaN;
    if (Number.isFinite(v)) { sum += v; cnt++; } else if (missingAsZero && missingAsZero(i)) cnt++;
  }
  return cnt >= n - 3 ? sum : NaN;
}

/** 某股票在交易日 t 收盤後可得的因子值（只用到 t 以前、且 t 當天已公布的資料） */
function factorsAt(panel, s, t) {
  const out = {};
  const vol20 = sumWindow(s.volume, t, 20);
  // 法人：同市場當天有法人資料、但這檔不在名單上 → 視為 0（沒有法人進出）
  const instDay = (i) => panel.instDates[s.market].has(panel.dates[i]);
  const f20 = sumWindow(s.foreign, t, 20, instDay), tr20 = sumWindow(s.trust, t, 20, instDay);
  out.foreign20 = vol20 > 0 ? f20 / vol20 : NaN;
  out.trust20 = vol20 > 0 ? tr20 / vol20 : NaN;
  const mb = s.marginBal ? s.marginBal[t] : NaN, mb20 = s.marginBal && t >= 20 ? s.marginBal[t - 20] : NaN;
  out.margin20 = mb20 >= 100 && Number.isFinite(mb) ? mb / mb20 - 1 : NaN;
  out.shortRatio = mb >= 100 && Number.isFinite(s.shortBal[t]) ? s.shortBal[t] / mb : NaN;
  // 月營收：只用 available ≤ 今天的資料，而且最新一期不能太舊（70 天內）
  const today = panel.dates[t];
  let k = -1;
  for (let j = s.revenue.length - 1; j >= 0; j--) if (s.revenue[j].available <= today) { k = j; break; }
  out.revYoY = NaN; out.revAccel = NaN;
  if (k >= 0 && daysBetween(s.revenue[k].available, today) <= 70) {
    const cur = s.revenue[k];
    out.revYoY = Number.isFinite(cur.yoy) ? cur.yoy : NaN;
    if (k >= 3) {
      const prev = s.revenue.slice(k - 3, k).map((r) => r.yoy).filter(Number.isFinite);
      if (prev.length === 3 && Number.isFinite(cur.yoy)) out.revAccel = cur.yoy - prev.reduce((a, b) => a + b, 0) / 3;
    }
  }
  out.mom = ret(s, t - LOOKBACK, t - 20);
  out.rev20 = ret(s, t - 20, t);
  return out;
}

function daysBetween(a, b) {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3;
}

/** 交易日 t 的檢驗母體：普通股、t 有收盤價、20 日平均成交值前 TOP_N 名 */
function universeAt(panel, t) {
  const list = [];
  for (const s of panel.codes.values()) {
    if (!(s.close[t] > 0)) continue;
    const v = sumWindow(s.value, t, 20);
    if (Number.isFinite(v) && v > 0) list.push([s, v]);
  }
  list.sort((a, b) => b[1] - a[1]);
  return list.slice(0, TOP_N).map((x) => x[0]);
}

function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}

function spearman(x, y) {
  const rx = ranks(x), ry = ranks(y);
  const n = x.length, mx = (n - 1) / 2;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += (rx[i] - mx) * (ry[i] - mx); b += (rx[i] - mx) ** 2; c += (ry[i] - mx) ** 2; }
  return a / Math.sqrt(b * c);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/**
 * 逐期檢驗。每一期：t 收盤算因子 → t+1 收盤進場 → t+1+FWD 收盤出場
 * @param opts.keys  要檢驗的因子（預設全部）
 * @param opts.start 第一個檢驗日的索引（預設 LOOKBACK）；資料還不夠算的因子當期自動略過
 * @returns {{periods: {t, date, ic: {}, spread: {}, n: {}}[]}}
 */
function evaluatePanel(panel, { keys = FACTORS.map((f) => f.key), start = LOOKBACK } = {}) {
  const T = panel.dates.length;
  const periods = [];
  for (let t = Math.max(19, start); t + 1 + FWD < T; t += STEP) {
    const uni = universeAt(panel, t);
    const rows = [];
    for (const s of uni) {
      const fwd = ret(s, t + 1, t + 1 + FWD);
      if (!Number.isFinite(fwd)) continue;
      rows.push({ f: factorsAt(panel, s, t), fwd });
    }
    const p = { t, date: panel.dates[t], ic: {}, spread: {}, n: {} };
    for (const key of keys) {
      const ok = rows.filter((r) => Number.isFinite(r.f[key]));
      if (ok.length < MIN_STOCKS) continue;
      p.ic[key] = spearman(ok.map((r) => r.f[key]), ok.map((r) => r.fwd));
      const sorted = ok.slice().sort((a, b) => a.f[key] - b.f[key]);
      const q = Math.floor(sorted.length / 5);
      p.spread[key] = mean(sorted.slice(-q).map((r) => r.fwd)) - mean(sorted.slice(0, q).map((r) => r.fwd));
      p.n[key] = ok.length;
    }
    periods.push(p);
  }
  return { periods };
}

/** 平均 IC 的 t 值：區間重疊 4 倍，有效樣本數 = 期數 × STEP / FWD */
function icStats(ics) {
  const nEff = (ics.length * STEP) / FWD;
  const icMean = ics.length ? mean(ics) : NaN;
  const t = ics.length > 2 ? icMean / (sd(ics) / Math.sqrt(nEff)) : NaN;
  return { icMean, t };
}

function summarize(periods, list = FACTORS) {
  return list.map((f) => {
    const ps = periods.filter((p) => Number.isFinite(p.ic[f.key]));
    const ics = ps.map((p) => p.ic[f.key]);
    const { icMean, t } = icStats(ics);
    const spread = ps.length ? mean(ps.map((p) => Math.exp(p.spread[f.key]) - 1)) : NaN;
    const verdict = !Number.isFinite(t) ? 'insufficient' : Math.abs(t) >= MULTI_T ? 'significant' : Math.abs(t) >= 2 ? 'marginal' : 'none';
    // 逐年拆開：看效果是穩定存在，還是集中在某一段行情
    const years = new Map();
    for (const p of ps) {
      const y = p.date.slice(0, 4);
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(p);
    }
    const byYear = [...years].map(([year, yp]) => ({
      year, periods: yp.length, icMean: mean(yp.map((p) => p.ic[f.key])),
      spread: mean(yp.map((p) => Math.exp(p.spread[f.key]) - 1)),
    }));
    return {
      ...f, periods: ics.length, from: ps.length ? ps[0].date : null, to: ps.length ? ps[ps.length - 1].date : null,
      avgStocks: ps.length ? Math.round(mean(ps.map((p) => p.n[f.key]))) : 0,
      icMean, t, icPositive: ics.length ? ics.filter((x) => x > 0).length / ics.length : NaN,
      spread, // 前 20% − 後 20% 的平均 20 日報酬差
      direction: icMean > 0 ? 'high' : 'low', verdict, byYear,
    };
  });
}

/** 最新一天：所有股票的因子值與在母體中的百分位 */
function latestRanks(panel) {
  // 法人、融資券在收盤後才公布：用「每個市場兩者都已有資料」的最新一天
  const markets = [...new Set([...panel.codes.values()].map((s) => s.market))];
  const ready = (d) => markets.every((m) => panel.instDates[m].has(d) && panel.marginDates[m].has(d));
  let t = panel.dates.length - 1;
  while (t > 0 && !ready(panel.dates[t])) t--;
  const uni = universeAt(panel, t);
  const vals = new Map(uni.map((s) => [s.code, factorsAt(panel, s, t)]));
  const pct = {};
  for (const { key } of FACTORS) {
    const list = [...vals.entries()].filter(([, f]) => Number.isFinite(f[key])).sort((a, b) => a[1][key] - b[1][key]);
    list.forEach(([code], i) => { (pct[code] ||= {})[key] = list.length > 1 ? i / (list.length - 1) : 0.5; });
  }
  return { date: panel.dates[t], universe: uni.length, vals: Object.fromEntries(vals), pct };
}

// ════════════════════════════════════════════════════════════════
// 從資料庫載入（伺服器的背景執行緒 / 命令列用）
// ════════════════════════════════════════════════════════════════
const DB = () => require('./official/db');
const STOCK_SQL = "code GLOB '[1-9][0-9][0-9][0-9]'";

/** 資料版本：任何官方資料（個股成交量除外）同步過就會改變。只查 sync_log，幾乎不花時間 */
function dataVersion() {
  const db = DB();
  if (!db.get('SELECT 1 x FROM inst LIMIT 1')) return null;
  const r = db.get("SELECT MAX(at) m, COUNT(*) n FROM sync_log WHERE dataset NOT LIKE 'voltotal%'");
  return `${r.m}|${r.n}`;
}

/** 兩個市場都已有法人資料的第一天（回補時兩個市場的進度不同） */
function chipStart() {
  const rows = DB().all("SELECT dataset, MIN(key) k FROM sync_log WHERE dataset IN ('inst_tse', 'inst_otc') AND status = 'ok' GROUP BY dataset");
  return rows.length ? rows.map((r) => r.k).sort().pop() : null;
}

function rawFrom(dates, { market = null, chips = true } = {}) {
  const db = DB();
  const from = dates[0];
  const it = (sql, ...p) => db.open().prepare(sql).iterate(...p); // 逐列串流讀取，避免一次載入百萬列
  const mk = market ? ` AND market = '${market}'` : '';
  return {
    dates,
    daily: it(`SELECT date, code, market, close, volume, value FROM daily WHERE date >= ? AND ${STOCK_SQL}${mk}`, from),
    inst: chips ? it(`SELECT date, code, foreign_net, trust_net FROM inst WHERE date >= ? AND ${STOCK_SQL}`, from) : [],
    margin: chips ? it(`SELECT date, code, margin_balance, short_balance FROM margin WHERE date >= ? AND ${STOCK_SQL}`, from) : [],
    exright: it('SELECT date, code, prev_close, ref_price FROM exright WHERE date >= ?', from),
    revenue: it('SELECT ym, code, yoy, available FROM revenue WHERE ym >= ?', `${Number(from.slice(0, 4)) - 1}-01`),
  };
}

const tseDates = () => DB().all("SELECT DISTINCT date FROM daily WHERE market = 'tse' ORDER BY date").map((r) => r.date);

/** 主檢驗：上市＋上櫃，8 個因子在同一段期間（籌碼資料涵蓋的期間） */
function runMain(allDates, cs) {
  const csIdx = Math.max(0, allDates.findIndex((d) => d >= cs));
  const startIdx = Math.max(0, csIdx - LOOKBACK - 5);
  const panel = buildPanel(rawFrom(allDates.slice(startIdx)));
  // 從籌碼資料滿 20 日起檢驗，讓所有因子比較的是同一段期間
  const start = Math.max(LOOKBACK, csIdx - startIdx + 20);
  const { periods } = evaluatePanel(panel, { start });
  return { factors: summarize(periods), latest: latestRanks(panel) };
}

/** 長期檢驗：不需要籌碼的因子，用上市股票所有有股價與營收的期間（含 2022 年空頭） */
function runLong(allDates) {
  const panel = buildPanel(rawFrom(allDates, { market: 'tse', chips: false }));
  const { periods } = evaluatePanel(panel, { keys: LONG_KEYS, start: 20 });
  return { universe: 'tse', factors: summarize(periods, FACTORS.filter((f) => LONG_KEYS.includes(f.key))) };
}

/** 完整報告（純資料、可序列化；伺服器在背景執行緒呼叫） */
function computeReport() {
  const version = dataVersion();
  const cs = chipStart();
  if (!version || !cs) return null;
  const t0 = Date.now();
  const allDates = tseDates();
  const main = runMain(allDates, cs);
  // 股價歷史比籌碼長一年以上才做長期檢驗
  const csIdx = allDates.findIndex((d) => d >= cs);
  const long = csIdx - LOOKBACK > 250 ? runLong(allDates) : null;
  return {
    version,
    generatedAt: new Date().toISOString(),
    seconds: (Date.now() - t0) / 1000,
    settings: { lookback: LOOKBACK, horizon: FWD, step: STEP, universe: TOP_N, multipleTestT: MULTI_T, tests: TESTS },
    factors: main.factors,
    long,
    latest: main.latest,
  };
}

let cache = null;
/** 同步版本（命令列、測試用）；伺服器請用 factors-service（背景執行緒，不會卡住即時報價） */
function report() {
  const v = dataVersion();
  if (!v) return null;
  if (!cache || cache.version !== v) cache = computeReport();
  return cache;
}

/** 從報告取出某檔股票目前的因子值與百分位（不在前 300 大時沒有百分位） */
function stockFactors(r, code) {
  if (!r) return null;
  const v = r.latest.vals[code];
  return {
    date: r.latest.date,
    inUniverse: !!v,
    factors: r.factors.map((f) => ({ key: f.key, value: v ? v[f.key] : null, percentile: r.latest.pct[code] ? r.latest.pct[code][f.key] ?? null : null })),
  };
}

module.exports = {
  FACTORS, LONG_KEYS, buildPanel, factorsAt, evaluatePanel, summarize, icStats, latestRanks,
  dataVersion, computeReport, report, stockFactors, ret, constants: { LOOKBACK, FWD, STEP, TOP_N, MULTI_T },
};

if (require.main === module) {
  const r = report();
  if (!r) { console.log('官方資料不足'); process.exit(0); }
  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
  const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const show = (list) => {
    for (const f of list) {
      console.log(`${f.name.padEnd(14, '　')} IC ${fx(f.icMean, 4)}  t ${fx(f.t, 2)}  前20%−後20% ${pct(f.spread)}  期數 ${f.periods}（${f.from}～${f.to}）  ${f.verdict}`);
      console.log(`    各年 IC：${f.byYear.map((y) => `${y.year} ${y.icMean >= 0 ? '+' : ''}${y.icMean.toFixed(3)}（${y.periods} 期）`).join('  ')}`);
    }
  };
  console.log(`計算 ${r.seconds.toFixed(1)} 秒；最新資料 ${r.latest.date}；母體 ${r.latest.universe} 檔`);
  console.log('── 主檢驗（上市＋上櫃）──');
  show(r.factors);
  if (r.long) { console.log('── 長期檢驗（僅上市）──'); show(r.long.factors); }
}
