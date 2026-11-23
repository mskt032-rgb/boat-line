import test from 'node:test';
import assert from 'node:assert/strict';
import { planTasks, needIndex } from '../scraper/plan.mjs';
import { deadlineMs } from '../app/js/time.js';

const D = '20261123';
const at = (hhmm) => deadlineMs(D, hhmm);

test('JST締切の換算', () => {
  assert.equal(new Date(at('10:30')).toISOString(), '2026-11-23T01:30:00.000Z');
});

test('締切時刻が分からない場は、まず1Rの出走表', () => {
  const t = planTasks([{ date: D, venues: { '02': { races: {} } } }], at('08:00'));
  assert.deepEqual(t.map((x) => [x.type, x.rno]), [['racelist', 1]]);
});

test('締切25分前から直前情報とオッズ、締切8分後から結果', () => {
  const races = { 1: { rno: 1, deadline: '10:30', racelist: { status: 'ok' } }, 2: { rno: 2, deadline: '11:00', racelist: { status: 'ok' } } };
  const v = { '02': { races } };
  const t1 = planTasks([{ date: D, venues: v }], at('10:10'));
  assert.deepEqual(t1.map((x) => `${x.type}${x.rno}`), ['beforeinfo1', 'odds3t1']);
  const t2 = planTasks([{ date: D, venues: v }], at('10:40'));
  assert.deepEqual(t2.map((x) => `${x.type}${x.rno}`).sort(), ['beforeinfo2', 'odds3t2', 'raceresult1'].sort());
});

test('8分以内に取ったばかりなら取り直さない', () => {
  const now = at('10:10');
  const iso = new Date(now - 3 * 60000).toISOString();
  const races = { 1: { rno: 1, deadline: '10:30', racelist: { status: 'ok' }, before: { attemptedAt: iso }, odds: { attemptedAt: iso } } };
  assert.equal(planTasks([{ date: D, venues: { '02': { races } } }], now).length, 0);
});

test('結果が出たら取りにいかない・回数上限', () => {
  const races = { 1: { rno: 1, deadline: '10:30', racelist: { status: 'ok' }, result: { ready: true } }, 2: { rno: 2, deadline: '10:31', racelist: { status: 'ok' }, result: { attempts: 8 } } };
  assert.equal(planTasks([{ date: D, venues: { '02': { races } } }], at('12:00')).length, 0);
});

test('締切が近い順', () => {
  const races = {};
  for (let r = 1; r <= 12; r++) races[r] = { rno: r, deadline: `${10 + r}:00` };
  const t = planTasks([{ date: D, venues: { '02': { races } } }], at('08:00'));
  assert.equal(t.length, 12);
  assert.deepEqual(t.map((x) => x.rno), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('開催場一覧の見直し間隔', () => {
  const now = at('09:00');
  assert.equal(needIndex(null, now), true);
  assert.equal(needIndex({ index: { status: 'ok', fetchedAt: new Date(now - 30 * 60000).toISOString() } }, now), false);
  assert.equal(needIndex({ index: { status: 'ok', fetchedAt: new Date(now - 130 * 60000).toISOString() } }, now), true);
});
