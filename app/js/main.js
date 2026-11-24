// BOAT LINE 画面の組み立て
import { VENUES, VENUE_NAME } from './venues.js';
import { jstDate, deadlineMs, jstParts } from './time.js';
import { predictRace, selectBets, MODES, KIMARITE_ORDER, rankCombos, raceAtDeadline } from './predict.js';
import { getPrefs, setPrefs, predictionsFor, savePredictionVersion, makeRecord, allPredictions, exportBackup, importBackup } from './store.js';
import { finalVersion, judge, summarize, compareExclusion, summarizeAutolog } from './verify.js';

const app = document.getElementById('app');
const DATA = './data';
const cache = new Map();
let refreshTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (p, d = 1) => (p == null ? '—' : `${(p * 100).toFixed(d)}%`);
const fmtDate = (d) => `${+d.slice(4, 6)}月${+d.slice(6, 8)}日`;
const wd = (d) => '日月火水木金土'[new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay()];
function fmtTime(iso) {
  if (!iso) return '—';
  const p = jstParts(Date.parse(iso));
  return `${p.m}/${p.d} ${p.hh}:${String(p.mm).padStart(2, '0')}`;
}
const bn = (n, small) => `<span class="bn bn${n}${small ? ' small' : ''}">${n}</span>`;
const combo = (c, small) => `<span class="combo">${c.split('-').map((n) => bn(n, small)).join('<span class="dash">-</span>')}</span>`;
const NA = '<span class="na">未取得</span>';
const v = (x, digits) => (x == null ? NA : digits != null ? Number(x).toFixed(digits) : esc(x));

