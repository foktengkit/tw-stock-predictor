/**
 * 前視偏差（look-ahead bias）金絲雀測試
 * 核心想法：任何在時點 k 做出的預測 / 計算出的指標，都不應該因為「k 之後的資料改變」而改變。
 * 執行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const TA = require('../public/js/indicators.js');
const { walkForward, inverseErrorWeights, knnAnalog, forecast, MODELS, BT } = require('../lib/predict');

/** 把模擬對數價格包成日 K（只略過週末的日期） */
function toCandles(logp) {
  const d = new Date('2023-01-02T00:00:00Z');
  return logp.map((v) => {
    while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    const time = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    const p = Math.exp(v);
    return { time, open: p, high: p, low: p, close: p, volume: 1000 };
  });
}

// 可重現的隨機數（mulberry32）
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

/** 帶一點自相關與趨勢的模擬對數價格 */
function synthLogp(n, seed = 7) {
  const r = rng(seed);
  const out = [Math.log(100)];
  let prev = 0;
  for (let i = 1; i < n; i++) {
    const ret = 0.0003 + 0.15 * prev + 0.018 * gauss(r);
    out.push(out[i - 1] + ret);
    prev = ret;
  }
  return out;
}

/** 從 k+1 起把未來資料換成完全不同的走勢 */
function perturbAfter(logp, k, seed = 99) {
  const r = rng(seed);
  return logp.map((v, i) => (i <= k ? v : v + 0.2 * Math.sin(i / 7) + 0.05 * gauss(r)));
}

const LOGP = synthLogp(760);
const K = 560; // 「現在」：之後的資料都視為未來

test('walk-forward：改動未來資料，不影響「當時」的任何預測、權重與集成結果', () => {
  const a = walkForward(LOGP);
  const b = walkForward(perturbAfter(LOGP, K));
  const before = a.rows.filter((r) => r.o <= K);
  assert.ok(before.length >= 20, '應有足夠的時點落在 K 之前');
  for (const ra of before) {
    const rb = b.rows.find((x) => x.o === ra.o);
    assert.deepEqual(rb.preds, ra.preds, `o=${ra.o} 的模型預測被未來資料影響`);
    assert.deepEqual(rb.preds20, ra.preds20, `o=${ra.o} 的 20 日模型預測被未來資料影響`);
    assert.deepEqual(rb.weights, ra.weights, `o=${ra.o} 的集成權重被未來資料影響`);
    assert.equal(rb.ens, ra.ens, `o=${ra.o} 的集成預測被未來資料影響`);
    assert.equal(rb.ens20, ra.ens20, `o=${ra.o} 的 20 日集成預測被未來資料影響`);
  }
});

test('對照組：舊做法（用全部回測結果決定權重再回頭評分）會被未來資料影響 → 證明本測試抓得到洩漏', () => {
  const oldEnsemble = (wf) => {
    const w = inverseErrorWeights(wf.rows); // 用了所有時點（包含當時還不知道答案的）
    return new Map(wf.rows.map((r) => [r.o, MODELS.reduce((s, m) => s + w[m.key] * r.preds[m.key], 0)]));
  };
  const a = oldEnsemble(walkForward(LOGP));
  const b = oldEnsemble(walkForward(perturbAfter(LOGP, K)));
  const changed = [...a.keys()].filter((o) => o <= K && a.get(o) !== b.get(o));
  assert.ok(changed.length > 0, '舊做法應該要被抓到');
});

test('回測時點互不重疊，且權重只用已實現的結果', () => {
  const { rows, Hb } = walkForward(LOGP);
  assert.equal(Hb, BT.Hb);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].o - rows[i - 1].o, Hb, '相鄰時點間隔應等於預測天數');
    assert.ok(rows[i - 1].o + Hb <= rows[i].o, '前一時點的答案必須在本時點之前揭曉');
  }
});

test('K 近鄰：候選片段與其後續走勢都在查詢視窗之前結束', () => {
  const W = 20, H = 5;
  const res = knnAnalog(LOGP, H, { W });
  const nR = LOGP.length - 1;
  for (const m of res.matches) {
    const e = m.index - 1; // 報酬序列中的片段結尾
    assert.ok(e + H < nR - W, `候選片段 e=${e} 與查詢視窗重疊`);
  }
});

