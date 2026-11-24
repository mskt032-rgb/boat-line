// テスト用: 公式サイトのページ構成を模した最小限のHTMLを作る(実在の選手・データではない)
const NAMES = ['山田　一郎', '佐藤　次郎', '鈴木　三郎', '高橋　四郎', '田中　五郎', '伊藤　六郎'];

export function deadlinesRow(times) {
  return `<table><tbody><tr><th>締切予定時刻</th>${times.map((t) => `<td>${t}</td>`).join('')}</tr></tbody></table>`;
}
export const TIMES = ['10:30', '11:00', '11:28', '11:56', '12:24', '12:52', '13:20', '13:50', '14:20', '14:50', '15:20', '15:52'];

export function indexHtml(date, jcds) {
  const rows = jcds.map((j) => `<tbody class="is-G3"><tr><td><a href="/owpc/pc/race/raceindex?jcd=${j}&hd=${date}"><img alt="場${j}"></a></td>
    <td class="is-alignL"><a href="/owpc/pc/race/raceindex?jcd=${j}&hd=${date}">第${j}回 テスト杯</a></td><td>11/22-11/26</td><td>3日目</td></tr></tbody>`).join('');
  return `<html><body><div class="table1"><table>${rows}</table></div>
    <a href="/owpc/pc/race/raceindex?jcd=99&hd=20000101">old</a></body></html>`;
}

export function racelistHtml(opts = {}) {
  const st = opts.st || ['0.14', '0.16', '0.15', '0.17', '0.18', '0.19'];
  const nat = opts.nat || ['7.10', '5.80', '6.20', '5.10', '4.90', '4.20'];
  const body = [1, 2, 3, 4, 5, 6].map((n, i) => `<tbody class="is-fs12">
    <tr><td class="is-boatColor${n}" rowspan="4">${'０１２３４５６'[n]}</td><td rowspan="4"><img></td>
    <td rowspan="4"><div class="is-fs11">${4000 + n}<span> / </span><span>${['A1', 'A2', 'B1', 'A1', 'B1', 'B2'][i]}</span></div>
      <div class="is-fs18 is-fBold"><a>${NAMES[i]}</a></div><div class="is-fs11">東京/東京<br>3${n}歳/5${n}.0kg</div></td>
    <td rowspan="4">F${i === 3 ? 1 : 0}<br>L0<br>${st[i]}</td>
    <td rowspan="4">${nat[i]}<br>4${n}.00<br>6${n}.00</td>
    <td rowspan="4">${i === 5 ? '0.00' : '6.00'}<br>40.00<br>55.00</td>
    <td rowspan="4">${10 + n}<br>${30 + n * 2}.50<br>50.00</td>
    <td rowspan="4">${20 + n}<br>35.00<br>50.00</td><td>3</td><td>9</td><td></td><td rowspan="4">早見</td></tr>
    <tr><td class="is-boatColor${n}">${n}</td><td>4</td><td></td></tr><tr><td>.15</td><td>F.02</td><td></td></tr><tr><td>${'０１２３４５６'[n]}</td><td>１</td><td></td></tr></tbody>`).join('');
  return `<html><body><h3 class="title16_titleDetail__add2020">予選　　　1800m</h3>${deadlinesRow(TIMES)}
    <div class="table1 is-tableFixed__3rdadmin"><table><thead><tr><th>枠</th></tr></thead>${body}</table></div></body></html>`;
}

