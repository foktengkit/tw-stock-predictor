import { $, $$, api, store, fmtPrice, fmtChange, fmtPct, dir, arrow, esc, taipeiClock, MARKET_LABEL, STATIC } from './util.js';
import { ChartView, INDICATORS } from './chart.js';
import { Watchlist } from './watchlist.js';
import { renderQuote } from './quote.js';
import { initSearch } from './search.js';
import { renderPrediction, renderPredictionLoading, renderPredictionError } from './predict-panel.js';
import { TechPanel } from './tech-panel.js';
import { Heatmap } from './heatmap.js';
import { Live } from './live.js';
import { CalendarPanel, toast } from './calendar.js';
import { ChipsPanel } from './chips.js';

const norm = (c) => {
  const s = String(c || '').trim().toUpperCase();
  return s === 'T00' || s === 'O00' ? s.toLowerCase() : s;
};

const INTRADAY = ['1m', '5m', '15m', '60m'];
const state = {
  code: norm(decodeURIComponent(location.hash.slice(1))) || store.get('code', '2330'),
  tf: STATIC && INTRADAY.includes(store.get('tf', 'D')) ? 'D' : store.get('tf', 'D'), // 公開版沒有分線
  tab: store.get('tab', 'predict'),
  symbol: null,
  quote: null,
  status: null,
  calendarVersion: null,
  loadId: 0,
};

// ---------- 主題 ----------
let theme = store.get('theme', 'dark');
document.documentElement.dataset.theme = theme;

// ---------- 圖表 ----------
const chart = new ChartView($('#chart'), $('#legend'));
chart.setTheme(theme);
chart.type = store.get('chartType', 'candles');
chart.active = new Set(store.get('indicators', ['MA', 'VOL']));
chart.showForecast = store.get('showForecast', true);
chart.showSignals = store.get('showSignals', false);

const chartMsg = $('#chartMsg');
const showMsg = (html) => { chartMsg.innerHTML = `<div style="text-align:center">${html}</div>`; chartMsg.hidden = false; };
const hideMsg = () => { chartMsg.hidden = true; };

// ---------- 面板 ----------
const watchlist = new Watchlist($('#watchlist'), {
  onSelect: (c) => loadSymbol(c),
  onChange: () => { subscribe(); updateAddBtn(); },
});
const tech = new TechPanel($('#tab-tech'));
const chips = new ChipsPanel($('#tab-chips'));
chips.setTheme(theme);
const heat = new Heatmap($('#tab-heat'), { onSelect: (c) => loadSymbol(c) });

const calPanel = new CalendarPanel($('#mstatus'), $('#calPop'));

// 公開版沒有伺服器，不建立即時連線
const live = STATIC ? { subscribe() {} } : new Live({
  onQuotes: handleQuotes,
  onOfficial: handleOfficial,
  onCalendar: (msg) => {
    if (msg.status) renderStatus(msg.status);
    toast(`📅 <b>休市日曆已更新</b><br>${esc(msg.reason)}<br><span class="muted">預測日期已重新計算</span>`);
    syncCalendar(msg.version, true);
  },
  onConnection: (on) => {
    const el = $('#conn');
    el.className = `conn ${on ? 'on' : 'off'}`;
    el.querySelector('.txt').textContent = on ? '即時連線' : '重新連線中…';
  },
});

function subscribe() {
  live.subscribe([...watchlist.codes, state.code]);
}

// ---------- 載入商品 ----------
async function loadSymbol(code, { updateHash = true } = {}) {
  code = norm(code);
  if (!code) return;
  const id = ++state.loadId;
  state.code = code;
  state.quote = null;
  store.set('code', code);
  if (updateHash && decodeURIComponent(location.hash.slice(1)) !== code) history.replaceState(null, '', `#${code}`);
  chart.forecast = null;
  watchlist.setActive(code);
  subscribe();
  renderPredictionLoading($('#tab-predict'));
  renderQuote($('#quotePanel'), state.symbol && state.symbol.code === code ? state.symbol : { code, name: '' }, null);

  api(`/api/quotes?codes=${encodeURIComponent(code)}`).then((j) => {
    if (id !== state.loadId) return;
    const q = j.quotes[code];
    if (!q) return;
    if (!state.symbol || state.symbol.code !== code) {
      state.symbol = { code, name: q.name, market: q.market, type: q.isIndex ? 'index' : 'stock' };
      updateTitle();
    }
    onQuote(q);
  }).catch(() => {});

  await loadChart(id);
  loadPrediction(id);
  if (state.tab === 'tech') tech.load(code);
  if (state.tab === 'chips') chips.load(code);
}

