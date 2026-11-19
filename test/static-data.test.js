/**
 * 公開版的 K 線處理：還原權息、公司行動斷點、週 / 月 K 合併
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// public/js 是瀏覽器用的 ES module（專案是 CommonJS），用 data: URL 匯入
const load = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '../public/js/static-data.js'), 'utf8'))}`);

const close = (c) => c.map((x) => x.adjClose);
const ret = (c, i) => c[i].adjClose / c[i - 1].adjClose - 1;

test('還原權息：除息日的跌幅不算報酬；最後一根等於原始收盤價', async () => {
  const { dailyCandles } = await load();
  // 第 3 天除息 5 元：前收 100、參考價 95、收 96 → 當天實際報酬 96 / 95 − 1
  const k = {
    code: '2330', type: 'stock', volSrc: 'official',
    rows: [['2026-01-05', 99, 101, 98, 100, 10], ['2026-01-06', 100, 101, 99, 100, 10], ['2026-01-07', 95, 97, 94, 96, 10], ['2026-01-08', 96, 99, 95, 98, 10]],
    ex: [['2026-01-07', 0.95]],
  };
  const c = dailyCandles(k);
  assert.equal(c[3].adjClose, 98);
  assert.ok(Math.abs(ret(c, 2) - (96 / 95 - 1)) < 1e-12, '除息日報酬應以參考價計算');
  assert.ok(Math.abs(ret(c, 1)) < 1e-12);
  assert.ok(c.every((x) => x.volSrc === 'official'));
});

test('普通股超過漲跌幅限制、又沒有除權息紀錄的跳空，視為公司行動（減資、分割）', async () => {
  const { dailyCandles } = await load();
  const rows = [['2026-01-05', 0, 0, 0, 50, 1], ['2026-01-06', 0, 0, 0, 51, 1], ['2026-01-07', 0, 0, 0, 102, 1], ['2026-01-08', 0, 0, 0, 104, 1]];
  const stock = dailyCandles({ code: '1234', type: 'stock', rows, ex: [] });
  assert.ok(Math.abs(ret(stock, 2)) < 1e-12, '減資造成的 100% 跳空不應被當成上漲');
  assert.ok(Math.abs(ret(stock, 3) - (104 / 102 - 1)) < 1e-12);
  // ETF（例如槓桿型）沒有同樣的漲跌幅限制，不做這個調整
  const etf = dailyCandles({ code: '00631L', type: 'stock', rows, ex: [] });
  assert.ok(Math.abs(ret(etf, 2) - 1) < 1e-12);
  // 漲停（+10%）是正常漲跌，不調整
  const limitUp = dailyCandles({ code: '1234', type: 'stock', rows: [['2026-01-05', 0, 0, 0, 100, 1], ['2026-01-06', 0, 0, 0, 110, 1]], ex: [] });
  assert.ok(Math.abs(ret(limitUp, 1) - 0.1) < 1e-12);
});

test('週 K / 月 K：開盤取第一天、收盤取最後一天、高低取極值、量相加', async () => {
  const { dailyCandles, aggregate } = await load();
  const rows = [
    ['2026-01-05', 10, 12, 9, 11, 100], ['2026-01-06', 11, 15, 10, 14, 200], ['2026-01-09', 14, 14, 8, 9, 50],
    ['2026-01-12', 9, 10, 9, 10, 10],
  ];
  const w = aggregate(dailyCandles({ code: '2330', type: 'stock', rows, ex: [] }), 'W');
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].time, w[0].open, w[0].high, w[0].low, w[0].close, w[0].volume], ['2026-01-05', 10, 15, 8, 9, 350]);
  assert.equal(w[1].time, '2026-01-12');
  const m = aggregate(dailyCandles({ code: '2330', type: 'stock', rows, ex: [] }), 'M');
  assert.deepEqual([m[0].time, m[0].open, m[0].close, m[0].volume], ['2026-01-01', 10, 10, 360]);
  assert.deepEqual(close(m), [10]);
});