export function beforeinfoHtml(opts = {}) {
  const ex = opts.ex ?? ['6.72', '6.80', '6.75', '6.70', '6.85', '6.90'];
  const order = opts.order || [1, 2, 3, 4, 5, 6];
  const sts = opts.sts || ['.10', '.12', 'F.01', '.08', '.15', '.20'];
  const rows = [1, 2, 3, 4, 5, 6].map((n, i) => `<tbody><tr><td class="is-boatColor${n}" rowspan="4">${n}</td><td rowspan="4"><img></td><td rowspan="4"><a>${NAMES[i]}</a></td>
    <td rowspan="2">52.0kg</td><td rowspan="4">${ex[i] ?? ''}</td><td rowspan="4">-0.5</td><td rowspan="4"></td><td rowspan="4"></td></tr><tr><td>0.0</td></tr></tbody>`).join('');
  const start = order.map((b, i) => `<div class="table1_boatImage1"><span class="table1_boatImage1Number is-type${b}">${b}</span><span class="table1_boatImage1Time">${sts[i]}</span></div>`).join('');
  return `<html><body>${deadlinesRow(TIMES)}<div class="table1"><table class="is-w748"><thead><tr><th>展示タイム</th></tr></thead>${rows}</table></div>
    <div class="table1"><table class="is-w238"><tbody><tr><td>${opts.noStart ? '' : start}</td></tr></tbody></table></div>
    <div class="weather1"><div class="weather1_body">
      <div class="weather1_bodyUnit is-direction"><span class="weather1_bodyUnitLabelTitle">気温</span><span class="weather1_bodyUnitLabelData">12.0℃</span></div>
      <div class="weather1_bodyUnit is-weather"><span class="weather1_bodyUnitLabelTitle">晴</span></div>
      <div class="weather1_bodyUnit is-wind"><span class="weather1_bodyUnitLabelData">3m</span></div>
      <div class="weather1_bodyUnit is-windDirection"><p class="weather1_bodyUnitImage is-wind7"></p></div>
      <div class="weather1_bodyUnit is-waterTemperature"><span class="weather1_bodyUnitLabelData">15.0℃</span></div>
      <div class="weather1_bodyUnit is-wave"><span class="weather1_bodyUnitLabelData">2cm</span></div>
    </div></div></body></html>`;
}

/** 3連単オッズ: 公式と同じく 20行 × (1着1〜6) の順に oddsPoint が並ぶ */
export function oddsHtml(valueOf = (combo) => (10 + combo.split('-').reduce((a, b) => a * 2 + +b, 0) / 10).toFixed(1)) {
  const firsts = [1, 2, 3, 4, 5, 6].map((f) => {
    const out = [];
    for (let s = 1; s <= 6; s++) { if (s === f) continue; for (let t = 1; t <= 6; t++) { if (t === f || t === s) continue; out.push(`${f}-${s}-${t}`); } }
    return out;
  });
  let rows = '';
  for (let r = 0; r < 20; r++) {
    rows += '<tr>' + [0, 1, 2, 3, 4, 5].map((fi) => { const c = firsts[fi][r]; const [, s, t] = c.split('-'); return `${r % 4 === 0 ? `<td rowspan="4">${s}</td>` : ''}<td>${t}</td><td class="oddsPoint">${valueOf(c)}</td>`; }).join('') + '</tr>';
  }
  return `<html><body><p class="tab4_refreshText">オッズ更新時間 11:15時点</p><div class="table1"><table><tbody>${rows}</tbody></table></div></body></html>`;
}

export function resultHtml({ order = [3, 1, 4, 2, 5, 6], payout = '¥12,340', canceled = false } = {}) {
  if (canceled) return '<html><body><p>レース中止</p></body></html>';
  const rows = order.map((b, i) => `<tr><td>${'１２３４５６'[i]}</td><td class="is-boatColor${b}">${b}</td><td><span>${4000 + b}</span><span>${NAMES[b - 1]}</span></td><td>1'49"${i}</td></tr>`).join('');
  return `<html><body><div class="table1"><table class="is-w495"><thead><tr><th>着</th><th>枠</th><th>ボートレーサー</th><th>レースタイム</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="table1"><table class="is-w495"><thead><tr><th>勝式</th><th>組番</th><th>払戻金</th><th>人気</th></tr></thead><tbody>
    <tr><td rowspan="2">3連単</td><td><div class="numberSet1"><span class="numberSet1_number is-type${order[0]}">${order[0]}</span><span>-</span><span class="numberSet1_number">${order[1]}</span><span>-</span><span class="numberSet1_number">${order[2]}</span></div></td><td><span class="is-payout1">${payout}</span></td><td>35</td></tr>
    <tr><td>2連単</td><td>x</td></tr></tbody></table></div>
    <div class="table1"><table><thead><tr><th>決まり手</th></tr></thead><tbody><tr><td>まくり</td></tr></tbody></table></div></body></html>`;
}

export function racerCourseHtml() {
  const tbl = (h, f) => `<table><thead><tr><th colspan="2">${h}</th></tr></thead><tbody>${[1, 2, 3, 4, 5, 6].map((c) => `<tr><td>${c}</td><td>${f(c)}</td></tr>`).join('')}</tbody></table>`;
  return `<html><body>${tbl('コース別進入率', (c) => `${(20 - c).toFixed(1)}%`)}${tbl('コース別3連対率 :1着率 :2着率 :3着率', (c) => `${(80 - c * 7).toFixed(1)}%`)}${tbl('コース別平均スタートタイミング', (c) => `.1${c}`)}</body></html>`;
}
