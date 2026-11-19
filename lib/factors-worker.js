// 在背景執行緒計算因子檢驗報告（約數秒到十幾秒的純計算），算完把結果傳回主執行緒後結束
const { parentPort } = require('node:worker_threads');
const factors = require('./factors');

try {
  parentPort.postMessage({ ok: true, report: factors.computeReport() });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.stack || e.message });
}
