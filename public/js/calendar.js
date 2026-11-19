import { api, esc } from './util.js';

const WD = '日一二三四五六';
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const wd = (iso) => WD[new Date(`${iso}T00:00:00Z`).getUTCDay()];

function ago(iso) {
  if (!iso) return '尚未檢查';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 盤勢徽章旁的休市日曆面板：顯示今天狀態、近期休市日與三項即時檢查 */
export class CalendarPanel {
  constructor(btn, pop) {
    this.btn = btn;
    this.pop = pop;
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('.mstatus-wrap')) this.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  toggle() { if (this.pop.hidden) this.open(); else this.close(); }

  open() {
    this.pop.hidden = false;
    this.pop.innerHTML = '<div class="skeleton"><div class="spinner"></div></div>';
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 30000);
  }

  close() {
    this.pop.hidden = true;
    clearInterval(this.timer);
  }

  async refresh() {
    if (this.pop.hidden) return;
    try {
      this.render(await api('/api/calendar'));
    } catch (e) {
      this.pop.innerHTML = `<div class="error">無法取得休市日曆：${esc(e.message)}</div>`;
    }
  }

  render(c) {
    if (c.static) return this.renderStatic(c);
    const t = c.today;
    const todayHtml = t.tradingDay
      ? `<b class="ok">交易日</b>${c.checks.mis.openedToday ? ' · 已確認開盤' : ''}`
      : `<b class="closed">休市</b>：${esc(t.reason.name)}`;
    const list = c.upcoming.slice(0, 8).map((h) => `
      <li class="${h.source === 'dgpa' || h.source === 'mis' ? 'live' : ''}">
        <span class="num">${md(h.date)}（${wd(h.date)}）</span><span>${esc(h.name)}</span><span class="tag">${esc(h.sourceLabel || '')}</span>
      </li>`).join('') || '<li><span></span><span class="muted">90 天內沒有休市日</span><span></span></li>';

    const ty = c.checks.typhoon;
    const typhoonText = ty.error ? `<span class="up">取得失敗</span>` : esc(ty.taipei.join(' ') || '—');
    const m = c.checks.mis;
    const misText = m.openedToday ? '今日已開盤' : m.dataDate ? `最新資料 ${md(m.dataDate)}` : '—';
    const years = c.calendar.officialYears;

    this.pop.innerHTML = `
      <h4>台股休市日曆 <span class="sync">● 自動同步中</span></h4>
      <div class="cal-today">今天 ${md(t.date)}（${wd(t.date)}）　${todayHtml}</div>
      <div class="cal-sec">近期休市日（週末除外）</div>
      <ul class="cal-list">${list}</ul>
      <div class="cal-sec">即時檢查</div>
      <div class="chk-row"><span>證交所休市日曆（每 6 小時）</span><span>${years.length ? `${years.join('、')} 年` : '<span class="up">未取得</span>'} · ${ago(c.calendar.officialFetchedAt)}</span></div>
      <div class="chk-row"><span>臺北市颱風停班（每 10 分鐘）</span><span>${typhoonText} · ${ago(ty.checkedAt)}</span></div>
      <div class="chk-row"><span>開盤確認（每次報價）</span><span>${misText} · ${ago(m.checkedAt)}</span></div>
      ${c.calendar.lastChange ? `<div class="chk-row"><span>最近一次異動</span><span>${esc(c.calendar.lastChange.reason)} · ${ago(c.calendar.lastChange.at)}</span></div>` : ''}
      <div class="cal-note">依證交所規定：臺北市宣布全日或上午停止上班時集中市場全日休市；只宣布下午停班則照常開盤。平日 09:10 後若仍無當日交易資料，也會判定為臨時休市。</div>`;
  }

  /** 公開版：沒有即時檢查，只顯示官方休市日曆與資料日期 */
  renderStatic(c) {
    const t = c.today;
    const list = c.upcoming.slice(0, 8).map((h) => `
      <li><span class="num">${md(h.date)}（${wd(h.date)}）</span><span>${esc(h.name)}</span><span class="tag">${esc(h.sourceLabel || '')}</span></li>`).join('')
      || '<li><span></span><span class="muted">90 天內沒有休市日</span><span></span></li>';
    const years = c.calendar.officialYears || [];
    this.pop.innerHTML = `
      <h4>台股休市日曆</h4>
      <div class="cal-today">今天 ${md(t.date)}（${wd(t.date)}）　${t.tradingDay ? '<b class="ok">交易日</b>' : `<b class="closed">休市</b>：${esc(t.reason.name)}`}</div>
      <div class="cal-sec">近期休市日（週末除外）</div>
      <ul class="cal-list">${list}</ul>
      <div class="cal-sec">資料狀態</div>
      <div class="chk-row"><span>最新收盤資料</span><span>${md(c.dataDate)}</span></div>
      <div class="chk-row"><span>網站更新時間</span><span>${ago(c.builtAt)}</span></div>
      <div class="chk-row"><span>證交所休市日曆</span><span>${years.length ? `${years.join('、')} 年` : '<span class="up">未取得</span>'}</span></div>
      <div class="cal-note">公開版每個交易日晚間依官方盤後資料自動更新，不提供盤中即時報價；颱風等臨時休市會在當天晚上的更新後反映。</div>`;
  }
}

let toastTimer;
export function toast(html, ms = 8000) {
  const el = document.getElementById('toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
