// robots.txt の簡易判定(User-agent グループ、Allow/Disallow、* と $ に対応)。
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val });
      if (key === 'crawl-delay') cur.crawlDelay = parseFloat(val);
    }
  }
  return groups;
}
function toRegex(p) {
  let s = p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (s.endsWith('$')) return new RegExp('^' + s);
  return new RegExp('^' + s);
}
export function robotsFor(groups, uaToken) {
  const ua = uaToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const crawlDelay = chosen.map((g) => g.crawlDelay).find((x) => Number.isFinite(x));
  return {
    crawlDelay,
    allowed(pathWithQuery) {
      let best = null;
      for (const r of rules) {
        if (r.path === '') { continue; } // 空の Disallow は「すべて許可」
        if (toRegex(r.path).test(pathWithQuery)) {
          const len = r.path.length;
          if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
        }
      }
      return best ? best.allow : true;
    },
  };
}
