/**
 * 公開版上線後的自動驗證
 *   node scripts/verify-site.js <網站網址> [--expect-built-at <ISO 時間>] [--browser]
 *
 * 1. HTTP：首頁、設定檔與關鍵資料檔都能下載、內容合理、資料沒有過期。
 *    給了 --expect-built-at 時，會等到線上版本就是這次建置的版本（剛部署完 CDN 可能還在更新）。
 * 2. 瀏覽器（--browser，需要 Chrome）：實際打開網頁，確認 K 線、預測、籌碼都畫出來，
 *    而且沒有任何 JavaScript 錯誤。
 * 任何一項失敗 → 結束代碼 1。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/?$/, '/');
const EXPECT_BUILT_AT = opt('--expect-built-at');
const BROWSER = args.includes('--browser');
const MAX_STALE_DAYS = 12; // 最長連假（春節）約 9 天，再多就代表資料同步出問題
if (!BASE.startsWith('http')) { console.error('用法：node scripts/verify-site.js <網站網址> [--expect-built-at ISO] [--browser]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(name);
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `：${detail}` : ''}`);
  return ok;
}

/** 下載（網路錯誤或 5xx 時重試，GitHub Pages 剛部署完偶爾會回 503） */
async function get(rel, { json = false, tries = 5 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}${rel}${rel.includes('?') ? '&' : '?'}t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
      if (r.status < 500) {
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: true });
        return json ? r.json() : r.text();
      }
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await sleep(5000);
  }
  throw last;
}

const parseConfig = (js) => JSON.parse(js.replace(/^[^{]*/, '').replace(/;\s*$/, ''));

async function httpChecks() {
  // 1. 線上版本
  let cfg;
  for (let i = 0; ; i++) {
    cfg = parseConfig(await get('config.js'));
    if (!EXPECT_BUILT_AT || cfg.builtAt === EXPECT_BUILT_AT || i >= 30) break;
    if (i === 0) console.log(`  線上還是舊版本（${cfg.builtAt}），等待 CDN 更新…`);
    await sleep(20000);
  }
  check('線上版本', !EXPECT_BUILT_AT || cfg.builtAt === EXPECT_BUILT_AT, `建置時間 ${cfg.builtAt}${EXPECT_BUILT_AT && cfg.builtAt !== EXPECT_BUILT_AT ? `（預期 ${EXPECT_BUILT_AT}）` : ''}`);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const stale = (Date.parse(today) - Date.parse(cfg.dataDate)) / 86400e3;
  check('資料日期', stale >= 0 && stale <= MAX_STALE_DAYS, `${cfg.dataDate}（${stale} 天前）`);

  // 2. 首頁與程式
  const html = await get('');
  check('首頁', html.includes('config.js') && html.includes('js/app.js'), `${html.length} 字元`);
  const bundle = await get('js/static-api.js');
  check('公開版資料模組', bundle.includes('staticApi') && !/^import\s/m.test(bundle), `${(bundle.length / 1024).toFixed(0)} KB`);

  // 3. 關鍵資料
  const meta = await get('data/meta.json', { json: true });
  check('資料摘要', meta.dataDate === cfg.dataDate && meta.files.candles > 2000 && meta.files.chips > 1500, `K 線 ${meta.files.candles} 檔、籌碼 ${meta.files.chips} 檔`);
  const quotes = await get('data/quotes.json', { json: true });
  const q = quotes['2330'], ix = quotes.t00;
  check('報價', !!(q && q.price > 0 && ix && ix.price > 1000 && Object.keys(quotes).length > 2000), `${Object.keys(quotes).length} 檔；2330 ${q && q.price}、加權 ${ix && ix.price}`);
  const k = await get('data/k/2330.json', { json: true });
  const last = k.rows[k.rows.length - 1];
  check('K 線', k.rows.length > 1000 && last[0] === cfg.dataDate, `2330 共 ${k.rows.length} 根，最後一根 ${last[0]}`);
  const fac = await get('data/factors.json', { json: true });
  check('因子檢驗', fac.factors.length === 8 && !!fac.long, `${fac.factors.length} 個因子，長期檢驗${fac.long ? '有' : '缺'}`);
  return cfg;
}

// ════════════════════════════════════════════════════════════════
// 瀏覽器檢查（透過 Chrome DevTools Protocol）
// ════════════════════════════════════════════════════════════════
function findChrome() {
  const list = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return list.find((p) => p && fs.existsSync(p));
}

async function browserChecks() {
  const chrome = findChrome();
  if (!check('找到 Chrome', !!chrome, chrome || '請設定 CHROME_PATH')) return;
  const WebSocket = require('ws');
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-chrome-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* 還在啟動 */ }
      if (!target) await sleep(500);
    }
    if (!check('啟動 Chrome', !!target)) return;
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.on('open', ok); ws.on('error', fail); });
    let id = 0;
    const pending = new Map(), errors = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception ? d.exception.description : d.text);
      }
    });
    const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const waitFor = async (expression, ms = 40000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return true; await sleep(500); }
      return false;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${BASE}#2330` });

    const legend = (code) => `!!(window.__app && document.querySelector('#legend').innerText.includes('${code}'))`;
    check('頁面啟動並畫出 K 線', await waitFor(legend('2330')), '2330');
    check('AI 預測（在瀏覽器裡計算）', await waitFor("document.querySelector('#tab-predict').innerText.includes('20 日預測價')"));
    await evaluate("__app.loadSymbol('6488')");
    check('切換到上櫃股票', await waitFor(legend('6488')), '6488');
    await evaluate("document.querySelector('[data-tab=chips]').click()");
    check('籌碼・營收分頁', await waitFor("document.querySelector('#tab-chips').innerText.includes('三大法人')"));
    await evaluate("__app.loadSymbol('t00')");
    check('加權指數', await waitFor(legend('加權指數')));
    check('沒有 JavaScript 錯誤', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '');
  } finally {
    if (ws) ws.close();
    proc.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

(async () => {
  console.log(`驗證 ${BASE}`);
  try {
    await httpChecks();
  } catch (e) {
    check('HTTP 檢查', false, e.message);
  }
  if (BROWSER) {
    try {
      await browserChecks();
    } catch (e) {
      check('瀏覽器檢查', false, e.message);
    }
  }
  console.log(failures.length ? `\n${failures.length} 項失敗：${failures.join('、')}` : '\n全部正常');
  process.exit(failures.length ? 1 : 0);
})();
