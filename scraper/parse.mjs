// BOAT RACE 公式サイトのページ(HTML)から必要な値を取り出す。
// 取り出せなかった値は null のままにし、推測では埋めない。気づいた点は warnings に残す。
import * as cheerio from 'cheerio';

const FW = '０１２３４５６７８９．：－';
const HW = '0123456789.:-';
export function norm(s) {
  return String(s ?? '')
    .replace(/[０-９．：－]/g, (c) => HW[FW.indexOf(c)])
    .replace(/[　\s]+/g, ' ')
    .trim();
}
function num(s) {
  const m = norm(s).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function nums(s) {
  // "-" や空欄は null として位置を保つ
  return norm(s).split(' ').filter(Boolean).map((t) => (/^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : /^\.\d+$/.test(t) ? parseFloat('0' + t) : null));
}
function textLines($, el) {
  // <br> 区切りを空白にしてから正規化
  const h = $(el).html() ?? '';
  return norm(cheerio.load(`<div>${h.replace(/<br\s*\/?>/gi, ' ')}</div>`)('div').text());
}

/** 「11/24」と「6日目」がくっついた「246日目」などを「6日目」に直す */
export function cleanDayLabel(s) {
  if (s == null) return s;
  const m = String(s).match(/(初日|最終日|[1-9]日目)$/);
  return m ? m[1] : s;
}

/** 日別トップ(開催場一覧) */
export function parseIndex(html, date) {
  const $ = cheerio.load(html);
  const warnings = [];
  const venues = new Map();
  $('a[href*="raceindex"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const jm = href.match(/jcd=(\d{2})/);
    const hm = href.match(/hd=(\d{8})/);
    if (!jm) return;
    if (hm && hm[1] !== date) return;
    const jcd = jm[1];
    const row = $(a).closest('tbody').length ? $(a).closest('tbody') : $(a).closest('tr');
    const v = venues.get(jcd) || { jcd, title: null, dayLabel: null, grade: null, nighter: false, note: null };
    const t = norm($(a).text());
    if (t && t.length > (v.title?.length || 0) && !/^\d+R$/.test(t) && !/出走表|結果|オッズ/.test(t)) v.title = t;
    const rowText = norm(row.text());
    const dm = rowText.match(/(初日|最終日|[1-9]日目)/); // 直前の日付の数字とくっつくことがあるので1桁だけ見る
    if (dm) v.dayLabel = cleanDayLabel(dm[1]);
    if (/中止|順延|打ち切り/.test(rowText)) v.note = (rowText.match(/(中止[^ ]*|順延[^ ]*|打ち切り[^ ]*)/) || [])[1] || '中止等';
    const cls = (row.find('[class*="is-"]').map((_, e) => $(e).attr('class')).get().join(' ') + ' ' + (row.attr('class') || ''));
    const g = cls.match(/is-(SGa|SG|G1a|G1b|G1|G2|G3|ippan)\b/);
    if (g) v.grade = g[1].replace(/[ab]$/, '');
    if (/is-nighter|ナイター/.test(cls + rowText)) v.nighter = true;
    venues.set(jcd, v);
  });
  if (!venues.size) warnings.push('開催場のリンクが見つかりませんでした(非開催日か、ページ構成の変更の可能性)');
  return { venues: [...venues.values()].sort((a, b) => a.jcd.localeCompare(b.jcd)), warnings };
}

/** 締切予定時刻の行(1R〜12R)を探す。どのページにも同じ形で載っている */
export function parseDeadlines($) {
  let out = null;
  $('tr').each((_, tr) => {
    if (out) return;
    const cells = $(tr).children('th,td');
    if (!/締切予定時刻/.test(norm(cells.first().text()))) return;
    const times = cells.slice(1).map((_, c) => (norm($(c).text()).match(/\b(\d{1,2}:\d{2})\b/) || [])[1] || null).get();
    if (times.filter(Boolean).length) out = times;
  });
  if (!out) return null;
  const map = {};
  out.forEach((t, i) => { if (t && i < 12) map[i + 1] = t; });
  return map;
}

function raceMeta($) {
  const title = norm($('.title16_titleDetail__add2020').first().text()) || null;
  const body = norm($('body').text());
  const dm = (title || '').match(/(\d{3,4})m/);
  return {
    raceTitle: title,
    distance: dm ? +dm[1] : null,
    fixedEntry: /進入固定/.test(body),
    stabilizer: /安定板使用/.test(body),
  };
}

