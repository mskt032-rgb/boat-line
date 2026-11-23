// BOAT LINE 予想エンジン(ブラウザ内で計算。通信なし)
// 1) 各艇の評価(能力・モーター・展示・ST)を、取得できた値だけで比べる(未取得は推測で埋めない)
// 2) 進入後のコース並びから「逃げ・差し・まくり・まくり差し・抜きほか」の展開確率を出す
// 3) 展開ごとに2着・3着の出やすさを掛け合わせ、3連単120通りの確率(合計100%)を出す

export const MODEL_VERSION = '1.1';

/** 全120通り(1着→2着→3着の昇順) */
export const ALL_COMBOS = (() => {
  const out = [];
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) if (a !== b && b !== c && a !== c) out.push(`${a}-${b}-${c}`);
  return out;
})();

// コース別の1着率の目安(全国の長期傾向をもとにした事前値)
const COURSE_WIN_PRIOR = [0.55, 0.145, 0.12, 0.105, 0.055, 0.025];
// コース別の決まり手の内訳の目安
const KIMARITE_SPLIT = {
  1: { 逃げ: 0.96, 抜き: 0.04 },
  2: { 差し: 0.62, まくり: 0.26, 抜き: 0.12 },
  3: { まくり: 0.42, まくり差し: 0.40, 差し: 0.06, 抜き: 0.12 },
  4: { まくり: 0.42, まくり差し: 0.28, 差し: 0.18, 抜き: 0.12 },
  5: { まくり差し: 0.48, まくり: 0.28, 差し: 0.10, 抜き: 0.14 },
  6: { まくり差し: 0.42, まくり: 0.33, 差し: 0.05, 抜き: 0.20 },
};
export const KIMARITE_ORDER = ['逃げ', '差し', 'まくり', 'まくり差し', '抜き'];

// 評価項目: key, 名前, 区分, 重み, 大きいほど良いか, ばらつきの下限
const FACTORS = [
  { key: 'natWin', label: '全国勝率', group: '能力', w: 1.0, better: 'high', floor: 0.5 },
  { key: 'locWin', label: '当地勝率', group: '能力', w: 0.25, better: 'high', floor: 0.6 },
  { key: 'clsPt', label: '級別', group: '能力', w: 0.25, better: 'high', floor: 0.4 },
  { key: 'motor2', label: 'モーター2連率', group: 'モーター', w: 0.4, better: 'high', floor: 6 },
  { key: 'boat2', label: 'ボート2連率', group: 'モーター', w: 0.1, better: 'high', floor: 6 },
  { key: 'exTime', label: '展示タイム', group: '展示', w: 0.45, better: 'low', floor: 0.04 },
  { key: 'avgST', label: '平均ST', group: 'ST', w: 0.35, better: 'low', floor: 0.02 },
  { key: 'exST', label: '展示ST', group: 'ST', w: 0.2, better: 'low', floor: 0.04 },
  { key: 'fPenalty', label: 'フライング持ち', group: 'ST', w: 0.3, better: 'high', floor: 0.5 },
];
const CLASS_PT = { A1: 1, A2: 0.5, B1: 0, B2: -0.6 };

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** 取得済みデータから各艇の素の値を集める(取れていない値は null) */
export function collectInputs(race) {
  const entries = race?.racelist?.data?.entries || [];
  const before = race?.before?.status === 'ok' ? race.before.data : null;
  const exByBoat = Object.fromEntries((before?.boats || []).map((b) => [b.boat, b]));
  const stByBoat = Object.fromEntries((before?.start || []).map((s) => [s.boat, s]));
  const boats = [];
  for (let n = 1; n <= 6; n++) {
    const e = entries.find((x) => x.boat === n);
    const ex = exByBoat[n];
    const st = stByBoat[n];
    boats.push({
      boat: n,
      present: !!e && !e.absent,
      name: e?.name ?? null,
      cls: e?.cls ?? null,
      natWin: isNum(e?.natWin) && e.natWin > 0 ? e.natWin : null,
      locWin: isNum(e?.locWin) && e.locWin > 0 ? e.locWin : null, // 0.00 は「当地の走歴なし」なので不採用
      clsPt: e?.cls in CLASS_PT ? CLASS_PT[e.cls] : null,
      motor2: isNum(e?.motor2) && e.motor2 > 0 ? e.motor2 : null,
      boat2: isNum(e?.boat2) && e.boat2 > 0 ? e.boat2 : null,
      exTime: isNum(ex?.exTime) ? ex.exTime : null,
      avgST: isNum(e?.avgST) && e.avgST > 0 ? e.avgST : null,
      exST: isNum(st?.st) ? Math.max(st.st, 0) : null, // 展示のフライングは「速すぎ」ではなく0.00として扱う
      fPenalty: isNum(e?.F) ? -e.F : null,
      F: e?.F ?? null,
      course: st?.course ?? null,
    });
  }
  return { boats, hasEntries: entries.length > 0, hasBefore: !!before, weather: before?.weather || null };
}

