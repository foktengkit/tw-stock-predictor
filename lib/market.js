// 台股交易時段判斷（台北時間 UTC+8）
const holidays = require('./holidays');

const TPE_OFFSET_MS = 8 * 3600 * 1000;

function taipeiNow(d = new Date()) {
  const t = new Date(d.getTime() + TPE_OFFSET_MS);
  const iso = t.toISOString();
  return {
    ymd: iso.slice(0, 10).replace(/-/g, ''), // YYYYMMDD
    isoDate: iso.slice(0, 10),
    clock: iso.slice(11, 19),
    weekday: t.getUTCDay(),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/**
 * @param {string} [dataDate] MIS 回傳的資料日期 (YYYYMMDD)。休市日曆沒有的臨時休市（如颱風假）
 *                            會表現為「開盤後資料日期仍不是今天」，以此作為備援判斷
 */
function marketStatus(dataDate) {
  const n = taipeiNow();
  const m = n.minutes;
  const holiday = holidays.holidayOf(n.isoDate);
  let status;
  if (n.weekday === 0 || n.weekday === 6) status = { code: 'closed', label: '休市（週末）' };
  else if (holiday) status = { code: 'closed', label: `休市（${holiday.name}）` };
  else if (dataDate && dataDate !== n.ymd && m >= 9 * 60 + 5) status = { code: 'closed', label: '休市' };
  else if (m >= 8 * 60 + 30 && m < 9 * 60) status = { code: 'pre', label: '盤前試撮' };
  else if (m >= 9 * 60 && m < 13 * 60 + 25) status = { code: 'open', label: '盤中交易' };
  else if (m >= 13 * 60 + 25 && m < 13 * 60 + 30) status = { code: 'open', label: '收盤競價' };
  else if (m >= 13 * 60 + 30 && m < 14 * 60 + 30) status = { code: 'post', label: '盤後交易' };
  else status = { code: 'closed', label: '已收盤' };
  status.active = status.code === 'open' || status.code === 'pre';
  status.date = n.isoDate;
  status.clock = n.clock;
  return status;
}

module.exports = { taipeiNow, marketStatus, TPE_OFFSET_MS };
