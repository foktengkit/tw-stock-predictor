import { api, esc, MARKET_LABEL } from './util.js';

export function initSearch(input, box, onSelect) {
  let items = [];
  let active = -1;
  let timer;
  let ctrl;

  const close = () => { box.hidden = true; active = -1; };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = '';
    input.blur();
    close();
    onSelect(it.code);
  };
  const paint = () => {
    if (!items.length) { box.innerHTML = '<div class="sr-empty">找不到符合的股票</div>'; return; }
    box.innerHTML = items.map((s, i) => `
      <div class="sr-item${i === active ? ' active' : ''}" data-i="${i}">
        <b>${esc(s.code === 't00' || s.code === 'o00' ? '指數' : s.code)}</b><span>${esc(s.name)}</span>
        <span class="tag">${s.type === 'index' ? '指數' : MARKET_LABEL[s.market] || ''}</span>
      </div>`).join('');
    const el = box.querySelector('.sr-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { close(); return; }
    timer = setTimeout(async () => {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      try {
        items = await api(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        active = items.length ? 0 : -1;
        box.hidden = false;
        paint();
      } catch { /* aborted */ }
    }, 120);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (!box.hidden && active >= 0) choose(active);
      else if (/^[0-9A-Za-z]{4,6}$/.test(input.value.trim())) { const c = input.value.trim().toUpperCase(); input.value = ''; input.blur(); close(); onSelect(c); }
    } else if (e.key === 'Escape') { close(); input.blur(); }
  });

  box.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.sr-item');
    if (it) { e.preventDefault(); choose(Number(it.dataset.i)); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  // 在頁面任意處直接輸入英數字即開始搜尋（與看盤軟體相同的操作習慣）
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !/[0-9a-zA-Z]/.test(e.key)) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    input.focus();
  });
}
