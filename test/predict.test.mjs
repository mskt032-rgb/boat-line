import test from 'node:test';
import assert from 'node:assert/strict';
import { predictRace, selectBets, ALL_COMBOS } from '../app/js/predict.js';
import { makeRace, flatOdds } from './helpers.mjs';

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('120通りで合計100%', () => {
  const p = predictRace(makeRace());
  assert.equal(p.ok, true);
  assert.equal(ALL_COMBOS.length, 120);
  assert.equal(Object.keys(p.probs).length, 120);
  assert.ok(Math.abs(sum(p.probs) - 1) < 1e-9);
  assert.ok(Object.values(p.probs).every((x) => x > 0));
  assert.ok(Math.abs(sum(p.winProb) - 1) < 1e-9);
  assert.ok(Math.abs(sum(p.scenarios) - 1) < 1e-9);
});

test('1着率は120通りの和と一致する', () => {
  const p = predictRace(makeRace({ withBefore: true }));
  for (let n = 1; n <= 6; n++) {
    const s = ALL_COMBOS.filter((c) => c.startsWith(`${n}-`)).reduce((a, c) => a + p.probs[c], 0);
    assert.ok(Math.abs(s - p.winProb[n]) < 1e-9);
  }
});

test('出走表が無ければ予想しない(推測しない)', () => {
  const p = predictRace({ racelist: null });
  assert.equal(p.ok, false);
});

test('展示が無いときは「未反映」と「枠なり仮定」を明示', () => {
  const p = predictRace(makeRace());
  assert.equal(p.reflect.exhibition, false);
  assert.equal(p.courseSource, 'assumed');
  assert.ok(p.notes.some((n) => n.includes('枠なり')));
  assert.ok(p.missing.some((m) => m.factor === '展示タイム'));
});

test('展示の進入が反映される(4号艇が2コースに入る)', () => {
  const p = predictRace(makeRace({ withBefore: true, order: [1, 4, 2, 3, 5, 6] }));
  assert.equal(p.courseSource, 'exhibition');
  assert.equal(p.courseOf[4], 2);
  assert.equal(p.reflect.exhibition, true);
});

test('当地勝率0.00は「走歴なし」として評価に入れない', () => {
  const p = predictRace(makeRace({ locZero: [6] }));
  const e6 = p.evals.find((e) => e.boat === 6);
  assert.ok(!e6.parts.some((x) => x.factor === '当地勝率'));
  assert.ok(p.notes.some((n) => n.includes('当地勝率') && n.includes('6')));
});

test('強い1号艇ほど1着率が上がる', () => {
  const weak = predictRace(makeRace({ nat: [4.0, 6, 6, 6, 6, 6] })).winProb[1];
  const strong = predictRace(makeRace({ nat: [8.0, 5, 5, 5, 5, 5] })).winProb[1];
  assert.ok(strong > weak + 0.1);
});

test('5・6号艇も確率を持ち、評価される', () => {
  const p = predictRace(makeRace({ withBefore: true }));
  assert.ok(p.winProb[5] > 0.005 && p.winProb[6] > 0.002);
  assert.ok(p.evals.find((e) => e.boat === 6).parts.length > 3);
});

test('スタートが速い外の艇はまくりが増える', () => {
  const base = predictRace(makeRace({ withBefore: true, sts: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15] }));
  const fast4 = predictRace(makeRace({ withBefore: true, sts: [0.15, 0.15, 0.15, 0.05, 0.15, 0.15] }));
  assert.ok(fast4.scenarios['まくり'] > base.scenarios['まくり']);
  assert.ok(fast4.winProb[4] > base.winProb[4]);
});

test('欠場艇は確率0、残りで合計100%', () => {
  const r = makeRace();
  r.racelist.data.entries[5].absent = true;
  const p = predictRace(r);
  assert.equal(p.winProb[6], 0);
  assert.ok(ALL_COMBOS.filter((c) => c.includes('6')).every((c) => p.probs[c] === 0));
  assert.ok(Math.abs(sum(p.probs) - 1) < 1e-9);
});

test('モードA: 最大12点、確率順、1号艇1着除外(初期ON)', () => {
  const p = predictRace(makeRace());
  const r = selectBets(p, null, { mode: 'A' });
  assert.ok(r.bets.length >= 1 && r.bets.length <= 12);
  assert.ok(r.bets.every((b) => !b.combo.startsWith('1-')));
  for (let i = 1; i < r.bets.length; i++) assert.ok(r.bets[i - 1].p >= r.bets[i].p);
  const r2 = selectBets(p, null, { mode: 'A', excludeBoat1First: false });
  assert.ok(r2.bets.some((b) => b.combo.startsWith('1-')));
});

test('逃げ有力時に1号艇除外の警告', () => {
  const p = predictRace(makeRace({ nat: [8.5, 4, 4, 4, 4, 4] }));
  assert.ok(p.winProb[1] >= 0.45);
  const r = selectBets(p, null, { mode: 'A', excludeBoat1First: true });
  assert.ok(r.warnings.some((w) => w.includes('1号艇の逃げが有力')));
  const r2 = selectBets(p, null, { mode: 'A', excludeBoat1First: false });
  assert.ok(!r2.warnings.some((w) => w.includes('逃げが有力')));
});

test('モードB/C: オッズ未取得なら計算しない', () => {
  const p = predictRace(makeRace());
  const r = selectBets(p, null, { mode: 'B' });
  assert.equal(r.available, false);
  assert.equal(r.bets.length, 0);
});

test('モードB: 期待値(確率×オッズ)順、最大12点', () => {
  const p = predictRace(makeRace());
  const r = selectBets(p, flatOdds(200), { mode: 'B', excludeBoat1First: false });
  assert.ok(r.bets.length <= 12 && r.bets.length > 0);
  for (const b of r.bets) assert.ok(Math.abs(b.ev - b.p * b.odds) < 1e-12);
  for (let i = 1; i < r.bets.length; i++) assert.ok(r.bets[i - 1].ev >= r.bets[i].ev);
});

test('モードC: 20倍未満は選ばない', () => {
  const odds = flatOdds(10);
  odds['2-3-4'] = 80; odds['4-5-6'] = 300; odds['5-6-4'] = 150;
  const p = predictRace(makeRace());
  const r = selectBets(p, odds, { mode: 'C' });
  assert.ok(r.bets.length > 0);
  assert.ok(r.bets.every((b) => b.odds >= 20));
});

test('締切時点の予想: 締切後に取得した直前情報・オッズは使わない', async () => {
  const { raceAtDeadline } = await import('../app/js/predict.js');
  const r = makeRace({ withBefore: true, odds: flatOdds(30) });
  const dl = Date.parse('2026-11-23T01:30:00Z');
  r.before.fetchedAt = '2026-11-23T01:20:00Z';
  r.odds.fetchedAt = '2026-11-23T01:31:00Z';
  const f = raceAtDeadline(r, dl);
  assert.ok(f.before);
  assert.equal(f.odds, null);
  assert.deepEqual(predictRace(f).probs, predictRace({ ...r, odds: null }).probs);
});
