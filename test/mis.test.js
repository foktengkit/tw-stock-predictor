/**
 * MIS 即時報價解析：用盤中實際觀察到的回應格式測試
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuote } = require('../lib/twse');

const base = { c: '2330', n: '台積電', ex: 'tse', d: '20261105', y: '2260.0000', o: '2250.0000', h: '2285.0000', l: '2245.0000', a: '2260.0000_', b: '2255.0000_', f: '10_', g: '20_' };

test('本次有成交（z 有值）：用本次成交價與成交時間', () => {
  const q = parseQuote({ ...base, z: '2255.0000', t: '09:13:05', tlong: '1793841185000', trade: { t: '09:13:05', z: '2255.0000' } });
  assert.equal(q.price, 2255);
  assert.equal(q.time, '09:13:05');
});

test('本次沒成交（z = "-"）且 trade.z 是舊的：沿用上一次較新的成交價，不要倒退成舊價', () => {
  const last = parseQuote({ ...base, z: '2255.0000', t: '09:13:05', tlong: '1793841185000' });
  const q = parseQuote({ ...base, z: '-', t: '09:13:20', tlong: '1793841200000', trade: { t: '09:08:00', z: '2275.0000' } }, last);
  assert.equal(q.price, 2255, '不應該用 09:08 的舊成交價 2275');
  assert.equal(q.time, '09:13:05');
});

test('本次沒成交（z = "-"）但 trade.z 比上一次新：用 trade.z', () => {
  const last = parseQuote({ ...base, c: '2317', z: '239.0000', t: '09:10:55', tlong: '1793841055000' });
  const q = parseQuote({ ...base, c: '2317', z: '-', t: '09:13:05', tlong: '1793841185000', trade: { t: '09:12:55', z: '238.0000' } }, last);
  assert.equal(q.price, 238);
  assert.equal(q.time, '09:12:55');
});

test('上一次的價格若是前一天的，不可沿用', () => {
  const last = parseQuote({ ...base, d: '20261104', z: '2260.0000', t: '13:30:00', tlong: '1793683800000' });
  const q = parseQuote({ ...base, z: '-', t: '08:59:00', tlong: '1793840340000' }, last);
  assert.notEqual(q.time, '13:30:00');
  assert.equal(q.hasTrade, false);
});
