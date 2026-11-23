import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex, parseRacelist, parseBeforeinfo, parseOdds3t, parseResult, combosForFirst, norm } from '../scraper/parse.mjs';
import { indexHtml, racelistHtml, beforeinfoHtml, oddsHtml, resultHtml } from './fixtures/html.mjs';

test('全角数字・全角空白をそろえる', () => {
  assert.equal(norm('１２：３０　テスト'), '12:30 テスト');
});

test('開催場一覧: その日の場だけを拾う', () => {
  const r = parseIndex(indexHtml('20261123', ['02', '12', '24']), '20261123');
  assert.deepEqual(r.venues.map((v) => v.jcd), ['02', '12', '24']);
  assert.equal(r.venues[0].dayLabel, '3日目'); // 日付「11/26」と「3日目」がくっついても正しく読む
  assert.equal(r.venues[0].grade, 'G3');
  assert.match(r.venues[0].title, /テスト杯/);
});

test('開催場一覧: 見つからないときは警告を出す', () => {
  const r = parseIndex('<html><body>本日の開催はありません</body></html>', '20261123');
  assert.equal(r.venues.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('出走表: 6艇の値と締切時刻', () => {
  const r = parseRacelist(racelistHtml());
  assert.equal(r.entries.length, 6);
  const e1 = r.entries[0];
  assert.equal(e1.boat, 1);
  assert.equal(e1.regNo, '4001');
  assert.equal(e1.cls, 'A1');
  assert.equal(e1.name, '山田 一郎');
  assert.equal(e1.age, 31);
  assert.equal(e1.weight, 51);
  assert.equal(e1.avgST, 0.14);
  assert.equal(e1.natWin, 7.1);
  assert.equal(e1.motorNo, 11);
  assert.equal(e1.motor2, 32.5);
  assert.equal(r.entries[3].F, 1);
  assert.equal(r.entries[5].locWin, 0);
  assert.equal(r.deadlines[1], '10:30');
  assert.equal(r.deadlines[12], '15:52');
  assert.equal(r.distance, 1800);
  assert.deepEqual(r.warnings, []);
});

test('出走表: 表が無いページでは空と警告', () => {
  const r = parseRacelist('<html><body>データがありません</body></html>');
  assert.equal(r.entries.length, 0);
  assert.ok(r.warnings.length);
});

test('直前情報: 展示タイム・進入・展示ST・気象', () => {
  const r = parseBeforeinfo(beforeinfoHtml({ order: [1, 2, 4, 3, 5, 6], sts: ['.10', '.12', '.08', 'F.01', '.15', '.20'] }));
  assert.equal(r.boats.length, 6);
  assert.equal(r.boats[0].exTime, 6.72);
  assert.equal(r.boats[0].tilt, -0.5);
  assert.deepEqual(r.start.map((s) => s.boat), [1, 2, 4, 3, 5, 6]);
  assert.equal(r.start[2].course, 3);
  assert.equal(r.start[3].flying, true);
  assert.equal(r.start[3].st, -0.01);
  assert.equal(r.weather.windSpeed, 3);
  assert.equal(r.weather.windDirCode, 7);
  assert.equal(r.weather.waveHeight, 2);
  assert.equal(r.weather.weather, '晴');
  assert.equal(r.hasExhibition, true);
});

test('直前情報: 展示前(空欄)は「未発表」扱い', () => {
  const r = parseBeforeinfo(beforeinfoHtml({ ex: ['', '', '', '', '', ''], noStart: true }));
  assert.equal(r.hasExhibition, false);
  assert.ok(r.boats.every((b) => b.exTime === null));
});

test('3連単オッズ: 120通りを正しい組み合わせに対応づける', () => {
  const r = parseOdds3t(oddsHtml((c) => (c === '3-6-2' ? '123.4' : c === '1-2-3' ? '4.5' : '50.0')));
  assert.equal(Object.keys(r.odds).length, 120);
  assert.equal(r.odds['1-2-3'], 4.5);
  assert.equal(r.odds['3-6-2'], 123.4);
  assert.equal(r.odds['6-5-4'], 50);
  assert.equal(r.oddsTime, '11:15');
});

test('3連単オッズ: 欄の数が違えば読み取らない', () => {
  const r = parseOdds3t('<table><tr><td class="oddsPoint">1.0</td></tr></table>');
  assert.equal(r.odds, null);
});

test('3連単オッズ: 欠場で数字が無い欄は null', () => {
  const r = parseOdds3t(oddsHtml((c) => (c.includes('6') ? '欠場' : '10.0')));
  assert.equal(r.odds['1-2-6'], null);
  assert.equal(r.odds['1-2-3'], 10);
});

test('combosForFirst は20通り', () => {
  assert.equal(combosForFirst(1).length, 20);
  assert.equal(combosForFirst(1)[0], '1-2-3');
  assert.equal(combosForFirst(6).at(-1), '6-5-4');
});

test('結果: 着順・3連単払戻・決まり手', () => {
  const r = parseResult(resultHtml());
  assert.equal(r.ready, true);
  assert.deepEqual(r.order.map((o) => o.boat), [3, 1, 4, 2, 5, 6]);
  assert.equal(r.order[0].rank, 1);
  assert.equal(r.trifecta.combo, '3-1-4');
  assert.equal(r.trifecta.payout, 12340);
  assert.equal(r.trifecta.popularity, 35);
  assert.equal(r.kimarite, 'まくり');
});

test('結果: 未発表と中止', () => {
  assert.equal(parseResult('<html><body>データがありません</body></html>').ready, false);
  const c = parseResult(resultHtml({ canceled: true }));
  assert.equal(c.canceled, true);
});
