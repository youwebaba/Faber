// RFC 9309: https://www.rfc-editor.org/rfc/rfc9309.html
const normalize = value => [...value].map(char => char.charCodeAt(0) > 127 ? encodeURIComponent(char) : char).join('')
  .replace(/%[0-9a-f]{2}/gi, octet => /^[A-Za-z0-9._~-]$/.test(String.fromCharCode(parseInt(octet.slice(1), 16)))
    ? String.fromCharCode(parseInt(octet.slice(1), 16)) : octet.toUpperCase());

// Avoid running untrusted robots patterns as regular expressions.
function matches(pattern, path, budget) {
  const exact = pattern.endsWith('$');
  if (exact) pattern = pattern.slice(0, -1);
  let p = 0, s = 0, star = -1, retry = 0;
  while (s < path.length) {
    if (--budget.steps < 0) throw Object.assign(new Error('Robots matching complexity limit exceeded.'), { code: 'ROBOTS_UNAVAILABLE' });
    if (p === pattern.length && !exact) return true;
    if (pattern[p] === '*') { star = p++; retry = s; }
    else if (pattern[p] === path[s]) { p++; s++; }
    else if (star >= 0) { p = star + 1; s = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function parseRobots(text, agent = 'FaberCrawler') {
  const groups = [];
  let group = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.split('#', 1)[0];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!group || group.hasRules) { group = { agents: [], rules: [], hasRules: false }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === 'allow' || key === 'disallow')) {
      group.hasRules = true;
      if (value) {
        const pattern = normalize(value);
        group.rules.push({ pattern, allow: key === 'allow', length: Buffer.byteLength(pattern.replace(/\*/g, '').replace(/\$$/, '').replace(/%[0-9A-F]{2}/g, 'x')) });
      }
    }
  }
  const specific = groups.filter(item => item.agents.includes(agent.toLowerCase()));
  return (specific.length ? specific : groups.filter(item => item.agents.includes('*'))).flatMap(item => item.rules);
}

export function robotsAllows(rules, url) {
  const target = url instanceof URL ? url : new URL(url);
  if (target.pathname === '/robots.txt') return true;
  const path = normalize(target.pathname + target.search).replace(/\*/g, '%2A').replace(/\$/g, '%24');
  // shortcut: exceptionally complex rules fail closed; increase only with a bounded matcher.
  const budget = { steps: 1_000_000 };
  let winner;
  for (const rule of rules) {
    if ((!winner || rule.length >= winner.length) && matches(rule.pattern, path, budget)
      && (!winner || rule.length > winner.length || rule.allow)) winner = rule;
  }
  return !winner || winner.allow;
}
