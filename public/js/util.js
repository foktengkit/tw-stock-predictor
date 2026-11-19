export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function fmtPrice(v, digits = 2) {
  if (!isNum(v)) return '—';
  return v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtInt(v) {
  return isNum(v) ? Math.round(v).toLocaleString('zh-TW') : '—';
}

export function fmtBig(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)} 兆`;
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 億`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(1)} 萬`;
  return fmtInt(v);
}

export function fmtPct(v, digits = 2, withSign = true) {
  if (!isNum(v)) return '—';
  const s = withSign && v > 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

export function fmtChange(v, digits = 2) {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtPrice(v, digits)}`;
}

export const dir = (v) => (!isNum(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');
export const arrow = (v) => (!isNum(v) || v === 0 ? '' : v > 0 ? '▲' : '▼');

export async function api(path, { signal } = {}) {
  const r = await fetch(path, { signal });
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error((body && body.error) || `${r.status} ${r.statusText}`);
  return body;
}

export const store = {
  get(key, def) {
    try { const v = localStorage.getItem(`tws.${key}`); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(`tws.${key}`, JSON.stringify(val)); } catch { /* ignore */ }
  },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const MARKET_LABEL = { tse: '上市', otc: '上櫃' };
export const TF_LABEL = { '1m': '1 分', '5m': '5 分', '15m': '15 分', '60m': '60 分', D: '日', W: '週', M: '月' };

export function taipeiClock() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
}

export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
