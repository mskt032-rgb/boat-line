// 日本時間(JST)の扱い。サーバー(UTC)でも端末でも同じ結果になるようにする。
const JST_OFFSET = 9 * 60 * 60 * 1000;
export function jstParts(ms = Date.now()) {
  const d = new Date(ms + JST_OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}
export function jstDate(ms = Date.now()) {
  const p = jstParts(ms);
  return `${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
}
export function addDays(yyyymmdd, n) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}
/** "20261123" と "10:45"(日本時間)→ その時刻のミリ秒 */
export function deadlineMs(yyyymmdd, hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  return Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET;
}
export function isoNow(ms = Date.now()) { return new Date(ms).toISOString(); }
