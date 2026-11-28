/**
 * 公開版需不需要重新發布？
 *   node scripts/check-new-data.js [--site <網站網址>] [--before <同步前的指紋>]
 *
 * 把本機官方資料庫的「資料指紋」和線上網站 data/meta.json 記錄的指紋比對：
 *   - 有新資料 → 要發布
 *   - 線上的程式不是目前的版本（例如上次部署失敗）→ 要發布
 *   - 都一樣 → 不用發布（外部排程每 15 分鐘觸發一次，大部分時候都是這種情況）
 * 環境變數 FORCE=true → 一律發布（推送了程式碼、手動勾選「強制發布」）。
 * 在 GitHub Actions 裡會寫出 fingerprint、db_changed（有給 --before）、publish（有給 --site）。
 */
const fs = require('node:fs');
const { summary, fingerprint } = require('../lib/official/fingerprint');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const short = (sha) => (sha ? sha.slice(0, 7) : '無');

async function liveMeta(site) {
  try {
    const r = await fetch(`${site.replace(/\/?$/, '/')}data/meta.json?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const s = summary();
  const fp = fingerprint(s);
  const out = { fingerprint: fp };
  console.log(`本機資料指紋 ${fp}`);
  for (const [table, v] of Object.entries(s)) console.log(`  ${table.padEnd(12)} ${v.replace('@', ' 筆，最新 ')}`);

  const before = opt('--before');
  if (before != null) {
    out.db_changed = String(before !== fp);
    console.log(before !== fp ? `這次同步抓到新資料（${before} → ${fp}）` : '這次同步沒有抓到新資料');
  }

  const site = opt('--site');
  if (site) {
    const reasons = [];
    if (process.env.FORCE === 'true') reasons.push('推送了程式碼或手動強制發布');
    const m = await liveMeta(site);
    if (m.error) {
      reasons.push(`讀不到線上版本（${m.error}）`);
    } else {
      if (m.dataFingerprint !== fp) reasons.push(`線上資料不是最新（線上 ${m.dataFingerprint || '無'}，本機 ${fp}）`);
      const sha = process.env.GITHUB_SHA;
      if (sha && m.commit !== sha) reasons.push(`線上程式是 ${short(m.commit)}，目前是 ${short(sha)}`);
    }
    out.publish = String(reasons.length > 0);
    console.log(reasons.length
      ? `→ 要發布：${reasons.join('；')}`
      : `→ 線上已是最新（資料日期 ${m.dataDate}，建置於 ${m.builtAt}），不用發布`);
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