function zScores(boats, f) {
  const vals = boats.filter((b) => b.present && isNum(b[f.key])).map((b) => b[f.key]);
  const out = {};
  if (vals.length < 2) return out; // 比べる相手がいないと評価しない
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const s = Math.max(sd, f.floor);
  for (const b of boats) {
    if (!b.present || !isNum(b[f.key])) continue;
    let z = (b[f.key] - mean) / s;
    if (f.better === 'low') z = -z;
    out[b.boat] = Math.max(-2.5, Math.min(2.5, z));
  }
  return out;
}

/** 各艇の総合評価 S と内訳 */
export function evaluateBoats(inputs) {
  const { boats } = inputs;
  const used = [], missing = [];
  const contrib = Object.fromEntries(boats.map((b) => [b.boat, []]));
  for (const f of FACTORS) {
    const z = zScores(boats, f);
    const got = Object.keys(z).length;
    const lacking = boats.filter((b) => b.present && !isNum(b[f.key])).map((b) => b.boat);
    if (!got) { missing.push({ factor: f.label, group: f.group, boats: lacking }); continue; }
    used.push({ factor: f.label, group: f.group, missingBoats: lacking });
    for (const [boat, v] of Object.entries(z)) contrib[boat].push({ factor: f.label, group: f.group, value: f.w * v });
  }
  // 使えた項目の重みの合計で割り、項目数によって評価の幅が変わらないようにする
  const wSum = FACTORS.filter((f) => used.some((u) => u.factor === f.label)).reduce((a, f) => a + f.w, 0) || 1;
  for (const k of Object.keys(contrib)) contrib[k] = contrib[k].map((p) => ({ ...p, value: p.value / wSum * 2 }));
  const evals = boats.map((b) => {
    const parts = contrib[b.boat];
    const score = parts.reduce((a, p) => a + p.value, 0);
    const byGroup = {};
    for (const p of parts) byGroup[p.group] = (byGroup[p.group] || 0) + p.value;
    return { ...b, score, parts, byGroup };
  });
  return { evals, used, missing };
}

function stOf(e) { return isNum(e?.exST) ? e.exST : isNum(e?.avgST) ? e.avgST : null; }

/**
 * 予想の本体。race は公式データを整理した JSON(1レース分)。
 * 返り値: probs(120通り), winProb(艇別1着率), scenarios(展開確率), evals(艇別評価), notes(反映状況)
 */
