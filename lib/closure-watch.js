/**
 * 臨時休市偵測
 *  1. 颱風停班：每 10 分鐘讀取人事行政總處「天然災害停止上班及上課情形」。
 *     依證交所規定，臺北市宣布「全日」或「上午」停止上班 → 集中市場全日休市；
 *     只宣布「下午」停止上班 → 照常開盤。
 *  2. 開盤確認：伺服器每次取得加權指數時檢查資料日期。平日 09:10 之後仍不是今天的資料
 *     （連續 3 次）→ 判定今日休市；只要出現今天的資料 → 確認有開盤。
 */
const calendar = require('./holidays');
const market = require('./market');

const taipeiNow = () => market.taipeiNow();
const DGPA_URL = process.env.DGPA_URL || 'https://www.dgpa.gov.tw/typh/daily/nds.html';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TYPHOON_CHECK_MS = Number(process.env.TYPHOON_CHECK_MS) || 10 * 60 * 1000;
const MIS_CONFIRM = 3;
const TYPHOON_NAME = '颱風停止交易（臺北市停止上班）';
const MIS_NAME = '臨時休市（開盤時間無交易資料）';

const typhoon = { checkedAt: null, pageDate: null, taipei: [], error: null };
const mis = { checkedAt: null, dataDate: null, openedToday: false, misses: 0, missDate: null };

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pad = (n) => String(n).padStart(2, '0');

/** 解析頁面：頁面日期 + 臺北市那一列的各則公告 */
function parseDgpa(html) {
  let pageDate = null;
  const ymd = html.match(/Header_YMD[^>]*>\s*(\d{2,3})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (ymd) pageDate = `${Number(ymd[1]) + 1911}-${pad(ymd[2])}-${pad(ymd[3])}`;
  if (!pageDate) {
    const u = html.match(/更新時間：(\d{4})\/(\d{2})\/(\d{2})/);
    if (u) pageDate = `${u[1]}-${u[2]}-${u[3]}`;
  }
  const row = html.match(/<FONT[^>]*>\s*(?:臺北市|台北市)\s*<\/FONT>\s*<\/TD>\s*<TD[^>]*>([\s\S]*?)<\/TD>/i);
  const statements = row
    ? row[1].split(/<br\s*\/?>/i).map((s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()).filter(Boolean)
    : [];
  return { pageDate, statements, noInfo: /無停班停課訊息/.test(html) };
}

/** 一則公告 → { date, closed } ；無法判讀或只影響部分區里時回傳 null */
function interpret(stmt, pageDate) {
  if (!pageDate || /[:：]/.test(stmt)) return null; // 「北投區xx里:今天停止上班」只影響部分地區
  let date = null;
  const md = stmt.match(/(\d{1,2})月(\d{1,2})日/);
  if (md) {
    let y = Number(pageDate.slice(0, 4));
    if (Number(md[1]) < Number(pageDate.slice(5, 7)) - 6) y++; // 12 月公告 1 月
    date = `${y}-${pad(md[1])}-${pad(md[2])}`;
  } else if (/今天|今日/.test(stmt)) date = pageDate;
  else if (/明天|明日/.test(stmt)) date = addDays(pageDate, 1);
  if (!date) return null;
  if (!/停止上班/.test(stmt)) return /照常上班/.test(stmt) ? { date, closed: false, text: stmt } : null;
  const morning = /上午停止上班/.test(stmt);
  const afternoonOnly = !morning && /(下午|晚間|晚上)停止上班/.test(stmt);
  return { date, closed: !afternoonOnly, text: stmt };
}

async function checkTyphoon() {
  try {
    const r = await fetch(DGPA_URL, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { pageDate, statements, noInfo } = parseDgpa(await r.text());
    typhoon.checkedAt = new Date().toISOString();
    typhoon.pageDate = pageDate;
    typhoon.taipei = statements.length ? statements : [noInfo ? '無停班停課訊息' : '臺北市無停班停課訊息'];
    typhoon.error = null;
    const today = taipeiNow().isoDate;
    for (const it of statements.map((s) => interpret(s, pageDate)).filter(Boolean)) {
      if (it.date < today) continue;
      if (it.closed) calendar.markClosed(it.date, TYPHOON_NAME, 'dgpa');
      else calendar.clearClosed(it.date, 'dgpa');
    }
  } catch (e) {
    typhoon.error = e.message;
    console.warn('[closure] 颱風停班資訊取得失敗:', e.message);
  }
}

/** 由伺服器在每次取得加權指數（t00）報價後呼叫 */
function checkMis(q) {
  if (!q || !/^\d{8}$/.test(q.date || '') || !q.fetchedAt || Date.now() - q.fetchedAt > 60e3) return;
  const n = taipeiNow();
  const today = n.isoDate;
  const dataDate = `${q.date.slice(0, 4)}-${q.date.slice(4, 6)}-${q.date.slice(6, 8)}`;
  mis.checkedAt = new Date().toISOString();
  mis.dataDate = dataDate;
  if (mis.missDate !== today) { mis.missDate = today; mis.misses = 0; mis.openedToday = false; }

  if (dataDate === today) {
    mis.openedToday = true;
    mis.misses = 0;
    calendar.markOpen(today, 'mis');
    return;
  }
  if (n.weekday === 0 || n.weekday === 6 || n.minutes < 9 * 60 + 10 || mis.openedToday) return;
  if (calendar.holidayOf(today)) return;
  if (++mis.misses >= MIS_CONFIRM) calendar.markClosed(today, MIS_NAME, 'mis');
}

function start() {
  checkTyphoon();
  setInterval(checkTyphoon, TYPHOON_CHECK_MS).unref();
}

function info() {
  return { typhoon: { ...typhoon }, mis: { checkedAt: mis.checkedAt, dataDate: mis.dataDate, openedToday: mis.openedToday } };
}

module.exports = { start, checkTyphoon, checkMis, info, parseDgpa, interpret };