async function getJson(path, { fresh = false } = {}) {
  const hit = cache.get(path);
  if (hit && !fresh && Date.now() - hit.t < 60000) return hit.v;
  try {
    const res = await fetch(`${DATA}/${path}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const val = await res.json();
    cache.set(path, { t: Date.now(), v: val });
    return val;
  } catch {
    return hit ? hit.v : null;
  }
}

function tickClock() {
  const p = jstParts();
  document.getElementById('clock').textContent = `${p.m}/${p.d} ${p.hh}:${String(p.mm).padStart(2, '0')}`;
}
setInterval(tickClock, 15000); tickClock();

function setTab(name) {
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));
}
function autoRefresh(fn, sec = 120) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') fn(true); }, sec * 1000);
}

function statusChip(slot, label, rec) {
  if (!rec) return `<span class="chip">${label} 未取得</span>`;
  if (rec.status === 'ok') return `<span class="chip ok">${label}</span>`;
  if (rec.status === 'pending' || rec.status === 'empty') return `<span class="chip wait">${label} 未発表</span>`;
  if (rec.status === 'error') return `<span class="chip err">${label} 失敗</span>`;
  return `<span class="chip">${label}</span>`;
}

// ---------- ホーム(場の一覧) ----------
async function viewHome(date, fresh) {
  setTab('home');
  const idx = await getJson('index.json', { fresh });
  const today = jstDate();
  const dates = idx?.dates?.length ? idx.dates : [];
  date = date || (dates.includes(today) ? today : dates[0]) || today;
  const day = await getJson(`${date}/day.json`, { fresh });
  const datebar = dates.slice(0, 10).map((d) => `<a href="#/d/${d}" class="${d === date ? 'on' : ''}">${d === today ? '今日' : `${fmtDate(d)}(${wd(d)})`}</a>`).join('');
  if (!day) {
    app.innerHTML = `<div class="datebar">${datebar}</div>
      <div class="card"><h2>${fmtDate(date)}のデータがまだありません</h2>
      <p class="muted">開催情報は毎朝6時ごろから自動で取得します。しばらくしてから開き直してください。</p>
      ${idx ? `<p class="small muted">最終更新: ${fmtTime(idx.updatedAt)}</p>` : '<p class="small muted">データの置き場所にまだ何もありません(初回の取得前です)。</p>'}</div>`;
    return;
  }
  const venues = day.venues || VENUES.map((x) => ({ ...x, held: false }));
  const held = venues.filter((x) => x.held);
  const vdocs = await Promise.all(held.map((x) => getJson(`${date}/${x.jcd}.json`, { fresh })));
  const now = Date.now();
  const cards = venues.map((x) => {
    if (!x.held) return `<div class="venue off"><div class="name">${esc(x.name)}</div><div class="sub">非開催</div></div>`;
    const vd = vdocs[held.indexOf(x)];
    let next = '';
    if (vd?.races) {
      const upcoming = Object.values(vd.races).filter((r) => r.deadline && deadlineMs(date, r.deadline) > now).sort((a, b) => a.rno - b.rno)[0];
      next = upcoming ? `次 ${upcoming.rno}R 締切 ${upcoming.deadline}` : Object.keys(vd.races).length ? '本日のレース終了' : '';
    } else next = '出走表 取得待ち';
    return `<a class="venue" href="#/v/${date}/${x.jcd}"><div class="name">${esc(x.name)}</div>
      <div class="sub">${esc([(x.dayLabel || '').replace(/^.*?(初日|最終日|[1-9]日目)$/, '$1') || null, x.title].filter(Boolean).join(' '))}${x.note ? ` <b>${esc(x.note)}</b>` : ''}</div>
      <div class="next">${esc(next)}</div></a>`;
  }).join('');
  const ix = day.index || {};
  app.innerHTML = `<div class="datebar">${datebar}</div>
    <h1>${fmtDate(date)}(${wd(date)}) 開催 ${held.length}場</h1>
    ${ix.status === 'error' ? `<div class="note bad">開催場一覧の最新取得に失敗しました(${esc(ix.error)})。前回取得分を表示しています。</div>` : ''}
    <div class="grid">${cards}</div>
    <p class="small muted">開催情報の取得: ${fmtTime(ix.fetchedAt)} / 出典: <a href="${esc(ix.source || 'https://www.boatrace.jp/')}" rel="noopener" target="_blank">BOAT RACE公式サイト</a></p>`;
  autoRefresh((f) => viewHome(date, f), 300);
}

// ---------- 場(レース一覧) ----------
async function viewVenue(date, jcd, fresh) {
  setTab('home');
  const vd = await getJson(`${date}/${jcd}.json`, { fresh });
  const name = VENUE_NAME[jcd] || jcd;
  const head = `<a class="back" href="#/d/${date}">‹ 場の一覧</a><h1>${esc(name)} ${fmtDate(date)}</h1>`;
  if (!vd || !Object.keys(vd.races || {}).length) {
    app.innerHTML = `${head}<div class="card"><p>この場の出走表はまだ取得できていません。</p><p class="small muted">朝の自動取得で順に集めています。数分〜20分ほど待ってから開き直してください。</p></div>`;
    autoRefresh((f) => viewVenue(date, jcd, f));
    return;
  }
  const now = Date.now();
  const items = [];
  for (let r = 1; r <= 12; r++) {
    const race = vd.races[r];
    if (!race) continue;
    const dl = deadlineMs(date, race.deadline);
    const saved = predictionsFor(date, jcd, r);
    const res = race.result?.status === 'ok' && race.result.data?.trifecta ? race.result.data.trifecta.combo : null;
    let resultHtml = '';
    if (res) {
      const fv = finalVersion(saved, dl);
      const j = fv ? judge(fv, race.result) : null;
      resultHtml = `<span class="chip ${j?.hit ? 'ok' : ''}">結果 ${res}${j ? (j.hit ? ' 的中' : '') : ''}</span>`;
    }
    items.push(`<li><a href="#/r/${date}/${jcd}/${r}"><span class="rno">${r}R</span><span class="dl">${esc(race.deadline || '--:--')}</span>
      <span class="chips">${resultHtml || (dl && dl < now
        ? (race.result?.canceled ? '<span class="chip">中止</span>' : '<span class="chip wait">結果 取得待ち</span>')
        : [statusChip('racelist', '出走表', race.racelist), statusChip('before', '展示', race.before), statusChip('odds', 'オッズ', race.odds)].join(''))}
      ${saved.length ? '<span class="chip ok">予想保存</span>' : ''}</span></a></li>`);
  }
  app.innerHTML = `${head}<div class="card" style="padding:0 4px"><ul class="races">${items.join('')}</ul></div>
    <p class="small muted">更新: ${fmtTime(vd.updatedAt)}。開いている間は2分ごとに最新に更新します。</p>`;
  autoRefresh((f) => viewVenue(date, jcd, f));
}

// ---------- レース(予想) ----------
function statusLine(label, rec) {
  let st;
  if (!rec) st = '<span class="chip">未取得</span>';
  else if (rec.status === 'ok') st = `<span class="chip ok">取得 ${fmtTime(rec.fetchedAt)}</span>`;
  else if (rec.status === 'pending' || rec.status === 'empty') st = `<span class="chip wait">未発表(確認 ${fmtTime(rec.attemptedAt)})</span>`;
  else st = `<span class="chip err">失敗 ${fmtTime(rec.attemptedAt)}</span>`;
  const err = rec?.error ? `<div class="small neg">直近の取得で問題: ${esc(rec.error)}${rec.status === 'ok' ? '(前回の正しいデータを使用中)' : ''}</div>` : '';
  return `<div>${label}</div><div>${st}${err}</div>`;
}

function reflectText(on) { return on ? '<span class="pos">予想に反映</span>' : '<span class="muted">反映なし</span>'; }

async function viewRace(date, jcd, rno, fresh) {
  setTab('home');
  rno = +rno;
  const vd = await getJson(`${date}/${jcd}.json`, { fresh });
  const name = VENUE_NAME[jcd] || jcd;
  const race = vd?.races?.[rno];
  const prefs = getPrefs();
  const dl = deadlineMs(date, race?.deadline);
  const now = Date.now();
  const left = dl ? Math.round((dl - now) / 60000) : null;
  const prevLink = rno > 1 ? `<a href="#/r/${date}/${jcd}/${rno - 1}">‹ ${rno - 1}R</a>` : '<span></span>';
  const nextLink = rno < 12 ? `<a href="#/r/${date}/${jcd}/${rno + 1}">${rno + 1}R ›</a>` : '<span></span>';
  let html = `<div class="row between"><a class="back" href="#/v/${date}/${jcd}">‹ ${esc(name)}のレース一覧</a></div>
    <div class="row between"><h1 style="margin:0">${esc(name)} ${rno}R</h1><div class="row small">${prevLink}　${nextLink}</div></div>
    <p class="muted" style="margin:2px 0 10px">${fmtDate(date)} 締切 ${esc(race?.deadline || '未取得')}${left != null ? (left > 0 ? `(あと${left}分)` : '(締切済み)') : ''}
    ${race?.racelist?.data?.raceTitle ? ' / ' + esc(race.racelist.data.raceTitle) : ''}</p>`;
  if (!race) {
    app.innerHTML = html + '<div class="card">このレースのデータはまだありません。</div>';
    autoRefresh((f) => viewRace(date, jcd, rno, f));
    return;
  }
  // 締切後は締切時点のデータだけで計算する(締切後に予想を書き換えない)
  const closed = dl != null && now >= dl;
  const predRace = closed ? raceAtDeadline(race, dl) : race;
  const pred = predictRace(predRace);
  const odds = predRace.odds?.status === 'ok' ? predRace.odds.data.odds : null;
  const bets = selectBets(pred, odds, prefs);
  const result = race.result?.status === 'ok' ? race.result : null;
  const resCombo = result?.data?.trifecta?.combo;

  // 自動保存(締切前だけ。締切後は「後出し」になるので保存しない)
  let saveMsg = '';
  if (pred.ok && (dl == null || now < dl)) {
    const r = savePredictionVersion(makeRecord({ date, jcd, rno, deadline: race.deadline, pred, betsRes: bets, prefs, race }));
    saveMsg = r.error ? `<div class="note bad">${esc(r.error)}</div>` : `<p class="small muted">この予想は端末に自動保存しました(第${r.record.version}版 ${fmtTime(r.record.savedAt)})。データや設定が変わると新しい版として追加保存し、前の版は書き換えません。</p>`;
  } else if (pred.ok) saveMsg = '<p class="small muted">締切時点のデータで計算した予想です。締切後に取得したデータでは書き換えません。</p>';
  const lateData = pred.ok && dl && race.racelist?.fetchedAt && Date.parse(race.racelist.fetchedAt) >= dl;

  // 設定
  html += `<div class="card"><div class="seg" role="group" aria-label="モード">${Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}" class="${prefs.mode === k ? 'on' : ''}">${k} ${m.label}<small>${k === 'A' ? '当たりやすさ' : k === 'B' ? '確率×オッズ' : '高配当'}</small></button>`).join('')}</div>
    <label class="toggle"><span>1号艇1着なし<br><span class="small muted">オンにすると、1号艇が1着の買い目を除きます</span></span>
    <span class="switch"><input type="checkbox" id="ex1" ${prefs.excludeBoat1First ? 'checked' : ''}><span></span></span></label></div>`;

  html += gradedCard(date, jcd, rno, dl, race, now); // 締切後は成績に使った予想を先に出す
  // 買い目
  if (!pred.ok) {
    const past = dl && now >= dl && !race.racelist?.data;
    const msg = past ? 'このレースの出走表はまだ取得できていません。終わったレースの出走表は、締切前のレースの取得が済んだあとに順番に取りにいきます。取得できると、参考の予想が出ます。' : pred.reason;
    html += `<div class="card"><div class="note ${past ? 'info' : 'warn'}">${esc(msg)}</div></div>`;
  }
  else {
    const list = bets.bets.map((b, i) => `<li class="${resCombo === b.combo ? 'hit' : ''}"><span class="rank">${i + 1}</span>${combo(b.combo)}
      <span class="p"><b>${pct(b.p)}</b><br><span class="small muted">${b.odds != null ? `オッズ ${b.odds.toFixed(1)}` : 'オッズ未取得'}${b.ev != null ? ` / 期待値 ${b.ev.toFixed(2)}` : ''}</span></span></li>`).join('');
    html += `<div class="card"><h2>買い目(${MODES[prefs.mode].label}・${bets.bets.length}点)</h2>
      ${lateData ? `<div class="note bad">この予想は、締切後(${fmtTime(race.racelist.fetchedAt)})に取得した出走表で計算した<b>参考</b>です。レース前の予想ではないため、成績には入りません。</div>` : ''}
      ${bets.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      ${list ? `<ul class="bets">${list}</ul>` : ''}
      ${bets.bets.length ? `<p class="small muted">この買い目のどれかが当たる推定確率: <b>${pct(bets.hitProb)}</b>${bets.avgEv != null ? ` / 平均期待値 ${bets.avgEv.toFixed(2)}` : ''}(各100円の場合 合計${bets.bets.length * 100}円)</p>` : ''}
      ${resCombo ? `<div class="note ${bets.bets.some((b) => b.combo === resCombo) ? 'good' : 'info'}">結果 ${combo(resCombo, true)} ${race.result.data.trifecta.payout ? `払戻 ${race.result.data.trifecta.payout.toLocaleString()}円` : ''} ${bets.bets.some((b) => b.combo === resCombo) ? '— この買い目で的中' : ''}</div>` : ''}
      ${saveMsg}</div>`;

    // 展開
    const scenRows = KIMARITE_ORDER.map((k) => `<div>${k}</div><div class="bar"><i style="width:${(pred.scenarios[k] * 100).toFixed(1)}%"></i></div><div class="v">${pct(pred.scenarios[k])}</div>`).join('');
    const winRows = [1, 2, 3, 4, 5, 6].map((n) => `<div>${bn(n, true)}</div><div class="bar"><i style="width:${(pred.winProb[n] * 100).toFixed(1)}%"></i></div><div class="v">${pct(pred.winProb[n])}</div>`).join('');
    const top = pred.topScenarios.slice(0, 4).map((s) => `<li>${s.course}コースの${bn(s.boat, true)}号艇の「${s.kimarite}」… ${pct(s.p)}</li>`).join('');
    html += `<div class="card"><h2>展開の見通し</h2><div class="kv">${scenRows}</div>
      <h3>起こりやすい展開</h3><ul class="plain">${top}</ul>
      <h3>1着になる確率</h3><div class="kv">${winRows}</div>
      <p class="small muted">進入(コース): ${pred.courseSource === 'exhibition' ? '展示の進入どおり' : '枠なりと仮定'} — ${[1, 2, 3, 4, 5, 6].filter((n) => pred.courseOf[n]).sort((a, b) => pred.courseOf[a] - pred.courseOf[b]).map((n) => bn(n, true)).join(' ')}</p></div>`;

    // 根拠
    const groups = ['能力', 'モーター', '展示', 'ST'];
    const evalRows = pred.evals.filter((e) => e.present).map((e) => `<tr><td>${bn(e.boat, true)}</td><td class="l">${esc(e.name || '')}<br><span class="na">${esc(e.cls || '')}</span></td>
      ${groups.map((g) => { const x = e.byGroup[g]; return `<td class="${x > 0.15 ? 'pos' : x < -0.15 ? 'neg' : ''}">${x == null ? '<span class="na">—</span>' : (x > 0 ? '+' : '') + x.toFixed(2)}</td>`; }).join('')}
      <td><b>${(e.score > 0 ? '+' : '') + e.score.toFixed(2)}</b></td></tr>`).join('');
    const best = [...pred.evals].filter((e) => e.present).sort((a, b) => b.score - a.score);
    const reasons = [];
    if (best[0]) reasons.push(`総合評価が最も高いのは${best[0].boat}号艇(${esc(best[0].name || '')})です。`);
    for (const g of groups) {
      const top1 = [...pred.evals].filter((e) => e.byGroup[g] != null).sort((a, b) => b.byGroup[g] - a.byGroup[g])[0];
      if (top1 && top1.byGroup[g] > 0.2) reasons.push(`${g}の評価は${top1.boat}号艇が一番です。`);
    }
    for (const n of [5, 6]) { const e = pred.evals.find((x) => x.boat === n); if (e?.present) reasons.push(`${n}号艇: 1着 ${pct(pred.winProb[n])}、総合評価 ${(e.score > 0 ? '+' : '') + e.score.toFixed(2)}。`); }
    html += `<div class="card"><h2>予想の根拠</h2><ul class="plain">${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>艇</th><th class="l">選手</th><th>能力</th><th>モーター</th><th>展示</th><th>ST</th><th>合計</th></tr></thead><tbody>${evalRows}</tbody></table></div>
      <p class="small muted">数字は6艇の中での比較(0が平均、プラスが良い)。「—」は値が取れていないため評価に入れていない項目です。</p>
      <h3>データの反映状況</h3><ul class="plain">
        <li>出走表(能力・モーター・平均ST): ${reflectText(true)}</li>
        <li>展示タイム: ${reflectText(pred.reflect.exhibition)}</li>
        <li>スタート展示(ST・進入): ${reflectText(pred.reflect.exST)}${pred.reflect.course ? '' : '(進入は枠なり仮定)'}</li>
        <li>気象(風速・波高): ${reflectText(pred.reflect.weather)}</li>
        <li>3連単オッズ: ${pred.reflect.odds ? '<span class="pos">買い目選び(B・C)に使用</span>' : '<span class="muted">未取得のため不使用</span>'}(確率の計算そのものには使っていません)</li>
      </ul>${pred.notes.length ? `<h3>注意</h3><ul class="plain">${pred.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <details><summary>確率の高い組み合わせ 上位20</summary><ul class="bets">${rankCombos(pred.probs).slice(0, 20).map(([c, p], i) => `<li><span class="rank">${i + 1}</span>${combo(c, true)}<span class="p">${pct(p, 2)}${odds?.[c] ? ` <span class="small muted">/ ${odds[c].toFixed(1)}倍</span>` : ''}</span></li>`).join('')}</ul>
      <p class="small muted">120通りの確率の合計: ${pct(Object.values(pred.probs).reduce((a, b) => a + b, 0), 2)}</p></details></div>`;
  }

  // 取得状況
  html += `<div class="card"><h2>データの取得状況</h2><div class="kv" style="grid-template-columns:auto 1fr">
    ${[['出走表', race.racelist], ['直前情報(展示・気象)', race.before], ['3連単オッズ', race.odds], ['確定結果', race.result]].map(([l, r]) => statusLine(l, r)).join('')}</div>
    ${race.odds?.data?.oddsTime ? `<p class="small muted">オッズは公式の${esc(race.odds.data.oddsTime)}時点の値です。</p>` : ''}
    <p class="small muted">出典: BOAT RACE公式サイト。${[race.racelist, race.before, race.odds, race.result].filter((r) => r?.source).map((r) => `<a href="${esc(r.source)}" target="_blank" rel="noopener">${r === race.racelist ? '出走表' : r === race.before ? '直前情報' : r === race.odds ? 'オッズ' : '結果'}</a>`).join(' ・ ')}</p></div>`;

  html += detailTables(race);
  html += versionsCard(date, jcd, rno, dl, race);
  app.innerHTML = html;

  app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { setPrefs({ mode: b.dataset.mode }); viewRace(date, jcd, rno); }));
  app.querySelector('#ex1')?.addEventListener('change', (e) => { setPrefs({ excludeBoat1First: e.target.checked }); viewRace(date, jcd, rno); });
  autoRefresh((f) => viewRace(date, jcd, rno, f));
}

// 締切後: 成績に使った予想(締切前に記録したもの)の買い目と的中を出す
function gradedCard(date, jcd, rno, dl, race, now) {
  if (!dl || now < dl) return '';
  const res = race.result?.status === 'ok' ? race.result.data?.trifecta?.combo : null;
  const list = (combos) => combos?.length ? `<ul class="bets">${combos.map((c, i) => `<li class="${c === res ? 'hit' : ''}"><span class="rank">${i + 1}</span>${combo(c, true)}<span class="p">${c === res ? '<b class="pos">的中</b>' : ''}</span></li>`).join('')}</ul>` : '<p class="na">買い目なし</p>';
  const block = (title, note, on, off) => `<h3>${title}</h3><p class="small muted">${note}</p>
    <details ${on?.includes(res) ? 'open' : ''}><summary>1号艇1着なし(${on?.length ?? 0}点)${on?.includes(res) ? ' — 的中' : ''}</summary>${list(on)}</details>
    <details ${off?.includes(res) ? 'open' : ''}><summary>1号艇1着あり(${off?.length ?? 0}点)${off?.includes(res) ? ' — 的中' : ''}</summary>${list(off)}</details>`;
  let h = '';
  if (race.auto) h += block('全レース自動記録の予想(モードA)', `締切前 ${fmtTime(race.auto.savedAt)} に記録${race.auto.reflect?.exhibition ? '(展示入り)' : '(展示なし)'}`, race.auto.bets?.A_on, race.auto.bets?.A_off);
  const fv = finalVersion(predictionsFor(date, jcd, rno), dl);
  if (fv) { const c = compareExclusion(fv, race.result); h += block('この端末で保存した予想(モードA)', `第${fv.version}版・締切前 ${fmtTime(fv.savedAt)} に保存${fv.reflect?.exhibition ? '(展示入り)' : '(展示なし)'}`, c.on.bets.map((b) => b.combo), c.off.bets.map((b) => b.combo)); }
  if (!h) return '';
  return `<div class="card"><h2>成績に使った予想${res ? ` — 結果 ${combo(res, true)}` : ''}</h2>${h}
    <p class="small muted">成績には、ここに出ている締切前に記録した予想を使っています。</p></div>`;
}

function detailTables(race) {
  const ents = race.racelist?.data?.entries || [];
  let h = '';
  if (ents.length) {
    h += `<div class="card"><details open><summary>出走表</summary><div class="tbl-wrap"><table class="t"><thead><tr><th>艇</th><th class="l">選手</th><th>級</th><th>全国勝率</th><th>当地勝率</th><th>平均ST</th><th>F/L</th><th>モーター<br>No / 2連率</th><th>ボート<br>No / 2連率</th></tr></thead><tbody>
      ${ents.map((e) => `<tr><td>${bn(e.boat, true)}</td><td class="l">${esc(e.name || '')}${e.absent ? ' <b class="neg">欠場</b>' : ''}<br><span class="na">${esc(e.regNo || '')} ${esc(e.branch || '')} ${e.age ? e.age + '歳' : ''}</span></td>
      <td>${v(e.cls)}</td><td>${v(e.natWin, 2)}</td><td>${v(e.locWin, 2)}</td><td>${v(e.avgST, 2)}</td><td>${e.F != null ? 'F' + e.F : '—'} ${e.L != null ? 'L' + e.L : ''}</td>
      <td>${v(e.motorNo)} / ${v(e.motor2, 1)}</td><td>${v(e.boatNo)} / ${v(e.boat2, 1)}</td></tr>`).join('')}</tbody></table></div></details></div>`;
  }
  const b = race.before?.data;
  if (b) {
    const stMap = Object.fromEntries((b.start || []).map((s) => [s.boat, s]));
    const w = b.weather;
    h += `<div class="card"><details open><summary>直前情報</summary>
      ${race.before.status !== 'ok' ? '<p class="note warn">展示はまだ行われていないか、発表前です。</p>' : ''}
      <div class="tbl-wrap"><table class="t"><thead><tr><th>艇</th><th>展示タイム</th><th>チルト</th><th>体重</th><th>進入</th><th>展示ST</th><th>部品交換</th></tr></thead><tbody>
      ${(b.boats || []).map((x) => { const s = stMap[x.boat]; return `<tr><td>${bn(x.boat, true)}</td><td>${v(x.exTime, 2)}</td><td>${v(x.tilt, 1)}</td><td>${v(x.weight, 1)}</td><td>${s ? s.course : NA}</td><td>${s?.st != null ? (s.flying ? 'F' : '') + Math.abs(s.st).toFixed(2).replace(/^0/, '') : NA}</td><td class="small">${esc(x.parts || '')}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${w ? `<p class="small">天候 ${v(w.weather)} / 気温 ${v(w.temperature, 1)}℃ / 風速 ${v(w.windSpeed)}m / 水温 ${v(w.waterTemperature, 1)}℃ / 波高 ${v(w.waveHeight)}cm</p>` : '<p class="small muted">気象: 未取得</p>'}
      </details></div>`;
  }
  const r = race.result?.status === 'ok' ? race.result.data : null;
  if (r) {
    h += `<div class="card"><details open><summary>確定結果</summary>
      ${race.result.canceled ? '<div class="note warn">このレースは中止になりました。</div>' : ''}
      <div class="tbl-wrap"><table class="t"><thead><tr><th>着</th><th>艇</th><th class="l">選手</th><th>タイム</th></tr></thead><tbody>
      ${(r.order || []).map((o) => `<tr><td>${esc(o.rankText)}</td><td>${bn(o.boat, true)}</td><td class="l">${esc(o.name || '')}</td><td>${esc(o.time || '')}</td></tr>`).join('')}</tbody></table></div>
      ${r.trifecta ? `<p>3連単 ${combo(r.trifecta.combo, true)} 払戻 ${r.trifecta.payout?.toLocaleString() ?? '—'}円 ${r.trifecta.popularity ? `(${r.trifecta.popularity}番人気)` : ''}</p>` : ''}
      ${r.kimarite ? `<p class="small">決まり手: ${esc(r.kimarite)}</p>` : ''}</details></div>`;
  }
  return h;
}

function versionsCard(date, jcd, rno, dl, race) {
  const vs = predictionsFor(date, jcd, rno);
  if (!vs.length) return '';
  const fv = finalVersion(vs, dl);
  const rows = vs.slice().reverse().map((x) => {
    const j = judge(x, race.result);
    return `<tr><td>第${x.version}版${x === fv ? '<br><span class="na">最終</span>' : ''}</td><td>${fmtTime(x.savedAt)}</td><td>${x.mode} ${x.excludeBoat1First ? '<br><span class="na">1号艇1着なし</span>' : ''}</td>
      <td>${x.bets.length}点</td><td>${j.state === 'done' ? (j.hit ? `<b class="pos">的中 ${j.ret.toLocaleString()}円</b>` : '外れ') : j.state === 'void' ? '中止' : '結果待ち'}</td></tr>`;
  }).join('');
  return `<div class="card"><details><summary>保存した予想の版(${vs.length}件)</summary><div class="tbl-wrap"><table class="t"><thead><tr><th>版</th><th>保存時刻</th><th>モード</th><th>点数</th><th>照合</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small muted">成績の集計には、締切前に保存した最後の版(最終)を使います。</p></details></div>`;
}

// ---------- 成績 ----------
async function autoCard() {
  const idx = await getJson('index.json');
  const dates = (idx?.dates || []).slice(0, 45);
  const logs = (await Promise.all(dates.map((d) => getJson(`${d}/autolog.json`)))).filter(Boolean);
  const rows = logs.flatMap((l) => l.rows.map((r) => ({ ...r, date: l.date })));
  if (!rows.length) return '<div class="card"><h2>全レース自動記録</h2><p class="small muted">まだ記録がありません。締切前のレースから順に、自動で記録していきます。</p></div>';
  const line = (m) => {
    const on = summarizeAutolog(rows, `${m}_on`), off = summarizeAutolog(rows, `${m}_off`);
    const c = (x) => (x.races ? `<b>${pct(x.hitRate)}</b> <span class="na">${x.hits}/${x.races}</span><br>回収 <b>${pct(x.recovery, 0)}</b>` : '<span class="na">—</span>');
    return `<tr><td class="l">${m} ${MODES[m].label}</td><td>${c(on)}</td><td>${c(off)}</td></tr>`;
  };
  const a = summarizeAutolog(rows, 'A_off');
  const cell = (r, k) => { const b = r.bets?.[k]; if (!b) return '<span class="na">—</span>'; if (!r.result?.combo) return '—'; return b.includes(r.result.combo) ? `<b class="pos">◯ ${(r.result.payout || 0).toLocaleString()}円</b>` : '×'; };
  const done = rows.filter((r) => r.result?.combo).sort((x, y) => (y.date + y.deadline).localeCompare(x.date + x.deadline));
  const list = done.map((r) => `<tr><td class="l"><a href="#/r/${r.date}/${r.jcd}/${r.rno}">${+r.date.slice(6)}日 ${esc(VENUE_NAME[r.jcd])}${r.rno}R</a>${r.reflect?.exhibition ? '' : '<br><span class="na">展示なし</span>'}</td><td>${combo(r.result.combo, true)}</td><td>${cell(r, 'A_on')}</td><td>${cell(r, 'A_off')}</td></tr>`).join('');
  return `<div class="card"><h2>全レース自動記録(締切直前の予想)</h2>
    <p class="small">画面を開かなくても、全レースの締切直前の予想を自動で記録しています。展示入りの割合: ${pct(a.exhibitionShare, 0)}</p>
    <div class="tbl-wrap"><table class="t"><thead><tr><th class="l">モード</th><th>1号艇1着<br>なし</th><th>1号艇1着<br>あり</th></tr></thead><tbody>${line('A')}${line('B')}${line('C')}</tbody></table></div>
    <p class="small muted">各買い目100円。B・Cはオッズが取れたレースだけで集計。</p>
    <details><summary>レースごとの結果(${done.length}件・モードA)</summary><div class="tbl-wrap"><table class="t"><thead><tr><th class="l">レース</th><th>結果</th><th>1号艇1着<br>なし</th><th>1号艇1着<br>あり</th></tr></thead><tbody>${list}</tbody></table></div></details></div>`;
}

async function viewStats() {
  setTab('stats');
  clearInterval(refreshTimer);
  const autoHtml = await autoCard();
  const all = allPredictions();
  if (!all.length) {
    app.innerHTML = '<h1>成績</h1>' + autoHtml + '<div class="card"><p>まだ保存した予想がありません。</p><p class="small muted">レースの画面を開くと、その時点の予想が自動で保存されます。結果が出ると自動で照合します。</p></div>';
    return;
  }
  app.innerHTML = '<h1>成績</h1><p class="muted">結果と照合しています…</p>';
  const groups = new Map();
  for (const p of all) { const k = `${p.date}|${p.jcd}|${p.rno}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const docs = new Map();
  const items = [];
  for (const [k, vs] of groups) {
    const [date, jcd, rno] = k.split('|');
    const key = `${date}/${jcd}`;
    if (!docs.has(key)) docs.set(key, await getJson(`${date}/${jcd}.json`));
    const race = docs.get(key)?.races?.[rno];
    const dl = deadlineMs(date, race?.deadline || vs[0].deadline);
    const fv = finalVersion(vs, dl);
    if (!fv) continue;
    items.push({ rec: fv, j: judge(fv, race?.result), date, jcd, rno: +rno });
  }
  const s = summarize(items);
  const byMode = ['A', 'B', 'C'].map((m) => ({ m, s: summarize(items.filter((x) => x.rec.mode === m)) })).filter((x) => x.s.races + x.s.waiting > 0);
  const bucketRows = s.buckets.filter((b) => b.n).map((b) => `<tr><td>${pct(b.lo, 0)}〜${b.hi > 1 ? '' : pct(b.hi, 0)}</td><td>${b.n}</td><td>${pct(b.avgP, 2)}</td><td>${pct(b.rate, 2)}</td></tr>`).join('');
  // 1号艇1着を「外す」「外さない」の比較(モードAで計算し直す)
  const cmp = items.map((x) => ({ ...x, c: compareExclusion(x.rec, docs.get(`${x.date}/${x.jcd}`)?.races?.[x.rno]?.result) }));
  const sumOf = (k) => summarize(cmp.map((x) => ({ rec: { ...x.rec, bets: x.c[k].bets }, j: x.c[k].j })));
  const sOn = sumOf('on'), sOff = sumOf('off');
  const cell = (j) => (j.state === 'done' ? (j.hit ? `<b class="pos">◯ ${j.ret.toLocaleString()}円</b>` : '×') : j.state === 'void' ? '中止' : '—');
  const rowOf = (x) => `<tr><td class="l"><a href="#/r/${x.date}/${x.jcd}/${x.rno}">${+x.date.slice(6)}日 ${esc(VENUE_NAME[x.jcd])}${x.rno}R</a></td>
     <td>${x.j.state === 'done' ? combo(x.j.combo, true) : x.j.state === 'void' ? '中止' : '結果待ち'}</td><td>${cell(x.c.on.j)}</td><td>${cell(x.c.off.j)}</td></tr>`;
  const order = (a, b) => (b.date + String(b.rno).padStart(2, '0') + b.jcd).localeCompare(a.date + String(a.rno).padStart(2, '0') + a.jcd);
  // 結果が出たレースは件数の上限なしで全部表示し、結果待ちは別にまとめる(過去の実績が隠れないように)
  const doneRows = cmp.filter((x) => x.j.state !== 'waiting').sort(order).map(rowOf).join('');
  const waitList = cmp.filter((x) => x.j.state === 'waiting').sort(order);
  const recent = doneRows || '<tr><td colspan="4" class="muted">結果が出たレースはまだありません</td></tr>';
  const cmpCard = `<div class="card"><h2>「1号艇1着なし」と「1号艇1着あり」の比較</h2>
    <div class="tbl-wrap"><table class="t"><thead><tr><th></th><th>1号艇1着<br>なし</th><th>1号艇1着<br>あり</th></tr></thead><tbody>
    <tr><td class="l">的中率</td><td><b>${pct(sOn.hitRate)}</b><br><span class="na">${sOn.hits}/${sOn.betRaces}</span></td><td><b>${pct(sOff.hitRate)}</b><br><span class="na">${sOff.hits}/${sOff.betRaces}</span></td></tr>
    <tr><td class="l">回収率</td><td><b>${pct(sOn.recovery, 0)}</b><br><span class="na">${sOn.ret.toLocaleString()}/${sOn.stake.toLocaleString()}円</span></td><td><b>${pct(sOff.recovery, 0)}</b><br><span class="na">${sOff.ret.toLocaleString()}/${sOff.stake.toLocaleString()}円</span></td></tr>
    </tbody></table></div><p class="small muted">締切前に保存した最終版の確率から、モードA(的中重視)で両方の買い目を作り直して比べています。各買い目100円。</p></div>`;
  app.innerHTML = `<h1>成績</h1>${autoHtml}<h2 style="margin:16px 0 8px">この端末で開いたレースの成績</h2>${cmpCard}
    <div class="card"><h2>全体(締切前の最終版で集計)</h2>
      <div class="stat"><div><b>${pct(s.hitRate)}</b><span>的中率<br>${s.hits}/${s.betRaces}レース</span></div>
      <div><b class="${s.recovery >= 1 ? 'pos' : ''}">${pct(s.recovery, 0)}</b><span>回収率<br>${s.ret.toLocaleString()}/${s.stake.toLocaleString()}円</span></div>
      <div><b>${s.avgRankActual ? s.avgRankActual.toFixed(1) + '位' : '—'}</b><span>実際の結果の<br>予想順位(平均)</span></div></div>
      <p class="small muted">結果待ち ${s.waiting}件 / 中止 ${s.void}件。各買い目100円として計算。</p></div>
    ${byMode.length > 1 ? `<div class="card"><h2>モード別</h2><div class="tbl-wrap"><table class="t"><thead><tr><th>モード</th><th>レース</th><th>的中率</th><th>回収率</th></tr></thead><tbody>${byMode.map((x) => `<tr><td>${x.m} ${MODES[x.m].label}</td><td>${x.s.betRaces}</td><td>${pct(x.s.hitRate)}</td><td>${pct(x.s.recovery, 0)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h2>確率の当たり具合</h2>
      <p class="small">予想した確率と、実際にその組み合わせが出た割合を比べます。2つの数字が近いほど、確率の見積もりが正確です。</p>
      ${bucketRows ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>予想確率の帯</th><th>件数</th><th>予想の平均</th><th>実際に出た割合</th></tr></thead><tbody>${bucketRows}</tbody></table></div>` : '<p class="muted">結果が出たレースがまだありません。</p>'}
      ${s.winTop.n ? `<p class="small">1着予想(一番確率が高い艇): 予想の平均 ${pct(s.winTop.avgP)} → 実際の的中 ${pct(s.winTop.rate)}(${s.winTop.n}レース)</p>` : ''}
      ${s.logLoss != null ? `<p class="small muted">対数損失 ${s.logLoss.toFixed(2)}(でたらめに120通りを均等に見た場合 ${s.uniformLogLoss.toFixed(2)}。小さいほど良い)</p>` : ''}</div>
    <div class="card"><h2>レースごとの結果(${cmp.length - waitList.length}件)</h2><div class="tbl-wrap"><table class="t"><thead><tr><th class="l">レース</th><th>結果</th><th>1号艇1着<br>なし</th><th>1号艇1着<br>あり</th></tr></thead><tbody>${recent}</tbody></table></div>
      ${waitList.length ? `<details><summary>結果待ち(${waitList.length}件)</summary><div class="tbl-wrap"><table class="t"><tbody>${waitList.map(rowOf).join('')}</tbody></table></div></details>` : ''}</div>`;
}

// ---------- 保存・情報 ----------
async function viewSettings() {
  setTab('settings');
  clearInterval(refreshTimer);
  const n = allPredictions().length;
  const log = await getJson('meta/log.json', { fresh: true });
  const state = await getJson('meta/state.json', { fresh: true });
  const recent = (log || []).slice(0, 8).map((l) => `<tr><td>${fmtTime(l.startedAt)}</td><td>${l.requests}</td><td>${l.errors?.length || 0}</td><td class="l small">${esc(l.stopped || '')}</td></tr>`).join('');
  const today = jstDate();
  app.innerHTML = `<h1>保存・情報</h1>
    <div class="card"><h2>バックアップ</h2>
      <p class="small">この端末に保存した予想は ${n} 件です。Safariの「履歴とWebサイトデータを消去」をすると消えるため、ときどき書き出して保存してください。</p>
      <button class="btn wide" id="exp">バックアップを書き出す</button>
      <label class="btn sub wide">バックアップを読み込む<input type="file" id="imp" accept="application/json,.json" hidden></label>
      <p class="small muted" id="bkmsg"></p></div>
    <div class="card"><h2>自動取得の記録</h2>
      ${state?.robots ? `<p class="small">robots.txt の最終確認: ${fmtTime(state.robots.checkedAt)}</p>` : ''}
      ${state?.backoffUntil && Date.parse(state.backoffUntil) > Date.now() ? `<div class="note warn">公式サイトの応答により ${fmtTime(state.backoffUntil)} まで取得を休んでいます。</div>` : ''}
      <p class="small">今日の取得件数: ${state?.daily?.[today] ?? 0} 件</p>
      ${recent ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>実行時刻</th><th>件数</th><th>失敗</th><th class="l">備考</th></tr></thead><tbody>${recent}</tbody></table></div>` : '<p class="muted small">まだ記録がありません。</p>'}</div>
    <div class="card"><h2>このアプリについて</h2><ul class="plain small">
      <li>情報の出典は <a href="https://www.boatrace.jp/" target="_blank" rel="noopener">BOAT RACE公式サイト</a> です。正式な情報は必ず公式サイトでご確認ください。</li>
      <li>予想は過去の傾向をもとにした目安で、当たることを保証するものではありません。</li>
      <li>舟券の購入は20歳以上の方に限られます。無理のない範囲でお楽しみください。</li>
      <li>予想の計算はこの端末の中だけで行い、保存した予想も外部には送りません。</li></ul></div>`;
  document.getElementById('exp').addEventListener('click', async () => {
    const text = exportBackup();
    const fname = `boatline-backup-${today}.json`;
    const blob = new Blob([text], { type: 'application/json' });
    const file = typeof File !== 'undefined' ? new File([blob], fname, { type: 'application/json' }) : null;
    try {
      if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'BOAT LINE バックアップ' }); return; }
    } catch (e) { if (e?.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    document.getElementById('bkmsg').textContent = 'ファイルを書き出しました。';
  });
  document.getElementById('imp').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { const added = importBackup(await f.text()); document.getElementById('bkmsg').textContent = `${added}件の予想を読み込みました(既にある版はそのまま)。`; }
    catch (err) { document.getElementById('bkmsg').textContent = `読み込めませんでした: ${err.message}`; }
  });
}

// ---------- 画面の切り替え ----------
function route() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  if (h[0] === 'v' && h[2]) return viewVenue(h[1], h[2]);
  if (h[0] === 'r' && h[3]) return viewRace(h[1], h[2], h[3]);
  if (h[0] === 'stats') return viewStats();
  if (h[0] === 'settings') return viewSettings();
  if (h[0] === 'd' && h[1]) return viewHome(h[1]);
  return viewHome(null);
}
window.addEventListener('hashchange', route);
route();
