/**
 * 官方資料同步（可中斷、可續傳，由新到舊）
 *
 * 命令列：node lib/official/sync.js [--daily-years 5] [--chips-years 2.5] [--revenue-years 5]
 * 伺服器：syncRecent() 只補最近幾天，盤後定時執行
 */
const { EventEmitter } = require('events');
const db = require('./db');
const src = require('./sources');

const events = new EventEmitter();
const RECENT_RETRY_DAYS = 7; // 最近幾天若「沒資料」可能只是還沒公布，之後要重抓

const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** 由今天往回的所有平日（休市日會在抓取時回傳「沒資料」） */
function weekdaysBack(days) {
  const out = [];
  let d = taipeiToday();
  const stop = addDays(d, -Math.round(days));
  while (d > stop) {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) out.push(d);
    d = addDays(d, -1);
  }
  return out;
}

const DAILY = {
  daily_tse: { host: 'twse', fetch: src.twseDaily, store: storeDaily },
  daily_otc: { host: 'tpex', fetch: src.tpexDaily, store: storeDaily },
  inst_tse: { host: 'twse', fetch: src.twseInst, store: (rows) => db.upsert('inst', ['date', 'code', 'foreign_net', 'trust_net', 'dealer_net', 'total_net'], rows.map((r) => [r.date, r.code, r.foreign_net, r.trust_net, r.dealer_net, r.total_net])) },
  inst_otc: { host: 'tpex', fetch: src.tpexInst, store: (rows) => db.upsert('inst', ['date', 'code', 'foreign_net', 'trust_net', 'dealer_net', 'total_net'], rows.map((r) => [r.date, r.code, r.foreign_net, r.trust_net, r.dealer_net, r.total_net])) },
  margin_tse: { host: 'twse', fetch: src.twseMargin, store: storeMargin },
  margin_otc: { host: 'tpex', fetch: src.tpexMargin, store: storeMargin },
};

function storeDaily(rows) {
  db.upsert('daily', ['date', 'code', 'market', 'open', 'high', 'low', 'close', 'volume', 'value', 'trades'],
    rows.map((r) => [r.date, r.code, r.market, r.open, r.high, r.low, r.close, r.volume, r.value, r.trades]));
  // 上市的每日收盤行情就是官方總量；上櫃的全市場檔只有整股，不寫入 vol_total
  const tse = rows.filter((r) => r.market === 'tse' && r.volume != null);
  if (tse.length) db.upsert('vol_total', ['date', 'code', 'volume'], tse.map((r) => [r.date, r.code, r.volume]));
  return rows.length;
}

function storeMargin(rows) {
  return db.upsert('margin', ['date', 'code', 'margin_buy', 'margin_sell', 'margin_balance', 'short_sell', 'short_buy', 'short_balance'],
    rows.map((r) => [r.date, r.code, r.margin_buy, r.margin_sell, r.margin_balance, r.short_sell, r.short_buy, r.short_balance]));
}

function doneKeys(dataset) {
  const cutoff = addDays(taipeiToday(), -RECENT_RETRY_DAYS);
  const rows = db.all("SELECT key, status FROM sync_log WHERE dataset = ? AND status IN ('ok', 'empty')", dataset);
  // 最近幾天的「沒資料」不算完成（可能只是還沒公布）
  return new Set(rows.filter((r) => r.status === 'ok' || r.key < cutoff).map((r) => r.key));
}

let running = false;
const progress = { running: false, total: 0, done: 0, failed: 0, current: null, startedAt: null };

