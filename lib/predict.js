/**
 * 股價預測引擎
 *  - 4 個模型：阻尼 Holt 指數平滑、線性趨勢回歸、AR(5) 報酬自我迴歸、K 近鄰歷史型態比對
 *  - 以滾動回測（walk-forward）計算各模型誤差，依誤差倒數加權成集成預測
 *  - 以 EWMA 波動度估計 80% / 95% 信賴區間與上漲機率
 * 注意：股價接近隨機漫步，任何模型的預測力都有限，結果僅供參考。
 */

const H_MAX = 20;
const MIN_BARS = 260;

const diffs = (a) => a.slice(1).map((v, i) => v - a[i]);
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c];
    if (Math.abs(piv) < 1e-14) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// ---------- 模型 1：阻尼 Holt 指數平滑（對數價格） ----------
function holtState(y, a, b, phi) {
  let l = y[0], tr = y[1] - y[0], sse = 0;
  for (let t = 1; t < y.length; t++) {
    const e = y[t] - (l + phi * tr);
    sse += e * e;
    const lp = l;
    l = a * y[t] + (1 - a) * (lp + phi * tr);
    tr = b * (l - lp) + (1 - b) * phi * tr;
  }
  return { l, tr, sse };
}
function holtOptimize(y) {
  let best = null;
  for (const a of [0.3, 0.5, 0.7, 0.85, 0.95, 1])
    for (const b of [0.01, 0.03, 0.08, 0.15, 0.3])
      for (const phi of [0.8, 0.9, 0.95, 0.98]) {
        const { sse } = holtState(y, a, b, phi);
        if (!best || sse < best.sse) best = { a, b, phi, sse };
      }
  return best;
}
const holtModel = {
  key: 'holt',
  name: '阻尼趨勢指數平滑',
  desc: 'Damped Holt：追蹤價格水準與趨勢，並讓趨勢隨時間衰減',
  prepare: (logp) => holtOptimize(logp.slice(-250)),
  forecast(logp, H, p) {
    const { l, tr } = holtState(logp.slice(-250), p.a, p.b, p.phi);
    const out = [];
    let damp = 0;
    for (let h = 1; h <= H; h++) { damp += p.phi ** h; out.push(l + damp * tr); }
    return out;
  },
};

// ---------- 模型 2：線性趨勢回歸（近 60 日，斜率折半避免過度外插） ----------
const trendModel = {
  key: 'trend',
  name: '線性趨勢回歸',
  desc: '以近 60 個交易日對數價格做最小平方法回歸，斜率折半後外插',
  prepare: () => null,
  forecast(logp, H) {
    const y = logp.slice(-60), n = y.length;
    const xm = (n - 1) / 2, ym = mean(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) ** 2; }
    const slope = (sxy / sxx) * 0.5;
    const last = logp[logp.length - 1];
    return Array.from({ length: H }, (_, h) => last + slope * (h + 1));
  },
};

// ---------- 模型 3：AR(5) 自我迴歸（日報酬，Ridge 正則化） ----------
const arModel = {
  key: 'ar',
  name: 'AR(5) 自我迴歸',
  desc: '以前 5 日報酬預測下一日報酬（Ridge 正則化），遞迴產生路徑',
  prepare: () => null,
  forecast(logp, H) {
    const P = 5;
    const r = diffs(logp).slice(-500);
    const n = r.length;
    const last = logp[logp.length - 1];
    if (n < P + 50) return Array(H).fill(last);
    const D = P + 1;
    const XtX = Array.from({ length: D }, () => Array(D).fill(0));
    const Xty = Array(D).fill(0);
    for (let t = P; t < n; t++) {
      const x = [1];
      for (let j = 1; j <= P; j++) x.push(r[t - j]);
      for (let i = 0; i < D; i++) { Xty[i] += x[i] * r[t]; for (let k = 0; k < D; k++) XtX[i][k] += x[i] * x[k]; }
    }
    const lam = 0.5 * (n - P) * mean(r.map((v) => v * v));
    for (let i = 1; i < D; i++) XtX[i][i] += lam;
    const w = solve(XtX, Xty);
    if (!w) return Array(H).fill(last);
    const hist = r.slice(-P);
    const out = [];
    let cum = last;
    for (let h = 0; h < H; h++) {
      let next = w[0];
      for (let j = 1; j <= P; j++) next += w[j] * hist[hist.length - j];
      next = clamp(next, -0.1, 0.1);
      hist.push(next);
      cum += next;
      out.push(cum);
    }
    return out;
  },
};

