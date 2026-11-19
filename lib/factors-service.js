/**
 * 伺服器用的因子報告：在背景執行緒計算，主執行緒（即時報價推播）不會被卡住。
 * 資料版本沒變就用快取；資料更新時先回傳舊報告、背景重算（第一次沒有舊報告才需要等）。
 */
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const factors = require('./factors');

let cache = null;
let pending = null;

function compute() {
  if (pending) return pending;
  const t0 = Date.now();
  pending = new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'factors-worker.js'));
    let done = false;
    w.once('message', (m) => { done = true; m.ok ? resolve(m.report) : reject(new Error(m.error)); });
    w.once('error', (e) => { done = true; reject(e); });
    w.once('exit', (code) => { if (!done) reject(new Error(`因子計算執行緒異常結束（${code}）`)); });
  })
    .then((r) => {
      if (r) console.log(`[factors] 報告已更新（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
      cache = r;
      return r;
    })
    .finally(() => { pending = null; });
  return pending;
}

/** @returns 最新的報告；沒有官方資料時為 null */
async function report() {
  const v = factors.dataVersion();
  if (!v) return null;
  if (cache && cache.version === v) return cache;
  const p = compute();
  if (cache) {
    p.catch((e) => console.warn('[factors] 背景重算失敗：', e.message));
    return { ...cache, updating: true };
  }
  return p;
}

/** 不等結果，只讓它在背景先算好（伺服器啟動、官方資料更新後呼叫） */
function warm() {
  report().catch((e) => console.warn('[factors] 預先計算失敗：', e.message));
}

module.exports = { report, warm, stockFactors: factors.stockFactors };
