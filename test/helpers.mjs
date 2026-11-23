// テスト用の架空レース
export function makeRace({ nat = [7.0, 5.8, 6.2, 5.1, 4.9, 4.2], withBefore = false, order = [1, 2, 3, 4, 5, 6], sts, ex, odds = null, locZero = [] } = {}) {
  const entries = [1, 2, 3, 4, 5, 6].map((n, i) => ({
    boat: n, name: `選手${n}`, cls: ['A1', 'A2', 'B1', 'A1', 'B1', 'B2'][i], natWin: nat[i], locWin: locZero.includes(n) ? 0 : 6,
    motor2: 30 + n * 2, boat2: 35, avgST: 0.14 + i * 0.01, F: i === 3 ? 1 : 0, L: 0,
  }));
  const race = { rno: 1, deadline: '10:30', racelist: { status: 'ok', fetchedAt: '2026-11-23T00:00:00Z', data: { entries } } };
  if (withBefore) {
    const s = sts || [0.1, 0.12, 0.11, 0.08, 0.15, 0.2];
    race.before = { status: 'ok', fetchedAt: '2026-11-23T01:10:00Z', data: {
      boats: [1, 2, 3, 4, 5, 6].map((n, i) => ({ boat: n, exTime: (ex || [6.72, 6.8, 6.75, 6.7, 6.85, 6.9])[i] })),
      start: order.map((b, i) => ({ course: i + 1, boat: b, st: s[i], flying: false })),
      weather: { windSpeed: 3, waveHeight: 2 },
    } };
  }
  if (odds) race.odds = { status: 'ok', fetchedAt: '2026-11-23T01:12:00Z', data: { odds } };
  return race;
}
export function flatOdds(v = 50) {
  const o = {};
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) if (a !== b && b !== c && a !== c) o[`${a}-${b}-${c}`] = v;
  return o;
}
