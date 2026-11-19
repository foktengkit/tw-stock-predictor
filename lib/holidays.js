/**
 * 台股休市日曆
 *  - official：證交所「市場開休市日期」（定期同步）
 *  - extra：   即時偵測到的臨時休市（颱風停班公告、開盤後確認未交易）
 *  - open：    即時確認「當天有開盤」，可推翻推估或誤判的休市標記
 * 任何變動都會讓 version 加一並發出 change 事件，伺服器據此通知所有瀏覽器。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const CACHE_FILE = process.env.CALENDAR_FILE || path.join(__dirname, '..', 'data', 'holidays.json');
const OFFICIAL_REFRESH_MS = 6 * 3600 * 1000;

// 官方日曆尚未公布的年份（例如年底時的明年），只能推估「固定日期」的國定假日；
// 農曆節日（春節、端午、中秋）與補假無法推估。
const FIXED = [
  ['01-01', '中華民國開國紀念日'],
  ['02-28', '和平紀念日'],
  ['04-04', '兒童節'],
  ['05-01', '勞動節'],
  ['09-28', '孔子誕辰紀念日 / 教師節'],
  ['10-10', '國慶日'],
  ['10-25', '臺灣光復暨金門古寧頭大捷紀念日'],
  ['12-25', '行憲紀念日'],
];

const SOURCE_LABEL = { twse: '證交所休市日曆', dgpa: '颱風停班公告', mis: '開盤確認', fixed: '固定國定假日（推估）' };

const events = new EventEmitter();
let state = { official: {}, extra: {}, open: {} };
let officialFetchedAt = null;
let version = 1;
let lastChange = null;

const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const isWeekend = (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d === 0 || d === 6; };
// 日曆裡也會列出「開始交易日」「最後交易日」，那些日子是有開盤的
const isTradingEntry = (name) => /開始交易|最後交易/.test(name);

function save() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(state));
  } catch (e) { console.warn('[calendar] 無法寫入快取:', e.message); }
}

function bump(reason) {
  version++;
  lastChange = { at: new Date().toISOString(), reason };
  save();
  console.log(`[calendar] v${version} ${reason}`);
  events.emit('change', { version, reason });
}

async function fetchYear(year) {
  const url = `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&queryYear=${year - 1911}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  // 尚未公布的年份，證交所會回傳今年的資料，因此要核對年份
  if (j.stat !== 'ok' || Number(j.queryYear) !== year || !Array.isArray(j.data)) return null;
  const closed = {};
  for (const [date, name] of j.data) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !isTradingEntry(String(name))) closed[date] = String(name).trim();
  }
  return closed;
}

async function refreshOfficial() {
  const y = Number(taipeiToday().slice(0, 4));
  const changes = [];
  for (const year of [y, y + 1]) {
    try {
      const closed = await fetchYear(year);
      if (!closed) continue;
      const before = JSON.stringify(state.official[year] || null);
      if (before !== JSON.stringify(closed)) {
        changes.push(before === 'null' ? `取得 ${year} 年證交所休市日曆` : `${year} 年證交所休市日曆有異動`);
        state.official[year] = closed;
      }
    } catch (e) {
      console.warn(`[calendar] ${year} 年休市日曆取得失敗:`, e.message);
    }
  }
  officialFetchedAt = new Date().toISOString();
  if (changes.length) bump(changes.join('；'));
}

function prune() {
  const cutoff = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10);
  for (const k of ['extra', 'open']) for (const d of Object.keys(state[k])) if (d < cutoff) delete state[k][d];
}

async function init() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // 相容舊版快取格式 { "2026": {...} }
    state = raw && raw.official ? { official: raw.official, extra: raw.extra || {}, open: raw.open || {} } : { official: raw || {}, extra: {}, open: {} };
  } catch { /* 沒有快取 */ }
  prune();
  // 有快取就背景更新；沒有快取才等第一次下載完成，確保預測日期正確
  if (Object.keys(state.official).length) refreshOfficial().catch(() => {});
  else await refreshOfficial().catch(() => {});
  setInterval(() => refreshOfficial().catch(() => {}), OFFICIAL_REFRESH_MS).unref();
}

/** @returns {{name, estimated, source} | null} 該日（YYYY-MM-DD）休市的原因；週末不列入 */
function holidayOf(iso) {
  if (state.open[iso]) return null;
  const official = state.official[iso.slice(0, 4)];
  if (official && official[iso]) return { name: official[iso], estimated: false, source: 'twse' };
  const ex = state.extra[iso];
  if (ex) return { name: ex.name, estimated: false, source: ex.source };
  if (!official) {
    const f = FIXED.find(([md]) => md === iso.slice(5));
    if (f) return { name: f[1], estimated: true, source: 'fixed' };
  }
  return null;
}

function isTradingDay(iso) {
  return !isWeekend(iso) && !holidayOf(iso);
}

function hasOfficialYear(year) {
  return !!state.official[String(year)];
}

/** 即時偵測到休市（颱風、未開盤） */
function markClosed(iso, name, source) {
  if (isWeekend(iso)) return false;
  const official = state.official[iso.slice(0, 4)];
  if (official && official[iso]) return false;
  const cur = state.extra[iso];
  if (cur && cur.name === name && cur.source === source && !state.open[iso]) return false;
  delete state.open[iso];
  state.extra[iso] = { name, source, at: new Date().toISOString() };
  bump(`${iso} 休市：${name}（${SOURCE_LABEL[source] || source}）`);
  return true;
}

/** 撤銷某來源先前的休市標記（例如颱風停班公告改為照常上班） */
function clearClosed(iso, source) {
  const cur = state.extra[iso];
  if (!cur || (source && cur.source !== source)) return false;
  delete state.extra[iso];
  bump(`${iso} 取消休市標記（${SOURCE_LABEL[source] || source}）`);
  return true;
}

/** 即時確認當天有開盤：推翻推估或誤判的休市 */
function markOpen(iso, source) {
  if (state.open[iso] || !holidayOf(iso)) return false;
  delete state.extra[iso];
  state.open[iso] = { source, at: new Date().toISOString() };
  bump(`${iso} 確認有開盤（${SOURCE_LABEL[source] || source}）`);
  return true;
}

/** 今天起 days 天內的平日休市日 */
function upcoming(days = 90) {
  const out = [];
  const d = new Date(`${taipeiToday()}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (!isWeekend(iso)) {
      const h = holidayOf(iso);
      if (h) out.push({ date: iso, ...h, sourceLabel: SOURCE_LABEL[h.source] });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function info() {
  return {
    version,
    lastChange,
    officialYears: Object.keys(state.official).sort(),
    officialFetchedAt,
  };
}

module.exports = {
  init, refreshOfficial, holidayOf, isTradingDay, isWeekend, hasOfficialYear,
  markClosed, clearClosed, markOpen, upcoming, info, events,
  getVersion: () => version, SOURCE_LABEL,
};
