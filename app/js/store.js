// 端末内(このiPhoneのSafari)への保存。予想は「版」として追加だけ行い、後から上書きしない。
import { ALL_COMBOS } from './predict.js';

const KEY = 'boatline.predictions.v1';
const PREF = 'boatline.prefs.v1';

function load(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; }
}

export function getPrefs() {
  return { mode: 'A', excludeBoat1First: true, ...load(PREF, {}) };
}
export function setPrefs(p) { save(PREF, { ...getPrefs(), ...p }); }

export function allPredictions() { return load(KEY, []); }

export function predictionsFor(date, jcd, rno) {
  return allPredictions().filter((p) => p.date === date && p.jcd === jcd && p.rno === rno).sort((a, b) => a.version - b.version);
}

/** 入力データと設定が前の版と同じなら保存しない。違えば新しい版として追加する */
export function savePredictionVersion(rec) {
  const list = allPredictions();
  const same = list.filter((p) => p.date === rec.date && p.jcd === rec.jcd && p.rno === rec.rno);
  const last = same.sort((a, b) => a.version - b.version).at(-1);
  if (last && last.fingerprint === rec.fingerprint) return { saved: false, record: last };
  const record = Object.freeze({ ...rec, version: (last?.version || 0) + 1, savedAt: new Date().toISOString() });
  list.push(record);
  const ok = save(KEY, list);
  return { saved: ok, record, error: ok ? null : '端末の保存領域に書き込めませんでした(プライベートブラウズ中などの可能性)' };
}

export function makeRecord({ date, jcd, rno, deadline, pred, betsRes, prefs, race }) {
  const stamps = {
    racelist: race?.racelist?.fetchedAt || null,
    before: race?.before?.status === 'ok' ? race.before.fetchedAt : null,
    odds: race?.odds?.status === 'ok' ? race.odds.fetchedAt : null,
  };
  const fingerprint = JSON.stringify([stamps, prefs.mode, prefs.excludeBoat1First, pred.modelVersion]);
  return {
    date, jcd, rno, deadline,
    modelVersion: pred.modelVersion,
    mode: prefs.mode,
    excludeBoat1First: prefs.excludeBoat1First,
    dataStamps: stamps,
    fingerprint,
    reflect: pred.reflect,
    probs: ALL_COMBOS.map((k) => Math.round(pred.probs[k] * 1e6) / 1e6),
    winProb: pred.winProb,
    scenarios: pred.scenarios,
    bets: betsRes.bets.map((b) => ({ combo: b.combo, p: Math.round(b.p * 1e5) / 1e5, odds: b.odds })),
    betsAvailable: betsRes.available,
  };
}

export function exportBackup() {
  return JSON.stringify({ app: 'BOAT LINE', kind: 'backup', exportedAt: new Date().toISOString(), predictions: allPredictions(), prefs: getPrefs() }, null, 1);
}

/** バックアップの読み込み。既存の版は消さず、無い版だけ足す */
export function importBackup(text) {
  const obj = JSON.parse(text);
  if (obj?.app !== 'BOAT LINE' || !Array.isArray(obj.predictions)) throw new Error('BOAT LINE のバックアップファイルではありません');
  const list = allPredictions();
  const keys = new Set(list.map((p) => `${p.date}|${p.jcd}|${p.rno}|${p.version}|${p.savedAt}`));
  let added = 0;
  for (const p of obj.predictions) {
    const k = `${p.date}|${p.jcd}|${p.rno}|${p.version}|${p.savedAt}`;
    if (!keys.has(k)) { list.push(p); keys.add(k); added++; }
  }
  save(KEY, list);
  return added;
}
