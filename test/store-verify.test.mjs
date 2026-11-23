import test from 'node:test';
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { savePredictionVersion, makeRecord, predictionsFor, exportBackup, importBackup, getPrefs } = await import('../app/js/store.js');
const { judge, summarize, finalVersion } = await import('../app/js/verify.js');
const { predictRace, selectBets } = await import('../app/js/predict.js');
const { makeRace, flatOdds } = await import('./helpers.mjs');

test('初期設定: モードA・1号艇1着除外ON', () => {
  assert.deepEqual(getPrefs(), { mode: 'A', excludeBoat1First: true });
});

test('版ごとに追加保存し、前の版は書き換えない', () => {
  mem.clear();
  const prefs = getPrefs();
  const r1 = makeRace();
  const p1 = predictRace(r1);
  const a = savePredictionVersion(makeRecord({ date: '20261123', jcd: '02', rno: 1, deadline: '10:30', pred: p1, betsRes: selectBets(p1, null, prefs), prefs, race: r1 }));
  assert.equal(a.record.version, 1);
  const again = savePredictionVersion(makeRecord({ date: '20261123', jcd: '02', rno: 1, deadline: '10:30', pred: p1, betsRes: selectBets(p1, null, prefs), prefs, race: r1 }));
  assert.equal(again.saved, false);
  const r2 = makeRace({ withBefore: true });
  const p2 = predictRace(r2);
  const b = savePredictionVersion(makeRecord({ date: '20261123', jcd: '02', rno: 1, deadline: '10:30', pred: p2, betsRes: selectBets(p2, null, prefs), prefs, race: r2 }));
  assert.equal(b.record.version, 2);
  const vs = predictionsFor('20261123', '02', 1);
  assert.equal(vs.length, 2);
  assert.deepEqual(vs[0].bets, a.record.bets);
  assert.equal(vs[0].probs.length, 120);
});

test('バックアップの書き出しと読み込み(重複しない)', () => {
  const text = exportBackup();
  assert.equal(importBackup(text), 0);
  mem.clear();
  assert.equal(importBackup(text), 2);
  assert.throws(() => importBackup('{"x":1}'));
});

test('照合と集計: 的中率・回収率・確率の当たり具合', () => {
  const rec = { bets: [{ combo: '3-1-4' }, { combo: '2-1-3' }], probs: new Array(120).fill(1 / 120), winProb: { 1: 0.5, 2: 0.1, 3: 0.2, 4: 0.1, 5: 0.05, 6: 0.05 }, mode: 'A' };
  const hit = judge(rec, { status: 'ok', data: { trifecta: { combo: '3-1-4', payout: 12340 } } });
  assert.equal(hit.hit, true); assert.equal(hit.stake, 200); assert.equal(hit.ret, 12340);
  const miss = judge(rec, { status: 'ok', data: { trifecta: { combo: '1-2-3', payout: 800 } } });
  assert.equal(miss.hit, false); assert.equal(miss.ret, 0);
  assert.equal(judge(rec, null).state, 'waiting');
  assert.equal(judge(rec, { status: 'ok', canceled: true, data: {} }).state, 'void');
  const s = summarize([{ rec, j: hit }, { rec, j: miss }, { rec, j: { state: 'waiting' } }]);
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.recovery, 12340 / 400);
  assert.equal(s.waiting, 1);
  assert.ok(Math.abs(s.logLoss - Math.log(120)) < 1e-9);
  assert.equal(s.buckets.reduce((a, b) => a + b.n, 0), 240);
  assert.equal(s.winTop.rate, 0.5);
});

test('最終版は締切前に保存された最後の版', () => {
  const vs = [{ version: 1, savedAt: '2026-11-23T01:00:00Z' }, { version: 2, savedAt: '2026-11-23T01:20:00Z' }, { version: 3, savedAt: '2026-11-23T01:40:00Z' }];
  assert.equal(finalVersion(vs, Date.parse('2026-11-23T01:30:00Z')).version, 2);
});
