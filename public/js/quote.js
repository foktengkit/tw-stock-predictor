import { fmtPrice, fmtInt, fmtBig, fmtChange, fmtPct, dir, arrow, esc, isNum, MARKET_LABEL } from './util.js';

/** 右側個股報價明細與五檔 */
export function renderQuote(el, symbol, q) {
  if (!symbol) { el.innerHTML = ''; return; }
  if (!q) {
    el.innerHTML = `<div class="q-name">${esc(symbol.name)}<span>${esc(symbol.code)}</span></div><div class="skeleton">載入報價中…</div>`;
    return;
  }
  const cls = dir(q.change);
  const isIndex = q.isIndex || symbol.type === 'index';
  const t = q.date ? `${q.date.slice(0, 4)}/${q.date.slice(4, 6)}/${q.date.slice(6, 8)} ${q.time || ''}` : '';
  const cell = (k, v, c = '') => `<div><span>${k}</span><span class="${c}">${v}</span></div>`;
  const pcls = (v) => (isNum(v) && isNum(q.prev) ? dir(v - q.prev) : '');

  let range = '';
  if (isNum(q.low) && isNum(q.high) && q.high > q.low) {
    const pos = Math.max(0, Math.min(100, ((q.price - q.low) / (q.high - q.low)) * 100));
    range = `<div class="range"><div class="rl"><span>今日最低</span><span>今日最高</span></div>
      <div class="track"><i style="left:${pos}%"></i></div>
      <div class="rl num"><span>${fmtPrice(q.low)}</span><span>${fmtPrice(q.high)}</span></div></div>`;
  }

  let book = '';
  if (!isIndex && (q.bids.length || q.asks.length)) {
    const maxV = Math.max(1, ...q.bids.map((x) => x.volume || 0), ...q.asks.map((x) => x.volume || 0));
    const rows = (arr, side) => Array.from({ length: 5 }, (_, i) => {
      const lv = arr[i];
      if (!lv) return '<div class="lv"><span>&nbsp;</span></div>';
      const w = ((lv.volume || 0) / maxV) * 100;
      const pc = pcls(lv.price);
      return side === 'bid'
        ? `<div class="lv"><i style="width:${w}%"></i><span>${fmtInt(lv.volume)}</span><span class="${pc}">${fmtPrice(lv.price)}</span></div>`
        : `<div class="lv"><i style="width:${w}%"></i><span class="${pc}">${fmtPrice(lv.price)}</span><span>${fmtInt(lv.volume)}</span></div>`;
    }).join('');
    const bidSum = q.bids.reduce((s, x) => s + (x.volume || 0), 0);
    const askSum = q.asks.reduce((s, x) => s + (x.volume || 0), 0);
    const bp = bidSum + askSum ? (bidSum / (bidSum + askSum)) * 100 : 50;
    book = `<div class="book"><h4>最佳五檔</h4>
      <div class="book-grid">
        <div class="book-col bid"><div class="hd"><span>買量</span><span>買價</span></div>${rows(q.bids, 'bid')}</div>
        <div class="book-col ask"><div class="hd"><span>賣價</span><span>賣量</span></div>${rows(q.asks, 'ask')}</div>
      </div>
      <div class="book-sum" title="委買 ${fmtInt(bidSum)} / 委賣 ${fmtInt(askSum)}"><i style="width:${bp}%"></i><i style="width:${100 - bp}%"></i></div>
      <div class="rl num" style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:3px"><span>委買 ${fmtInt(bidSum)}</span><span>委賣 ${fmtInt(askSum)}</span></div>
    </div>`;
  }

  el.innerHTML = `
    <div class="q-name">${esc(q.name || symbol.name)}<span>${esc(isIndex ? '' : symbol.code)}</span> <span class="tag">${isIndex ? '指數' : MARKET_LABEL[symbol.market] || ''}</span></div>
    <div class="q-full">${esc(q.fullName || '')}</div>
    <div class="q-price ${cls}"><b class="num">${fmtPrice(q.price)}</b><span class="num">${arrow(q.change)} ${fmtChange(q.change)} (${fmtPct(q.changePct)})</span></div>
    <div class="q-time" title="證交所公開即時資訊：快照約 25 秒更新一次，比實際時間延遲約 30–60 秒">最後成交 ${esc(t)} · 證交所公開資料（延遲約 1 分鐘內）</div>
    <div class="q-grid">
      ${cell('開盤', fmtPrice(q.open), pcls(q.open))}
      ${cell('昨收', fmtPrice(q.prev))}
      ${cell('最高', fmtPrice(q.high), pcls(q.high))}
      ${cell('最低', fmtPrice(q.low), pcls(q.low))}
      ${isIndex ? '' : `<div title="證交所即時報價的累積成交量。統計口徑與日 K（Yahoo）及證交所官方日成交量不同，通常較少"><span>盤中成交量</span><span>${fmtInt(q.volume)} 張</span></div>`}
      ${isIndex ? '' : cell('成交值(估)', fmtBig((q.volume || 0) * 1000 * (q.price || 0)))}
      ${isIndex ? '' : cell('漲停', fmtPrice(q.limitUp), 'up')}
      ${isIndex ? '' : cell('跌停', fmtPrice(q.limitDown), 'down')}
    </div>
    ${range}
    ${book}`;
}
