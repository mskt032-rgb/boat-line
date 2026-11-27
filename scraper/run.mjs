// 定期実行で1回分の取得を行い、JSONに保存する。
// 方針: robots.txt を毎回確認し許可された場所だけ、3秒以上の間隔、1回あたり最大160件・8分まで(10分ごとの実行が重ならないように)。
// 403/429/503 など「アクセスを控えて」という応答があれば、その回は即座にやめて30分休む(回避はしない)。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRacerCourse, cleanDayLabel, parseIndex, parseRacelist, parseBeforeinfo, parseOdds3t, parseResult } from './parse.mjs';
import { parseRobots, robotsFor } from './robots.mjs';
import { planTasks, needIndex } from './plan.mjs';
import { jstDate, addDays, isoNow, deadlineMs } from '../app/js/time.js';
import { VENUES, VENUE_NAME } from '../app/js/venues.js';
import { recordAutoPredictions, buildAutolog } from './autopred.mjs';
import { summarizeAutolog } from '../app/js/verify.js';

export const BASE = 'https://www.boatrace.jp';
export const UA = 'BOAT-LINE-personal/1.0 (personal non-commercial use; +https://github.com/mskt032-rgb/boat-line)';
const KEEP_DAYS = 45; // アプリで1レースずつ見られる期間。これより古い日は圧縮して archive ブランチへ(1年以上残す)
export const STAT_KEYS = ['A_on', 'A_off', 'B2', 'B3', 'C2'];

