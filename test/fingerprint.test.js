/**
 * 官方資料指紋：有新資料才改變；重抓到一樣的資料、抓取失敗都不變
 * （公開版靠它決定要不要重新發布，誤判會變成「該更新沒更新」或「每 15 分鐘白白發布一次」）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tws-fp-'));
process.env.OFFICIAL_DB = path.join(dir, 'official.db');
const db = require('../lib/official/db');
const { fingerprint, summary } = require('../lib/official/fingerprint');

const DAILY = ['date', 'code', 'market', 'open', 'high', 'low', 'close', 'volume', 'value', 'trades'];
const day = (date, code) => [date, code, 'tse', 100, 101, 99, 100, 1000, 100000, 10];

test('有新資料才改變指紋', () => {
  db.upsert('daily', DAILY, [day('2026-11-19', '2330'), day('2026-11-19', '2317')]);
  const a = fingerprint();

  // 重抓同一天（INSERT OR REPLACE 同樣的資料）、某個資料集抓取失敗 → 不變
  db.upsert('daily', DAILY, [day('2026-11-19', '2330'), day('2026-11-19', '2317')]);
  db.logSync('margin_tse', '2026-11-20', 'error', 0);
  db.logSync('index_tse', '2026-11', 'empty', 0);
  assert.equal(fingerprint(), a);

  // 新的交易日 → 改變
  db.upsert('daily', DAILY, [day('2026-11-20', '2330')]);
  const b = fingerprint();
  assert.notEqual(b, a);

  // 同一天晚上才公布的融資融券 → 改變
  db.upsert('margin', ['date', 'code', 'margin_balance', 'short_balance'], [['2026-11-20', '2330', 5000, 100]]);
  const c = fingerprint();
  assert.notEqual(c, b);

  // 月營收申報期間陸續有公司公布（同一個月份，筆數增加）→ 改變
  db.upsert('revenue', ['ym', 'code', 'revenue', 'available'], [['2026-11', '2330', 1, '2026-12-11']]);
  const d = fingerprint();
  db.upsert('revenue', ['ym', 'code', 'revenue', 'available'], [['2026-11', '2317', 1, '2026-12-11']]);
  assert.notEqual(fingerprint(), d);

  assert.match(summary().daily, /^3@2026-11-20$/);
});

test.after(() => {
  db.open().close(); // Windows 不能刪除還開著的檔案
  fs.rmSync(dir, { recursive: true, force: true });
});
