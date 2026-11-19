import { fmtPrice, fmtPct, dir, esc, isNum } from './util.js';

export function ratingLabel(score) {
  if (!isNum(score)) return { key: 'na', text: '—' };
  if (score >= 0.5) return { key: 'strong-buy', text: '強烈偏多' };
  if (score >= 0.1) return { key: 'buy', text: '偏多' };
  if (score > -0.1) return { key: 'neutral', text: '中立' };
  if (score > -0.5) return { key: 'sell', text: '偏空' };
  return { key: 'strong-sell', text: '強烈偏空' };
}

const pct = (v, d = 1) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : '—');

/** 預測期間的除權息：已公告金額的已從預測價扣除 */
function dividendNote(list) {
  if (!list || !list.length) return '';
  const md = (iso) => iso.slice(5).replace('-', '/');
  const items = list.map((d) => {
    if (d.pending) return `${md(d.date)} 除息（金額待公告，<b>未扣除</b>）`;
    const parts = [];
    if (d.cash) parts.push(`現金股利 ${d.cash} 元`);
    if (d.stockRatio) parts.push(`配股率 ${d.stockRatio}`);
    return `${md(d.date)} ${parts.join('、') || '除權息'}（已扣除）`;
  });
  return `<div class="note">💰 預測期間除權息：${items.join('、')}。模型以還原權息價格估計走勢，畫面上的預測價已換回原始股價。</div>`;
}

/** 說明預測日期跳過了哪些休市日 */
function calendarNote(cal) {
  if (!cal) return '';
  const md = (iso) => iso.slice(5).replace('-', '/');
  const skipped = cal.skipped.length
    ? `已跳過休市日：${cal.skipped.map((s) => `${md(s.date)} ${esc(s.name)}${s.estimated ? '（推估）' : ''}`).join('、')}`
    : '預測期間沒有遇到休市日';
  const warn = cal.unofficialYears.length
    ? `<br>⚠️ 證交所尚未公布 ${cal.unofficialYears.join('、')} 年休市日曆，該年僅排除固定日期的國定假日，農曆節日與補假可能未排除。`
    : '';
  return `<div class="note">📅 ${skipped}（依證交所開休市日曆）${warn}</div>`;
}

export function renderPredictionLoading(el) {
  el.innerHTML = '<div class="skeleton"><div class="spinner"></div>模型運算中…（4 個模型 × 100 次樣本外回測）</div>';
}

export function renderPredictionError(el, msg) {
  el.innerHTML = `<div class="skeleton">無法產生預測：${esc(msg)}</div>`;
}

/**
 * 與基準比較：方向準確率的 95% 信賴區間下緣 > max(50%, 永遠猜漲) → 優於；上緣 < 永遠猜漲 → 劣於
 */
function judge(ens, upRate) {
  const ci = ens && ens.ci95;
  if (!ci) return 'na';
  const base = Math.max(0.5, isNum(upRate) ? upRate : 0.5);
  if (ci[0] > base) return 'better';
  if (isNum(upRate) && ci[1] < upRate) return 'worse';
  return 'same';
}
const JUDGE_TEXT = { better: '優於基準', same: '未優於基準', worse: '輸給基準', na: '—' };