async function runTasks(tasks, label) {
  // 依主機分組，各主機各自排隊（不同主機可平行）
  const byHost = {};
  for (const t of tasks) (byHost[t.host] ||= []).push(t);
  progress.total += tasks.length;
  await Promise.all(Object.values(byHost).map(async (queue) => {
    for (const t of queue) {
      progress.current = `${t.dataset} ${t.key}`;
      try {
        const rows = await t.run();
        db.logSync(t.dataset, t.key, rows ? 'ok' : 'empty', rows || 0);
        if (rows) events.emit('update', { dataset: t.dataset, key: t.key, rows });
      } catch (e) {
        progress.failed++;
        db.logSync(t.dataset, t.key, 'error', 0);
        console.warn(`[official] ${label} ${t.dataset} ${t.key} 失敗：${e.message}`);
      }
      progress.done++;
      if (progress.done % 25 === 0) console.log(`[official] ${progress.done}/${progress.total}（失敗 ${progress.failed}）${progress.current}`);
    }
  }));
}

function dailyTasks(dataset, dates) {
  const ds = DAILY[dataset];
  const done = doneKeys(dataset);
  return dates.filter((d) => !done.has(d)).map((d) => ({
    dataset, key: d, host: ds.host,
    run: async () => { const rows = await ds.fetch(d); return rows ? ds.store(rows) : null; },
  }));
}

function revenueTasks(months) {
  const out = [];
  const today = taipeiToday();
  for (const [market, kind] of [['sii', 0], ['sii', 1], ['otc', 0], ['otc', 1]]) {
    const dataset = `revenue_${market}${kind}`;
    const done = doneKeys(dataset);
    for (const ym of months) {
      const due = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1)).toISOString().slice(0, 10); // 次月 1 日起才可能有
      if (due > today) continue;
      // 申報期限是次月 10 日：期限後 3 天內都要重抓（之前抓到的可能只是部分公司）
      const settled = addDays(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 13)).toISOString().slice(0, 10), 0) < today;
      if (settled && done.has(ym)) continue;
      out.push({
        dataset, key: ym, host: 'mops',
        run: async () => {
          const rows = await src.mopsRevenue(ym, market, kind);
          if (!rows) return null;
          return db.upsert('revenue', ['ym', 'code', 'revenue', 'last_month', 'last_year', 'mom', 'yoy', 'cum_yoy', 'available'],
            rows.map((r) => [r.ym, r.code, r.revenue, r.last_month, r.last_year, r.mom, r.yoy, r.cum_yoy, r.available]));
        },
      });
    }
  }
  return out;
}

/** 除權息依「日曆年」分段抓；今年每次都重抓（會有新的除權息），往年抓過就好 */
function exrightTasks(years) {
  const out = [];
  const today = taipeiToday();
  const thisYear = Number(today.slice(0, 4));
  for (let y = thisYear; y > thisYear - Math.ceil(years) - 1; y--) {
    const start = `${y}-01-01`, end = y === thisYear ? today : `${y}-12-31`;
    const key = String(y);
    for (const [dataset, host, fn] of [['exright_tse', 'twse', src.twseExright], ['exright_otc', 'tpex', src.tpexExright]]) {
      if (y !== thisYear && doneKeys(dataset).has(key)) continue;
      out.push({
        dataset, key, host,
        run: async () => {
          const rows = await fn(start, end);
          return db.upsert('exright', ['date', 'code', 'prev_close', 'ref_price'], rows.map((r) => [r.date, r.code, r.prev_close, r.ref_price])) || null;
        },
      });
    }
  }
  return out;
}

