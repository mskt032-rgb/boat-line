// 保存した予想と確定結果の照合、的中率・回収率・確率の当たり具合
import { ALL_COMBOS } from './predict.js';

const BUCKETS = [[0, 0.01], [0.01, 0.03], [0.03, 0.06], [0.06, 0.1], [0.1, 0.2], [0.2, 1.01]];

/** 締切前に保存された最後の版(=その予想の最終版)を選ぶ */
export function finalVersion(versions, deadlineMs) {
  const before = versions.filter((v) => deadlineMs == null || Date.parse(v.savedAt) <= deadlineMs);
  return before.sort((a, b) => a.version - b.version).at(-1) || null;
}

/** 1件の照合 */
export function judge(rec, result) {
  if (!result || result.status !== 'ok') return { state: 'waiting' };
  if (result.canceled) return { state: 'void', note: 'レース中止' };
  const tri = result.data?.trifecta;
  if (!tri?.combo) return { state: 'waiting' };
  const refunded = (result.data.refunds || []);
  const bets = rec.bets || [];
  const hit = bets.find((b) => b.combo === tri.combo);
  const actualIdx = ALL_COMBOS.indexOf(tri.combo);
  const pActual = actualIdx >= 0 ? rec.probs?.[actualIdx] ?? null : null;
  const stake = bets.length * 100;
  const refundStake = bets.filter((b) => b.combo.split('-').some((n) => refunded.includes(+n))).length * 100;
  return {
    state: 'done',
    combo: tri.combo,
    payout: tri.payout,
    hit: !!hit,
    stake,
    ret: (hit && tri.payout ? tri.payout : 0) + refundStake,
    pActual,
    rankActual: pActual != null ? [...rec.probs].sort((a, b) => b - a).indexOf(pActual) + 1 : null,
  };
}

/** 集計 */
export function summarize(items) {
  // items: [{rec, j}] (j = judge の結果)
  const done = items.filter((x) => x.j.state === 'done');
  const withBets = done.filter((x) => x.rec.bets?.length);
  const hits = withBets.filter((x) => x.j.hit);
  const stake = withBets.reduce((a, x) => a + x.j.stake, 0);
  const ret = withBets.reduce((a, x) => a + x.j.ret, 0);
  const ll = done.filter((x) => x.j.pActual > 0);
  const logLoss = ll.length ? ll.reduce((a, x) => a - Math.log(x.j.pActual), 0) / ll.length : null;
  // 確率の当たり具合: 予想確率の帯ごとに、実際に出た割合を比べる(全120通りを使う)
  const buckets = BUCKETS.map(([lo, hi]) => ({ lo, hi, n: 0, pSum: 0, hits: 0 }));
  for (const x of done) {
    (x.rec.probs || []).forEach((p, i) => {
      const b = buckets.find((bk) => p >= bk.lo && p < bk.hi);
      if (!b) return;
      b.n++; b.pSum += p; if (ALL_COMBOS[i] === x.j.combo) b.hits++;
    });
  }
  // 1着予想の当たり具合
  const winTop = done.filter((x) => x.rec.winProb).map((x) => {
    const top = Object.entries(x.rec.winProb).sort((a, b) => b[1] - a[1])[0];
    return { p: top[1], hit: x.j.combo?.startsWith(`${top[0]}-`) };
  });
  return {
    races: done.length,
    betRaces: withBets.length,
    hits: hits.length,
    hitRate: withBets.length ? hits.length / withBets.length : null,
    stake, ret,
    recovery: stake ? ret / stake : null,
    logLoss, uniformLogLoss: Math.log(120),
    avgRankActual: done.length ? done.reduce((a, x) => a + (x.j.rankActual || 0), 0) / done.length : null,
    buckets: buckets.map((b) => ({ ...b, avgP: b.n ? b.pSum / b.n : null, rate: b.n ? b.hits / b.n : null })),
    winTop: { n: winTop.length, avgP: winTop.length ? winTop.reduce((a, x) => a + x.p, 0) / winTop.length : null, rate: winTop.length ? winTop.filter((x) => x.hit).length / winTop.length : null },
    waiting: items.filter((x) => x.j.state === 'waiting').length,
    void: items.filter((x) => x.j.state === 'void').length,
  };
}
