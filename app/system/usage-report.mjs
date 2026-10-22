// @ts-check
import {randomUUID} from 'node:crypto';

// Anonymous usage for Sentry: one Release Health session per app start and one
// daily log line of counts. Only numbers, statuses, blocker categories and the
// agent provider names leave the machine: no titles, URLs, search terms,
// profile or record content.
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/** Counts of runs finished and records found in [from, to), plus current totals. */
export function usageCounts(db, from, to) {
  const counts = {},
    add = (key, n) => (counts[key] = (counts[key] ?? 0) + n),
    providers = new Set();
  for (const row of db
    .prepare(
      `SELECT json_extract(data,'$.kind') AS kind,json_extract(data,'$.recordOperation') AS operation,
       json_extract(data,'$.status') AS status,json_extract(data,'$.conversation.provider') AS provider,
       json_extract(data,'$.blocker.category') AS category,count(*) AS n
       FROM automation_runs WHERE json_extract(data,'$.finishedAt')>=? AND json_extract(data,'$.finishedAt')<?
       GROUP BY 1,2,3,4,5`,
    )
    .all(from, to)) {
    const group = row.operation ?? (row.kind === 'run' ? 'scan' : row.kind);
    add(`${group}_${row.status}`, row.n);
    add(`${group}_total`, row.n);
    // Why record tasks stopped, by blocker category (needs_answer, technical, ...).
    if (row.category) add(`${group}_blocker_${row.category}`, row.n);
    if (row.provider) providers.add(row.provider);
  }
  const one = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
  return {
    ...counts,
    records_found: one(
      "SELECT count(*) AS n FROM workspace_records WHERE json_extract(data,'$.createdAt')>=? AND json_extract(data,'$.createdAt')<?",
      from,
      to,
    ),
    workspaces: one('SELECT count(*) AS n FROM automations'),
    sources: one(
      "SELECT coalesce(sum(json_array_length(data,'$.sources')),0) AS n FROM automations",
    ),
    records: one('SELECT count(*) AS n FROM workspace_records'),
    providers: [...providers].sort().join(',') || 'none',
  };
}

const attribute = (value) =>
  typeof value === 'number'
    ? {value, type: 'integer'}
    : typeof value === 'boolean'
      ? {value, type: 'boolean'}
      : {value: String(value), type: 'string'};

export function startUsageReporting({
  db,
  setting,
  send,
  release,
  environment,
  system = {},
  now = Date.now,
}) {
  const sid = randomUUID(),
    started = now();
  let errors = 0,
    init = true,
    reporting = null;
  async function session(status) {
    if (!setting.enabled()) return;
    const payload = {
      sid,
      did: await setting.installId(),
      init,
      started: iso(started),
      timestamp: iso(now()),
      duration: Math.round((now() - started) / 1000),
      status,
      errors,
      attrs: {release, environment},
    };
    init = false;
    await send([{type: 'session', payload}]);
  }
  async function daily() {
    if (!setting.enabled()) return;
    const at = now(),
      last = setting.usageReportedAt();
    if (last && at - last < DAY) return;
    const from = Math.max(last ?? at - DAY, at - 7 * DAY),
      counts = usageCounts(db, from, at),
      item = {
        timestamp: at / 1000,
        trace_id: randomUUID().replaceAll('-', ''),
        level: 'info',
        body: 'usage.daily',
        attributes: Object.fromEntries(
          Object.entries({
            ...counts,
            ...system,
            window_hours: Math.round((at - from) / 3600000),
            install_id: await setting.installId(),
            'sentry.release': release,
            'sentry.environment': environment,
          }).map(([key, value]) => [key, attribute(value)]),
        ),
      };
    const sent = await send([
      {
        type: 'log',
        item_count: 1,
        content_type: 'application/vnd.sentry.items.log+json',
        payload: {items: [item]},
      },
    ]);
    if (sent) await setting.markUsageReported(at);
  }
  // One daily report at a time; a later call while one is sending waits for it.
  const tick = () => (reporting ??= daily().finally(() => (reporting = null)));
  return {
    start: async () => {
      await session('ok');
      await tick();
    },
    // A scan that ended failed, blocked or timed out marks the session errored.
    failure: () => {
      errors += 1;
    },
    tick,
    stop: () => session('exited'),
  };
}