export function predictRace(race, opts = {}) {
  const inputs = collectInputs(race);
  const notes = [];
  if (!inputs.hasEntries) return { ok: false, reason: '出走表がまだ取得できていないため、予想できません。', inputs };
  const { evals, used, missing } = evaluateBoats(inputs);
  const present = evals.filter((e) => e.present);
  if (present.length < 3) return { ok: false, reason: '出走する艇が3艇未満のため予想できません。', inputs };

  // 進入(コース)。展示の進入が取れていればそれを使い、無ければ枠なり(1号艇=1コース…)と仮定する
  let courseSource = 'exhibition';
  const courseOf = {};
  if (present.every((e) => isNum(e.course))) present.forEach((e) => { courseOf[e.boat] = e.course; });
  else {
    courseSource = 'assumed';
    const sorted = [...present].sort((a, b) => a.boat - b.boat);
    sorted.forEach((e, i) => { courseOf[e.boat] = i + 1; });
    notes.push('展示の進入コースが未取得のため、進入は「枠なり(1号艇が1コース…)」と仮定して計算しています。');
  }
  const byCourse = {};
  for (const e of present) byCourse[courseOf[e.boat]] = e;

  // 気象: 風速・波高だけ小さく反映(風向きは場ごとに意味が違うため反映しない)
  let roughness = 0;
  const w = inputs.weather;
  if (w && isNum(w.windSpeed) && w.windSpeed >= 5) roughness += (w.windSpeed - 4) * 0.06;
  if (w && isNum(w.waveHeight) && w.waveHeight >= 8) roughness += (w.waveHeight - 7) * 0.02;
  roughness = Math.min(roughness, 0.5);

  const beta = opts.beta ?? 0.45;
  const scen = [];
  for (const e of present) {
    const c = courseOf[e.boat];
    const prior = COURSE_WIN_PRIOR[c - 1] ?? 0.02;
    const split = KIMARITE_SPLIT[c] || KIMARITE_SPLIT[6];
    const myST = stOf(e);
    const inner = byCourse[c - 1];
    const innerST = stOf(inner);
    const d = isNum(myST) && isNum(innerST) ? innerST - myST : 0; // 内側の艇よりどれだけ早いか(秒)
    for (const [kim, share] of Object.entries(split)) {
      let adj = beta * e.score;
      if (kim === '逃げ') {
        const others = [byCourse[2], byCourse[3]].map(stOf).filter(isNum);
        if (isNum(myST) && others.length) adj += 4 * (others.reduce((a, b) => a + b, 0) / others.length - myST);
        adj -= roughness;
      } else if (kim === 'まくり') adj += 6 * d + roughness * 0.5;
      else if (kim === 'まくり差し') adj += 3 * d + roughness * 0.3;
      else if (kim === '差し') adj += -0.3 * (byCourse[1]?.score ?? 0) + roughness * 0.3;
      scen.push({ boat: e.boat, course: c, kimarite: kim, weight: prior * share * Math.exp(adj) });
    }
  }
  const totalW = scen.reduce((a, s) => a + s.weight, 0);
  scen.forEach((s) => { s.p = s.weight / totalW; });

  // 展開ごとの2着・3着の出やすさ(コース関係の目安 × 艇の評価)
  const alpha2 = opts.alpha2 ?? 0.4, alpha3 = opts.alpha3 ?? 0.3;
  const aff = (s, cj) => {
    const cw = s.course;
    switch (s.kimarite) {
      case '逃げ': return [0, 0, 1.0, 0.85, 0.7, 0.5, 0.35][cj];
      case '差し': return cj === 1 ? 1.0 : cj < cw ? 0.6 : Math.max(0.3, 0.85 - 0.15 * (cj - cw - 1));
      case 'まくり': return cj < cw ? (cj === 1 ? 0.45 : 0.35) : cj === cw + 1 ? 1.0 : cj === cw + 2 ? 0.7 : 0.5;
      case 'まくり差し': return cj === 1 ? 0.8 : cj === cw - 1 ? 0.4 : cj < cw ? 0.55 : cj === cw + 1 ? 0.8 : 0.55;
      default: return 1 / (1 + 0.18 * cj);
    }
  };
  const probs = Object.fromEntries(ALL_COMBOS.map((k) => [k, 0]));
  for (const s of scen) {
    const rest = present.filter((e) => e.boat !== s.boat);
    const w2 = rest.map((e) => aff(s, courseOf[e.boat]) * Math.exp(alpha2 * e.score));
    const sum2 = w2.reduce((a, b) => a + b, 0);
    rest.forEach((e2, i) => {
      const p2 = w2[i] / sum2;
      const rest3 = rest.filter((x) => x.boat !== e2.boat);
      const w3 = rest3.map((e) => Math.sqrt(aff(s, courseOf[e.boat])) * Math.exp(alpha3 * e.score));
      const sum3 = w3.reduce((a, b) => a + b, 0);
      rest3.forEach((e3, k) => { probs[`${s.boat}-${e2.boat}-${e3.boat}`] += s.p * p2 * (w3[k] / sum3); });
    });
  }
  // 丸め誤差を除いて合計を1にそろえる
  const tot = Object.values(probs).reduce((a, b) => a + b, 0);
  for (const k of ALL_COMBOS) probs[k] /= tot;

  const winProb = {};
  for (let n = 1; n <= 6; n++) winProb[n] = 0;
  for (const s of scen) winProb[s.boat] += s.p;
  const scenarios = {};
  for (const k of KIMARITE_ORDER) scenarios[k] = 0;
  for (const s of scen) scenarios[s.kimarite] += s.p;
  const topScenarios = [...scen].sort((a, b) => b.p - a.p).slice(0, 6).map(({ boat, course, kimarite, p }) => ({ boat, course, kimarite, p }));

  // 反映状況の説明
  const reflect = {
    racelist: true,
    exhibition: inputs.hasBefore && used.some((u) => u.factor === '展示タイム'),
    exST: used.some((u) => u.factor === '展示ST'),
    course: courseSource === 'exhibition',
    weather: !!(w && (isNum(w.windSpeed) || isNum(w.waveHeight))),
    odds: race?.odds?.status === 'ok',
  };
  for (const m of missing) notes.push(`「${m.factor}」は値が取れていないため予想に入れていません。`);
  for (const u of used) if (u.missingBoats.length) notes.push(`「${u.factor}」は${u.missingBoats.join('・')}号艇の値が無いため、その艇には反映していません。`);
  if (reflect.weather) notes.push('気象は風速・波高のみ小さく反映しています(風向きは反映していません)。');
  if (race?.racelist?.data?.fixedEntry) notes.push('このレースは進入固定です。');

  return { ok: true, modelVersion: MODEL_VERSION, probs, winProb, scenarios, topScenarios, evals, used, missing, courseOf, courseSource, reflect, notes };
}

