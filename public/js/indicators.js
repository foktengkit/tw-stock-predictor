/**
 * 技術指標函式庫（前後端共用，UMD）
 * 所有函式回傳與輸入等長的陣列，資料不足處為 null。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nulls = (n) => new Array(n).fill(null);

  function sma(src, n) {
    const out = nulls(src.length);
    let sum = 0, run = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!isNum(v)) { sum = 0; run = 0; continue; }
      sum += v; run++;
      if (run > n) sum -= src[i - n];
      if (run >= n) out[i] = sum / n;
    }
    return out;
  }

  function sum(src, n) {
    return sma(src, n).map((v) => (v == null ? null : v * n));
  }

  function smooth(src, n, alpha) {
    const out = nulls(src.length);
    let prev = null, seed = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!isNum(v)) continue;
      if (prev === null) {
        seed += v; cnt++;
        if (cnt === n) { prev = seed / n; out[i] = prev; }
      } else {
        prev = alpha * v + (1 - alpha) * prev;
        out[i] = prev;
      }
    }
    return out;
  }
  const ema = (src, n) => smooth(src, n, 2 / (n + 1));
  const rma = (src, n) => smooth(src, n, 1 / n);

  function wma(src, n) {
    const out = nulls(src.length);
    const denom = (n * (n + 1)) / 2;
    for (let i = n - 1; i < src.length; i++) {
      let acc = 0, ok = true;
      for (let j = 0; j < n; j++) {
        const v = src[i - j];
        if (!isNum(v)) { ok = false; break; }
        acc += v * (n - j);
      }
      if (ok) out[i] = acc / denom;
    }
    return out;
  }

  function hma(src, n) {
    const half = wma(src, Math.max(1, Math.floor(n / 2)));
    const full = wma(src, n);
    const diff = half.map((v, i) => (v == null || full[i] == null ? null : 2 * v - full[i]));
    return wma(diff, Math.max(1, Math.floor(Math.sqrt(n))));
  }

  function vwma(close, volume, n) {
    const pv = close.map((c, i) => (isNum(c) && isNum(volume[i]) ? c * volume[i] : null));
    const a = sum(pv, n), b = sum(volume, n);
    return a.map((v, i) => (v == null || !b[i] ? null : v / b[i]));
  }

  function stdev(src, n) {
    const mean = sma(src, n);
    const out = nulls(src.length);
    for (let i = n - 1; i < src.length; i++) {
      if (mean[i] == null) continue;
      let acc = 0;
      for (let j = 0; j < n; j++) acc += (src[i - j] - mean[i]) ** 2;
      out[i] = Math.sqrt(acc / n);
    }
    return out;
  }

  function bollinger(close, n = 20, mult = 2) {
    const mid = sma(close, n), sd = stdev(close, n);
    return {
      mid,
      upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
      lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
    };
  }

  function highest(src, n) {
    const out = nulls(src.length);
    for (let i = n - 1; i < src.length; i++) {
      let m = -Infinity, ok = true;
      for (let j = 0; j < n; j++) { const v = src[i - j]; if (!isNum(v)) { ok = false; break; } if (v > m) m = v; }
      if (ok) out[i] = m;
    }
    return out;
  }
  function lowest(src, n) {
    const out = nulls(src.length);
    for (let i = n - 1; i < src.length; i++) {
      let m = Infinity, ok = true;
      for (let j = 0; j < n; j++) { const v = src[i - j]; if (!isNum(v)) { ok = false; break; } if (v < m) m = v; }
      if (ok) out[i] = m;
    }
    return out;
  }

  function change(src, n = 1) {
    return src.map((v, i) => (i < n || !isNum(v) || !isNum(src[i - n]) ? null : v - src[i - n]));
  }

  function rsi(close, n = 14) {
    const ch = change(close);
    const gain = rma(ch.map((v) => (v == null ? null : Math.max(v, 0))), n);
    const loss = rma(ch.map((v) => (v == null ? null : Math.max(-v, 0))), n);
    return gain.map((g, i) => {
      const l = loss[i];
      if (g == null || l == null) return null;
      if (l === 0) return 100;
      return 100 - 100 / (1 + g / l);
    });
  }

  function stoch(high, low, close, kLen = 14, kSmooth = 3, dSmooth = 3) {
    const hh = highest(high, kLen), ll = lowest(low, kLen);
    const raw = close.map((c, i) => (hh[i] == null ? null : hh[i] === ll[i] ? 50 : (100 * (c - ll[i])) / (hh[i] - ll[i])));
    const k = sma(raw, kSmooth);
    return { k, d: sma(k, dSmooth) };
  }

  /** 台灣常用 KD（9,3,3）：K = 2/3 前K + 1/3 RSV */
  function kd(high, low, close, n = 9) {
    const hh = highest(high, n), ll = lowest(low, n);
    const K = nulls(close.length), D = nulls(close.length);
    let pk = 50, pd = 50;
    for (let i = 0; i < close.length; i++) {
      if (hh[i] == null) continue;
      const rsv = hh[i] === ll[i] ? 50 : (100 * (close[i] - ll[i])) / (hh[i] - ll[i]);
      pk = (2 / 3) * pk + (1 / 3) * rsv;
      pd = (2 / 3) * pd + (1 / 3) * pk;
      K[i] = pk; D[i] = pd;
    }
    return { k: K, d: D };
  }

  function macd(close, fast = 12, slow = 26, signal = 9) {
    const f = ema(close, fast), s = ema(close, slow);
    const line = f.map((v, i) => (v == null || s[i] == null ? null : v - s[i]));
    const sig = ema(line, signal);
    const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
    return { macd: line, signal: sig, hist };
  }

  function cci(high, low, close, n = 20) {
    const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
    const ma = sma(tp, n);
    const out = nulls(close.length);
    for (let i = n - 1; i < close.length; i++) {
      if (ma[i] == null) continue;
      let md = 0;
      for (let j = 0; j < n; j++) md += Math.abs(tp[i - j] - ma[i]);
      md /= n;
      out[i] = md === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * md);
    }
    return out;
  }

  function trueRange(high, low, close) {
    return close.map((c, i) => (i === 0 ? high[i] - low[i] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))));
  }

  function atr(high, low, close, n = 14) {
    return rma(trueRange(high, low, close), n);
  }

  function adx(high, low, close, n = 14) {
    const len = close.length;
    const plusDM = nulls(len), minusDM = nulls(len), tr = nulls(len);
    for (let i = 1; i < len; i++) {
      const up = high[i] - high[i - 1], dn = low[i - 1] - low[i];
      plusDM[i] = up > dn && up > 0 ? up : 0;
      minusDM[i] = dn > up && dn > 0 ? dn : 0;
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    }
    const trR = rma(tr, n), p = rma(plusDM, n), m = rma(minusDM, n);
    const plusDI = p.map((v, i) => (v == null || !trR[i] ? null : (100 * v) / trR[i]));
    const minusDI = m.map((v, i) => (v == null || !trR[i] ? null : (100 * v) / trR[i]));
    const dx = plusDI.map((v, i) => {
      const w = minusDI[i];
      if (v == null || w == null) return null;
      return v + w === 0 ? 0 : (100 * Math.abs(v - w)) / (v + w);
    });
    return { adx: rma(dx, n), plusDI, minusDI };
  }

  function ao(high, low) {
    const hl2 = high.map((h, i) => (h + low[i]) / 2);
    const a = sma(hl2, 5), b = sma(hl2, 34);
    return a.map((v, i) => (v == null || b[i] == null ? null : v - b[i]));
  }

  const momentum = (close, n = 10) => change(close, n);

  function williamsR(high, low, close, n = 14) {
    const hh = highest(high, n), ll = lowest(low, n);
    return close.map((c, i) => (hh[i] == null ? null : hh[i] === ll[i] ? -50 : (-100 * (hh[i] - c)) / (hh[i] - ll[i])));
  }

  function stochRsi(close, rsiLen = 14, stochLen = 14, kS = 3, dS = 3) {
    const r = rsi(close, rsiLen);
    const hh = highest(r, stochLen), ll = lowest(r, stochLen);
    const raw = r.map((v, i) => (hh[i] == null ? null : hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
    const k = sma(raw, kS);
    return { k, d: sma(k, dS) };
  }

  function bullBearPower(high, low, close, n = 13) {
    const e = ema(close, n);
    return e.map((v, i) => (v == null ? null : high[i] - v + (low[i] - v)));
  }

  function ultimateOsc(high, low, close, a = 7, b = 14, c = 28) {
    const bp = close.map((cl, i) => (i === 0 ? null : cl - Math.min(low[i], close[i - 1])));
    const tr = close.map((cl, i) => (i === 0 ? null : Math.max(high[i], close[i - 1]) - Math.min(low[i], close[i - 1])));
    const avg = (n) => { const s1 = sum(bp, n), s2 = sum(tr, n); return s1.map((v, i) => (v == null || !s2[i] ? null : v / s2[i])); };
    const A = avg(a), B = avg(b), C = avg(c);
    return A.map((v, i) => (v == null || B[i] == null || C[i] == null ? null : (100 * (4 * v + 2 * B[i] + C[i])) / 7));
  }

  function ichimokuBase(high, low, n = 26) {
    const hh = highest(high, n), ll = lowest(low, n);
    return hh.map((v, i) => (v == null ? null : (v + ll[i]) / 2));
  }

  /** 樞紐點：以一根 K 棒的高低收計算 */
  function pivots(h, l, c) {
    const P = (h + l + c) / 3, r = h - l;
    return {
      classic: { R3: h + 2 * (P - l), R2: P + r, R1: 2 * P - l, P, S1: 2 * P - h, S2: P - r, S3: l - 2 * (h - P) },
      fibonacci: { R3: P + r, R2: P + 0.618 * r, R1: P + 0.382 * r, P, S1: P - 0.382 * r, S2: P - 0.618 * r, S3: P - r },
      camarilla: { R3: c + (r * 1.1) / 4, R2: c + (r * 1.1) / 6, R1: c + (r * 1.1) / 12, P, S1: c - (r * 1.1) / 12, S2: c - (r * 1.1) / 6, S3: c - (r * 1.1) / 4 },
    };
  }

  return { isNum, sma, ema, rma, wma, hma, vwma, sum, stdev, bollinger, highest, lowest, change, rsi, stoch, kd, macd, cci, atr, adx, ao, momentum, williamsR, stochRsi, bullBearPower, ultimateOsc, ichimokuBase, pivots };
});
