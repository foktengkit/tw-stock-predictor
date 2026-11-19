import { fmtPrice, fmtInt, fmtChange, fmtPct, dir, esc, isNum, MARKET_LABEL, TF_LABEL } from './util.js';

const LW = window.LightweightCharts;
const TA = window.TA;

export const UP = '#f23645';
export const DOWN = '#089981';
const FORECAST = '#ffb300';
const INTRADAY_SEC = { '1m': 60, '5m': 300, '15m': 900, '60m': 3600 };

const THEMES = {
  dark: { bg: '#131722', text: '#b2b5be', grid: 'rgba(42,46,57,0.55)', border: '#2a2e39', cross: '#758696', mark: 'rgba(178,181,190,0.06)' },
  light: { bg: '#ffffff', text: '#131722', grid: 'rgba(224,227,235,0.6)', border: '#e0e3eb', cross: '#9598a1', mark: 'rgba(19,23,34,0.05)' },
};

/** 其他小圖表共用的主題設定 */
export function chartThemeOptions(theme) {
  const t = THEMES[theme] || THEMES.dark;
  return {
    layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
  };
}

/** 指標定義：pane = main（疊加在主圖）或 sub（獨立副圖） */
export const INDICATORS = {
  MA: {
    label: '均線 MA (5 / 20 / 60)', pane: 'main',
    lines: [
      { id: 'MA5', color: '#f7a600', calc: (d) => TA.sma(d.close, 5) },
      { id: 'MA20', color: '#e040fb', calc: (d) => TA.sma(d.close, 20) },
      { id: 'MA60', color: '#29b6f6', calc: (d) => TA.sma(d.close, 60) },
    ],
  },
  EMA: {
    label: '指數均線 EMA (12 / 26)', pane: 'main',
    lines: [
      { id: 'EMA12', color: '#ff7043', calc: (d) => TA.ema(d.close, 12) },
      { id: 'EMA26', color: '#9ccc65', calc: (d) => TA.ema(d.close, 26) },
    ],
  },
  BOLL: {
    label: '布林通道 (20, 2)', pane: 'main',
    lines: [
      { id: 'BB上', color: 'rgba(41,98,255,0.75)', calc: (d) => TA.bollinger(d.close).upper },
      { id: 'BB中', color: 'rgba(255,109,0,0.75)', calc: (d) => TA.bollinger(d.close).mid },
      { id: 'BB下', color: 'rgba(41,98,255,0.75)', calc: (d) => TA.bollinger(d.close).lower },
    ],
  },
  VOL: { label: '成交量', pane: 'vol', lines: [] },
  RSI: {
    label: 'RSI (14)', pane: 'sub', levels: [70, 30],
    lines: [{ id: 'RSI', color: '#7e57c2', calc: (d) => TA.rsi(d.close, 14) }],
  },
  MACD: {
    label: 'MACD (12, 26, 9)', pane: 'sub',
    lines: [
      { id: 'OSC', type: 'hist', calc: (d) => TA.macd(d.close).hist },
      { id: 'DIF', color: '#2962ff', calc: (d) => TA.macd(d.close).macd },
      { id: 'MACD', color: '#ff6d00', calc: (d) => TA.macd(d.close).signal },
    ],
  },
  KD: {
    label: 'KD 隨機指標 (9, 3, 3)', pane: 'sub', levels: [80, 20],
    lines: [
      { id: 'K', color: '#ff9800', calc: (d) => TA.kd(d.high, d.low, d.close, 9).k },
      { id: 'D', color: '#2962ff', calc: (d) => TA.kd(d.high, d.low, d.close, 9).d },
    ],
  },
};

