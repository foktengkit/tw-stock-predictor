import { api, fmtPrice, esc, isNum, TF_LABEL } from './util.js';
import { ratingLabel } from './predict-panel.js';

const TFS = ['15m', '60m', 'D', 'W', 'M'];
const ACTION = { 1: ['買進', 'buy'], '-1': ['賣出', 'sell'], 0: ['中立', 'neutral'] };

function gaugeSvg(score) {
  const cx = 100, cy = 100, r = 80;
  const pt = (deg, rad = r) => {
    const a = (deg * Math.PI) / 180;
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  };
  const colors = ['var(--down)', 'color-mix(in srgb, var(--down) 45%, transparent)', 'var(--faint)', 'color-mix(in srgb, var(--up) 45%, transparent)', 'var(--up)'];
  const arcs = colors.map((c, i) => {
    const a1 = 180 - i * 36 - 1.5, a2 = 180 - (i + 1) * 36 + 1.5;
    const [x1, y1] = pt(a1), [x2, y2] = pt(a2);
    return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" stroke="${c}" stroke-width="12" fill="none" stroke-linecap="butt"/>`;
  }).join('');
  const s = isNum(score) ? Math.max(-1, Math.min(1, score)) : 0;
  const [nx, ny] = pt(90 - s * 90, r - 22);
  const lbl = (deg, text, anchor) => { const [x, y] = pt(deg, r + 4); return `<text x="${x.toFixed(1)}" y="${(y + (deg === 90 ? -6 : 12)).toFixed(1)}" text-anchor="${anchor}" font-size="9" fill="var(--muted)">${text}</text>`; };
  return `<svg viewBox="-12 0 224 112" role="img" aria-label="評等儀表">
    ${arcs}
    ${lbl(180, '強力賣出', 'start')}${lbl(90, '中立', 'middle')}${lbl(0, '強力買進', 'end')}
    ${isNum(score) ? `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>` : ''}
    <circle cx="${cx}" cy="${cy}" r="5" fill="var(--text)"/>
  </svg>`;
}

function gauge(title, group, main = false) {
  const l = ratingLabel(group.score);
  const cls = l.key.includes('buy') ? 'up' : l.key.includes('sell') ? 'down' : 'muted';
  return `<div class="gauge${main ? ' main' : ''}">
    <h5>${title}</h5>${gaugeSvg(group.score)}
    <div class="glabel ${cls}">${l.text}</div>
    <div class="gcount"><span>賣出<b>${group.counts.sell}</b></span><span>中立<b>${group.counts.neutral}</b></span><span>買進<b>${group.counts.buy}</b></span></div>
  </div>`;
}

function table(title, items) {
  const rows = items.map((it) => {
    const a = it.action == null ? ['—', 'neutral'] : ACTION[it.action];
    return `<tr><td>${esc(it.name)}</td><td class="r num">${isNum(it.value) ? fmtPrice(it.value) : '—'}</td><td class="r act ${a[1]}">${a[0]}</td></tr>`;
  }).join('');
  return `<div><h4>${title}</h4><table class="t"><thead><tr><th>名稱</th><th class="r">數值</th><th class="r">訊號</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function pivotTable(pv) {
  const keys = ['R3', 'R2', 'R1', 'P', 'S1', 'S2', 'S3'];
  const rows = keys.map((k) => `<tr><td>${k === 'P' ? '樞紐 P' : k}</td><td class="r num">${fmtPrice(pv.classic[k])}</td><td class="r num">${fmtPrice(pv.fibonacci[k])}</td><td class="r num">${fmtPrice(pv.camarilla[k])}</td></tr>`).join('');
  const based = typeof pv.basedOn === 'number'
    ? new Date(pv.basedOn * 1000).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/')
    : String(pv.basedOn).replace(/-/g, '/');
  return `<div><h4>樞紐點（依 ${based} K 棒）</h4>
    <table class="t"><thead><tr><th></th><th class="r">經典</th><th class="r">費波那契</th><th class="r">卡瑪利拉</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note" style="margin-top:8px">R 為壓力、S 為支撐。總結＝移動平均線與震盪指標兩組訊號（買進數 − 賣出數）÷ 指標數的平均。</div>
    <div class="note" style="margin-top:6px">⚠️ 這是技術指標的訊號統計，不是買賣建議。以台灣 50 成分股回測，評等與之後 20 日漲跌的關聯很弱：「強力賣出」之後平均仍是上漲。</div></div>`;
}

export class TechPanel {
  constructor(el) {
    this.el = el;
    this.tf = 'D';
    this.code = null;
    this.loadedKey = null;
    this.seq = 0;
  }

  async load(code, { force = false } = {}) {
    this.code = code;
    const key = `${code}|${this.tf}`;
    if (!force && key === this.loadedKey) return;
    const id = ++this.seq;
    if (key !== this.loadedKey) this.el.innerHTML = `${this.head()}<div class="skeleton"><div class="spinner"></div>計算技術指標中…</div>`;
    this.bindHead();
    try {
      const r = await api(`/api/rating?code=${encodeURIComponent(code)}&tf=${this.tf}`);
      if (id !== this.seq) return;
      this.loadedKey = key;
      this.render(r);
    } catch (e) {
      if (id !== this.seq) return;
      this.loadedKey = null;
      this.el.innerHTML = `${this.head()}<div class="skeleton">無法計算技術指標：${esc(e.message)}</div>`;
      this.bindHead();
    }
  }

  head() {
    return `<div class="tech-head"><div class="seg">${TFS.map((t) => `<button data-ttf="${t}" class="${t === this.tf ? 'active' : ''}">${TF_LABEL[t]}</button>`).join('')}</div>
      <span class="muted">依所選週期的 K 線計算 26 項指標</span></div>`;
  }

  bindHead() {
    for (const b of this.el.querySelectorAll('[data-ttf]')) {
      b.onclick = () => { this.tf = b.dataset.ttf; this.load(this.code); };
    }
  }

  render(r) {
    this.el.innerHTML = `${this.head()}
      <div class="gauges">${gauge('震盪指標', r.oscillators)}${gauge('總結', r.summary, true)}${gauge('移動平均線', r.movingAverages)}</div>
      <div class="tgrid">${table('震盪指標', r.oscillators.items)}${table('移動平均線', r.movingAverages.items)}${pivotTable(r.pivots)}</div>`;
    this.bindHead();
  }
}
