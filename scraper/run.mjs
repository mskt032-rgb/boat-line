// 定期実行で1回分の取得を行い、JSONに保存する。
// 方針: robots.txt を毎回確認し許可された場所だけ、3秒以上の間隔、1回あたり最大160件・8分まで(10分ごとの実行が重ならないように)。
// 403/429/503 など「アクセスを控えて」という応答があれば、その回は即座にやめて30分休む(回避はしない)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanDayLabel, parseIndex, parseRacelist, parseBeforeinfo, parseOdds3t, parseResult } from './parse.mjs';
import { parseRobots, robotsFor } from './robots.mjs';
import { planTasks, needIndex } from './plan.mjs';
import { jstDate, addDays, isoNow } from '../app/js/time.js';
import { VENUES, VENUE_NAME } from '../app/js/venues.js';
import { recordAutoPredictions, buildAutolog } from './autopred.mjs';

export const BASE = 'https://www.boatrace.jp';
export const UA = 'BOAT-LINE-personal/1.0 (personal non-commercial use; +https://github.com/mskt032-rgb/boat-line)';
const KEEP_DAYS = 45;

const PATHS = {
  index: (d) => `/owpc/pc/race/index?hd=${d}`,
  racelist: (d, j, r) => `/owpc/pc/race/racelist?rno=${r}&jcd=${j}&hd=${d}`,
  beforeinfo: (d, j, r) => `/owpc/pc/race/beforeinfo?rno=${r}&jcd=${j}&hd=${d}`,
  odds3t: (d, j, r) => `/owpc/pc/race/odds3t?rno=${r}&jcd=${j}&hd=${d}`,
  raceresult: (d, j, r) => `/owpc/pc/race/raceresult?rno=${r}&jcd=${j}&hd=${d}`,
};
const SLOT = { racelist: 'racelist', beforeinfo: 'before', odds3t: 'odds', raceresult: 'result' };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

class StopRun extends Error {}

export async function defaultFetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(25000), redirect: 'follow' });
  const text = await res.text();
  return { status: res.status, text };
}