test('還原權息不引入前視：價格整體乘上常數，預測只平移、誤差與權重完全不變', () => {
  const c = Math.log(0.83); // 模擬「未來除息」造成的整段縮放
  const a = walkForward(LOGP);
  const b = walkForward(LOGP.map((v) => v + c));
  for (let i = 0; i < a.rows.length; i++) {
    for (const m of MODELS) assert.ok(Math.abs(b.rows[i].preds[m.key] - a.rows[i].preds[m.key] - c) < 1e-9, `${m.key} 不是平移不變`);
    for (const m of MODELS) assert.ok(Math.abs(b.rows[i].weights[m.key] - a.rows[i].weights[m.key]) < 1e-9);
  }
});

test('技術指標：任一時點的數值只由當時以前的 K 棒決定（不偷看未來、沒有時間軸錯位）', () => {
  const r = rng(3);
  const n = 400, k = 300;
  const close = [], high = [], low = [], vol = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= Math.exp(0.02 * gauss(r));
    close.push(p); high.push(p * (1 + 0.01 * r())); low.push(p * (1 - 0.01 * r())); vol.push(1000 + 500 * r());
  }
  const cut = (a) => a.slice(0, k + 1);
  const fut = (a) => a.map((v, i) => (i <= k ? v : v * (1.5 + r())));
  const cases = {
    sma: (c) => TA.sma(c.close, 20),
    ema: (c) => TA.ema(c.close, 20),
    hma: (c) => TA.hma(c.close, 9),
    vwma: (c) => TA.vwma(c.close, c.vol, 20),
    rsi: (c) => TA.rsi(c.close, 14),
    'macd.signal': (c) => TA.macd(c.close).signal,
    'bollinger.upper': (c) => TA.bollinger(c.close).upper,
    'kd.d': (c) => TA.kd(c.high, c.low, c.close).d,
    'stoch.d': (c) => TA.stoch(c.high, c.low, c.close).d,
    cci: (c) => TA.cci(c.high, c.low, c.close),
    'adx.adx': (c) => TA.adx(c.high, c.low, c.close).adx,
    williamsR: (c) => TA.williamsR(c.high, c.low, c.close),
    ultimateOsc: (c) => TA.ultimateOsc(c.high, c.low, c.close),
    'stochRsi.d': (c) => TA.stochRsi(c.close).d,
    ichimokuBase: (c) => TA.ichimokuBase(c.high, c.low),
    momentum: (c) => TA.momentum(c.close),
  };
  const full = { close, high, low, vol };
  const past = { close: cut(close), high: cut(high), low: cut(low), vol: cut(vol) };
  const changedFuture = { close: fut(close), high: fut(high), low: fut(low), vol: fut(vol) };
  for (const [name, f] of Object.entries(cases)) {
    const a = f(full), b = f(past), c = f(changedFuture);
    for (let i = 0; i <= k; i++) {
      assert.equal(a[i], b[i], `${name}[${i}] 與只用過去資料算出的值不同`);
      assert.equal(c[i], a[i], `${name}[${i}] 被未來資料影響`);
    }
  }
});

test('盤中未收盤的最後一根：可當預測起點，但絕不當回測答案', () => {
  const candles = toCandles(LOGP);
  const n = candles.length;
  const a = forecast(candles, 20, {}, { lastBarPartial: true });
  const b = forecast(candles.slice(0, -1), 20, {}, { lastBarPartial: false });
  // 回測結果應與「把最後一根拿掉」完全相同
  assert.deepEqual(a.backtest.ensemble, b.backtest.ensemble);
  assert.equal(a.backtest.to, candles[n - 2].time);
  assert.equal(a.lastPrice, candles[n - 1].close, '預測起點仍是目前價');
});

test('除權息：已公告金額從除息日起扣除，之前的預測不受影響；金額待公告者不扣', () => {
  const candles = toCandles(LOGP);
  const base = forecast(candles, 20);
  const ex = base.path[7].time;
  const withDiv = forecast(candles, 20, {}, { exEvents: [{ date: ex, cash: 2, stockRatio: 0, pending: false }] });
  for (let h = 0; h < 20; h++) {
    const expect = base.path[h].time >= ex ? base.path[h].value - 2 : base.path[h].value;
    assert.ok(Math.abs(withDiv.path[h].value - expect) < 1e-9, `第 ${h + 1} 天預測價錯誤`);
  }
  const pending = forecast(candles, 20, {}, { exEvents: [{ date: ex, cash: 0, stockRatio: 0, pending: true }] });
  assert.deepEqual(pending.path.map((p) => p.value), base.path.map((p) => p.value));
  assert.equal(pending.dividends[0].pending, true);
});
