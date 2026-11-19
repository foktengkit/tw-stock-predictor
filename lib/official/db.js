/**
 * 官方資料庫（SQLite，Node 內建 node:sqlite）：證交所、櫃買中心、公開資訊觀測站的原始資料
 * 存放於 data/official.db。WAL 模式：伺服器讀取與背景同步寫入可同時進行。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const FILE = process.env.OFFICIAL_DB || path.join(__dirname, '..', '..', 'data', 'official.db');
let db = null;

const SCHEMA = `
  -- 每日行情（全市場檔）。上市 volume 為官方總成交股數（含零股、鉅額、盤後）；
  -- 上櫃全市場檔只有一般交易（整股），官方總量另存 vol_total
  CREATE TABLE IF NOT EXISTS daily (
    date TEXT NOT NULL, code TEXT NOT NULL, market TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL,
    volume INTEGER, value INTEGER, trades INTEGER,
    PRIMARY KEY (code, date)
  );
  CREATE INDEX IF NOT EXISTS daily_date ON daily(date);
  -- 官方總成交股數（上市取自每日收盤行情；上櫃取自個股日成交資訊）
  CREATE TABLE IF NOT EXISTS vol_total (
    date TEXT NOT NULL, code TEXT NOT NULL, volume INTEGER NOT NULL,
    PRIMARY KEY (code, date)
  );
  -- 三大法人買賣超（股）
  CREATE TABLE IF NOT EXISTS inst (
    date TEXT NOT NULL, code TEXT NOT NULL,
    foreign_net INTEGER, trust_net INTEGER, dealer_net INTEGER, total_net INTEGER,
    PRIMARY KEY (code, date)
  );
  -- 融資融券（張）
  CREATE TABLE IF NOT EXISTS margin (
    date TEXT NOT NULL, code TEXT NOT NULL,
    margin_buy INTEGER, margin_sell INTEGER, margin_balance INTEGER,
    short_sell INTEGER, short_buy INTEGER, short_balance INTEGER,
    PRIMARY KEY (code, date)
  );
  -- 月營收（千元）。available = 最早可以使用這筆資料的日期（法定公布期限次日）
  CREATE TABLE IF NOT EXISTS revenue (
    ym TEXT NOT NULL, code TEXT NOT NULL,
    revenue INTEGER, last_month INTEGER, last_year INTEGER,
    mom REAL, yoy REAL, cum_yoy REAL, available TEXT NOT NULL,
    PRIMARY KEY (code, ym)
  );
  -- 除權除息：除權息前收盤價與參考價（用來計算還原權息報酬）
  CREATE TABLE IF NOT EXISTS exright (
    date TEXT NOT NULL, code TEXT NOT NULL, prev_close REAL, ref_price REAL,
    PRIMARY KEY (code, date)
  );
  -- 同步紀錄：每個資料集、每個日期（或月份）是否已抓取
  CREATE TABLE IF NOT EXISTS sync_log (
    dataset TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, rows INTEGER, at TEXT,
    PRIMARY KEY (dataset, key)
  );
`;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  db = new DatabaseSync(FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

const clean = (v) => (v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v);

/** 批次寫入（INSERT OR REPLACE），單一交易 */
function upsert(table, cols, rows) {
  if (!rows.length) return 0;
  const d = open();
  const st = d.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  d.exec('BEGIN');
  try {
    for (const r of rows) st.run(...r.map(clean));
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

function logSync(dataset, key, status, rows = 0) {
  open().prepare('INSERT OR REPLACE INTO sync_log (dataset, key, status, rows, at) VALUES (?, ?, ?, ?, ?)')
    .run(dataset, key, status, rows, new Date().toISOString());
}

function syncedKeys(dataset) {
  const rows = open().prepare("SELECT key FROM sync_log WHERE dataset = ? AND status IN ('ok', 'empty')").all(dataset);
  return new Set(rows.map((r) => r.key));
}

function all(sql, ...params) {
  return open().prepare(sql).all(...params);
}

function get(sql, ...params) {
  return open().prepare(sql).get(...params);
}

module.exports = { open, upsert, logSync, syncedKeys, all, get, FILE };
