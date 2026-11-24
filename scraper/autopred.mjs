// 全レース自動記録: 取得のたびに、締切前のレースの予想を計算して記録する。
// 締切を過ぎたら記録は書き換えない(後出しをしない)。最後に記録されたものが「締切直前の予想」になる。
import { predictRace, selectBets, ALL_COMBOS } from '../app/js/predict.js';
import { deadlineMs } from '../app/js/time.js';

const MODES = ['A', 'B', 'C'];

export function recordAutoPredictions(vdoc, date, nowMs) {
  let changed = false;
  for (const race of Object.values(vdoc.races || {})) {
    const dl = deadlineMs(date, race.deadline);
    if (dl == null || nowMs >= dl) continue;
    if (race.racelist?.status !== 'ok') continue;
    const stamp = JSON.stringify([race.racelist?.fetchedAt, race.before?.fetchedAt, race.odds?.fetchedAt]);
    if (race.auto?.stamp === stamp) continue;
    const pred = predictRace(race);
    if (!pred.ok) continue;
    const odds = race.odds?.status === 'ok' ? race.odds.data.odds : null;
    const bets = {};
    for (const m of MODES) for (const [k, ex] of [['on', true], ['off', false]]) {
      const r = selectBets(pred, odds, { mode: m, excludeBoat1First: ex });
      bets[`${m}_${k}`] = r.available ? r.bets.map((b) => b.combo) : null;
    }
    race.auto = {
      savedAt: new Date(nowMs).toISOString(), stamp, modelVersion: pred.modelVersion,
      reflect: { exhibition: pred.reflect.exhibition, course: pred.reflect.course, odds: pred.reflect.odds },
      probs: ALL_COMBOS.map((c) => Math.round(pred.probs[c] * 1e6) / 1e6),
      winProb: pred.winProb, bets,
    };
    changed = true;
  }
  return changed;
}

/** 1日分の自動記録と結果をまとめた軽いファイル(成績画面用) */
export function buildAutolog(date, venueDocs) {
  const rows = [];
  for (const [jcd, v] of Object.entries(venueDocs || {})) {
    for (const r of Object.values(v.races || {})) {
      if (!r.auto) continue;
      const res = r.result?.status === 'ok' ? r.result : null;
      const tri = res?.data?.trifecta;
      const idx = tri ? ALL_COMBOS.indexOf(tri.combo) : -1;
      rows.push({
        jcd, rno: r.rno, deadline: r.deadline, savedAt: r.auto.savedAt, reflect: r.auto.reflect, bets: r.auto.bets,
        result: res ? { canceled: !!res.canceled, combo: tri?.combo ?? null, payout: tri?.payout ?? null, refunds: res.data?.refunds || [] } : null,
        pActual: idx >= 0 ? r.auto.probs[idx] : null,
        rankActual: idx >= 0 ? [...r.auto.probs].sort((a, b) => b - a).indexOf(r.auto.probs[idx]) + 1 : null,
      });
    }
  }
  rows.sort((a, b) => a.jcd.localeCompare(b.jcd) || a.rno - b.rno);
  return { date, updatedAt: new Date().toISOString(), rows };
}