export class ChartView {
  constructor(container, legendEl) {
    this.el = container;
    this.legendEl = legendEl;
    this.theme = 'dark';
    this.type = 'candles';
    this.tf = 'D';
    this.symbol = null;
    this.candles = [];
    this.active = new Set(['MA', 'VOL']);
    this.forecast = null;
    this.showForecast = true;
    this.showSignals = false;
    this.series = [];
    this.lines = []; // { def, series, values }
    this.hlines = new Map(); // code -> price[]
    this.priceLines = [];
    this.drawMode = null;
    this.hovering = false;
    this.lastTickTs = 0;
    this.cumVol = null;

    this.chart = LW.createChart(container, {
      autoSize: true,
      layout: { attributionLogo: true, fontFamily: getComputedStyle(document.body).fontFamily, panes: { separatorColor: '#2a2e39', enableResize: true } },
      localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 6, barSpacing: 7 },
      crosshair: { mode: LW.CrosshairMode.Normal },
    });
    this.setTheme('dark');

    this.chart.subscribeCrosshairMove((p) => {
      this.hovering = !!(p && p.time !== undefined);
      this.renderLegend(this.hovering ? this.indexOf(p.time) : null);
    });
    this.chart.subscribeClick((p) => {
      if (this.drawMode !== 'hline' || !p.point || !this.main) return;
      const price = this.main.coordinateToPrice(p.point.y);
      if (!isNum(price)) return;
      const list = this.hlines.get(this.symbol.code) || [];
      list.push(price);
      this.hlines.set(this.symbol.code, list);
      this.addPriceLine(price);
      this.onDrawDone && this.onDrawDone();
    });
  }

  // ---------- public API ----------
  setTheme(theme) {
    this.theme = theme;
    const t = THEMES[theme];
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, panes: { separatorColor: t.border } },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: { vertLine: { color: t.cross, labelBackgroundColor: '#363a45' }, horzLine: { color: t.cross, labelBackgroundColor: '#363a45' } },
    });
    if (this.watermark) this.watermark.applyOptions({ lines: this.watermarkLines() });
  }

  setData(symbol, tf, candles) {
    this.symbol = symbol;
    this.tf = tf;
    this.candles = candles.map((c) => ({ ...c }));
    this.cumVol = null;
    this.lastTickTs = 0;
    const intraday = !!INTRADAY_SEC[tf];
    this.chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    this.render();
    this.resetView();
  }

  setIndicators(set) { this.active = new Set(set); this.render(); }
  setType(type) { this.type = type; this.render(); }
  setForecast(f) { this.forecast = f; this.render(); }
  setShowForecast(v) { this.showForecast = v; this.render(); }
  setShowSignals(v) { this.showSignals = v; this.render(); }
  setMagnet(on) { this.chart.applyOptions({ crosshair: { mode: on ? LW.CrosshairMode.Magnet : LW.CrosshairMode.Normal } }); }
  setDrawMode(mode) { this.drawMode = mode; }

  clearDrawings() {
    if (this.symbol) this.hlines.delete(this.symbol.code);
    for (const pl of this.priceLines) { try { this.main.removePriceLine(pl); } catch { /* noop */ } }
    this.priceLines = [];
  }

  resetView() {
    const n = this.candles.length;
    if (!n) return;
    const showF = this.forecastVisible();
    const span = INTRADAY_SEC[this.tf] ? (this.tf === '1m' ? 270 : 160) : this.tf === 'D' ? 140 : 120;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - span), to: n + (showF ? 24 : 6) });
  }

  focusTime(time) {
    const i = this.indexOf(time);
    if (i == null) return;
    this.chart.timeScale().setVisibleLogicalRange({ from: i - 40, to: i + 40 });
  }

  screenshot() {
    const canvas = this.chart.takeScreenshot(true);
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.symbol ? this.symbol.code : 'chart'}_${this.tf}_${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  /** 以 MIS 即時報價更新最後一根 K 棒（或新增一根） */
  updateLive(q) {
    if (!this.candles.length || !q || !isNum(q.price) || !this.symbol || q.code !== this.symbol.code) return;
    const last = this.candles[this.candles.length - 1];
    let appended = false;
    const sec = INTRADAY_SEC[this.tf];
    const isoDate = q.date ? `${q.date.slice(0, 4)}-${q.date.slice(4, 6)}-${q.date.slice(6, 8)}` : null;
    const local = Math.floor(q.ts / 1000) + 8 * 3600; // 台北時間秒數
    const tod = local % 86400;
    if (tod < 9 * 3600) return; // 08:30–09:00 試撮價不是真實成交，不畫進 K 線

    if (sec) {
      if (q.ts === this.lastTickTs) return;
      this.lastTickTs = q.ts;
      // 13:30 之後（如指數 13:33 收盤統計）併入最後一根
      const capped = tod > 13.5 * 3600 ? local - tod + 13.5 * 3600 : local;
      const t = Math.floor(capped / sec) * sec;
      if (t < last.time) return;
      let dv = 0;
      if (isNum(q.volume)) {
        if (this.cumVol && this.cumVol.date === q.date && q.volume >= this.cumVol.v) dv = q.volume - this.cumVol.v;
        this.cumVol = { date: q.date, v: q.volume };
      }
      if (t === last.time) {
        last.close = q.price; last.high = Math.max(last.high, q.price); last.low = Math.min(last.low, q.price); last.volume += dv;
      } else {
        this.candles.push({ time: t, open: q.price, high: q.price, low: q.price, close: q.price, volume: dv });
        appended = true;
      }
    } else if (isoDate) {
      if (this.tf === 'D') {
        if (isoDate < last.time) return;
        const sameDay = isoDate === last.time;
        const bar = {
          time: isoDate,
          open: q.open ?? q.price,
          high: Math.max(q.high ?? q.price, q.price),
          low: Math.min(q.low ?? q.price, q.price),
          close: q.price,
          // MIS 成交量口徑比 Yahoo 小；同一天不讓量「倒退」，與歷史 K 棒維持一致
          volume: sameDay ? Math.max(last.volume || 0, q.volume || 0) : q.volume ?? 0,
        };
        if (sameDay) Object.assign(last, bar);
        else { this.candles.push(bar); appended = true; }
      } else {
        const bucket = this.tf === 'W' ? mondayOf(isoDate) : `${isoDate.slice(0, 7)}-01`;
        if (bucket < last.time) return;
        if (bucket === last.time) {
          last.close = q.price;
          last.high = Math.max(last.high, q.high ?? q.price);
          last.low = Math.min(last.low, q.low ?? q.price);
        } else {
          this.candles.push({ time: bucket, open: q.open ?? q.price, high: q.high ?? q.price, low: q.low ?? q.price, close: q.price, volume: q.volume ?? 0 });
          appended = true;
        }
      }
    } else return;

    if (appended) { this.render(); return; }
    this.refreshLast();
  }

  // ---------- internals ----------
  forecastVisible() {
    return this.showForecast && this.tf === 'D' && this.forecast && this.symbol && this.forecast.code === this.symbol.code;
  }

  data() {
    const c = this.candles;
    return {
      time: c.map((x) => x.time), open: c.map((x) => x.open), high: c.map((x) => x.high),
      low: c.map((x) => x.low), close: c.map((x) => x.close), volume: c.map((x) => x.volume || 0),
    };
  }

  indexOf(time) {
    if (time === undefined || time === null) return null;
    const key = typeof time === 'object' ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}` : time;
    const i = this.timeIndex && this.timeIndex.get(key);
    return i === undefined ? null : i;
  }

  mainPoint(c) {
    return this.type === 'line' || this.type === 'area' ? { time: c.time, value: c.close } : { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
  }

  volPoint(c) {
    return { time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(242,54,69,0.45)' : 'rgba(8,153,129,0.45)' };
  }

  watermarkLines() {
    if (!this.symbol) return [];
    return [{ text: `${this.symbol.code === 't00' ? '' : this.symbol.code + ' '}${this.symbol.name}`, color: THEMES[this.theme].mark, fontSize: 56, fontStyle: 'bold', fontFamily: getComputedStyle(document.body).fontFamily }];
  }

  clearSeries() {
    for (const s of this.series) { try { this.chart.removeSeries(s); } catch { /* noop */ } }
    this.series = [];
    this.lines = [];
    this.priceLines = [];
    this.markers = null;
    try {
      while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);
    } catch { /* noop */ }
  }

  add(def, opts, pane = 0) {
    const s = this.chart.addSeries(def, { priceLineVisible: false, ...opts }, pane);
    this.series.push(s);
    return s;
  }

  render() {
    if (!this.symbol) return;
    this.clearSeries();
    const d = this.data();
    this.timeIndex = new Map(d.time.map((t, i) => [t, i]));
    const isIndex = this.symbol.type === 'index';
    const showVol = this.active.has('VOL') && !isIndex;

    // 主圖
    const priceOpts = { priceLineVisible: true, lastValueVisible: true };
    if (this.type === 'candles') {
      this.main = this.add(LW.CandlestickSeries, { ...priceOpts, upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN });
    } else if (this.type === 'bars') {
      this.main = this.add(LW.BarSeries, { ...priceOpts, upColor: UP, downColor: DOWN, thinBars: false });
    } else if (this.type === 'line') {
      this.main = this.add(LW.LineSeries, { ...priceOpts, color: '#2962ff', lineWidth: 2 });
    } else {
      this.main = this.add(LW.AreaSeries, { ...priceOpts, lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.35)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2 });
    }
    this.main.setData(this.candles.map((c) => this.mainPoint(c)));
    this.main.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: showVol ? 0.24 : 0.06 } });

    if (showVol) {
      this.vol = this.add(LW.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false });
      this.vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      this.vol.setData(this.candles.map((c) => this.volPoint(c)));
    } else this.vol = null;

    // 疊加指標 + 副圖指標
    let pane = 1;
    for (const key of Object.keys(INDICATORS)) {
      if (!this.active.has(key)) continue;
      const def = INDICATORS[key];
      if (def.pane === 'vol') continue;
      const paneIdx = def.pane === 'main' ? 0 : pane++;
      let first = null;
      for (const ln of def.lines) {
        const values = ln.calc(d);
        let s;
        if (ln.type === 'hist') {
          s = this.add(LW.HistogramSeries, { lastValueVisible: false }, paneIdx);
          s.setData(values.map((v, i) => (v == null ? null : { time: d.time[i], value: v, color: v >= 0 ? 'rgba(242,54,69,0.6)' : 'rgba(8,153,129,0.6)' })).filter(Boolean));
        } else {
          s = this.add(LW.LineSeries, { color: ln.color, lineWidth: def.pane === 'main' ? 1.5 : 1.5, lastValueVisible: def.pane !== 'main', crosshairMarkerVisible: false }, paneIdx);
          s.setData(values.map((v, i) => (v == null ? null : { time: d.time[i], value: v })).filter(Boolean));
          if (!first) first = s;
        }
        this.lines.push({ key, def: ln, series: s, values });
      }
      if (def.levels && first) {
        for (const lv of def.levels) first.createPriceLine({ price: lv, color: 'rgba(134,137,147,0.5)', lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
      }
    }
    const panes = this.chart.panes();
    if (panes.length > 1) {
      panes[0].setStretchFactor(panes.length > 2 ? 2.2 : 3);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    }

    // AI 預測路徑
    if (this.forecastVisible()) {
      const f = this.forecast;
      const start = { time: f.lastDate, value: f.lastPrice };
      const mk = (key) => [start, ...f.path.map((p) => ({ time: p.time, value: p[key] }))];
      const band = { color: 'rgba(255,179,0,0.55)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, lastValueVisible: false, crosshairMarkerVisible: false };
      this.add(LW.LineSeries, band).setData(mk('high80'));
      this.add(LW.LineSeries, band).setData(mk('low80'));
      this.add(LW.LineSeries, { color: FORECAST, lineWidth: 2, lineStyle: LW.LineStyle.Dashed, lastValueVisible: true, title: 'AI 預測', crosshairMarkerVisible: true }).setData(mk('value'));
    }

    // 均線交叉訊號
    if (this.showSignals && this.candles.length > 25) {
      const s5 = TA.sma(d.close, 5), s20 = TA.sma(d.close, 20);
      const marks = [];
      for (let i = 1; i < d.close.length; i++) {
        if (s5[i - 1] == null || s20[i - 1] == null) continue;
        if (s5[i - 1] <= s20[i - 1] && s5[i] > s20[i]) marks.push({ time: d.time[i], position: 'belowBar', color: UP, shape: 'arrowUp', text: '金叉' });
        else if (s5[i - 1] >= s20[i - 1] && s5[i] < s20[i]) marks.push({ time: d.time[i], position: 'aboveBar', color: DOWN, shape: 'arrowDown', text: '死叉' });
      }
      this.markers = LW.createSeriesMarkers(this.main, marks);
    }

    // 使用者畫的水平線
    for (const p of this.hlines.get(this.symbol.code) || []) this.addPriceLine(p);

    // 浮水印
    if (this.watermark) { try { this.watermark.detach(); } catch { /* noop */ } }
    this.watermark = LW.createTextWatermark(this.chart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines: this.watermarkLines() });

    this.renderLegend(null);
  }

  addPriceLine(price) {
    const pl = this.main.createPriceLine({ price, color: '#2962ff', lineWidth: 1, lineStyle: LW.LineStyle.Solid, axisLabelVisible: true, title: '' });
    this.priceLines.push(pl);
  }

  refreshLast() {
    const last = this.candles[this.candles.length - 1];
    this.main.update(this.mainPoint(last));
    if (this.vol) this.vol.update(this.volPoint(last));
    const d = this.data();
    const i = d.close.length - 1;
    for (const l of this.lines) {
      l.values = l.def.calc(d);
      const v = l.values[i];
      if (v == null) continue;
      if (l.def.type === 'hist') l.series.update({ time: last.time, value: v, color: v >= 0 ? 'rgba(242,54,69,0.6)' : 'rgba(8,153,129,0.6)' });
      else l.series.update({ time: last.time, value: v });
    }
    if (!this.hovering) this.renderLegend(null);
  }

  renderLegend(idx) {
    const c = this.candles;
    if (!c.length || !this.symbol) { this.legendEl.innerHTML = ''; return; }
    const i = idx == null ? c.length - 1 : idx;
    const bar = c[i];
    if (!bar) return;
    const prev = c[i - 1];
    const ch = prev ? bar.close - prev.close : null;
    const pct = prev ? (ch / prev.close) * 100 : null;
    const cls = dir(bar.close - bar.open);
    const kv = (k, v, cl = cls) => `<span><span class="k">${k}</span><span class="${cl} num">${v}</span></span>`;
    const head = `<span class="ttl">${esc(this.symbol.code === 't00' ? '' : this.symbol.code)} ${esc(this.symbol.name)} · ${TF_LABEL[this.tf]} · ${this.symbol.type === 'index' ? '指數' : MARKET_LABEL[this.symbol.market] || ''}</span>`;
    let row1 = `${head}${kv('開', fmtPrice(bar.open))}${kv('高', fmtPrice(bar.high))}${kv('低', fmtPrice(bar.low))}${kv('收', fmtPrice(bar.close))}`;
    if (ch != null) row1 += `<span class="${dir(ch)} num">${fmtChange(ch)} (${fmtPct(pct)})</span>`;
    if (this.symbol.type !== 'index') row1 += kv('量', `${fmtInt(bar.volume)} 張`, 'num');

    const groups = new Map();
    for (const l of this.lines) {
      const v = l.values[i];
      if (!groups.has(l.key)) groups.set(l.key, []);
      groups.get(l.key).push(`<span><span class="k">${l.def.id}</span><span class="num" style="color:${l.def.color || 'inherit'}">${v == null ? '—' : fmtPrice(v)}</span></span>`);
    }
    const rows = [...groups.values()].map((g) => `<div class="row">${g.join('')}</div>`).join('');
    let fRow = '';
    if (this.forecastVisible() && idx == null) {
      const f = this.forecast, end = f.path[f.path.length - 1];
      fRow = `<div class="row"><span><span class="k">AI 預測 ${f.path.length} 日</span><span class="num" style="color:${FORECAST}">${fmtPrice(end.value)}</span></span><span class="k num">80% 區間 ${fmtPrice(end.low80)} – ${fmtPrice(end.high80)}</span></div>`;
    }
    this.legendEl.innerHTML = `<div class="row">${row1}</div>${rows}${fRow}`;
  }
}

function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