const PATHS = {
  index: (d) => `/owpc/pc/race/index?hd=${d}`,
  racelist: (d, j, r) => `/owpc/pc/race/racelist?rno=${r}&jcd=${j}&hd=${d}`,
  beforeinfo: (d, j, r) => `/owpc/pc/race/beforeinfo?rno=${r}&jcd=${j}&hd=${d}`,
  odds3t: (d, j, r) => `/owpc/pc/race/odds3t?rno=${r}&jcd=${j}&hd=${d}`,
  raceresult: (d, j, r) => `/owpc/pc/race/raceresult?rno=${r}&jcd=${j}&hd=${d}`,
  racerCourse: (toban) => `/owpc/pc/data/racersearch/course?toban=${toban}`,
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
  timeBudgetMs = 8 * 60000, watchUntilMs = null, archiveDir = null, watchMaxRequests = 40, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now(),
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
  let reqCap = maxRequests;
  let timeEnd = startedAt + timeBudgetMs;
  async function get(p) {
    if (runLog.requests >= reqCap) throw new StopRun('今回の取得件数の上限に達しました');
    if (clock() > timeEnd) throw new StopRun('今回の取得時間の上限に達しました');
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

    // 選手のコース別成績(1人30日に1回まで。1回の実行で最大20人。締切が近いレースの選手から)
    const racerDir = path.join(store, 'racers');
    const want = [];
    for (const [jcd, vdoc] of Object.entries(venueDocs[today] || {})) {
      for (const race of Object.values(vdoc.races || {})) {
        const dl = deadlineMs(today, race.deadline);
        if (dl == null || dl < now) continue;
        for (const e of race.racelist?.data?.entries || []) if (e.regNo) want.push({ toban: e.regNo, dl });
      }
    }
    want.sort((a, b) => a.dl - b.dl);
    const seen = new Set();
    let racerFetched = 0;
    for (const { toban } of want) {
      if (seen.has(toban) || racerFetched >= 20) continue;
      seen.add(toban);
      const file = path.join(racerDir, `${toban}.json`);
      const prev = readJson(file, null);
      const fresh = prev && prev.schema === 2 && clock() - Date.parse(prev.attemptedAt || 0) < (prev.status === 'ok' ? 30 : 3) * 86400000;
      if (fresh) continue;
      const p = PATHS.racerCourse(toban);
      const rec = { toban, attemptedAt: isoNow(clock()), source: BASE + p };
      try {
        const r = parseRacerCourse(await get(p));
        Object.assign(rec, Object.keys(r.courses).length ? { schema: 2, status: 'ok', fetchedAt: isoNow(clock()), courses: r.courses, tables: r.tables } : { schema: 2, status: 'empty', warnings: r.warnings, tables: r.tables });
      } catch (e) {
        if (e instanceof StopRun) throw e;
        Object.assign(rec, { status: 'error', error: e.message });
      }
      writeJson(file, { ...(prev?.schema === 2 && prev?.status === 'ok' && rec.status !== 'ok' ? prev : {}), ...rec });
      racerFetched++;
    }
    runLog.racers = racerFetched;
  } catch (e) {
    if (!(e instanceof StopRun)) { runLog.errors.push(`予期しないエラー: ${e.message}`); }
    else runLog.stopped = e.message;
  }
  // 全レース自動記録: 締切前のレースはその時点の予想を記録(締切後は書き換えない)
  try {
    for (const d of [today]) for (const [jcd, vdoc] of Object.entries(venueDocs[d] || {})) {
      if (recordAutoPredictions(vdoc, d, clock(), (t) => readJson(path.join(store, 'racers', `${t}.json`), null))) markDirty(d, jcd);
    }
  } catch (e) { runLog.errors.push(`予想の自動記録: ${e.message}`); }
  saveAll();

  // 見張り: (1) 締切15分前を過ぎても展示が取れていないレースは展示を、(2) 締切5分前を過ぎたレースはオッズを、(3) 締切8分後を過ぎて結果がまだのレースは結果を、約1分半おきに取りにいく
  if (watchUntilMs && !runLog.stopped?.includes('応答コード') && robots) {
    reqCap = runLog.requests + watchMaxRequests;
    timeEnd = watchUntilMs;
    let watched = 0;
    try {
      while (clock() < watchUntilMs - 20000) {
        const nowW = clock();
        const targets = [];
        for (const [jcd, vdoc] of Object.entries(venueDocs[today] || {})) {
          for (const race of Object.values(vdoc.races || {})) {
            const dl = deadlineMs(today, race.deadline);
            if (dl == null || race.racelist?.status !== 'ok' || race.before?.status === 'ok') continue;
            const left = dl - nowW;
            if (left <= 60000 || left > 15 * 60000) continue;
            if (race.before?.attemptedAt && nowW - Date.parse(race.before.attemptedAt) < 90000) continue;
            targets.push({ jcd, vdoc, race, dl });
          }
        }
        // (2) 締切5分前〜30秒前のレースのオッズを取り直す(締切にできるだけ近いオッズで期待値を計算するため)
        const oddsTargets = [];
        for (const [jcd, vdoc] of Object.entries(venueDocs[today] || {})) {
          for (const race of Object.values(vdoc.races || {})) {
            const dl = deadlineMs(today, race.deadline);
            if (dl == null || race.racelist?.status !== 'ok' || vdoc.canceled) continue;
            const left = dl - nowW;
            if (left <= 30000 || left > 5 * 60000) continue;
            if (race.odds?.attemptedAt && nowW - Date.parse(race.odds.attemptedAt) < 90000) continue;
            if (targets.some((t) => t.race === race)) continue;
            oddsTargets.push({ jcd, vdoc, race, dl });
          }
        }
        oddsTargets.sort((a, b) => a.dl - b.dl);
        for (const { jcd, vdoc, race, dl } of oddsTargets) {
          const po = PATHS.odds3t(today, jcd, race.rno);
          try {
            const o = parseOdds3t(await get(po));
            if (o.odds && clock() < dl) race.odds = { ...(race.odds || {}), attemptedAt: isoNow(clock()), source: BASE + po, status: 'ok', fetchedAt: isoNow(clock()), data: { odds: o.odds, oddsTime: o.oddsTime, final: o.final }, error: null };
            else race.odds = { ...(race.odds || {}), attemptedAt: isoNow(clock()) };
            runLog.lateOdds = (runLog.lateOdds || 0) + 1;
          } catch (e) {
            if (e instanceof StopRun) throw e;
            race.odds = { ...(race.odds || {}), attemptedAt: isoNow(clock()), error: e.message };
          }
          if (recordAutoPredictions(vdoc, today, clock(), (t) => readJson(path.join(store, 'racers', `${t}.json`), null))) markDirty(today, jcd);
          markDirty(today, jcd);
        }
        // (3) 締切から8分以上たって結果がまだのレースは、結果を取りにいく(アプリへの反映を早めるため)
        for (const [jcd, vdoc] of Object.entries(venueDocs[today] || {})) {
          for (const race of Object.values(vdoc.races || {})) {
            const dl = deadlineMs(today, race.deadline);
            const r0 = race.result || {};
            if (dl == null || r0.ready || r0.canceled || (r0.attempts || 0) >= 12) continue;
            const past = nowW - dl;
            if (past < 8 * 60000 || past > 90 * 60000) continue;
            if (r0.attemptedAt && nowW - Date.parse(r0.attemptedAt) < 90000) continue;
            const p = PATHS.raceresult(today, jcd, race.rno);
            const rec = { ...r0, attemptedAt: isoNow(clock()), source: BASE + p, attempts: (r0.attempts || 0) + 1 };
            try {
              const r = parseResult(await get(p));
              rec.ready = r.ready; rec.canceled = r.canceled;
              if (r.ready || r.canceled) Object.assign(rec, { status: 'ok', fetchedAt: isoNow(clock()), data: { order: r.order, trifecta: r.trifecta, kimarite: r.kimarite, start: r.start, refunds: r.refunds }, error: null });
              else rec.status = 'pending';
            } catch (e) {
              if (e instanceof StopRun) throw e;
              rec.error = e.message;
            }
            race.result = rec;
            runLog.lateResults = (runLog.lateResults || 0) + 1;
            markDirty(today, jcd);
          }
        }
        targets.sort((a, b) => a.dl - b.dl);
        for (const { jcd, vdoc, race } of targets) {
          const p = PATHS.beforeinfo(today, jcd, race.rno);
          const prev = race.before || {};
          const rec = { ...prev, attemptedAt: isoNow(clock()), source: BASE + p };
          try {
            const r = parseBeforeinfo(await get(p));
            if (r.hasExhibition) Object.assign(rec, { status: 'ok', fetchedAt: isoNow(clock()), data: { boats: r.boats, start: r.start, weather: r.weather }, error: null });
            else rec.status = prev.status || 'pending';
            race.before = rec;
            if (r.hasExhibition) {
              const po = PATHS.odds3t(today, jcd, race.rno);
              const o = parseOdds3t(await get(po));
              if (o.odds) race.odds = { ...(race.odds || {}), attemptedAt: isoNow(clock()), source: BASE + po, status: 'ok', fetchedAt: isoNow(clock()), data: { odds: o.odds, oddsTime: o.oddsTime, final: o.final }, error: null };
              watched++;
            }
          } catch (e) {
            if (e instanceof StopRun) throw e;
            rec.error = e.message; race.before = rec;
          }
          if (recordAutoPredictions(vdoc, today, clock(), (t) => readJson(path.join(store, 'racers', `${t}.json`), null))) markDirty(today, jcd);
          markDirty(today, jcd);
        }
        saveAll();
        await sleep(30000);
      }
    } catch (e) {
      if (e instanceof StopRun && /応答コード/.test(e.message)) runLog.stopped = e.message;
    }
    runLog.watchedExhibitions = watched;
    saveAll();
  }

  for (const d of [today, addDays(today, -1)]) {
    if (dayDocs[d]) {
      const log = buildAutolog(d, venueDocs[d]);
      writeJson(path.join(store, d, 'autolog.json'), log);
      updateDayStats(store, d, log.rows);
    }
  }
  // 集計がまだ無い日(この機能より前の日など)を埋める
  try {
    const have = readJson(path.join(store, 'stats-days.json'), { days: {} }).days;
    for (const d of fs.readdirSync(store).filter((x) => /^\d{8}$/.test(x) && !have[x])) {
      const log = readJson(path.join(store, d, 'autolog.json'), null);
      if (log?.rows?.length) updateDayStats(store, d, log.rows);
    }
  } catch (e) { runLog.errors.push(`日ごとの集計: ${e.message}`); }
  prune(store, today, archiveDir);
  return finish();
}