// ---------- 模型 4：K 近鄰歷史型態比對 ----------
function knnAnalog(logp, H, { W = 20, K = 12 } = {}) {
  const r = diffs(logp);
  const n = r.length;
  if (n < 2 * W + H + 100) return null;
  const shape = (seg) => { const sd = std(seg) || 1e-9; let c = 0; return seg.map((v) => (c += v) / sd); };
  const targetSeg = r.slice(n - W);
  const target = shape(targetSeg);
  const sdT = std(targetSeg);
  const cands = [];
  // 候選片段（含其後 H 天）必須在查詢視窗開始之前結束：否則會和查詢視窗共用資料，
  // 形成「自己比對自己」的假相似，後續走勢也只是在重複最近幾天
  for (let e = W - 1; e + H < n - W; e++) {
    const seg = r.slice(e - W + 1, e + 1);
    const z = shape(seg);
    let d = 0;
    for (let i = 0; i < W; i++) d += (z[i] - target[i]) ** 2;
    cands.push({ e, d, sd: std(seg) });
  }
  cands.sort((a, b) => a.d - b.d);
  const chosen = [];
  for (const c of cands) {
    if (chosen.every((x) => Math.abs(x.e - c.e) >= 5)) chosen.push(c);
    if (chosen.length >= K) break;
  }
  const path = Array(H).fill(0);
  let wsum = 0, upW = 0;
  const matches = [];
  for (const c of chosen) {
    const w = 1 / (Math.sqrt(c.d) + 1e-6);
    const scale = c.sd > 0 ? clamp(sdT / c.sd, 0.5, 2) : 1;
    let cum = 0;
    for (let h = 0; h < H; h++) { cum += r[c.e + 1 + h] * scale; path[h] += w * cum; }
    wsum += w;
    if (cum > 0) upW += w;
    matches.push({ index: c.e + 1, distance: Math.sqrt(c.d), forwardReturn: Math.exp(logp[c.e + 1 + H] - logp[c.e + 1]) - 1 });
  }
  const last = logp[logp.length - 1];
  return { path: path.map((v) => last + v / wsum), upProb: upW / wsum, matches };
}
const knnModel = {
  key: 'knn',
  name: 'K 近鄰型態比對',
  desc: '在歷史中找出與近 20 日走勢形狀最相似的 12 段，平均其後續走勢',
  prepare: () => null,
  forecast(logp, H) {
    const res = knnAnalog(logp, H);
    return res ? res.path : Array(H).fill(logp[logp.length - 1]);
  },
};

const MODELS = [holtModel, trendModel, arModel, knnModel];

// ---------- 滾動回測（Walk-Forward，擴張視窗） ----------
const BT = { Hb: 5, origins: 100, warmup: 8 };

/** 絕對百分比誤差：|預測價 / 實際價 − 1| */
const ape = (f, actual) => Math.abs(Math.exp(f - actual) - 1);

/** 依「已實現」的歷史誤差計算權重（誤差倒數）；樣本太少時用等權重 */
function inverseErrorWeights(rows) {
  if (rows.length < BT.warmup) return Object.fromEntries(MODELS.map((m) => [m.key, 1 / MODELS.length]));
  const inv = MODELS.map((m) => 1 / Math.max(1e-9, mean(rows.map((r) => ape(r.preds[m.key], r.actual)))));
  const sum = inv.reduce((a, b) => a + b, 0);
  return Object.fromEntries(MODELS.map((m, i) => [m.key, inv[i] / sum]));
}

/**
 * 每個預測時點 o：
 *  1. 只用 logp[0..o] 重新估計模型參數並預測 o + Hb（不使用任何 o 之後的資料）
 *  2. 時點間隔 = Hb，評估區間互不重疊，樣本彼此獨立
 *  3. 集成權重只用「在 o 當下已經知道答案」的過去時點（o' + Hb ≤ o）計算
 *  4. 與畫面一致：每次都產生完整的 H_MAX（20）日路徑，取第 Hb 天與第 20 天分別評估
 * @returns {{rows: {o, base, actual, preds, weights, ens, actual20, preds20, ens20}[], Hb, Hl}} rows 由舊到新
 *          actual20 在答案尚未揭曉的最近幾個時點為 null
 */
