/**
 * 官方資料指紋：每個資料表的「筆數＠最新日期」。
 * 有新資料（新的交易日、剛公布的法人或融資券、月營收、除權息）時就會改變；
 * 重抓到一樣的資料，或某次抓取暫時失敗，都不會改變。公開版用它判斷需不需要重新發布。
 */
const crypto = require('node:crypto');
const db = require('./db');

const TABLES = [
  ['daily', 'date'], ['vol_total', 'date'], ['inst', 'date'], ['margin', 'date'],
  ['revenue', 'ym'], ['exright', 'date'], ['index_daily', 'date'],
];

function summary() {
  const out = {};
  for (const [table, col] of TABLES) {
    const r = db.get(`SELECT COUNT(*) n, MAX(${col}) latest FROM ${table}`) || {};
    out[table] = `${r.n || 0}@${r.latest || '-'}`;
  }
  return out;
}

function fingerprint(s = summary()) {
  return crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);
}

module.exports = { summary, fingerprint };
