/**
 * 上市櫃清單：證交所偶爾回傳 CSV、某個市場取得失敗時不能丟掉該市場的股票
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stocklist-'));
process.env.STOCKLIST_FILE = path.join(tmp, 'stocks.json');
process.env.STOCKLIST_RETRY_MS = '1';

function fresh() {
  delete require.cache[require.resolve('../lib/stocklist')];
  return require('../lib/stocklist');
}

const tseJson = Array.from({ length: 400 }, (_, i) => ({ Code: String(1100 + i), Name: `上市${i}` }));
const otcJson = Array.from({ length: 300 }, (_, i) => ({ SecuritiesCompanyCode: String(3100 + i), CompanyName: `上櫃${i}` }));
const tseCsv = ['日期,證券代號,證券名稱,成交股數', ...tseJson.map((s) => `1151119,"${s.Code}","${s.Name}","1,000"`)].join('\n');

function mockFetch(handlers) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const h = handlers[url.includes('twse') ? 'tse' : 'otc'];
    const body = typeof h === 'function' ? h() : h;
    return { ok: true, status: 200, text: async () => body };
  };
  return calls;
}

test('CSV 解析：雙引號欄位內的逗號、Excel 的 ="0050" 寫法', () => {
  const { parseCsv } = fresh();
  assert.deepEqual(parseCsv('a,"b,c",="0050"\n\n1,"2 ""x""",3'), [['a', 'b,c', '0050'], ['1', '2 "x"', '3']]);
});

test('證交所回傳 CSV（而不是 JSON）時也能取得上市清單', async () => {
  mockFetch({ tse: tseCsv, otc: JSON.stringify(otcJson) });
  const s = fresh();
  const { complete } = await s.refresh();
  assert.equal(complete, true);
  assert.equal(s.all().filter((x) => x.market === 'tse' && x.type === 'stock').length, 400);
  assert.equal(s.get('1100').name, '上市0');
  assert.equal(s.all().filter((x) => x.market === 'otc' && x.type === 'stock').length, 300);
  assert.ok(fs.existsSync(process.env.STOCKLIST_FILE), '完整取得時要寫入快取');
});

test('某個市場取得失敗：沿用該市場上一次的清單，也不覆寫快取', async () => {
  mockFetch({ tse: JSON.stringify(tseJson), otc: JSON.stringify(otcJson) });
  const s = fresh();
  await s.refresh();
  const cacheBefore = fs.readFileSync(process.env.STOCKLIST_FILE, 'utf8');

  // 證交所回傳無法辨識的內容（重試後仍失敗）
  const calls = mockFetch({ tse: '<html>系統維護中</html>', otc: JSON.stringify(otcJson.slice(0, 110)) });
  const { complete } = await s.refresh();
  assert.equal(complete, false);
  assert.equal(calls.filter((u) => u.includes('twse')).length, 2, '失敗時應重試一次');
  assert.equal(s.all().filter((x) => x.market === 'tse' && x.type === 'stock').length, 400, '上市股票不能因為一次失敗就消失');
  assert.equal(s.all().filter((x) => x.market === 'otc' && x.type === 'stock').length, 110);
  assert.equal(fs.readFileSync(process.env.STOCKLIST_FILE, 'utf8'), cacheBefore, '不完整的清單不能寫進快取');
});

test('建置時先載入上一次的清單：這次證交所失敗，仍有完整的上市股票', async () => {
  const s = fresh();
  assert.equal(s.loadCache(), true);
  mockFetch({ tse: 'not json, not csv', otc: JSON.stringify(otcJson) });
  await s.refresh();
  assert.equal(s.all().filter((x) => x.market === 'tse' && x.type === 'stock').length, 400);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
