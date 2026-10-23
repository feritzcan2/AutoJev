// Summarises the usage.daily lines (`sentry-scans.sh usage` JSON on stdin) per
// day and per install. A line counts the runs that finished in the window
// before it (window_hours), so a day's numbers are what the installs reported
// that day. Only production installs count: development is the repo build,
// check is a manual check, and 0.1.13 on 2026-10-21 07:33–07:42 UTC were CI runs.
const ACTIVE_DAYS = Number(process.argv[2] ?? 2);

const input = await new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (text += chunk)).on('end', () => resolve(text));
});
const ciSmoke = (row) =>
  row.release === '0.1.13' &&
  row.timestamp >= '2026-10-21T07:33' &&
  row.timestamp < '2026-10-21T07:43';
const rows = JSON.parse(input)
  .data.map((d) => {
    const row = {timestamp: d.timestamp, install: d.install_id, environment: d.environment};
    for (const [key, value] of Object.entries(d)) {
      const tag = /^tags\[([^,]+),/.exec(key)?.[1];
      if (tag) row[tag === 'sentry.release' ? 'release' : tag] = value ?? 0;
    }
    return row;
  })
  .filter(
    (row) => row.environment === 'production' && row.release !== '0.0.0-check' && !ciSmoke(row),
  )
  .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

const day = (row) => row.timestamp.slice(0, 10);
const sum = (list, key) => list.reduce((n, row) => n + (row[key] || 0), 0);
const scans = (list) => ({
  total: sum(list, 'scan_total'),
  completed: sum(list, 'scan_completed') + sum(list, 'scan_partial'),
  blocked: sum(list, 'scan_blocked'),
  failed: sum(list, 'scan_failed') + sum(list, 'scan_timeout'),
  interrupted: sum(list, 'scan_interrupted'),
});

console.log('Per day (production installs)');
console.log(
  'day         installs  scanning  scans  done  blocked  failed  interrupted  applications  applied',
);
const days = [...new Set(rows.map(day))];
for (const d of days) {
  const list = rows.filter((row) => day(row) === d),
    s = scans(list);
  console.log(
    [
      d,
      String(new Set(list.map((r) => r.install)).size).padStart(8),
      String(new Set(list.filter((r) => r.scan_total > 0).map((r) => r.install)).size).padStart(9),
      String(s.total).padStart(6),
      String(s.completed).padStart(5),
      String(s.blocked).padStart(8),
      String(s.failed).padStart(7),
      String(s.interrupted).padStart(12),
      String(sum(list, 'execute_total')).padStart(13),
      String(sum(list, 'execute_completed')).padStart(8),
    ].join(' '),
  );
}

const last = days.at(-1),
  cutoff = new Date(Date.parse(`${last}T00:00:00Z`) - (ACTIVE_DAYS - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
const installs = new Map();
for (const row of rows) {
  const entry = installs.get(row.install) ?? {rows: [], days: new Set()};
  entry.rows.push(row);
  entry.days.add(day(row));
  installs.set(row.install, entry);
}
let scanned = 0,
  continuing = 0,
  fresh = 0,
  stopped = 0;
console.log(`\nPer install (active = reported since ${cutoff})`);
console.log(
  'install   first       last        days  release  os      scans  done  blocked  failed  applied  state',
);
for (const [id, {rows: list, days: seen}] of installs) {
  const s = scans(list),
    first = day(list[0]),
    lastSeen = day(list.at(-1)),
    active = lastSeen >= cutoff,
    state = !active ? 'stopped' : first >= cutoff ? 'new' : 'continuing';
  if (s.total > 0) scanned++;
  if (state === 'continuing') continuing++;
  else if (state === 'new') fresh++;
  else stopped++;
  console.log(
    [
      id.slice(0, 8),
      first,
      lastSeen,
      String(seen.size).padStart(4),
      String(list.at(-1).release).padEnd(8),
      String(list.at(-1).os).padEnd(6),
      String(s.total).padStart(5),
      String(s.completed).padStart(5),
      String(s.blocked).padStart(8),
      String(s.failed).padStart(7),
      String(sum(list, 'execute_completed')).padStart(8),
      state + (s.total ? '' : ', never scanned'),
    ].join('  '),
  );
}
const all = scans(rows);
console.log(
  `\nTotal: ${installs.size} installs, ${scanned} scanned at least once; ${continuing} continuing, ${fresh} new, ${stopped} stopped.` +
    ` Scans ${all.total}: ${all.completed} done, ${all.blocked} blocked, ${all.failed} failed, ${all.interrupted} interrupted` +
    ' (not failures: a next-page handoff, a session resume, the app closed or the user stopped it).' +
    ` Applications ${sum(rows, 'execute_total')}: ${sum(rows, 'execute_completed')} applied.`,
);