async function loadChart(id = state.loadId) {
  const code = state.code;
  showMsg('<div class="spinner"></div>載入 K 線中…');
  try {
    const h = await api(`/api/history?code=${encodeURIComponent(code)}&tf=${state.tf}`);
    if (id !== state.loadId) return;
    state.symbol = h.symbol;
    updateTitle();
    if (!h.candles.length) { showMsg('此週期沒有資料'); return; }
    chart.setData(h.symbol, state.tf, h.candles);
    if (state.quote) chart.updateLive(state.quote);
    hideMsg();
  } catch (e) {
    if (id !== state.loadId) return;
    showMsg(`${esc(e.message)}${code === 'o00' ? '<br><small>（櫃買指數僅提供即時報價）</small>' : ''}`);
  }
}

async function loadPrediction(id = state.loadId) {
  const el = $('#tab-predict');
  try {
    const p = await api(`/api/predict?code=${encodeURIComponent(state.code)}`);
    if (id !== state.loadId) return;
    chart.setForecast({ ...p, code: p.symbol.code });
    renderPrediction(el, p, { onJump: jumpTo });
  } catch (e) {
    if (id !== state.loadId) return;
    renderPredictionError(el, e.message);
  }
}

async function jumpTo(date) {
  if (state.tf !== 'D') { await setTf('D'); }
  chart.focusTime(date);
}

function updateTitle() {
  const s = state.symbol;
  if (!s) return;
  $('#symCode').textContent = s.type === 'index' ? '' : s.code;
  $('#symName').textContent = s.name || '';
  $('#symMarket').textContent = s.type === 'index' ? '指數' : MARKET_LABEL[s.market] || '';
  updateAddBtn();
}

function updateAddBtn() {
  const btn = $('#addWatch');
  const has = watchlist.has(state.code);
  btn.title = has ? '從自選移除目前股票' : '將目前股票加入自選';
  btn.innerHTML = has
    ? '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12l5 5 9-10" stroke="currentColor" stroke-width="2" fill="none"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2"/></svg>';
  btn.style.color = has ? 'var(--accent)' : '';
}

// ---------- 即時報價 ----------
/** 休市日曆版本變了 → 重新計算預測日期、更新日曆面板 */
function syncCalendar(version, force = false) {
  if (version == null) return;
  const changed = state.calendarVersion != null && version !== state.calendarVersion;
  state.calendarVersion = version;
  if (changed || force) {
    loadPrediction();
    calPanel.refresh();
  }
}

/**
 * 官方資料有新進度（盤後行情、法人、融資券、月營收、上櫃個股成交量）：
 * 稍等片刻合併多筆通知，再重新整理圖表成交量與籌碼分頁
 */
let officialTimer = null;
function handleOfficial(msg) {
  const relevantToChart = /^daily_/.test(msg.dataset) || (msg.dataset === 'voltotal_otc' && msg.code === state.code);
  clearTimeout(officialTimer);
  officialTimer = setTimeout(() => {
    if (relevantToChart && ['D', 'W', 'M'].includes(state.tf)) loadChart();
    if (state.tab === 'chips') chips.load(state.code, { quiet: true });
  }, 3000);
}

function handleQuotes(msg) {
  if (msg.status) renderStatus(msg.status);
  syncCalendar(msg.calendar); // 斷線期間若錯過 calendar 通知，靠版本號補上
  renderIndices(msg.quotes);
  watchlist.update(msg.quotes);
  const q = msg.quotes[state.code];
  if (q) onQuote(q);
}

function onQuote(q) {
  state.quote = q;
  renderQuote($('#quotePanel'), state.symbol || { code: q.code, name: q.name, market: q.market }, q);
  if (!STATIC) chart.updateLive(q); // 公開版的報價就是最後一根日 K
  document.title = `${q.isIndex ? '' : `${q.code} `}${q.name} ${fmtPrice(q.price)} ${arrow(q.change)}${fmtPct(q.changePct)} · 台股觀測站`;
}

