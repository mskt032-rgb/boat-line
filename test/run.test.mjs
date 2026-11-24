import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../scraper/run.mjs';
import { deadlineMs } from '../app/js/time.js';
import { indexHtml, racelistHtml, beforeinfoHtml, oddsHtml, resultHtml } from './fixtures/html.mjs';

const D = '20261123';
function fakeSite({ robots = 'User-agent: *\nDisallow:\n', failRacelist = null, status = {} } = {}) {
  const calls = [];
  const fetchText = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (status[u.pathname]) return { status: status[u.pathname], text: '' };
    if (u.pathname === '/robots.txt') return { status: 200, text: robots };
    if (u.pathname.endsWith('/index')) return { status: 200, text: indexHtml(D, ['02', '24']) };
    const rno = u.searchParams.get('rno');
    if (u.pathname.endsWith('/racelist')) {
      if (failRacelist === rno) throw new Error('ネットワークエラー');
      return { status: 200, text: racelistHtml() };
    }
    if (u.pathname.endsWith('/beforeinfo')) return { status: 200, text: beforeinfoHtml() };
    if (u.pathname.endsWith('/odds3t')) return { status: 200, text: oddsHtml() };
    if (u.pathname.endsWith('/raceresult')) return { status: 200, text: resultHtml() };
    return { status: 404, text: '' };
  };
  return { fetchText, calls };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const opts = (store, site, now) => ({ store, now, fetchText: site.fetchText, intervalMs: 0, sleep: async () => {}, clock: () => now });

test('朝: 開催場一覧→各場の出走表を取得して保存', async () => {
  const store = tmp();
  const site = fakeSite();
  const now = deadlineMs(D, '07:00');
  const log = await runOnce(opts(store, site, now));
  assert.equal(site.calls[0], '/robots.txt');
  const day = read(store, `${D}/day.json`);
  assert.equal(day.venues.length, 24);
  assert.deepEqual(day.venues.filter((v) => v.held).map((v) => v.jcd), ['02', '24']);
  const v = read(store, `${D}/02.json`);
  assert.equal(Object.keys(v.races).length, 12);
  assert.equal(v.races[1].deadline, '10:30');
  assert.equal(v.races[5].racelist.status, 'ok');
  assert.equal(v.races[5].racelist.data.entries.length, 6);
  assert.match(v.races[5].racelist.source, /^https:\/\/www\.boatrace\.jp\/owpc\/pc\/race\/racelist\?rno=5&jcd=02&hd=20261123$/);
  assert.ok(v.races[5].racelist.fetchedAt);
  assert.equal(log.requests, 1 + 1 + 24);
  assert.deepEqual(read(store, 'index.json').dates, [D]);
  assert.equal(read(store, 'meta/log.json').length, 1);
});

test('1件の失敗で全体を止めない', async () => {
  const store = tmp();
  const site = fakeSite({ failRacelist: '3' });
  const log = await runOnce(opts(store, site, deadlineMs(D, '07:00')));
  const v = read(store, `${D}/02.json`);
  assert.equal(v.races[3].racelist.status, 'error');
  assert.match(v.races[3].racelist.error, /ネットワーク/);
  assert.equal(v.races[4].racelist.status, 'ok');
  assert.ok(log.errors.length >= 2);
});

test('締切前に直前情報・オッズ、締切後に結果', async () => {
  const store = tmp();
  const site = fakeSite();
  await runOnce(opts(store, site, deadlineMs(D, '07:00')));
  await runOnce(opts(store, site, deadlineMs(D, '10:15')));
  let v = read(store, `${D}/02.json`);
  assert.equal(v.races[1].before.status, 'ok');
  assert.equal(v.races[1].odds.status, 'ok');
  assert.equal(Object.keys(v.races[1].odds.data.odds).length, 120);
  assert.equal(v.races[2].odds, undefined);
  await runOnce(opts(store, site, deadlineMs(D, '10:45')));
  v = read(store, `${D}/02.json`);
  assert.equal(v.races[1].result.ready, true);
  assert.equal(v.races[1].result.data.trifecta.combo, '3-1-4');
});

test('robots.txt で禁止されていれば取得しない', async () => {
  const store = tmp();
  const site = fakeSite({ robots: 'User-agent: *\nDisallow: /owpc/pc/race/\n' });
  const log = await runOnce(opts(store, site, deadlineMs(D, '07:00')));
  assert.deepEqual(site.calls, ['/robots.txt']);
  assert.ok(log.errors.some((e) => e.includes('robots.txt')));
});

test('429 が返ったらその回は中止し、30分休む', async () => {
  const store = tmp();
  const site = fakeSite({ status: { '/owpc/pc/race/racelist': 429 } });
  const now = deadlineMs(D, '07:00');
  const log = await runOnce(opts(store, site, now));
  assert.match(log.stopped, /429/);
  const n = site.calls.length;
  assert.equal(n, 3); // robots, index, racelist 1件だけ
  const log2 = await runOnce(opts(store, site, now + 10 * 60000));
  assert.match(log2.stopped, /休止中/);
  assert.equal(site.calls.length, n);
});

test('1回あたりの件数上限を守る', async () => {
  const store = tmp();
  const site = fakeSite();
  const log = await runOnce({ ...opts(store, site, deadlineMs(D, '07:00')), maxRequests: 5 });
  assert.equal(log.requests, 5);
  assert.match(log.stopped, /上限/);
});

test('robots.txt が取れないときは何も取得しない', async () => {
  const store = tmp();
  const site = fakeSite({ status: { '/robots.txt': 500 } });
  const log = await runOnce(opts(store, site, deadlineMs(D, '07:00')));
  assert.equal(site.calls.length, 1);
  assert.match(log.stopped, /robots/);
});

test('以前に保存した「246日目」などの表記を直して保存し直す', async () => {
  const store = tmp();
  const site = fakeSite();
  const now = deadlineMs(D, '07:00');
  await runOnce(opts(store, site, now));
  const f = path.join(store, D, 'day.json');
  const day = JSON.parse(fs.readFileSync(f, 'utf8'));
  day.venues.find((v) => v.jcd === '02').dayLabel = '246日目';
  fs.writeFileSync(f, JSON.stringify(day));
  await runOnce(opts(store, site, now + 5 * 60000));
  assert.equal(read(store, `${D}/day.json`).venues.find((v) => v.jcd === '02').dayLabel, '6日目');
});

test('全レース自動記録: 締切前に記録し、締切後は書き換えない。結果と合わせて autolog を作る', async () => {
  const store = tmp();
  const site = fakeSite();
  await runOnce(opts(store, site, deadlineMs(D, '07:00')));
  let v = read(store, `${D}/02.json`);
  assert.ok(v.races[1].auto, '朝の時点で記録される');
  assert.equal(v.races[1].auto.reflect.exhibition, false);
  await runOnce(opts(store, site, deadlineMs(D, '10:15')));
  v = read(store, `${D}/02.json`);
  const before = v.races[1].auto;
  assert.equal(before.reflect.exhibition, true, '展示が入った予想に更新される');
  assert.ok(before.bets.A_on.length > 0 && before.bets.A_off.length > 0 && before.bets.B_off);
  await runOnce(opts(store, site, deadlineMs(D, '10:45')));
  v = read(store, `${D}/02.json`);
  assert.deepEqual(v.races[1].auto, before, '締切後は書き換えない');
  const log = read(store, `${D}/autolog.json`);
  const row = log.rows.find((r) => r.jcd === '02' && r.rno === 1);
  assert.equal(row.result.combo, '3-1-4');
  assert.equal(row.result.payout, 12340);
  assert.ok(row.rankActual >= 1);
});
