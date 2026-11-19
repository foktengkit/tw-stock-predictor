// 技術分析綜合評等：移動平均線 + 震盪指標的買賣訊號統計
const TA = require('../public/js/indicators.js');

function label(score) {
  if (score == null) return { key: 'na', text: '—' };
  if (score >= 0.5) return { key: 'strong-buy', text: '強力買進' };
  if (score >= 0.1) return { key: 'buy', text: '買進' };
  if (score > -0.1) return { key: 'neutral', text: '中立' };
  if (score > -0.5) return { key: 'sell', text: '賣出' };
  return { key: 'strong-sell', text: '強力賣出' };
}

function summarize(items) {
  const valid = items.filter((x) => x.action != null);
  const buy = valid.filter((x) => x.action > 0).length;
  const sell = valid.filter((x) => x.action < 0).length;
  const score = valid.length ? (buy - sell) / valid.length : null;
  return { score, ...label(score), counts: { buy, sell, neutral: valid.length - buy - sell }, items };
}

/**
 * @param {{open,high,low,close,volume}[]} candles
 * @param {{pivotFromPrevious?: boolean}} opt 盤中時最後一根尚未完成，樞紐點改用前一根
 */
function technicalRating(candles, { pivotFromPrevious = false } = {}) {
  if (candles.length < 35) throw Object.assign(new Error('K 線數量不足以計算技術指標'), { status: 422 });
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const vol = candles.map((c) => c.volume || 0);
  const i = close.length - 1;
  const price = close[i];
  const at = (arr, k = 0) => (arr[i - k] == null ? null : arr[i - k]);

  const ma = [];
  const pushMA = (name, arr) => {
    const v = at(arr);
    ma.push({ name, value: v, action: v == null ? null : v < price ? 1 : v > price ? -1 : 0 });
  };
  for (const len of [10, 20, 30, 50, 100, 200]) {
    pushMA(`EMA (${len})`, TA.ema(close, len));
    pushMA(`SMA (${len})`, TA.sma(close, len));
  }
  pushMA('一目均衡表基準線 (26)', TA.ichimokuBase(high, low, 26));
  pushMA('成交量加權均線 VWMA (20)', TA.vwma(close, vol, 20));
  pushMA('Hull 均線 (9)', TA.hma(close, 9));

  const osc = [];
  const pushO = (name, value, rule) => osc.push({ name, value, action: value == null ? null : rule() });

  const rsi = TA.rsi(close, 14);
  pushO('RSI (14)', at(rsi), () => (at(rsi) < 30 && at(rsi) > at(rsi, 1) ? 1 : at(rsi) > 70 && at(rsi) < at(rsi, 1) ? -1 : 0));

  const st = TA.stoch(high, low, close, 14, 3, 3);
  pushO('隨機指標 %K (14, 3, 3)', at(st.k), () => {
    const k = at(st.k), d = at(st.d);
    return k < 20 && d < 20 && k > d ? 1 : k > 80 && d > 80 && k < d ? -1 : 0;
  });

  const cci = TA.cci(high, low, close, 20);
  pushO('順勢指標 CCI (20)', at(cci), () => (at(cci) < -100 && at(cci) > at(cci, 1) ? 1 : at(cci) > 100 && at(cci) < at(cci, 1) ? -1 : 0));

  const adx = TA.adx(high, low, close, 14);
  pushO('平均趨向指標 ADX (14)', at(adx.adx), () => {
    const a = at(adx.adx), rising = a > at(adx.adx, 1);
    if (a > 20 && rising && at(adx.plusDI) > at(adx.minusDI)) return 1;
    if (a > 20 && rising && at(adx.plusDI) < at(adx.minusDI)) return -1;
    return 0;
  });

  const ao = TA.ao(high, low);
  pushO('動量震盪 AO', at(ao), () => (at(ao) > 0 && at(ao) > at(ao, 1) ? 1 : at(ao) < 0 && at(ao) < at(ao, 1) ? -1 : 0));

  const mom = TA.momentum(close, 10);
  pushO('動量 (10)', at(mom), () => (at(mom) > at(mom, 1) ? 1 : at(mom) < at(mom, 1) ? -1 : 0));

  const macd = TA.macd(close, 12, 26, 9);
  pushO('MACD (12, 26)', at(macd.macd), () => (at(macd.macd) > at(macd.signal) ? 1 : at(macd.macd) < at(macd.signal) ? -1 : 0));

  const srsi = TA.stochRsi(close, 14, 14, 3, 3);
  pushO('Stoch RSI (3, 3, 14, 14)', at(srsi.k), () => {
    const k = at(srsi.k), d = at(srsi.d);
    return k < 20 && d < 20 && k > d ? 1 : k > 80 && d > 80 && k < d ? -1 : 0;
  });

  const wr = TA.williamsR(high, low, close, 14);
  pushO('威廉指標 %R (14)', at(wr), () => (at(wr) < -80 && at(wr) > at(wr, 1) ? 1 : at(wr) > -20 && at(wr) < at(wr, 1) ? -1 : 0));

  const bbp = TA.bullBearPower(high, low, close, 13);
  pushO('多空力道 (13)', at(bbp), () => (at(bbp) > 0 && at(bbp) > at(bbp, 1) ? 1 : at(bbp) < 0 && at(bbp) < at(bbp, 1) ? -1 : 0));

  const uo = TA.ultimateOsc(high, low, close, 7, 14, 28);
  pushO('終極震盪指標 UO (7, 14, 28)', at(uo), () => (at(uo) > 70 ? 1 : at(uo) < 30 ? -1 : 0));

  const maSum = summarize(ma);
  const oscSum = summarize(osc);
  const sScore = maSum.score != null && oscSum.score != null ? (maSum.score + oscSum.score) / 2 : maSum.score ?? oscSum.score;
  const pb = candles[pivotFromPrevious && candles.length > 1 ? i - 1 : i];

  return {
    price,
    summary: {
      score: sScore,
      ...label(sScore),
      counts: {
        buy: maSum.counts.buy + oscSum.counts.buy,
        sell: maSum.counts.sell + oscSum.counts.sell,
        neutral: maSum.counts.neutral + oscSum.counts.neutral,
      },
    },
    oscillators: oscSum,
    movingAverages: maSum,
    pivots: { basedOn: pb.time, ...TA.pivots(pb.high, pb.low, pb.close) },
  };
}

module.exports = { technicalRating, label };