/** 確率の高い順の並び */
export function rankCombos(probs) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1]);
}

export const MODES = {
  A: { label: '的中重視', desc: '当たる確率が高い順に選びます' },
  B: { label: '回収率重視', desc: '推定確率×オッズ(期待値)が高い順に選びます' },
  C: { label: '穴狙い', desc: 'オッズ20倍以上の中から期待値が高い順に選びます' },
};

/**
 * 買い目を選ぶ(最大12点)。
 * @param pred predictRace の結果
 * @param odds {"1-2-3": 12.3, ...} または null
 * @param opt {mode:'A'|'B'|'C', excludeBoat1First:boolean, maxPoints:number}
 */
export function selectBets(pred, odds, opt = {}) {
  const mode = opt.mode || 'A';
  const maxPoints = Math.min(12, Math.max(1, opt.maxPoints || 12));
  const exclude1 = opt.excludeBoat1First !== false;
  const warnings = [];
  if (!pred?.ok) return { bets: [], warnings: [pred?.reason || '予想できません'], available: false };
  const p1 = pred.winProb[1] || 0;
  if (exclude1 && p1 >= 0.45) warnings.push(`1号艇の逃げが有力です(1号艇の1着 推定${(p1 * 100).toFixed(0)}%)。いまは1号艇1着を買い目から外しているので、外れやすくなっています。`);
  let cands = rankCombos(pred.probs).map(([combo, p]) => ({ combo, p, odds: odds?.[combo] ?? null }));
  if (exclude1) cands = cands.filter((c) => !c.combo.startsWith('1-'));
  cands = cands.filter((c) => c.p > 0);
  cands.forEach((c) => { c.ev = c.odds != null ? c.p * c.odds : null; });
  let bets = [];
  const hasOdds = !!odds && Object.values(odds).some((v) => v != null);
  if (mode === 'A') {
    let cum = 0;
    for (const c of cands) { if (bets.length >= maxPoints || cum >= 0.5) break; bets.push(c); cum += c.p; }
  } else {
    if (!hasOdds) return { bets: [], warnings: [...warnings, 'オッズがまだ取得できていないため、このモードは計算できません。オッズは締切の約25分前から取得します。'], available: false };
    let pool = cands.filter((c) => c.odds != null && c.p >= 0.003);
    if (mode === 'C') pool = pool.filter((c) => c.odds >= 20);
    pool.sort((a, b) => b.ev - a.ev);
    const good = pool.filter((c) => c.ev >= 1.0);
    if (good.length) bets = good.slice(0, maxPoints);
    else {
      bets = pool.slice(0, Math.min(5, maxPoints));
      if (bets.length) warnings.push('期待値が1倍(回収率100%)を超える見込みの買い目がありません。参考として期待値の高い順に表示しています。');
    }
    if (!bets.length) warnings.push('条件に合う買い目がありません。');
  }
  const hitProb = bets.reduce((a, b) => a + b.p, 0);
  const evSum = bets.every((b) => b.ev != null) && bets.length ? bets.reduce((a, b) => a + b.ev, 0) / bets.length : null;
  return { bets, warnings, available: true, hitProb, avgEv: evSum };
}
