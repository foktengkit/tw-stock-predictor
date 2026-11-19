/**
 * 公開版的 K 線處理（純函式，瀏覽器與 Node 測試共用）
 */
export const LIMIT_JUMP = Math.log(1.105); // 漲跌幅限制 10%：單日超過代表有未還原的公司行動（減資、分割…）

export function bucketDate(iso, tf) {
  if (tf === 'M') return `${iso.slice(0, 7)}-01`;
  if (tf === 'W') {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return iso;
}

/**
 * 日 K。adjClose（還原權息收盤價，預測模型用；最後一根等於收盤價）：
 * 除權息日起，之前的價格乘上「參考價 ÷ 前一日收盤」；
 * 普通股沒有除權息紀錄、卻超過漲跌幅限制的跳空（減資、分割等），視為公司行動而非漲跌。
 * @param k {code, type, volSrc, rows: [date, open, high, low, close, volume][], ex: [date, ref/prev][]}
 */
export function dailyCandles(k) {
  const rows = k.rows, n = rows.length;
  const ex = new Map(k.ex || []);
  const checkJumps = k.type === 'stock' && /^\d{4}$/.test(k.code);
  const out = new Array(n);
  let f = 1;
  for (let i = n - 1; i >= 0; i--) {
    const [time, open, high, low, close, volume] = rows[i];
    out[i] = { time, open, high, low, close, volume, adjClose: close * f };
    if (k.volSrc === 'official') out[i].volSrc = 'official';
    const ratio = ex.get(time);
    if (ratio) f *= ratio;
    else if (checkJumps && i > 0 && Math.abs(Math.log(close / rows[i - 1][4])) > LIMIT_JUMP) f *= close / rows[i - 1][4];
  }
  return out;
}

/** 日 K 合併成週 / 月 K */
export function aggregate(daily, tf) {
  const out = [];
  for (const c of daily) {
    const b = bucketDate(c.time, tf);
    const last = out[out.length - 1];
    if (last && last.time === b) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.adjClose = c.adjClose;
      last.volume += c.volume;
    } else out.push({ ...c, time: b });
  }
  return out;
}