/** 今節成績(出走表の右側: 1段目=R番号、2段目=進入コース、3段目=ST、4段目=着順) */
export function parseKonsetsu($, tb) {
  const trs = $(tb).find('tr');
  const cellText = (td) => norm($(td).text());
  const row0 = trs.eq(0).children('td').slice(8).map((_, td) => cellText(td)).get();
  const rows = [1, 2, 3].map((i) => trs.eq(i).children('td').map((_, td) => cellText(td)).get());
  const n = rows[0].length;
  const races = [];
  for (let i = 0; i < n; i++) {
    const r = row0[i], course = rows[0][i], st = rows[1][i], rank = rows[2][i];
    if (!rank) continue;
    races.push({
      r: /^\d+$/.test(r || '') ? +r : null,
      course: /^[1-6]$/.test(course || '') ? +course : null,
      st: (() => { const m = (st || '').match(/^(F)?0?\.(\d{2})$/); return m ? (m[1] ? -1 : 1) * parseFloat('0.' + m[2]) : null; })(),
      rank: /^[1-6]$/.test(rank) ? +rank : null,
      rankText: rank,
    });
  }
  return { kon: races, konRaw: [row0.slice(0, n + 1), ...rows] };
}

/** 出走表 */
export function parseRacelist(html) {
  const $ = cheerio.load(html);
  const warnings = [];
  let tbodies = $('.table1.is-tableFixed__3rdadmin tbody');
  if (!tbodies.length) tbodies = $('tbody.is-fs12');
  const entries = [];
  tbodies.each((_, tb) => {
    const tds = $(tb).find('tr').first().children('td');
    if (tds.length < 8) return;
    const boat = num(tds.eq(0).text());
    if (!(boat >= 1 && boat <= 6)) return;
    const info = tds.eq(2);
    const fs11 = info.find('.is-fs11');
    const reg = norm(fs11.eq(0).text());
    const prof = norm(fs11.eq(1).text());
    const flst = textLines($, tds.eq(3));
    const nat = nums(textLines($, tds.eq(4)));
    const loc = nums(textLines($, tds.eq(5)));
    const mot = nums(textLines($, tds.eq(6)));
    const bt = nums(textLines($, tds.eq(7)));
    const stm = flst.match(/(\d?\.\d{2})\s*$/) || flst.match(/(\d?\.\d{2})/);
    const e = {
      boat,
      regNo: (reg.match(/(\d{4})/) || [])[1] || null,
      cls: (reg.match(/\b(A1|A2|B1|B2)\b/) || [])[1] || null,
      name: norm(info.find('.is-fs18').text()) || null,
      branch: (prof.match(/^([^/ ]+)\//) || [])[1] || null,
      age: (prof.match(/(\d+)歳/) || [])[1] ? +prof.match(/(\d+)歳/)[1] : null,
      weight: (prof.match(/(\d+(?:\.\d+)?)kg/) || [])[1] ? +prof.match(/(\d+(?:\.\d+)?)kg/)[1] : null,
      F: (flst.match(/F(\d+)/) || [])[1] != null ? +flst.match(/F(\d+)/)[1] : null,
      L: (flst.match(/L(\d+)/) || [])[1] != null ? +flst.match(/L(\d+)/)[1] : null,
      avgST: stm ? parseFloat(stm[1].startsWith('.') ? '0' + stm[1] : stm[1]) : null,
      natWin: nat[0] ?? null, nat2: nat[1] ?? null, nat3: nat[2] ?? null,
      locWin: loc[0] ?? null, loc2: loc[1] ?? null, loc3: loc[2] ?? null,
      motorNo: mot[0] ?? null, motor2: mot[1] ?? null, motor3: mot[2] ?? null,
      boatNo: bt[0] ?? null, boat2: bt[1] ?? null, boat3: bt[2] ?? null,
      absent: /欠場/.test(norm($(tb).text())),
      ...parseKonsetsu($, tb),
    };
    for (const k of ['natWin', 'locWin']) if (e[k] != null && (e[k] < 0 || e[k] > 11)) { warnings.push(`${boat}号艇の${k}が範囲外(${e[k]})のため不採用`); e[k] = null; }
    for (const k of ['nat2', 'loc2', 'motor2', 'boat2']) if (e[k] != null && (e[k] < 0 || e[k] > 100)) { warnings.push(`${boat}号艇の${k}が範囲外のため不採用`); e[k] = null; }
    if (e.avgST != null && (e.avgST < 0 || e.avgST > 1)) e.avgST = null;
    entries.push(e);
  });
  if (entries.length !== 6) warnings.push(`出走表の艇数が${entries.length}件でした(通常6件)`);
  return { entries, deadlines: parseDeadlines($), ...raceMeta($), warnings };
}

function parseSt(s) {
  const t = norm(s);
  if (!t) return { st: null, flying: false, late: false };
  const flying = /F/.test(t);
  const late = /L/.test(t);
  const m = t.match(/(\d?\.\d{2})/);
  const v = m ? parseFloat(m[1].startsWith('.') ? '0' + m[1] : m[1]) : null;
  return { st: v == null ? null : flying ? -v : v, flying, late };
}

/** 直前情報(展示タイム・スタート展示・気象) */
export function parseBeforeinfo(html) {
  const $ = cheerio.load(html);
  const warnings = [];
  let tbodies = $('.table1 table.is-w748 tbody');
  if (!tbodies.length) {
    $('table').each((_, t) => { if (/展示タイム/.test(norm($(t).find('thead').text()))) tbodies = $(t).find('tbody'); });
  }
  const boats = [];
  tbodies.each((_, tb) => {
    const trs = $(tb).find('tr');
    const tds = trs.first().children('td');
    if (tds.length < 6) return;
    const boat = num(tds.eq(0).text());
    if (!(boat >= 1 && boat <= 6)) return;
    const ex = num(tds.eq(4).text());
    boats.push({
      boat,
      name: norm(tds.eq(2).text()) || null,
      weight: num(tds.eq(3).text()),
      exTime: ex != null && ex > 5 && ex < 9 ? ex : null,
      tilt: num(tds.eq(5).text()),
      propeller: norm(tds.eq(6).text()) || null,
      parts: norm(tds.eq(7).text()) || null,
      adjustWeight: trs.eq(1).length ? num(trs.eq(1).children('td').first().text()) : null,
      absent: /欠場/.test(norm($(tb).text())),
    });
  });
  const start = [];
  $('.table1_boatImage1').each((i, el) => {
    const boat = num($(el).find('.table1_boatImage1Number').text());
    const s = parseSt($(el).find('.table1_boatImage1Time').text());
    if (boat >= 1 && boat <= 6) start.push({ course: start.length + 1, boat, ...s });
  });
  const w = $('.weather1');
  const unit = (cls) => w.find(`.weather1_bodyUnit.${cls}`);
  const dirClass = unit('is-windDirection').find('[class*="is-wind"]').attr('class') || '';
  const weather = w.length ? {
    temperature: num(unit('is-direction').find('.weather1_bodyUnitLabelData').text()),
    weather: norm(unit('is-weather').find('.weather1_bodyUnitLabelTitle').text()) || null,
    windSpeed: num(unit('is-wind').find('.weather1_bodyUnitLabelData').text()),
    windDirCode: (dirClass.match(/is-wind(\d+)/) || [])[1] ? +dirClass.match(/is-wind(\d+)/)[1] : null,
    waterTemperature: num(unit('is-waterTemperature').find('.weather1_bodyUnitLabelData').text()),
    waveHeight: num(unit('is-wave').find('.weather1_bodyUnitLabelData').text()),
  } : null;
  const hasExhibition = boats.some((b) => b.exTime != null) || start.some((s) => s.st != null);
  if (boats.length && boats.length !== 6) warnings.push(`直前情報の艇数が${boats.length}件でした`);
  return { boats, start: start.length ? start : [], weather, hasExhibition, deadlines: parseDeadlines($), warnings };
}

/** 3連単の組み合わせ(公式の表と同じ並び: 1着ごとに2着→3着の昇順で20通り) */
export function combosForFirst(f) {
  const out = [];
  for (let s = 1; s <= 6; s++) { if (s === f) continue; for (let t = 1; t <= 6; t++) { if (t === f || t === s) continue; out.push(`${f}-${s}-${t}`); } }
  return out;
}

/** 3連単オッズ */
export function parseOdds3t(html) {
  const $ = cheerio.load(html);
  const warnings = [];
  const cells = $('td.oddsPoint');
  const odds = {};
  if (cells.length !== 120) {
    warnings.push(`オッズの欄が${cells.length}個でした(通常120個)。読み取りを中止しました`);
    return { odds: null, oddsTime: null, warnings };
  }
  const table = [1, 2, 3, 4, 5, 6].map(combosForFirst);
  let valid = 0;
  cells.each((i, c) => {
    const row = Math.floor(i / 6), f = (i % 6) + 1;
    const v = num($(c).text());
    const key = table[f - 1][row];
    odds[key] = v != null && v >= 1 ? v : null;
    if (odds[key] != null) valid++;
  });
  const body = norm($('body').text());
  const tm = body.match(/(\d{1,2}:\d{2})\s*(?:時点|現在)/);
  const final = /締切時オッズ/.test(body);
  if (!valid) return { odds: null, oddsTime: null, warnings: [...warnings, 'オッズがまだ発表されていません'] };
  return { odds, oddsTime: tm ? tm[1] : null, final, warnings };
}

/** レース結果 */
export function parseResult(html) {
  const $ = cheerio.load(html);
  const warnings = [];
  const body = norm($('body').text());
  const order = [];
  $('table').each((_, t) => {
    if (order.length) return;
    const head = norm($(t).find('thead').text());
    if (!/着/.test(head) || !/レースタイム/.test(head)) return;
    $(t).find('tbody tr').each((_, tr) => {
      const tds = $(tr).children('td');
      if (tds.length < 3) return;
      const rankText = norm(tds.eq(0).text());
      const boat = num(tds.eq(1).text());
      const racer = norm(tds.eq(2).text());
      if (!(boat >= 1 && boat <= 6)) return;
      order.push({
        rank: /^\d$/.test(rankText) ? +rankText : null,
        rankText,
        boat,
        regNo: (racer.match(/(\d{4})/) || [])[1] || null,
        name: racer.replace(/\d{4}/, '').trim() || null,
        time: norm(tds.eq(3).text()) || null,
      });
    });
  });
  let trifecta = null;
  $('tr').each((_, tr) => {
    if (trifecta) return;
    const tds = $(tr).children('td');
    if (!/3連単/.test(norm(tds.first().text()))) return;
    const ns = $(tr).find('.numberSet1_number').map((_, n) => num($(n).text())).get();
    const payText = norm($(tr).find('.is-payout1').first().text()) || tds.map((_, td) => norm($(td).text())).get().find((x) => /¥/.test(x)) || '';
    const pay = payText.match(/¥?\s?([\d,]+)/);
    const pop = norm(tds.last().text());
    if (ns.length >= 3) trifecta = { combo: ns.slice(0, 3).join('-'), payout: pay ? +pay[1].replace(/,/g, '') : null, popularity: /^\d+$/.test(pop) ? +pop : null };
  });
  let kimarite = null;
  $('table').each((_, t) => {
    if (kimarite) return;
    if (/決まり手/.test(norm($(t).find('thead').text()))) kimarite = norm($(t).find('tbody td').first().text()) || null;
  });
  const start = [];
  $('.table1_boatImage1').each((_, el) => {
    const boat = num($(el).find('.table1_boatImage1Number').text());
    const s = parseSt($(el).find('.table1_boatImage1Time').text());
    if (boat >= 1 && boat <= 6) start.push({ course: start.length + 1, boat, ...s });
  });
  const canceled = /レース中止|レースは中止/.test(body);
  const refunds = [];
  $('tr').each((_, tr) => {
    const t = norm($(tr).text());
    if (/^返還/.test(t)) $(tr).find('.numberSet1_number, .is-boatColor1, .is-boatColor2, .is-boatColor3, .is-boatColor4, .is-boatColor5, .is-boatColor6').each((_, n) => { const v = num($(n).text()); if (v) refunds.push(v); });
  });
  const ready = order.length > 0 && !!trifecta;
  if (!ready && !canceled) warnings.push('結果はまだ発表されていません');
  return { ready, canceled, order, trifecta, kimarite, start, refunds: [...new Set(refunds)], warnings };
}

/** 選手のコース別成績ページ。項目ごとに小さな表(見出し + 1〜6コースの行)が並ぶ形を読む */
export function parseRacerCourse(html) {
  const $ = cheerio.load(html);
  const warnings = [];
  const tables = [];
  $('table').each((_, t) => {
    const header = norm($(t).find('thead').text() || $(t).find('th').first().text());
    const rows = {};
    $(t).find('tbody tr').each((_, tr) => {
      const cells = $(tr).children('th,td').map((_, c) => norm($(c).text())).get();
      const m = (cells[0] || '').match(/^([1-6])(?:コース)?$/);
      if (!m) return;
      const v = (cells.slice(1).join(' ').match(/-?\d*\.?\d+/) || [])[0];
      rows[m[1]] = v != null ? parseFloat(v) : null;
    });
    if (Object.keys(rows).length) tables.push({ header, rows, raw: $(t).find('tbody tr').first().children().map((_, c) => norm($(c).text())).get() });
  });
  const find = (re) => tables.find((t) => re.test(t.header));
  const ren3 = find(/3連対率/), st = find(/平均ST|スタートタイミング/), entry = find(/進入率/), win = find(/^[^3]*1着率/);
  const courses = {};
  for (let c = 1; c <= 6; c++) {
    courses[c] = { ren3: ren3?.rows[c] ?? null, st: st?.rows[c] ?? null, entryRate: entry?.rows[c] ?? null, win: win && win !== ren3 ? win.rows[c] ?? null : null };
  }
  if (!ren3) warnings.push('コース別3連対率の表が見つかりませんでした');
  return { schema: 2, courses: ren3 ? courses : {}, tables: tables.map(({ header, raw }) => ({ header, raw })), warnings };
}