/** 日ごとの成績の集計(小さいので消さずに残す。成績画面の「全期間」「日ごと」に使う) */
export function updateDayStats(store, date, rows) {
  const file = path.join(store, 'stats-days.json');
  const all = readJson(file, { days: {} });
  const day = {};
  for (const k of STAT_KEYS) {
    const s = summarizeAutolog(rows, k);
    day[k] = { races: s.races, hits: s.hits, stake: s.stake, ret: s.ret, exh: Math.round((s.exhibitionShare || 0) * s.races) };
  }
  all.days[date] = day;
  all.updatedAt = isoNow();
  writeJson(file, all);
}

/** 45日より古い日: archiveDir があれば1日1ファイルに圧縮して渡し、公開用からは外す */
function prune(store, today, archiveDir) {
  const limit = addDays(today, -KEEP_DAYS);
  for (const d of fs.existsSync(store) ? fs.readdirSync(store) : []) {
    if (!/^\d{8}$/.test(d) || d >= limit) continue;
    const dir = path.join(store, d);
    if (archiveDir) {
      const bundle = { date: d, files: {} };
      for (const f of fs.readdirSync(dir)) bundle.files[f] = readJson(path.join(dir, f), null);
      fs.mkdirSync(path.join(archiveDir, d.slice(0, 4)), { recursive: true });
      fs.writeFileSync(path.join(archiveDir, d.slice(0, 4), `${d}.json.gz`), zlib.gzipSync(JSON.stringify(bundle)));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeIndex(store, now) {
  const dates = (fs.existsSync(store) ? fs.readdirSync(store) : []).filter((d) => /^\d{8}$/.test(d) && fs.existsSync(path.join(store, d, 'day.json'))).sort().reverse();
  writeJson(path.join(store, 'index.json'), { updatedAt: isoNow(now), dates, source: BASE, note: 'BOAT RACE公式サイトから取得した情報を個人利用のために整理したもの' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = process.argv[2] || 'store/data';
  const watchUntilMs = process.env.WATCH_UNTIL ? Number(process.env.WATCH_UNTIL) * 1000 : null;
  const archiveDir = process.env.ARCHIVE_OUT || null;
  runOnce({ store, watchUntilMs, archiveDir }).then((log) => {
    console.log(JSON.stringify({ ...log, errors: log.errors.slice(0, 30) }, null, 1));
  }).catch((e) => { console.error(e); process.exitCode = 0; });
}
