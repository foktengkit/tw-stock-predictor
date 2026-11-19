import { store, fmtPrice, fmtChange, fmtPct, dir, esc, isNum } from './util.js';

const DEFAULT = ['2330', '2317', '2454', '2308', '2382', '0050', '00878', '2881', '2603', '6488'];

export class Watchlist {
  constructor(el, { onSelect, onChange }) {
    this.el = el;
    this.onSelect = onSelect;
    this.onChange = onChange;
    this.codes = store.get('watchlist', DEFAULT);
    this.names = store.get('watchnames', {});
    this.quotes = {};
    this.active = null;
    el.addEventListener('click', (e) => {
      const x = e.target.closest('.x');
      const row = e.target.closest('.wl-row');
      if (!row) return;
      if (x) { e.stopPropagation(); this.remove(row.dataset.code); return; }
      this.onSelect(row.dataset.code);
    });
    this.render();
  }

  has(code) { return this.codes.includes(code); }

  add(code, name) {
    if (this.has(code)) return;
    this.codes.push(code);
    if (name) this.names[code] = name;
    this.save();
    this.render();
  }

  remove(code) {
    this.codes = this.codes.filter((c) => c !== code);
    this.save();
    this.render();
  }

  save() {
    store.set('watchlist', this.codes);
    store.set('watchnames', this.names);
    this.onChange && this.onChange(this.codes);
  }

  setActive(code) {
    this.active = code;
    for (const r of this.el.querySelectorAll('.wl-row')) r.classList.toggle('active', r.dataset.code === code);
  }

  render() {
    if (!this.codes.length) {
      this.el.innerHTML = '<div class="wl-empty">尚無自選股<br>搜尋股票後按右上角「＋」加入</div>';
      return;
    }
    this.el.innerHTML = this.codes.map((c) => `
      <div class="wl-row${c === this.active ? ' active' : ''}" data-code="${esc(c)}">
        <span class="s"><b>${esc(c)}</b><small>${esc(this.names[c] || '')}</small></span>
        <span class="p num">—</span><span class="c num">—</span><span class="pc num">—</span>
        <button class="x" title="移除">×</button>
      </div>`).join('');
    for (const c of this.codes) if (this.quotes[c]) this.paint(c, this.quotes[c], false);
  }

  update(quotes) {
    let namesChanged = false;
    for (const c of this.codes) {
      const q = quotes[c];
      if (!q) continue;
      const prev = this.quotes[c];
      this.quotes[c] = q;
      if (q.name && this.names[c] !== q.name) { this.names[c] = q.name; namesChanged = true; }
      this.paint(c, q, prev && isNum(prev.price) && prev.price !== q.price ? (q.price > prev.price ? 'up' : 'down') : false);
    }
    if (namesChanged) store.set('watchnames', this.names);
  }

  paint(code, q, flash) {
    const row = this.el.querySelector(`.wl-row[data-code="${CSS.escape(code)}"]`);
    if (!row) return;
    const cls = dir(q.change);
    row.querySelector('small').textContent = q.name || '';
    const p = row.querySelector('.p');
    p.textContent = fmtPrice(q.price);
    p.className = `p num ${cls}`;
    const c = row.querySelector('.c');
    c.textContent = fmtChange(q.change);
    c.className = `c num ${cls}`;
    const pc = row.querySelector('.pc');
    pc.textContent = fmtPct(q.changePct);
    pc.className = `pc num ${cls}`;
    if (flash) {
      p.classList.add(`flash-${flash}`);
      setTimeout(() => p.classList.remove(`flash-${flash}`), 700);
    }
  }
}