export async function runOnce({
  store, now = Date.now(), fetchText = defaultFetchText, maxRequests = 160, intervalMs = 3000,
  timeBudgetMs = 8 * 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now(),
}) {
  const startedAt = clock();
  const statePath = path.join(store, 'meta', 'state.json');
  const logPath = path.join(store, 'meta', 'log.json');
  const state = readJson(statePath, { daily: {} });
  const runLog = { startedAt: isoNow(now), requests: 0, saved: 0, errors: [], stopped: null };
  const today = jstDate(now);
  const finish = () => {
    runLog.finishedAt = isoNow(clock());
    state.daily[today] = (state.daily[today] || 0) + runLog.requests;
    for (const d of Object.keys(state.daily)) if (d < addDays(today, -KEEP_DAYS)) delete state.daily[d];
    writeJson(statePath, state);
    const log = readJson(logPath, []);
    log.unshift(runLog);
    writeJson(logPath, log.slice(0, 60));
    writeIndex(store, now);
    return runLog;
  };

  if (state.backoffUntil && Date.parse(state.backoffUntil) > now) {
    runLog.stopped = `休止中(${state.backoffUntil} まで)`;
    return finish();
  }

  let last = 0;
  let robots = null;
  async function get(p) {
    if (runLog.requests >= maxRequests) throw new StopRun('今回の取得件数の上限に達しました');
    if (clock() - startedAt > timeBudgetMs) throw new StopRun('今回の取得時間の上限に達しました');
    if (robots && !robots.allowed(p)) throw Object.assign(new Error(`robots.txt で許可されていないため取得しません: ${p}`), { disallowed: true });
    const gap = Math.max(intervalMs, (robots?.crawlDelay || 0) * 1000);
    const wait = last + gap - clock();
    if (wait > 0) await sleep(wait);
    last = clock();
    runLog.requests++;
    const { status, text } = await fetchText(BASE + p);
    last = clock();
    if ([403, 429, 503].includes(status)) {
      state.backoffUntil = isoNow(now + 30 * 60000);
      throw new StopRun(`公式サイトから応答コード${status}が返ったため、今回は取得を中止し30分休みます`);
    }
    if (status >= 400) throw new Error(`応答コード${status}`);
    return text;
  }

  // robots.txt(毎回確認)
  try {
    const { status, text } = await fetchText(BASE + '/robots.txt');
    runLog.requests++;
    last = clock();
    if (status >= 500) throw new Error(`robots.txt 応答コード${status}`);
    robots = robotsFor(status === 200 ? parseRobots(text) : [], 'BOAT-LINE-personal');
    state.robots = { checkedAt: isoNow(now), status, text: status === 200 ? text.slice(0, 4000) : '' };
  } catch (e) {
    runLog.stopped = `robots.txt を確認できなかったため取得しませんでした: ${e.message}`;
    return finish();
  }

  // 日ごとのデータを読み込む(今日と、結果待ちがあるかもしれない昨日)
  const dayDocs = {};
  const venueDocs = {};
  const dirty = new Set();
  const loadDay = (d) => {
    dayDocs[d] = readJson(path.join(store, d, 'day.json'), null);
    // 以前の版で保存した表記の誤りを直す
    for (const v of dayDocs[d]?.venues || []) {
      const fixed = cleanDayLabel(v.dayLabel);
      if (fixed !== v.dayLabel) { v.dayLabel = fixed; dirty.add(`${d}/day`); }
    }
    venueDocs[d] = {};
    for (const v of dayDocs[d]?.venues || []) {
      if (v.held) venueDocs[d][v.jcd] = readJson(path.join(store, d, `${v.jcd}.json`), { date: d, jcd: v.jcd, name: v.name, races: {} });
    }
  };
  loadDay(today);
  loadDay(addDays(today, -1));
  const markDirty = (d, jcd) => dirty.add(`${d}/${jcd}`);
  const saveAll = () => {
    for (const key of dirty) {
      const [d, jcd] = key.split('/');
      if (jcd === 'day') writeJson(path.join(store, d, 'day.json'), dayDocs[d]);
      else { venueDocs[d][jcd].updatedAt = isoNow(clock()); writeJson(path.join(store, d, `${jcd}.json`), venueDocs[d][jcd]); }
      runLog.saved++;
    }
    dirty.clear();
  };

  try {
    // 1) 開催場一覧
    if (needIndex(dayDocs[today], now)) {
      const p = PATHS.index(today);
      const day = dayDocs[today] || { date: today, venues: VENUES.map((v) => ({ ...v, held: false })) };
      day.index = { ...(day.index || {}), attemptedAt: isoNow(clock()), source: BASE + p };
      try {
        const parsed = parseIndex(await get(p), today);
        const held = new Map(parsed.venues.map((v) => [v.jcd, v]));
        day.venues = VENUES.map((v) => ({ ...v, held: held.has(v.jcd), ...(held.get(v.jcd) || {}), name: v.name }));
        day.index = { ...day.index, status: 'ok', fetchedAt: isoNow(clock()), warnings: parsed.warnings, error: null };
        for (const v of day.venues) if (v.held && !venueDocs[today][v.jcd]) venueDocs[today][v.jcd] = { date: today, jcd: v.jcd, name: v.name, races: {} };
      } catch (e) {
        if (e instanceof StopRun) throw e;
        day.index = { ...day.index, status: 'error', error: e.message };
        runLog.errors.push(`開催場一覧: ${e.message}`);
      }
      dayDocs[today] = day;
      markDirty(today, 'day');
      saveAll();
    }

    // 2) 計画に沿って取得
    const days = [today, addDays(today, -1)].filter((d) => dayDocs[d]).map((d) => ({ date: d, venues: venueDocs[d] }));
    // 締切時刻が分かると新しい作業が増えるので、計画を数回立て直す
    const done = new Set();
    let planned = 0;
    for (let round = 0; round < 4; round++) {
      const tasks = planTasks(days, now).filter((t) => !done.has(`${t.type}|${t.date}|${t.jcd}|${t.rno}`));
      if (!tasks.length) break;
      planned += tasks.length;
      for (const t of tasks) {
        done.add(`${t.type}|${t.date}|${t.jcd}|${t.rno}`);
        const vdoc = venueDocs[t.date][t.jcd];
        const race = (vdoc.races[t.rno] ||= { rno: t.rno, deadline: null });
        const slot = SLOT[t.type];
        const p = PATHS[t.type](t.date, t.jcd, t.rno);
        const prev = race[slot] || {};
        const rec = { ...prev, attemptedAt: isoNow(clock()), source: BASE + p };
        try {
          const html = await get(p);
          if (t.type === 'racelist') {
            const r = parseRacelist(html);
            Object.assign(rec, r.entries.length ? { status: 'ok', fetchedAt: isoNow(clock()), data: { entries: r.entries, raceTitle: r.raceTitle, distance: r.distance, fixedEntry: r.fixedEntry, stabilizer: r.stabilizer } } : { status: prev.status === 'ok' ? 'ok' : 'empty' });
            rec.warnings = r.warnings; rec.error = null;
            if (r.deadlines) for (const [rn, tm] of Object.entries(r.deadlines)) { (vdoc.races[rn] ||= { rno: +rn, deadline: null }).deadline = tm; }
          } else if (t.type === 'beforeinfo') {
            const r = parseBeforeinfo(html);
            if (r.hasExhibition || r.weather) Object.assign(rec, { status: r.hasExhibition ? 'ok' : 'pending', fetchedAt: isoNow(clock()), data: { boats: r.boats, start: r.start, weather: r.weather } });
            else rec.status = prev.status === 'ok' ? 'ok' : 'pending';
            rec.warnings = r.warnings; rec.error = null;
          } else if (t.type === 'odds3t') {
            const r = parseOdds3t(html);
            if (r.odds) Object.assign(rec, { status: 'ok', fetchedAt: isoNow(clock()), data: { odds: r.odds, oddsTime: r.oddsTime, final: r.final } });
            else rec.status = prev.status === 'ok' ? 'ok' : 'pending';
            rec.warnings = r.warnings; rec.error = null;
          } else if (t.type === 'raceresult') {
            const r = parseResult(html);
            rec.attempts = (prev.attempts || 0) + 1;
            rec.ready = r.ready; rec.canceled = r.canceled;
            if (r.ready || r.canceled) Object.assign(rec, { status: 'ok', fetchedAt: isoNow(clock()), data: { order: r.order, trifecta: r.trifecta, kimarite: r.kimarite, start: r.start, refunds: r.refunds } });
            else rec.status = 'pending';
            rec.warnings = r.warnings; rec.error = null;
          }
        } catch (e) {
          if (e instanceof StopRun) { race[slot] = prev; throw e; }
          if (t.type === 'raceresult') rec.attempts = (prev.attempts || 0) + 1;
          rec.error = e.message;
          rec.status = prev.status === 'ok' ? 'ok' : 'error'; // 以前の正しいデータは残す
          runLog.errors.push(`${VENUE_NAME[t.jcd]}${t.rno}R ${t.type}: ${e.message}`);
        }
        race[slot] = rec;
        markDirty(t.date, t.jcd);
        if (dirty.size >= 3) saveAll();
      }
    }
    runLog.planned = planned;
  } catch (e) {
    if (!(e instanceof StopRun)) { runLog.errors.push(`予期しないエラー: ${e.message}`); }
    else runLog.stopped = e.message;
  }
  // 全レース自動記録: 締切前のレースはその時点の予想を記録(締切後は書き換えない)
  try {
    for (const d of [today]) for (const [jcd, vdoc] of Object.entries(venueDocs[d] || {})) {
      if (recordAutoPredictions(vdoc, d, clock())) markDirty(d, jcd);
    }
  } catch (e) { runLog.errors.push(`予想の自動記録: ${e.message}`); }
  saveAll();
  for (const d of [today, addDays(today, -1)]) {
    if (dayDocs[d]) writeJson(path.join(store, d, 'autolog.json'), buildAutolog(d, venueDocs[d]));
  }
  prune(store, today);
  return finish();
}

function prune(store, today) {
  const limit = addDays(today, -KEEP_DAYS);
  for (const d of fs.existsSync(store) ? fs.readdirSync(store) : []) {
    if (/^\d{8}$/.test(d) && d < limit) fs.rmSync(path.join(store, d), { recursive: true, force: true });
  }
}

function writeIndex(store, now) {
  const dates = (fs.existsSync(store) ? fs.readdirSync(store) : []).filter((d) => /^\d{8}$/.test(d) && fs.existsSync(path.join(store, d, 'day.json'))).sort().reverse();
  writeJson(path.join(store, 'index.json'), { updatedAt: isoNow(now), dates, source: BASE, note: 'BOAT RACE公式サイトから取得した情報を個人利用のために整理したもの' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = process.argv[2] || 'store/data';
  runOnce({ store }).then((log) => {
    console.log(JSON.stringify({ ...log, errors: log.errors.slice(0, 30) }, null, 1));
  }).catch((e) => { console.error(e); process.exitCode = 0; });
}
