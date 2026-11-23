import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsFor } from '../scraper/robots.mjs';

test('Disallow された場所は取得しない', () => {
  const r = robotsFor(parseRobots('User-agent: *\nDisallow: /owpc/pc/extra/\nAllow: /owpc/pc/extra/ok\n'), 'BOAT-LINE-personal');
  assert.equal(r.allowed('/owpc/pc/race/racelist?rno=1'), true);
  assert.equal(r.allowed('/owpc/pc/extra/x'), false);
  assert.equal(r.allowed('/owpc/pc/extra/ok'), true);
});
test('全体禁止', () => {
  const r = robotsFor(parseRobots('User-agent: *\nDisallow: /\n'), 'BOAT-LINE-personal');
  assert.equal(r.allowed('/owpc/pc/race/index'), false);
});
test('空の Disallow は全部許可、Crawl-delay を読む', () => {
  const r = robotsFor(parseRobots('User-agent: *\nDisallow:\nCrawl-delay: 5\n'), 'x');
  assert.equal(r.allowed('/a'), true);
  assert.equal(r.crawlDelay, 5);
});
test('専用の指定があればそちらを使う', () => {
  const r = robotsFor(parseRobots('User-agent: *\nDisallow:\n\nUser-agent: BOAT-LINE-personal\nDisallow: /owpc/\n'), 'BOAT-LINE-personal');
  assert.equal(r.allowed('/owpc/pc/race/index'), false);
});
test('ワイルドカード', () => {
  const r = robotsFor(parseRobots('User-agent: *\nDisallow: /*?print=\n'), 'x');
  assert.equal(r.allowed('/a?print=1'), false);
  assert.equal(r.allowed('/a?x=1'), true);
});