function renderIndices(quotes) {
  const items = [['t00', '加權'], ['o00', '櫃買']].filter(([c]) => quotes[c]);
  if (!items.length) return;
  $('#indices').innerHTML = items.map(([c, label]) => {
    const q = quotes[c], cls = dir(q.change);
    return `<button class="idx" data-code="${c}" title="${esc(q.name)}"><span class="n">${label}</span><span class="p num ${cls}">${fmtPrice(q.price)}</span><span class="c num ${cls}">${arrow(q.change)} ${fmtChange(q.change)} (${fmtPct(q.changePct)})</span></button>`;
  }).join('');
}

function renderStatus(s) {
  const prevActive = state.status && state.status.active;
  state.status = s;
  const b = $('#mstatus .badge');
  b.textContent = s.label;
  b.className = `badge ${s.code}`;
  // 剛收盤時重新抓一次正式日 K 與預測
  if (prevActive && !s.active) { loadChart(); loadPrediction(); }
}

// ---------- 工具列 ----------
async function setTf(tf) {
  state.tf = tf;
  store.set('tf', tf);
  for (const b of $$('#tfGroup button')) b.classList.toggle('active', b.dataset.tf === tf);
  $('#showForecast').parentElement.style.opacity = tf === 'D' ? '' : '0.5';
  await loadChart();
}

for (const b of $$('#tfGroup button')) b.addEventListener('click', () => setTf(b.dataset.tf));
for (const b of $$('#tfGroup button')) b.classList.toggle('active', b.dataset.tf === state.tf);
$('#showForecast').parentElement.style.opacity = state.tf === 'D' ? '' : '0.5';

const typeSel = $('#chartType');
typeSel.value = chart.type;
typeSel.addEventListener('change', () => { chart.setType(typeSel.value); store.set('chartType', typeSel.value); });

// 指標選單
const indList = $('#indList');
const groups = [['主圖疊加', ['MA', 'EMA', 'BOLL', 'VOL']], ['副圖', ['RSI', 'MACD', 'KD']]];
indList.innerHTML = groups.map(([g, keys]) => `<div class="menu-group">${g}</div>${keys.map((k) => {
  const def = INDICATORS[k];
  const color = (def.lines.find((l) => l.color) || {}).color || '#868993';
  return `<label><input type="checkbox" data-ind="${k}" ${chart.active.has(k) ? 'checked' : ''}/><span class="swatch" style="background:${color}"></span>${def.label}</label>`;
}).join('')}`).join('');
indList.addEventListener('change', () => {
  const set = $$('input[data-ind]', indList).filter((i) => i.checked).map((i) => i.dataset.ind);
  chart.setIndicators(set);
  store.set('indicators', set);
});
$('#indBtn').addEventListener('click', (e) => { e.stopPropagation(); indList.hidden = !indList.hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('#indMenu')) indList.hidden = true; });

const fc = $('#showForecast');
fc.checked = chart.showForecast;
fc.addEventListener('change', () => { chart.setShowForecast(fc.checked); store.set('showForecast', fc.checked); });
const sg = $('#showSignals');
sg.checked = chart.showSignals;
sg.addEventListener('change', () => { chart.setShowSignals(sg.checked); store.set('showSignals', sg.checked); });

// 左側工具
const toolBtn = (t) => $(`#tools [data-tool="${t}"]`);
let magnet = false;
const exitHline = () => { chart.setDrawMode(null); toolBtn('hline').classList.remove('active'); document.body.classList.remove('hline-mode'); };
chart.onDrawDone = exitHline;
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const t = b.dataset.tool;
  if (t === 'magnet') { magnet = !magnet; chart.setMagnet(magnet); b.classList.toggle('active', magnet); }
  else if (t === 'hline') {
    if (chart.drawMode === 'hline') exitHline();
    else { chart.setDrawMode('hline'); b.classList.add('active'); document.body.classList.add('hline-mode'); }
  } else if (t === 'clear') chart.clearDrawings();
  else if (t === 'fit') chart.resetView();
  else if (t === 'shot') chart.screenshot();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') exitHline(); });

