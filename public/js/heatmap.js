import { api, esc, fmtPrice, fmtPct, fmtBig, isNum } from './util.js';

/** Squarified treemap：讓每塊磚盡量接近正方形 */
function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map((it) => ({ it, a: it.value * scale }));
  const worst = (row, side) => {
    const s = row.reduce((acc, r) => acc + r.a, 0);
    let mx = -Infinity, mn = Infinity;
    for (const r of row) { mx = Math.max(mx, r.a); mn = Math.min(mn, r.a); }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [rest[0]];
    let i = 1;
    let cur = worst(row, side);
    while (i < rest.length) {
      const cand = [...row, rest[i]];
      const wc = worst(cand, side);
      if (wc > cur) break;
      row = cand; cur = wc; i++;
    }
    const sum = row.reduce((acc, r) => acc + r.a, 0);
    if (w >= h) {
      const cw = sum / h;
      let yy = y;
      for (const r of row) { const rh = r.a / cw; out.push({ ...r.it, x, y: yy, w: cw, h: rh }); yy += rh; }
      x += cw; w -= cw;
    } else {
      const rh = sum / w;
      let xx = x;
      for (const r of row) { const rw = r.a / rh; out.push({ ...r.it, x: xx, y, w: rw, h: rh }); xx += rw; }
      y += rh; h -= rh;
    }
    rest = rest.slice(i);
  }
  return out;
}

function tileColor(pct) {
  if (!isNum(pct) || Math.abs(pct) < 0.005) return 'rgb(90,95,108)';
  const t = Math.pow(Math.min(Math.abs(pct) / 5, 1), 0.7);
  const base = [90, 95, 108];
  const target = pct > 0 ? [235, 38, 58] : [6, 150, 112];
  const c = base.map((b, i) => Math.round(b + (target[i] - b) * t));
  return `rgb(${c.join(',')})`;
}

export class Heatmap {
  constructor(el, { onSelect }) {
    this.el = el;
    this.onSelect = onSelect;
    this.items = [];
    this.el.innerHTML = `<div class="hm-legend"><span>台灣 50 主要成分股 · 面積＝今日成交值 · 顏色＝漲跌幅</span><span class="spacer"></span>
      <span>-5%</span>${[-5, -3, -1, 0, 1, 3, 5].map((v) => `<i style="background:${tileColor(v)}"></i>`).join('')}<span>+5%</span></div>
      <div class="heatmap"></div>`;
    this.box = this.el.querySelector('.heatmap');
    this.box.addEventListener('click', (e) => {
      const t = e.target.closest('.hm-tile');
      if (t) this.onSelect(t.dataset.code);
    });
    new ResizeObserver(() => this.active && this.layout()).observe(this.box);
  }

  start() {
    this.active = true;
    this.fetch();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.fetch(), 10000);
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
  }

  async fetch() {
    try {
      const j = await api('/api/heatmap');
      this.items = j.items;
      if (this.active) this.layout();
    } catch (e) {
      this.box.innerHTML = `<div class="skeleton">熱力圖載入失敗：${esc(e.message)}</div>`;
    }
  }

  layout() {
    const W = this.box.clientWidth, H = this.box.clientHeight;
    if (!W || !H || !this.items.length) return;
    const allZero = this.items.every((it) => !it.value);
    const bySector = new Map();
    for (const it of this.items) {
      const v = allZero ? 1 : Math.max(it.value, 1);
      if (!bySector.has(it.sector)) bySector.set(it.sector, []);
      bySector.get(it.sector).push({ ...it, value: v });
    }
    const sectors = [...bySector.entries()]
      .map(([name, list]) => ({ name, list: list.sort((a, b) => b.value - a.value), value: list.reduce((s, x) => s + x.value, 0) }))
      .sort((a, b) => b.value - a.value);

    let html = '';
    for (const s of squarify(sectors, 0, 0, W, H)) {
      const head = s.h > 60 && s.w > 50 ? 16 : 0;
      html += `<div class="hm-sector" style="left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px">${head ? `<div class="hm-title">${esc(s.name)}</div>` : ''}</div>`;
      for (const t of squarify(s.list, s.x, s.y + head, s.w, s.h - head)) {
        const minSide = Math.min(t.w, t.h);
        const fs = Math.max(9, Math.min(22, minSide / 4.2));
        const showName = t.w > 34 && t.h > 22;
        const showPct = t.w > 34 && t.h > 38;
        html += `<div class="hm-tile" data-code="${t.code}" style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;background:${tileColor(t.changePct)};font-size:${fs}px"
          title="${esc(t.code)} ${esc(t.name)}&#10;成交 ${fmtPrice(t.price)}（${fmtPct(t.changePct)}）&#10;成交值 ${fmtBig(t.value)}">
          ${showName ? `<span class="nm">${esc(t.name)}</span>` : ''}${showPct ? `<span class="pc" style="font-size:${Math.max(9, fs * 0.72)}px">${fmtPct(t.changePct)}</span>` : ''}</div>`;
      }
    }
    this.box.innerHTML = html;
  }
}
