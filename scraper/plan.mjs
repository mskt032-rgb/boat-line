// 「今回の実行で何を取得するか」を決める。通信はしない(テストしやすい純粋な関数)。
import { deadlineMs } from '../app/js/time.js';

export const RULES = {
  indexRefreshMin: 120,     // 開催場一覧は2時間に1回まで見直す
  preWindowMin: 25,         // 締切25分前から直前情報・オッズを取得
  preAfterMin: 0,           // 締切後は直前情報・オッズを取らない(締切時点の予想を書き換えないため)
  preRefetchMin: 8,         // 同じレースの直前情報・オッズは8分以上あけて取り直す
  resultDelayMin: 6,        // 締切6分後から結果を取りにいく(反映を早めるため)
  resultMaxAttempts: 8,     // 結果の取得を試す回数の上限
  resultGiveUpHours: 18,    // 締切から18時間を過ぎたら結果取得をあきらめる
  racelistPastMin: 10,      // 締切を10分以上過ぎたレースの出走表は「あとから取得」に回す(参考の予想用)
  pastListHours: 30,        // あとから取得するのは締切から30時間以内(今日・昨日)まで
  pastListRetryMin: 30,     // あとから取得が失敗したら30分あける
};

const minutes = (ms) => ms / 60000;
const olderThan = (iso, now, min) => !iso || now - Date.parse(iso) >= min * 60000;

export function needIndex(day, now) {
  if (!day || !day.index || day.index.status !== 'ok') {
    // 失敗した直後は10分あける
    return !day?.index?.attemptedAt || olderThan(day.index.attemptedAt, now, 10);
  }
  return olderThan(day.index.fetchedAt, now, RULES.indexRefreshMin);
}

/**
 * @param {{date:string, venues:Object<string,object>}[]} days  対象日(今日・昨日)ごとの場データ
 * @returns 優先順に並んだ取得作業の一覧
 */
export function planTasks(days, now) {
  const pre = [], lists = [], results = [], firsts = [], pastLists = [];
  for (const { date, venues } of days) {
    for (const [jcd, v] of Object.entries(venues)) {
      const races = v.races || {};
      const knowDeadlines = Object.values(races).some((r) => r.deadline);
      if (!knowDeadlines) {
        if (!races[1]?.racelist?.attemptedAt || olderThan(races[1].racelist.attemptedAt, now, 10)) firsts.push({ type: 'racelist', date, jcd, rno: 1, at: 0 });
        continue;
      }
      for (let rno = 1; rno <= 12; rno++) {
        const r = races[rno];
        if (!r) continue;
        const dl = deadlineMs(date, r.deadline);
        if (dl == null) continue;
        const toDl = minutes(dl - now);
        if (r.racelist?.status !== 'ok' && toDl > -RULES.racelistPastMin && olderThan(r.racelist?.attemptedAt, now, 10)) {
          lists.push({ type: 'racelist', date, jcd, rno, at: dl });
        } else if (r.racelist?.status !== 'ok' && r.racelist?.status !== 'empty' && toDl <= -RULES.racelistPastMin
          && toDl >= -RULES.pastListHours * 60 && olderThan(r.racelist?.attemptedAt, now, RULES.pastListRetryMin)) {
          pastLists.push({ type: 'racelist', date, jcd, rno, at: dl });
        }
        if (toDl <= RULES.preWindowMin && toDl > -RULES.preAfterMin && !v.canceled) {
          if (olderThan(r.before?.attemptedAt, now, RULES.preRefetchMin)) pre.push({ type: 'beforeinfo', date, jcd, rno, at: dl });
          if (olderThan(r.odds?.attemptedAt, now, RULES.preRefetchMin)) pre.push({ type: 'odds3t', date, jcd, rno, at: dl });
        }
        if (toDl <= -RULES.resultDelayMin && toDl >= -RULES.resultGiveUpHours * 60 && !r.result?.ready && !r.result?.canceled
          && (r.result?.attempts || 0) < RULES.resultMaxAttempts && olderThan(r.result?.attemptedAt, now, 9)) {
          results.push({ type: 'raceresult', date, jcd, rno, at: dl });
        }
      }
    }
  }
  const byAt = (a, b) => a.at - b.at;
  // 締切が近いものを最優先 → 各場の最初の出走表 → 90分以内の出走表 → 結果 → 残りの出走表 → 終わったレースの出走表(参考用)
  lists.sort(byAt);
  const soon = lists.filter((t) => t.at - now <= 90 * 60000);
  const later = lists.filter((t) => t.at - now > 90 * 60000);
  return [...pre.sort(byAt), ...firsts, ...soon, ...results.sort(byAt), ...later, ...pastLists.sort(byAt)];
}