function walkForward(logp, { Hb = BT.Hb, origins = BT.origins } = {}) {
  const n = logp.length, Hl = H_MAX;
  const rows = [];
  for (let o = n - 1 - Hb; o >= MIN_BARS - 60 && rows.length < origins; o -= Hb) {
    const hist = logp.slice(0, o + 1);
    const preds = {}, preds20 = {};
    for (const m of MODELS) {
      const path = m.forecast(hist, Hl, m.prepare(hist));
      preds[m.key] = path[Hb - 1];
      preds20[m.key] = path[Hl - 1];
    }
    rows.push({ o, base: logp[o], actual: logp[o + Hb], actual20: o + Hl < n ? logp[o + Hl] : null, preds, preds20 });
  }
  rows.reverse();
  rows.forEach((row, i) => {
    // 權重只用 5 日答案已揭曉的過去時點；20 日預測沿用同一組權重（與實盤預測相同）
    const known = rows.slice(0, i).filter((r) => r.o + Hb <= row.o);
    row.weights = inverseErrorWeights(known);
    row.ens = MODELS.reduce((s, m) => s + row.weights[m.key] * row.preds[m.key], 0);
    row.ens20 = MODELS.reduce((s, m) => s + row.weights[m.key] * row.preds20[m.key], 0);
  });
  return { rows, Hb, Hl };
}

// 回測只依賴「已收盤」的資料，同一批資料重算結果相同 → 快取（盤中每 5 秒報價變動也不必重跑）
const wfCache = new Map();
function cachedWalkForward(logp, key) {
  if (!key) return walkForward(logp);
  const k = `${key}|${logp.length}|${logp[logp.length - 1].toFixed(8)}`;
  if (!wfCache.has(k)) {
    if (wfCache.size > 300) wfCache.delete(wfCache.keys().next().value);
    wfCache.set(k, walkForward(logp));
  }
  return wfCache.get(k);
}

/** Wilson 95% 信賴區間（比常態近似在小樣本更準） */
function wilson(k, n, z = 1.96) {
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * @param pick    取出預測值
 * @param actualOf 取出實際值（預設 5 日）
 * @param overlap 評估區間重疊倍數（20 日預測每 5 日做一次 = 4），信賴區間用有效樣本數 n / overlap
 */
function score(rows, pick, actualOf = (r) => r.actual, overlap = 1) {
  let hits = 0, n = 0;
  const apes = [];
  for (const r of rows) {
    const f = pick(r), a = actualOf(r);
    if (a == null) continue;
    apes.push(ape(f, a));
    if (f !== r.base && a !== r.base) { n++; if (Math.sign(f - r.base) === Math.sign(a - r.base)) hits++; }
  }
  const nEff = n / overlap;
  return {
    mape: apes.length ? mean(apes) : null, hitRate: n ? hits / n : null, hits, n,
    ci95: n ? wilson((hits / n) * nEff, nEff) : null,
  };
}

/** 方向準確率的基準：「永遠猜漲」能猜對的比例 */
function alwaysUpRate(rows, actualOf) {
  const moves = rows.filter((r) => actualOf(r) != null && actualOf(r) !== r.base);
  return moves.length ? moves.filter((r) => actualOf(r) > r.base).length / moves.length : null;
}

/**
 * 預測模型用的價格：還原權息（除息缺口不算下跌），並等比例縮放到最後一根與原始價格相同。
 * 還原造成的「未來除息」影響在任一時點之前只是常數倍數（對數空間的平移），
 * 而本檔所有模型與誤差指標都對平移不變，因此不會引入前視偏差。
 */
function modelPrices(candles) {
  let k = -1;
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].adjClose > 0) { k = i; break; }
  if (k < 0) return candles.map((c) => c.close);
  const f = candles[k].close / candles[k].adjClose;
  return candles.map((c, i) => (i <= k && c.adjClose > 0 ? c.adjClose * f : c.close));
}

