import { api, esc, fmtInt, isNum } from './util.js';
import { chartThemeOptions, UP, DOWN } from './chart.js';

const LW = window.LightweightCharts;
const lots = (shares) => (isNum(shares) ? shares / 1000 : null);
const signed = (v, d = 0) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toLocaleString('zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d })}` : '—');
const cls = (v) => (!isNum(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');

const VERDICT = {
  significant: ['顯著', 'sig'],
  marginal: ['邊緣', 'mar'],
  none: ['不顯著', 'non'],
  insufficient: ['資料不足', 'non'],
};

/** 因子數值的顯示方式 */
function fmtFactor(key, v) {
  if (!isNum(v)) return '—';
  switch (key) {
    case 'foreign20': case 'trust20': case 'margin20': return `${signed(v * 100, 1)}%`;
    case 'shortRatio': return `${(v * 100).toFixed(1)}%`;
    case 'revYoY': return `${signed(v, 1)}%`;
    case 'revAccel': return `${signed(v, 1)} 個百分點`;
    case 'mom': case 'rev20': return `${signed((Math.exp(v) - 1) * 100, 1)}%`;
    default: return v.toFixed(3);
  }
}

/** 各年平均 IC，例如「2025 +0.117 · 2026 +0.058」 */
function yearsText(byYear) {
  if (!byYear || !byYear.length) return '—';
  return byYear.map((y) => `<span title="${y.periods} 期" class="${cls(y.icMean)}">${y.year} ${signed(y.icMean, 3)}</span>`).join(' · ');
}

function rankText(p) {
  if (!isNum(p)) return '—';
  return p >= 0.5 ? `前 ${Math.max(1, Math.round((1 - p) * 100))}%` : `後 ${Math.max(1, Math.round(p * 100))}%`;
}

/** 底部「籌碼・營收」分頁：三大法人、融資融券、月營收與因子檢驗 */
export class ChipsPanel {
  constructor(el) {
    this.el = el;
    this.theme = 'dark';
    this.charts = [];
    this.code = null;
    this.seq = 0;
  }

  setTheme(theme) {
    this.theme = theme;
    for (const c of this.charts) c.applyOptions(chartThemeOptions(theme));
  }

  async load(code, { quiet = false } = {}) {
    this.code = code;
    const id = ++this.seq;
    if (!quiet) this.el.innerHTML = '<div class="skeleton"><div class="spinner"></div>讀取官方資料…</div>';
    try {
      const [d, f] = await Promise.all([api(`/api/chips?code=${encodeURIComponent(code)}`), api('/api/factors').catch((e) => ({ error: e.message }))]);
      if (id !== this.seq) return;
      this.render(d, f);
    } catch (e) {
      if (id !== this.seq) return;
      this.destroyCharts();
      this.el.innerHTML = `<div class="skeleton">${esc(e.message)}</div>`;
    }
  }

  destroyCharts() {
    for (const c of this.charts) { try { c.remove(); } catch { /* noop */ } }
    this.charts = [];
  }

  miniChart(container, extra = {}) {
    const c = LW.createChart(container, {
      autoSize: true,
      ...chartThemeOptions(this.theme),
      layout: { ...chartThemeOptions(this.theme).layout, fontSize: 11, attributionLogo: false },
      rightPriceScale: { borderVisible: false },
      leftPriceScale: { borderVisible: false, visible: !!extra.left },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      handleScroll: false, handleScale: false,
      crosshair: { mode: LW.CrosshairMode.Magnet },
      localization: { locale: 'zh-TW', priceFormatter: extra.fmt || ((v) => fmtInt(v)) },
    });
    this.charts.push(c);
    return c;
  }

  render(d, f) {
    this.destroyCharts();
    const cov = d.coverage || {};
    const inst = d.inst || [], margin = d.margin || [], rev = d.revenue || [];
    const lastInst = inst[inst.length - 1], lastMargin = margin[margin.length - 1], lastRev = rev[rev.length - 1];

    // 三大法人摘要：近 5 / 20 日
    const sumLast = (key, n) => lots(inst.slice(-n).reduce((s, r) => s + (r[key] || 0), 0));
    const instRows = [['外資', 'foreign_net'], ['投信', 'trust_net'], ['自營商', 'dealer_net'], ['合計', 'total_net']].map(([n, k]) => {
      const a = sumLast(k, 5), b = sumLast(k, 20);
      return `<tr><td>${n}</td><td class="r ${cls(a)}">${signed(a)}</td><td class="r ${cls(b)}">${signed(b)}</td></tr>`;
    }).join('');

    // 融資融券摘要
    const m20 = margin.length > 20 ? margin[margin.length - 21] : null;
    const mChg = lastMargin && m20 && m20.margin_balance ? lastMargin.margin_balance / m20.margin_balance - 1 : null;
    const ratio = lastMargin && lastMargin.margin_balance ? lastMargin.short_balance / lastMargin.margin_balance : null;

    const facHtml = this.factorTable(d, f);
    this.el.innerHTML = `
      <div class="chips-head">
        <span>官方資料：證交所、櫃買中心、公開資訊觀測站</span>
        <span class="muted">法人／融資券更新至 ${md(lastInst && lastInst.date)}／${md(lastMargin && lastMargin.date)} · 月營收至 ${lastRev ? lastRev.ym.replace('-', '/') : '—'}
        · 籌碼資料涵蓋 ${cov.inst && cov.inst.days ? `${cov.inst.days} 個交易日` : '—'}</span>
      </div>
      <div class="chips-grid">
        <section>
          <h4>三大法人買賣超（張）</h4>
          <div class="mini" data-c="inst"></div>
          <table class="t compact"><thead><tr><th></th><th class="r">近 5 日</th><th class="r">近 20 日</th></tr></thead><tbody>${instRows}</tbody></table>
        </section>
        <section>
          <h4>融資融券餘額（張）</h4>
          <div class="mini" data-c="margin"></div>
          <div class="kv">
            <div><span>融資餘額</span><b>${fmtInt(lastMargin && lastMargin.margin_balance)}</b><span class="${cls(mChg)}">${isNum(mChg) ? `20 日 ${signed(mChg * 100, 1)}%` : ''}</span></div>
            <div><span>融券餘額</span><b>${fmtInt(lastMargin && lastMargin.short_balance)}</b><span></span></div>
            <div><span>券資比</span><b>${isNum(ratio) ? `${(ratio * 100).toFixed(2)}%` : '—'}</b><span></span></div>
          </div>
        </section>
        <section>
          <h4>月營收（億元）與年增率</h4>
          <div class="mini" data-c="rev"></div>
          <div class="kv">${lastRev ? `
            <div><span>${lastRev.ym.replace('-', '/')} 營收</span><b>${(lastRev.revenue / 1e5).toLocaleString('zh-TW', { maximumFractionDigits: 2 })} 億</b><span></span></div>
            <div><span>月增 / 年增</span><b class="${cls(lastRev.mom)}">${signed(lastRev.mom, 1)}%</b><b class="${cls(lastRev.yoy)}">${signed(lastRev.yoy, 1)}%</b></div>
            <div><span>可用日期</span><b>${md(lastRev.available)}</b><span class="muted">申報期限次日，之前不列入預測</span></div>` : '<div class="muted">沒有月營收資料（ETF 或資料尚未下載）</div>'}
          </div>
        </section>
      </div>
      ${facHtml}`;

    // 圖表
    const box = (k) => this.el.querySelector(`.mini[data-c="${k}"]`);
    if (inst.length) {
      const c = this.miniChart(box('inst'), { left: true });
      const s = c.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
      s.setData(inst.slice(-60).map((r) => ({ time: r.date, value: lots(r.total_net) || 0, color: (r.total_net || 0) >= 0 ? UP : DOWN })));
      // 外資累計用左側座標，避免把每日柱狀壓扁
      const fl = c.addSeries(LW.LineSeries, { color: '#ffb300', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, title: '外資累計', priceScaleId: 'left' });
      let cum = 0;
      fl.setData(inst.slice(-60).map((r) => ({ time: r.date, value: (cum += lots(r.foreign_net) || 0) })));
      c.timeScale().fitContent();
    }
    if (margin.length) {
      const c = this.miniChart(box('margin'), { left: true });
      c.addSeries(LW.LineSeries, { color: UP, lineWidth: 1.5, priceLineVisible: false, title: '融資', priceScaleId: 'left' })
        .setData(margin.map((r) => ({ time: r.date, value: r.margin_balance })).filter((p) => isNum(p.value)));
      c.addSeries(LW.LineSeries, { color: DOWN, lineWidth: 1.5, priceLineVisible: false, title: '融券', priceScaleId: 'right' })
        .setData(margin.map((r) => ({ time: r.date, value: r.short_balance })).filter((p) => isNum(p.value)));
      c.timeScale().fitContent();
    }
    if (rev.length) {
      const c = this.miniChart(box('rev'), { left: true, fmt: (v) => v.toLocaleString('zh-TW', { maximumFractionDigits: 1 }) });
      c.addSeries(LW.HistogramSeries, { color: 'rgba(41,98,255,0.6)', priceLineVisible: false, lastValueVisible: false })
        .setData(rev.slice(-24).map((r) => ({ time: `${r.ym}-01`, value: (r.revenue || 0) / 1e5 })));
      c.addSeries(LW.LineSeries, { color: '#ffb300', lineWidth: 1.5, priceLineVisible: false, title: '年增%', priceScaleId: 'left' })
        .setData(rev.slice(-24).filter((r) => isNum(r.yoy)).map((r) => ({ time: `${r.ym}-01`, value: r.yoy })));
      c.timeScale().fitContent();
    }
  }

  factorTable(d, f) {
    if (!f || f.error) return `<div class="factor-box"><h4>因子檢驗</h4><div class="muted">${esc((f && f.error) || '尚無資料')}</div></div>`;
    const mine = new Map(((d.factors && d.factors.factors) || []).map((x) => [x.key, x]));
    const inUni = d.factors && d.factors.inUniverse;
    const rows = f.factors.map((x) => {
      const m = mine.get(x.key) || {};
      const [vt, vc] = VERDICT[x.verdict] || VERDICT.none;
      const dirTxt = x.verdict === 'insufficient' ? '' : x.direction === 'high' ? '數值高者較強' : '數值低者較強';
      return `<tr title="${esc(x.desc)}">
        <td>${esc(x.name)}<div class="muted small">${esc(x.group)}</div></td>
        <td class="r num">${fmtFactor(x.key, m.value)}</td>
        <td class="r">${inUni ? rankText(m.percentile) : '—'}</td>
        <td class="r num">${isNum(x.icMean) ? x.icMean.toFixed(3) : '—'}</td>
        <td class="r num">${isNum(x.t) ? x.t.toFixed(2) : '—'}</td>
        <td class="r num ${cls(x.spread)}">${isNum(x.spread) ? `${signed(x.spread * 100, 2)}%` : '—'}</td>
        <td><span class="vbadge ${vc}">${vt}</span><div class="muted small">${dirTxt}</div></td>
        <td class="num small">${yearsText(x.byYear)}</td>
      </tr>`;
    }).join('');
    const s = f.settings;
    const any = f.factors.find((x) => x.periods);
    const range = (x) => (x && x.from ? `${x.from.replace(/-/g, '/')}–${x.to.replace(/-/g, '/')}` : '');
    return `<div class="factor-box">
      <h4>因子檢驗：這些資料能預測「哪些股票比較強」嗎？${f.updating ? '<span class="muted small">（資料更新中，稍後重新計算）</span>' : ''}</h4>
      <table class="t"><thead><tr><th>因子</th><th class="r">本股數值</th><th class="r">本股排名</th><th class="r">IC</th><th class="r">t 值</th><th class="r">前 20% − 後 20%</th><th>判定</th><th>各年 IC</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note" style="margin-top:8px">
        ${range(any)} 每 ${s.step} 個交易日，在成交值前 ${s.universe} 大的普通股（不含 ETF）中，用「當天收盤後已公布」的資料算因子，
        量<b>隔天收盤</b>起 ${s.horizon} 個交易日的還原權息報酬。<b>IC</b> 是因子排名與之後報酬排名的相關係數（0 = 無關）；
        <b>t 值</b>已依區間重疊調整；本頁連同下方長期檢驗共做 ${s.tests || f.factors.length} 個檢定，為避免「試越多次越容易碰巧顯著」，要 |t| ≥ ${s.multipleTestT} 才算<b>顯著</b>（2 ≤ |t| &lt; ${s.multipleTestT} 為邊緣）。
        「前 20% − 後 20%」是因子最高與最低兩組股票，之後 20 日平均報酬的差距，未扣交易成本。
        <b>各年 IC</b> 用來看效果是每年都有，還是只集中在某一段行情。
        ${inUni === false ? '<br>本股不在成交值前 300 大，未納入排名。' : ''}
      </div>
      ${this.longTable(f)}
    </div>`;
  }

  /** 長期檢驗：不需要籌碼的因子，用更長的歷史（含不同行情）再驗一次 */
  longTable(f) {
    if (!f.long) return '';
    const rows = f.long.factors.map((x) => {
      const [vt, vc] = VERDICT[x.verdict] || VERDICT.none;
      return `<tr title="${esc(x.desc)}">
        <td>${esc(x.name)}</td>
        <td class="r num">${isNum(x.icMean) ? x.icMean.toFixed(3) : '—'}</td>
        <td class="r num">${isNum(x.t) ? x.t.toFixed(2) : '—'}</td>
        <td class="r num ${cls(x.spread)}">${isNum(x.spread) ? `${signed(x.spread * 100, 2)}%` : '—'}</td>
        <td><span class="vbadge ${vc}">${vt}</span></td>
        <td class="r num small">${x.from ? `${x.from.slice(0, 7).replace('-', '/')}–${x.to.slice(0, 7).replace('-', '/')}` : '—'}</td>
        <td class="num small">${yearsText(x.byYear)}</td>
      </tr>`;
    }).join('');
    return `<h4 style="margin-top:14px">長期檢驗：營收與股價因子放到更長的歷史（僅上市）</h4>
      <table class="t compact"><thead><tr><th>因子</th><th class="r">IC</th><th class="r">t 值</th><th class="r">前 20% − 後 20%</th><th>判定</th><th class="r">期間</th><th>各年 IC</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note" style="margin-top:6px">籌碼資料只回補約 2.5 年，但月營收與上市股價有約 5 年，涵蓋 2022 年空頭與之後的多頭。
        只在單一段行情有效的因子，在這裡通常會變弱或翻向。上櫃股價只回補 2.5 年，所以長期檢驗只用上市股票。</div>`;
  }
}