export function renderPrediction(el, p, { onJump } = {}) {
  const h20 = p.horizons[p.horizons.length - 1];
  const bt = p.backtest, lg = bt.long;
  const beatsRw = isNum(bt.ensemble.mape) && isNum(bt.randomWalk.mape) && bt.ensemble.mape < bt.randomWalk.mape;
  const upBase = bt.alwaysUp && bt.alwaysUp.hitRate;
  const upBase20 = lg.alwaysUp && lg.alwaysUp.hitRate;
  const j5 = judge(bt.ensemble, upBase), j20 = judge(lg.ensemble, upBase20);
  // 兩個期間都顯著優於基準才算「有預測力」
  const overall = j5 === 'better' && j20 === 'better' ? 'better' : j5 === 'worse' || j20 === 'worse' ? 'worse' : 'same';
  const pillClass = { better: 'bull', same: 'neutral', worse: 'na' }[overall];
  const ciTxt = (s) => (s && s.ci95 ? `（95% 區間 ${pct(s.ci95[0], 0)}–${pct(s.ci95[1], 0)}）` : '');
  const base20 = p.baseRate && p.baseRate.upShare;

  const cards = `
  <div class="cards">
    <div class="card">
      <div class="lbl">預測力檢驗（樣本外回測）</div>
      <div><span class="pill ${pillClass}">${overall === 'better' ? '有預測力' : JUDGE_TEXT[overall]}</span></div>
      <div class="sub">基準：永遠猜漲、未來價格＝今天價格</div>
      <div class="sub">技術指標統計：${esc(p.technical.text)}（僅供參考，非買賣建議）</div>
    </div>
    <div class="card">
      <div class="lbl">${h20.days} 日預測價（${h20.date.slice(5).replace('-', '/')}）</div>
      <div class="val ${dir(h20.changePct)}">${fmtPrice(h20.price)} <small style="font-size:13px">${fmtPct(h20.changePct)}</small></div>
      <div class="sub num">80% 區間 ${fmtPrice(h20.low80)} – ${fmtPrice(h20.high80)}</div>
      <div class="sub">預測訊號 <b class="${p.signal.key === 'bull' ? 'up' : p.signal.key === 'bear' ? 'down' : 'muted'}">${p.signal.text}</b></div>
    </div>
    <div class="card">
      <div class="lbl">${h20.days} 日後上漲機率（模型）</div>
      <div class="val ${h20.upProb >= 0.5 ? 'up' : 'down'}">${pct(h20.upProb, 0)}</div>
      <div class="bar"><i style="width:${(h20.upProb * 100).toFixed(1)}%"></i></div>
      <div class="sub">對照：近 2 年任意 20 日上漲比例 <b>${pct(base20, 0)}</b></div>
    </div>
    <div class="card">
      <div class="lbl">樣本外方向準確率</div>
      <div class="sub" style="margin-top:4px"><b class="num" style="font-size:16px;color:var(--text)">${pct(lg.ensemble.hitRate, 0)}</b> ${lg.horizon} 日${ciTxt(lg.ensemble)}<br>永遠猜漲 ${pct(upBase20, 0)} · <b>${JUDGE_TEXT[j20]}</b></div>
      <div class="sub" style="margin-top:4px"><b class="num" style="font-size:16px;color:var(--text)">${pct(bt.ensemble.hitRate, 0)}</b> ${bt.horizon} 日${ciTxt(bt.ensemble)}<br>永遠猜漲 ${pct(upBase, 0)} · <b>${JUDGE_TEXT[j5]}</b></div>
    </div>
  </div>`;

  const horizonRows = p.horizons.map((h) => `
    <tr><td>${h.days} 日</td><td class="muted">${h.date.slice(5).replace('-', '/')}</td>
    <td class="r ${dir(h.changePct)}">${fmtPrice(h.price)}</td><td class="r ${dir(h.changePct)}">${fmtPct(h.changePct)}</td>
    <td class="r muted">${fmtPrice(h.low80)} – ${fmtPrice(h.high80)}</td><td class="r">${pct(h.upProb, 0)}</td></tr>`).join('');

  const maxW = Math.max(...p.models.map((m) => m.weight));
  const modelRows = p.models.map((m) => `
    <tr title="${esc(m.desc)}"><td>${esc(m.name)}</td>
    <td class="r ${dir(m.changePct)}">${fmtPrice(m.target)}<br><small>${fmtPct(m.changePct)}</small></td>
    <td><span class="weight" style="width:${Math.round((m.weight / maxW) * 46)}px"></span>${pct(m.weight, 0)}</td>
    <td class="r">${pct(m.mape, 2)}</td><td class="r">${pct(m.hitRate, 0)}</td></tr>`).join('');

  const a = p.analog;
  const analog = a ? `
    <h4 style="margin-top:12px">歷史相似型態</h4>
    <div class="note">在歷史中找到 <b>${a.count}</b> 段與近 20 日走勢最相似的區間，其中加權 <b class="${a.upProb >= 0.5 ? 'up' : 'down'}">${pct(a.upProb, 0)}</b> 在 ${p.horizon} 日後上漲，平均報酬 <b class="${dir(a.avgReturn)}">${fmtPct(a.avgReturn * 100)}</b>。點擊可跳至該時間點：</div>
    ${a.matches.slice(0, 4).map((m) => `<div class="match" data-date="${m.date}"><span>${m.date.replace(/-/g, '/')}</span><span class="muted">相似度 ${(m.similarity * 100).toFixed(0)}</span><span class="${dir(m.forwardReturn)} num">${fmtPct(m.forwardReturn * 100)}</span></div>`).join('')}` : '';

  el.innerHTML = `${cards}
  <div class="pgrid">
    <div>
      <h4>預測路徑</h4>
      <table class="t"><thead><tr><th>期間</th><th>日期</th><th class="r">預測價</th><th class="r">漲跌</th><th class="r">80% 區間</th><th class="r">上漲機率</th></tr></thead><tbody>${horizonRows}</tbody></table>
      <div class="note" style="margin-top:8px">基準價 <b>${fmtPrice(p.lastPrice)}</b>（${p.lastDate.replace(/-/g, '/')}）· 年化波動度 <b>${pct(p.volatility.annual, 1)}</b></div>
      ${calendarNote(p.calendar)}
      ${dividendNote(p.dividends)}
    </div>
    <div>
      <h4>模型集成（依回測誤差加權）</h4>
      <table class="t"><thead><tr><th>模型</th><th class="r">${p.horizon} 日目標</th><th>權重</th><th class="r">回測誤差</th><th class="r">方向準確</th></tr></thead><tbody>${modelRows}</tbody></table>
    </div>
    <div>
      <h4>樣本外回測（Walk-Forward）</h4>
      <div class="note">${bt.from.replace(/-/g, '/')}–${bt.to.replace(/-/g, '/')} 期間，每 ${bt.horizon} 個交易日站在當時、只用當時以前的資料預測 ${bt.horizon} 日後價格，共 <b>${bt.samples}</b> 次互不重疊的預測（模型參數與集成權重都只用當時已知的資料）。
      集成模型平均誤差 <b>${pct(bt.ensemble.mape, 2)}</b>，「未來價格 = 今天價格」的隨機漫步基準誤差 <b>${pct(bt.randomWalk.mape, 2)}</b>；
      方向猜對 <b>${bt.ensemble.hits}/${bt.ensemble.n}</b> 次；同期「永遠猜漲」可猜對 <b>${pct(upBase, 0)}</b>。
      ${lg.horizon} 日預測：平均誤差 <b>${pct(lg.ensemble.mape, 2)}</b>，隨機漫步 <b>${pct(lg.randomWalk.mape, 2)}</b>（每 ${bt.horizon} 日預測一次、區間互相重疊，信賴區間已用有效樣本數 ÷${lg.overlap} 計算）。
      ${beatsRw ? '模型誤差略低於基準。' : '<b>模型未優於隨機漫步基準</b>，代表此股走勢難以從價格本身預測。'}
      ${bt.excludedPartialBar ? '（盤中尚未收盤的今日 K 棒不列入回測）' : ''}</div>
      ${analog}
      <div class="disclaimer">⚠️ 本預測由統計模型自動產生，僅供研究與學習參考，不構成任何投資建議。股價受基本面、消息面與總體經濟影響，過去表現不代表未來結果。</div>
    </div>
  </div>`;

  if (onJump) for (const m of el.querySelectorAll('.match')) m.addEventListener('click', () => onJump(m.dataset.date));
}
