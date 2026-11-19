/**
 * 官方資料來源健康檢查：實際下載並解析每個來源，確認連得上、格式沒變、數值合理。
 *   node scripts/check-sources.js [YYYY-MM-DD]
 * 沒給日期時，自動找最近一個有資料的交易日。任何一項失敗 → 結束代碼 1（給 GitHub Actions 判斷用）。
 */
const src = require('../lib/official/sources');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`);
}

const iso = (d) => d.toISOString().slice(0, 10);
function weekdaysBack(n) {
  const out = [];
  const d = new Date(Date.now() + 8 * 3600e3); // 台北日期
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(iso(d));
  }
  return out;
}

const find = (rows, code) => (rows || []).find((r) => r.code === code);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    check(name, false, `${e.message}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  }
}

(async () => {
  console.log(`執行環境：Node ${process.version}，${new Date().toISOString()}`);

  // 1. 找最近一個有資料的交易日（今天的資料可能還沒公布，所以從昨天往回找）
  let date = process.argv[2];
  let tse = null;
  await step('證交所每日收盤行情', async () => {
    for (const d of date ? [date] : weekdaysBack(7)) {
      tse = await src.twseDaily(d);
      if (tse && tse.length) { date = d; break; }
    }
    const t = find(tse, '2330');
    check('證交所每日收盤行情', !!(tse && tse.length > 800 && t && t.close > 0 && t.volume > 0),
      tse ? `${date}，${tse.length} 檔；2330 收 ${t && t.close}、量 ${t && t.volume}` : '最近 7 個平日都沒有資料');
  });
  if (!date) { summary(); return; }

  await step('櫃買中心每日收盤行情', async () => {
    const rows = await src.tpexDaily(date);
    const t = find(rows, '6488');
    check('櫃買中心每日收盤行情', !!(rows && rows.length > 500 && t && t.close > 0), `${rows ? rows.length : 0} 檔；6488 收 ${t && t.close}`);
  });

  await step('證交所三大法人', async () => {
    const rows = await src.twseInst(date);
    const t = find(rows, '2330');
    // 合計 = 外資 + 投信 + 自營商：欄位位置一旦改變，這個等式通常就不成立
    const sumOk = t && Math.abs(t.foreign_net + t.trust_net + t.dealer_net - t.total_net) <= 2;
    check('證交所三大法人', !!(rows && rows.length > 300 && t && sumOk), `${rows ? rows.length : 0} 檔；2330 外資 ${t && t.foreign_net}、合計檢查 ${sumOk ? '通過' : '不符'}`);
  });

  await step('櫃買中心三大法人', async () => {
    const rows = await src.tpexInst(date);
    const t = rows && rows[0];
    const sumOk = t && Math.abs(t.foreign_net + t.trust_net + t.dealer_net - t.total_net) <= 2;
    check('櫃買中心三大法人', !!(rows && rows.length > 200 && sumOk), `${rows ? rows.length : 0} 檔；合計檢查 ${sumOk ? '通過' : '不符'}`);
  });

  await step('證交所融資融券', async () => {
    const rows = await src.twseMargin(date);
    const t = find(rows, '2330');
    check('證交所融資融券', !!(rows && rows.length > 500 && t && t.margin_balance > 0), `${rows ? rows.length : 0} 檔；2330 融資餘額 ${t && t.margin_balance}`);
  });

  await step('櫃買中心融資融券', async () => {
    const rows = await src.tpexMargin(date);
    const t = find(rows, '6488');
    check('櫃買中心融資融券', !!(rows && rows.length > 300 && t && t.margin_balance >= 0), `${rows ? rows.length : 0} 檔；6488 融資餘額 ${t && t.margin_balance}`);
  });

  await step('櫃買個股日成交資訊（官方總量）', async () => {
    const rows = await src.tpexStockMonth('6488', date.slice(0, 7));
    const t = rows && rows.find((r) => r.date === date);
    check('櫃買個股日成交資訊（官方總量）', !!(t && t.volume > 0), `6488 ${date} 總量 ${t && t.volume}`);
  });

  await step('除權除息', async () => {
    const y = date.slice(0, 4);
    const a = await src.twseExright(`${y}-01-01`, date);
    const b = await src.tpexExright(`${y}-01-01`, date);
    check('除權除息', a.length > 100 && b.length > 100, `${y} 年上市 ${a.length} 筆、上櫃 ${b.length} 筆`);
  });

  await step('指數月資料', async () => {
    const ym = date.slice(0, 7);
    const a = await src.twseIndexMonth(ym);
    const b = await src.tpexIndexMonth(ym);
    const ta = a && a.find((r) => r.date === date), tb = b && b.find((r) => r.date === date);
    check('指數月資料', !!(ta && ta.close > 1000 && tb && tb.close > 50), `${date} 加權 ${ta && ta.close}、櫃買 ${tb && tb.close}`);
  });

  // 以下是公開版建置會用到的其他官方來源
  await step('上市櫃股票清單（OpenAPI）', async () => {
    const stocks = require('../lib/stocklist');
    await stocks.refresh();
    const all = stocks.all();
    const tse = all.filter((s) => s.market === 'tse' && s.type === 'stock').length;
    const otc = all.filter((s) => s.market === 'otc' && s.type === 'stock').length;
    check('上市櫃股票清單（OpenAPI）', tse > 1000 && otc > 700, `上市 ${tse} 檔、上櫃 ${otc} 檔`);
  });

  await step('證交所休市日曆', async () => {
    const holidays = require('../lib/holidays');
    await holidays.refreshOfficial();
    const years = holidays.info().officialYears;
    check('證交所休市日曆', years.includes(date.slice(0, 4)), `已取得 ${years.join('、') || '無'} 年`);
  });

  await step('月營收（公開資訊觀測站）', async () => {
    // 次月 10 日前才申報完，所以抓「上上個月」一定齊全
    const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 2);
    const ym = iso(d).slice(0, 7);
    const rows = await src.mopsRevenue(ym, 'sii', 0);
    const t = find(rows, '2330');
    check('月營收（公開資訊觀測站）', !!(rows && rows.length > 800 && t && t.revenue > 0), `${ym} 上市 ${rows ? rows.length : 0} 家；2330 營收 ${t && t.revenue}`);
  });

  summary();
})().catch((e) => { console.error(e); process.exit(1); });

function summary() {
  const bad = results.filter((r) => !r.ok);
  console.log(bad.length ? `\n${bad.length} 項失敗：${bad.map((r) => r.name).join('、')}` : `\n全部 ${results.length} 項正常`);
  process.exit(bad.length ? 1 : 0);
}