function monthsBack(years) {
  const out = [];
  const d = new Date(`${taipeiToday().slice(0, 7)}-01T00:00:00Z`);
  for (let i = 0; i < Math.round(years * 12); i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** 完整回補：由新到舊交錯各資料集，讓最近的資料先完整 */
async function backfill({ dailyYears = 5, chipsYears = 2.5, revenueYears = 5 } = {}) {
  if (running) return;
  running = true;
  Object.assign(progress, { running: true, total: 0, done: 0, failed: 0, startedAt: new Date().toISOString() });
  try {
    const dailyDates = weekdaysBack(dailyYears * 365.25);
    const chipDates = weekdaysBack(chipsYears * 365.25);
    // 除權息要涵蓋所有有股價的年份，還原報酬才正確
    const tasks = [...exrightTasks(Math.max(dailyYears, chipsYears, 1)), ...revenueTasks(monthsBack(revenueYears))];
    // 交錯：同一天的行情、法人、融資券排在一起，由新到舊
    const lists = {
      daily_tse: dailyTasks('daily_tse', dailyDates), daily_otc: dailyTasks('daily_otc', chipDates),
      inst_tse: dailyTasks('inst_tse', chipDates), inst_otc: dailyTasks('inst_otc', chipDates),
      margin_tse: dailyTasks('margin_tse', chipDates), margin_otc: dailyTasks('margin_otc', chipDates),
    };
    const byDate = new Map();
    for (const list of Object.values(lists)) for (const t of list) (byDate.get(t.key) || byDate.set(t.key, []).get(t.key)).push(t);
    for (const d of [...byDate.keys()].sort().reverse()) tasks.push(...byDate.get(d));
    console.log(`[official] 回補 ${tasks.length} 項（每日行情 ${dailyYears} 年、籌碼 ${chipsYears} 年、月營收 ${revenueYears} 年）`);
    await runTasks(tasks, '回補');
  } finally {
    running = false;
    progress.running = false;
    progress.current = null;
  }
}

/** 伺服器定時呼叫：補最近 10 個平日、最近 3 個月營收與最近一年的除權息 */
async function syncRecent() {
  if (running) return;
  running = true;
  progress.running = true;
  try {
    const dates = weekdaysBack(14);
    const tasks = [...exrightTasks(0), ...revenueTasks(monthsBack(0.25))];
    for (const ds of Object.keys(DAILY)) tasks.push(...dailyTasks(ds, dates));
    if (tasks.length) await runTasks(tasks, '每日同步');
  } finally {
    running = false;
    progress.running = false;
    progress.current = null;
  }
}

/** 上櫃個股官方總成交量：依需要逐月下載（只抓沒抓過的月份；當月與上月每次重抓） */
const stockMonthBusy = new Set();
async function syncTpexStock(code, months = 60) {
  if (stockMonthBusy.has(code)) return;
  stockMonthBusy.add(code);
  try {
    const dataset = `voltotal_otc_${code}`;
    const done = doneKeys(dataset);
    const recent = new Set(monthsBack(1 / 12).concat([taipeiToday().slice(0, 7)]));
    const list = [taipeiToday().slice(0, 7), ...monthsBack(months / 12)].filter((ym) => recent.has(ym) || !done.has(ym));
    for (const ym of list) {
      try {
        const rows = await src.tpexStockMonth(code, ym);
        if (rows) db.upsert('vol_total', ['date', 'code', 'volume'], rows.map((r) => [r.date, r.code, r.volume]));
        db.logSync(dataset, ym, rows ? 'ok' : 'empty', rows ? rows.length : 0);
        if (rows) events.emit('update', { dataset: 'voltotal_otc', key: ym, code, rows: rows.length });
      } catch (e) {
        console.warn(`[official] 上櫃 ${code} ${ym} 成交量失敗：${e.message}`);
      }
    }
  } finally {
    stockMonthBusy.delete(code);
  }
}

function status() {
  const rows = db.all(`SELECT dataset, status, COUNT(*) n, MAX(CASE WHEN status='ok' THEN key END) latest, MIN(CASE WHEN status='ok' THEN key END) earliest
                       FROM sync_log WHERE dataset NOT LIKE 'voltotal_otc_%' GROUP BY dataset, status`);
  const by = {};
  for (const r of rows) {
    const d = (by[r.dataset] ||= { ok: 0, empty: 0, error: 0, latest: null, earliest: null });
    d[r.status] = r.n;
    if (r.latest) { d.latest = r.latest; d.earliest = r.earliest; }
  }
  return { progress: { ...progress }, datasets: by };
}

module.exports = { backfill, syncRecent, syncTpexStock, status, events };

// ---------- 命令列 ----------
if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
  backfill({ dailyYears: arg('--daily-years', 5), chipsYears: arg('--chips-years', 2.5), revenueYears: arg('--revenue-years', 5) })
    .then(() => { console.log('[official] 回補完成', JSON.stringify(status().datasets)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