// 自選
$('#addWatch').addEventListener('click', () => {
  if (watchlist.has(state.code)) watchlist.remove(state.code);
  else watchlist.add(state.code, state.symbol && state.symbol.name);
  if (state.quote) watchlist.update({ [state.code]: state.quote });
});

// 指數點擊
$('#indices').addEventListener('click', (e) => {
  const b = e.target.closest('.idx');
  if (b) loadSymbol(b.dataset.code);
});

// 主題
$('#themeBtn').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  chart.setTheme(theme);
  chips.setTheme(theme);
  store.set('theme', theme);
});

// 底部分頁
function setTab(tab, { expand = true } = {}) {
  state.tab = tab;
  store.set('tab', tab);
  for (const b of $$('.tabs [role="tab"]')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const t of ['predict', 'chips', 'tech', 'heat']) $(`#tab-${t}`).hidden = t !== tab;
  if (tab === 'heat') heat.start(); else heat.stop();
  if (tab === 'tech') tech.load(state.code);
  if (tab === 'chips') chips.load(state.code);
  if (expand) {
    $('#bottom').classList.remove('collapsed');
    store.set('collapsed', false);
  }
}
for (const b of $$('.tabs [role="tab"]')) b.addEventListener('click', () => setTab(b.dataset.tab));
$('#collapseBtn').addEventListener('click', () => {
  const c = $('#bottom').classList.toggle('collapsed');
  store.set('collapsed', c);
});
if (store.get('collapsed', false)) $('#bottom').classList.add('collapsed');

// 搜尋
initSearch($('#searchInput'), $('#searchResults'), (c) => loadSymbol(c));

window.addEventListener('hashchange', () => {
  const c = norm(decodeURIComponent(location.hash.slice(1)));
  if (c && c !== state.code) loadSymbol(c, { updateHash: false });
});

// 時鐘與定時更新
setInterval(() => { $('#clock').textContent = `台北 ${taipeiClock()}`; }, 1000);
$('#clock').textContent = `台北 ${taipeiClock()}`;
setInterval(() => { if (state.status && state.status.active) loadPrediction(); }, 5 * 60e3);
setInterval(() => { if (state.tab === 'tech' && state.status && state.status.active) tech.load(state.code, { force: true }); }, 60e3);

api('/api/market').then((j) => { renderStatus(j.status); renderIndices(j.indices); }).catch(() => {});
api(`/api/quotes?codes=${watchlist.codes.join(',')}`).then((j) => watchlist.update(j.quotes)).catch(() => {});

// ---------- 公開版 ----------
const ABOUT = `<b>關於本站（公開版）</b><br>
  個人研究專案。資料來自臺灣證券交易所、證券櫃檯買賣中心、公開資訊觀測站的<b>盤後公開資料</b>，每個交易日晚間自動更新，<b>不是即時報價</b>。<br>
  預測與技術指標經回測驗證<b>沒有可靠的預測力</b>，僅供參考，<b>不構成任何投資建議</b>。<br>
  <a href="https://github.com/foktengkit/tw-stock-predictor" target="_blank" rel="noopener">原始碼與方法說明</a>`;
if (STATIC) {
  for (const b of $$('#tfGroup button')) if (INTRADAY.includes(b.dataset.tf)) b.hidden = true;
  const conn = $('#conn');
  conn.className = 'conn static';
  conn.title = '公開版：每個交易日晚間依官方盤後資料更新';
  conn.querySelector('.txt').textContent = '每日盤後更新';
  const about = document.createElement('button');
  about.className = 'icon-btn about-btn';
  about.title = '關於本站、資料來源與使用聲明';
  about.setAttribute('aria-label', '關於本站');
  about.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  about.addEventListener('click', () => toast(ABOUT, 20000));
  $('#themeBtn').before(about);
  if (!store.get('aboutSeen', false)) { toast(ABOUT, 20000); store.set('aboutSeen', true); }
}

window.__app = { chart, state, loadSymbol, setTf }; // 方便在瀏覽器主控台除錯
setTab(state.tab, { expand: false });
loadSymbol(state.code);
