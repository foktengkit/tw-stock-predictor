/**
 * 因子檢驗的前視偏差測試（用模擬資料，不需要網路或資料庫）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPanel, factorsAt, evaluatePanel, summarize, ret, FACTORS, constants } = require('../lib/factors');

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

function weekdays(n, start = '2023-01-02') {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 模擬 120 檔股票、420 個交易日的行情、法人、融資券、月營收 */
function synthRaw({ seed = 1, nStocks = 120, T = 420, tweak } = {}) {
  const r = rng(seed);
  const dates = weekdays(T);
  const raw = { dates, daily: [], inst: [], margin: [], exright: [], revenue: [] };
  for (let k = 0; k < nStocks; k++) {
    const code = String(1100 + k);
    let p = 50 + 50 * r(), mb = 5000 + 5000 * r();
    const rets = dates.map(() => 0.015 * gauss(r));
    for (let i = 0; i < T; i++) {
      p *= Math.exp(rets[i]);
      const vol = 1e6 * (1 + r());
      raw.daily.push({ date: dates[i], code, close: p, volume: vol, value: vol * p * (1 + k / 10) });
      raw.inst.push({ date: dates[i], code, foreign_net: vol * 0.05 * gauss(r), trust_net: vol * 0.02 * gauss(r) });
      mb *= Math.exp(0.01 * gauss(r));
      raw.margin.push({ date: dates[i], code, margin_balance: Math.round(mb), short_balance: Math.round(mb * 0.05 * r()) });
    }
    for (let m = 0; m < 20; m++) {
      const ym = `${2023 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
      const avail = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 11)).toISOString().slice(0, 10);
      raw.revenue.push({ ym, code, yoy: 30 * gauss(r), available: avail });
    }
  }
  if (tweak) tweak(raw);
  return raw;
}

const K = 300; // 「現在」：之後都是未來

function perturbFuture(raw) {
  const cut = raw.dates[K];
  const r = rng(99);
  for (const x of raw.daily) if (x.date > cut) { x.close *= Math.exp(0.3 * gauss(r)); x.volume *= 2; x.value *= 3; }
  for (const x of raw.inst) if (x.date > cut) { x.foreign_net = 1e7 * gauss(r); x.trust_net = 1e7 * gauss(r); }
  for (const x of raw.margin) if (x.date > cut) { x.margin_balance *= 5; }
  for (const x of raw.revenue) if (x.available > cut) x.yoy = 999 * gauss(r);
}

test('因子值只由當天以前、且已公布的資料決定（改動未來資料不影響過去任何因子）', () => {
  const a = buildPanel(synthRaw());
  const b = buildPanel(synthRaw({ tweak: perturbFuture }));
  let checked = 0;
  for (const s of a.codes.values()) {
    const s2 = b.codes.get(s.code);
    for (let t = constants.LOOKBACK; t <= K; t += 7) {
      assert.deepEqual(factorsAt(b, s2, t), factorsAt(a, s, t), `${s.code} 在 ${a.dates[t]} 的因子被未來資料影響`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

test('檢驗結果：預測區間在「現在」以前結束的期數，完全不受未來資料影響', () => {
  const a = evaluatePanel(buildPanel(synthRaw())).periods;
  const b = evaluatePanel(buildPanel(synthRaw({ tweak: perturbFuture }))).periods;
  const done = a.filter((p) => p.t + 1 + constants.FWD <= K);
  assert.ok(done.length >= 10);
  for (const p of done) {
    const q = b.find((x) => x.t === p.t);
    assert.deepEqual(q.ic, p.ic, `${p.date} 的 IC 被未來資料影響`);
  }
});

test('月營收：申報期限前不能使用，期限後才使用', () => {
  const panel = buildPanel(synthRaw());
  const s = panel.codes.get('1100');
  const rev = s.revenue.find((x) => x.ym === '2023-06'); // 2023-07-11 起才可用
  const before = panel.dates.findIndex((d) => d >= '2023-07-11') - 1;
  const after = before + 1;
  assert.ok(panel.dates[before] < '2023-07-11' && panel.dates[after] >= '2023-07-11');
  assert.notEqual(factorsAt(panel, s, before).revYoY, rev.yoy, '申報期限前就用到了 6 月營收');
  assert.equal(factorsAt(panel, s, after).revYoY, rev.yoy);
});

test('報酬從「隔天收盤」起算：只能預測當天→隔天的訊號，檢驗結果應接近 0', () => {
  // 只在檢驗日，讓投信買賣超「剛好等於隔天的漲跌」（其他日為 0，避免 20 日加總把它稀釋掉）
  // 若錯把報酬從當天收盤算起，IC 會明顯為正；正確從隔天收盤起算則應接近 0
  const raw = synthRaw({
    seed: 5,
    tweak: (x) => {
      const di = new Map(x.dates.map((d, i) => [d, i]));
      const byCode = new Map();
      for (const d of x.daily) (byCode.get(d.code) || byCode.set(d.code, []).get(d.code)).push(d);
      const next = new Map();
      for (const list of byCode.values()) for (let i = 0; i + 1 < list.length; i++) next.set(`${list[i].code}|${list[i].date}`, Math.log(list[i + 1].close / list[i].close));
      for (const r of x.inst) {
        const i = di.get(r.date);
        const onRebalance = i >= constants.LOOKBACK && (i - constants.LOOKBACK) % constants.STEP === 0;
        r.trust_net = onRebalance ? (next.get(`${r.code}|${r.date}`) || 0) * 1e8 : 0;
      }
    },
  });
  const panel = buildPanel(raw);
  const { periods } = evaluatePanel(panel);
  const ic = periods.map((p) => p.ic.trust20).filter(Number.isFinite);
  const meanIc = ic.reduce((a, b) => a + b, 0) / ic.length;
  assert.ok(Math.abs(meanIc) < 0.05, `IC 平均 ${meanIc.toFixed(3)}，表示用到了隔天的漲跌`);
  // 對照：如果從當天收盤起算，就會抓到這個「偷看」訊號
  let wrong = 0, n = 0;
  for (const p of periods) {
    const xs = [], ys = [];
    for (const s of panel.codes.values()) {
      const f = factorsAt(panel, s, p.t).trust20, y = ret(s, p.t, p.t + constants.FWD);
      if (Number.isFinite(f) && Number.isFinite(y)) { xs.push(f); ys.push(y); }
    }
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < xs.length; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; }
    wrong += a / Math.sqrt(b * c); n++;
  }
  assert.ok(wrong / n > 0.1, `對照組應該要偵測到偷看訊號（得到 ${(wrong / n).toFixed(3)}）`);
});

test('還原權息：除息日的跌幅不算報酬；沒有對應公司行動的大跳空視為斷點', () => {
  const dates = weekdays(30);
  const daily = dates.map((d, i) => ({ date: d, code: '2330', close: i < 10 ? 100 : i < 20 ? 95 : 190, volume: 1, value: 1 }));
  const panel = buildPanel({ dates, daily, inst: [], margin: [], revenue: [], exright: [{ date: dates[10], code: '2330', prev_close: 100, ref_price: 95 }] });
  const s = panel.codes.get('2330');
  assert.ok(Math.abs(ret(s, 5, 15)) < 1e-12, '除息缺口被當成下跌');
  assert.ok(Number.isNaN(ret(s, 15, 25)), '未還原的 100% 跳空應視為資料斷點');
  assert.ok(Math.abs(ret(s, 21, 25)) < 1e-12);
});

test('每個因子都有被檢驗到', () => {
  const { periods } = evaluatePanel(buildPanel(synthRaw()));
  for (const f of FACTORS) assert.ok(periods.some((p) => Number.isFinite(p.ic[f.key])), `${f.key} 沒有任何一期有結果`);
});

test('沒有籌碼資料的面板（長期檢驗）：籌碼因子為空，營收與價格因子照常計算', () => {
  const raw = synthRaw();
  raw.inst = []; raw.margin = [];
  const panel = buildPanel(raw);
  const s = panel.codes.get('1100');
  assert.equal(s.foreign, null, '沒有法人資料就不該配置籌碼序列');
  const f = factorsAt(panel, s, 330);
  for (const k of ['foreign20', 'trust20', 'margin20', 'shortRatio']) assert.ok(Number.isNaN(f[k]), `${k} 應為空值`);
  for (const k of ['revYoY', 'mom', 'rev20']) assert.ok(Number.isFinite(f[k]), `${k} 應有值`);
  const { periods } = evaluatePanel(panel, { keys: ['revYoY', 'rev20'], start: 20 });
  assert.ok(periods[0].t < constants.LOOKBACK, '指定 start 後應從更早開始檢驗');
  assert.ok(periods.every((p) => !('foreign20' in p.ic)));
  assert.ok(periods.some((p) => Number.isFinite(p.ic.revYoY)));
});

test('法人資料依市場判斷：只有上櫃有資料的日子，上市股票不能當成「法人沒有進出」', () => {
  const dates = weekdays(40);
  const daily = [];
  for (const d of dates) {
    daily.push({ date: d, code: '2330', market: 'tse', close: 100, volume: 1000, value: 1e5 });
    daily.push({ date: d, code: '6488', market: 'otc', close: 100, volume: 1000, value: 1e5 });
  }
  // 上櫃每天都有法人資料；上市只有後 25 天有資料，而且 2330 從來不在名單上（沒有法人進出）
  const inst = dates.map((d) => ({ date: d, code: '6488', foreign_net: 10, trust_net: 0 }));
  for (const d of dates.slice(15)) inst.push({ date: d, code: '2317', foreign_net: 5, trust_net: 0 });
  daily.push(...dates.map((d) => ({ date: d, code: '2317', market: 'tse', close: 50, volume: 1000, value: 5e4 })));
  const panel = buildPanel({ dates, daily, inst, margin: [], exright: [], revenue: [] });
  const tse = panel.codes.get('2330');
  assert.ok(Number.isNaN(factorsAt(panel, tse, 25).foreign20), '上市法人資料還沒回補到的日子，不能算成 0');
  assert.equal(factorsAt(panel, tse, 39).foreign20, 0, '上市有法人資料、但這檔不在名單上 → 0');
  assert.ok(factorsAt(panel, panel.codes.get('6488'), 25).foreign20 > 0);
});

test('只納入 4 碼普通股（排除 ETF、特別股）', () => {
  const dates = weekdays(30);
  const daily = [];
  for (const code of ['2330', '0050', '00878', '2881A', '006208']) {
    for (const d of dates) daily.push({ date: d, code, close: 10, volume: 1, value: 1e9 });
  }
  const panel = buildPanel({ dates, daily, inst: [], margin: [], exright: [], revenue: [] });
  assert.deepEqual([...panel.codes.keys()], ['2330']);
});

test('逐年拆解的期數加總等於總期數，各年 IC 的加權平均等於總平均', () => {
  const raw = synthRaw({ T: 600 });
  const [rev] = summarize(evaluatePanel(buildPanel(raw)).periods, FACTORS.filter((f) => f.key === 'rev20'));
  assert.ok(rev.byYear.length >= 2);
  assert.equal(rev.byYear.reduce((s, y) => s + y.periods, 0), rev.periods);
  const w = rev.byYear.reduce((s, y) => s + y.icMean * y.periods, 0) / rev.periods;
  assert.ok(Math.abs(w - rev.icMean) < 1e-12);
});