function ewmaVol(r, lambda = 0.94) {
  const rr = r.slice(-250);
  let v = mean(rr.slice(0, 30).map((x) => x * x));
  for (const x of rr) v = lambda * v + (1 - lambda) * x * x;
  return Math.sqrt(v);
}

/**
 * 從 lastDate 之後依序找出 H 個交易日，跳過週末與休市日
 * @param {{isTradingDay?: Function, holidayOf?: Function}} cal 休市日曆（未提供時只跳過週末）
 * @returns {{dates: string[], skipped: {date, name, estimated}[]}} skipped 為被跳過的平日休市日
 */
function nextTradingDays(lastDate, H, cal = {}) {
  const d = new Date(`${lastDate}T00:00:00Z`);
  const dates = [], skipped = [];
  while (dates.length < H) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    const h = cal.holidayOf && cal.holidayOf(iso);
    if (h) { skipped.push({ date: iso, ...h }); continue; }
    dates.push(iso);
  }
  return { dates, skipped };
}

/**
 * @param {{time:string, close:number}[]} candles 日 K（由舊到新）
 * @param {{holidayOf?: Function, hasOfficialYear?: Function}} calendar 休市日曆
 * @param {{lastBarPartial?: boolean, exEvents?: object[], cacheKey?: string}} opt
 *   lastBarPartial 盤中時最後一根是「目前價」而非收盤價：可當預測起點，但不可當回測答案，也不納入波動度
 *   exEvents       已公告的除權息（{date, cash, stockRatio, pending}），用來把總報酬預測換回原始股價
 *   cacheKey       回測結果快取鍵（同一批已收盤資料不必重算）
 */
function forecast(candles, H = H_MAX, calendar = {}, { lastBarPartial = false, exEvents = [], cacheKey = null } = {}) {
  H = clamp(Math.round(H) || H_MAX, 1, H_MAX);
  if (candles.length < MIN_BARS) {
    throw Object.assign(new Error(`歷史資料不足（需至少 ${MIN_BARS} 個交易日，目前 ${candles.length}）`), { status: 422 });
  }
  const logp = modelPrices(candles).map(Math.log);
  const last = logp[logp.length - 1];
  const lastPrice = candles[candles.length - 1].close;
  const logpDone = lastBarPartial ? logp.slice(0, -1) : logp; // 只含已收盤的 K 棒

  // 樣本外回測：每個時點只用當時以前的資料，權重也只用當時已實現的誤差
  const wf = cachedWalkForward(logpDone, cacheKey);
  const ensScore = score(wf.rows, (r) => r.ens);
  const rwScore = score(wf.rows, (r) => r.base);
  // 方向準確率的正確基準不是 50%：多頭期間「永遠猜漲」本身就超過一半
  const alwaysUp = alwaysUpRate(wf.rows, (r) => r.actual);
  // 畫面主打的是 20 日預測，也要回測 20 日（每 5 日一次 → 區間重疊 4 倍）
  const a20 = (r) => r.actual20;
  const overlap20 = wf.Hl / wf.Hb;
  const ens20 = score(wf.rows, (r) => r.ens20, a20, overlap20);
  const rw20 = score(wf.rows, (r) => r.base, a20);
  const alwaysUp20 = alwaysUpRate(wf.rows, a20);
  // 上漲機率的對照：近 500 個交易日中，任意 20 日區間的上漲比例（全為已知資料）
  const lp = logpDone.slice(-520);
  const win20 = lp.slice(20).map((v, i) => v - lp[i]);
  const baseUp20 = win20.length ? win20.filter((x) => x > 0).length / win20.length : null;

  // 實盤預測的權重：全部回測時點的結果此刻都已實現，可以全部使用
  const weights = inverseErrorWeights(wf.rows);
  const params = Object.fromEntries(MODELS.map((m) => [m.key, m.prepare(logp)]));
  const paths = Object.fromEntries(MODELS.map((m) => [m.key, m.forecast(logp, H, params[m.key])]));
  const ens = Array.from({ length: H }, (_, h) => MODELS.reduce((s, m) => s + weights[m.key] * paths[m.key][h], 0));

  const sigma = ewmaVol(diffs(logpDone));
  const { dates, skipped } = nextTradingDays(candles[candles.length - 1].time, H, calendar);
  const spanYears = [...new Set([candles[candles.length - 1].time, ...dates].map((x) => Number(x.slice(0, 4))))];
  const unofficialYears = calendar.hasOfficialYear ? spanYears.filter((y) => !calendar.hasOfficialYear(y)) : spanYears;
  // 模型預測的是總報酬（還原權息）；換回原始股價時，除權息日起扣掉股利：(價 − 現金股利) ÷ (1 + 配股率)
  const lastDate = candles[candles.length - 1].time;
  const exInWindow = exEvents.filter((e) => e.date > lastDate && e.date <= dates[H - 1]).sort((a, b) => (a.date < b.date ? -1 : 1));
  const exApplied = exInWindow.filter((e) => !e.pending);
  const toRaw = (price, date) => exApplied.reduce((p, e) => (e.date <= date ? (p - e.cash) / (1 + e.stockRatio) : p), price);
  const path = ens.map((v, h) => {
    const s = sigma * Math.sqrt(h + 1);
    const t = dates[h];
    const value = toRaw(Math.exp(v), t);
    return {
      time: t,
      value,
      low80: toRaw(Math.exp(v - 1.2816 * s), t), high80: toRaw(Math.exp(v + 1.2816 * s), t),
      low95: toRaw(Math.exp(v - 1.96 * s), t), high95: toRaw(Math.exp(v + 1.96 * s), t),
      upProb: normCdf((Math.log(value) - last) / s),
    };
  });

  const knn = knnAnalog(logp, H);
  const horizons = [1, 5, 10, 20].filter((h) => h <= H).map((h) => {
    const p = path[h - 1];
    return { days: h, date: p.time, price: p.value, changePct: (p.value / lastPrice - 1) * 100, low80: p.low80, high80: p.high80, upProb: p.upProb };
  });

  const z = (ens[H - 1] - last) / (sigma * Math.sqrt(H));
  const signal = z > 0.3 ? { key: 'bull', text: '偏多' } : z < -0.3 ? { key: 'bear', text: '偏空' } : { key: 'flat', text: '盤整' };

  return {
    lastPrice,
    lastDate: candles[candles.length - 1].time,
    horizon: H,
    path,
    horizons,
    calendar: { skipped, unofficialYears },
    dividends: exInWindow.map((e) => ({ date: e.date, cash: e.cash, stockRatio: e.stockRatio, pending: e.pending })),
    signal: { ...signal, z },
    volatility: { daily: sigma, annual: sigma * Math.sqrt(250) },
    models: MODELS.map((m) => {
      const s = score(wf.rows, (r) => r.preds[m.key]);
      return {
        key: m.key,
        name: m.name,
        desc: m.desc,
        weight: weights[m.key],
        target: Math.exp(paths[m.key][H - 1]),
        changePct: (Math.exp(paths[m.key][H - 1]) / lastPrice - 1) * 100,
        mape: s.mape,
        hitRate: s.hitRate,
      };
    }),
    backtest: {
      method: 'walk-forward',
      horizon: wf.Hb,
      samples: wf.rows.length,
      from: candles[wf.rows[0].o].time,
      to: candles[wf.rows[wf.rows.length - 1].o + wf.Hb].time,
      excludedPartialBar: lastBarPartial,
      ensemble: ensScore,
      randomWalk: { mape: rwScore.mape },
      alwaysUp: { hitRate: alwaysUp },
      long: { horizon: wf.Hl, ensemble: ens20, randomWalk: { mape: rw20.mape }, alwaysUp: { hitRate: alwaysUp20 }, overlap: overlap20 },
    },
    baseRate: { horizon: 20, upShare: baseUp20, window: win20.length },
    analog: knn && {
      count: knn.matches.length,
      upProb: knn.upProb,
      avgReturn: mean(knn.matches.map((m) => m.forwardReturn)),
      matches: knn.matches.slice(0, 6).map((m) => ({ date: candles[m.index].time, forwardReturn: m.forwardReturn, similarity: 1 / (1 + m.distance) })),
    },
  };
}

module.exports = { forecast, nextTradingDays, walkForward, inverseErrorWeights, score, modelPrices, knnAnalog, MODELS, BT };
