import {randomUUID} from 'node:crypto';
import {siteKey} from './site-key.mjs';

export {siteKey};
// Two addresses belong to the same site when their registrable domains match,
// so a www redirect or a job board on a subdomain still counts as the source.
const siteDomain = (host) => {
  const labels = host.split('.');
  const keep = labels.length > 2 && labels.at(-2).length <= 3 && labels.at(-1).length <= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
};
// The registrable domain of an address (de.linkedin.com -> linkedin.com).
export const siteDomainOf = (url) => siteDomain(siteKey(url));
export const sameSite = (a, b) => {
  const x = siteKey(a),
    y = siteKey(b);
  return x === y || siteDomain(x) === siteDomain(y);
};
const minute = 60000;
// Pacing: every site keeps PACE_MIN between navigations, so a scan never
// bursts. A site that answered with a rate limit or a verification challenge
// within the last hours keeps a longer gap, growing with its incidents: a
// few seconds between pages is already enough for some sites to throttle.
const PACE_WINDOW = 6 * 60 * minute,
  PACE_MIN = 8000,
  PACE_STEP = 10000,
  PACE_MAX = 30000;
const REQUEST_LOG_MS = 60 * minute;
export const siteRetryDelay = (attempt) => [5 * minute, 10 * minute][attempt - 1] ?? null;
// A site that recovered and then worked for this long starts a new incident
// with a fresh retry budget instead of continuing the old count.
const ATTEMPT_RESET = 60 * minute;
// Repeated transport failures across a site's pages are an outage, not one bad
// address: failures on three different addresses within ten minutes start the
// same bounded shared wait as a rate limit. One or two addresses that keep
// failing are those pages (a site may refuse deep results pages), not the
// site. One success clears the count.
const UNREACHABLE_WINDOW = 10 * minute,
  UNREACHABLE_FAILURES = 3;
export const networkFailure = (error) =>
  /\bnet::ERR_(?!ABORTED\b)[A-Z0-9_]+/.test(String(error?.message ?? error ?? ''));
export function accessBarrier({status, title = '', text = ''}) {
  if (status === 429) return 'rate_limit';
  // A quoted error in a listing is not a site-wide access barrier.
  const page = text.trim();
  if (page.length > 12000) return null;
  // Require both a challenge title and its verification body. Listings may
  // legitimately mention Cloudflare or quote a verification error.
  const challengeTitle =
    /^(?:Just a moment[.!…]*|Additional Verification Required|Attention Required!?\s*\|\s*Cloudflare)$/i.test(
      title.trim(),
    );
  const verificationLine =
    /^(?:Additional Verification Required|Verify you are human(?: by completing the action below)?[.!]?|Verifying you are human[.!…]*|Performing security verification[.!…]*|Checking your browser(?: before accessing [^\n]+)?[.!…]*)\s*$/im.test(
      page,
    ) || /This page is displayed while the website verifies you are not a bot/i.test(page);
  if (challengeTitle && verificationLine && /(?:\bCloudflare\b|\b(?:Your )?Ray ID\b)/i.test(page))
    return 'verification';
  return /^(?:Your IP (?:address |range )?(?:has been |is )?(?:temporarily )?blocked\.?|IP (?:address |range )?(?:has been |is )?(?:temporarily )?blocked\.?)/i.test(
    page,
  )
    ? 'ip_block'
    : null;
}
export function retryAfterTime(value, now) {
  if (!value) return null;
  const at = /^\d+$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(at) && at > now ? at : null;
}
export class SiteWaitError extends Error {
  constructor(wait) {
    super(wait.message);
    this.code = 'SITE_WAIT';
    this.wait = wait;
  }
}
// Scans, applications and contact tasks keep separate waits for the same
// site: a scan that hits a rate limit (such as a public API budget) must not
// hold a signed-in application or contact search there, and the reverse.
// Pacing stays shared, so the lanes together still never burst a site.
export const APPLY_LANE = 'apply',
  CONTACTS_LANE = 'contacts';
export const runSiteLane = (run) =>
  ['prepare', 'execute', 'verify'].includes(run?.recordOperation)
    ? APPLY_LANE
    : run?.recordOperation === 'contacts'
      ? CONTACTS_LANE
      : undefined;
const waitKey = (site, lane) => (lane ? `${site} ${lane}` : site);
export class SiteAccess {
  constructor(db, {now = Date.now, changed = () => {}} = {}) {
    Object.assign(this, {db, now, changed});
    this.incidents = new Map();
    this.paced = new Map();
    this.requests = new Map();
    this.failures = new Map();
    db.exec(
      'CREATE TABLE IF NOT EXISTS browser_site_waits(site TEXT PRIMARY KEY,data TEXT NOT NULL)',
    );
    db.exec('CREATE TABLE IF NOT EXISTS site_requests(site TEXT NOT NULL,at INTEGER NOT NULL)');
  }
  // The same store seen from one lane; pacing, incidents and listeners are shared.
  forLane(lane) {
    const base = this.base ?? this;
    if (!lane) return base;
    base.lanes ??= new Map();
    if (!base.lanes.has(lane))
      base.lanes.set(lane, Object.create(base, {lane: {value: lane}, base: {value: base}}));
    return base.lanes.get(lane);
  }
  stored(site, lane) {
    return JSON.parse(
      this.db.prepare('SELECT data FROM browser_site_waits WHERE site=?').get(waitKey(site, lane))
        ?.data ?? 'null',
    );
  }
  row(url) {
    return this.stored(siteKey(url), this.lane);
  }
  save(value) {
    this.db
      .prepare(
        'INSERT INTO browser_site_waits(site,data) VALUES(?,?) ON CONFLICT(site) DO UPDATE SET data=excluded.data',
      )
      .run(waitKey(value.site, value.lane), JSON.stringify(value));
    this.changed();
    return value;
  }
  status(url) {
    const row = this.row(url);
    if (!row || row.recovered) return null;
    const {token, leaseUntil = 0, ...state} = row,
      exhausted = row.attempts >= 3,
      retryAt = exhausted ? null : Math.max(row.retryAt, leaseUntil),
      probing = !exhausted && leaseUntil > this.now();
    return {
      ...state,
      retryAt,
      exhausted,
      probing,
      waiting: exhausted || retryAt > this.now(),
      message: `${row.site}: shared wait for ${row.lane === APPLY_LANE ? 'applications' : row.lane === CONTACTS_LANE ? 'contact tasks' : 'scans'} because of ${row.reason === 'budget' ? 'its request budget being used up' : row.reason === 'ip_block' ? 'an IP block' : row.reason === 'verification' ? 'an access verification' : row.reason === 'unreachable' ? 'the site being unreachable' : 'a rate limit'}. ${exhausted ? 'Third access failure; automatic retries stopped. Intervention is needed to continue.' : probing ? 'A single access check is in progress.' : `Resumes automatically: ${new Date(retryAt).toLocaleString('en-GB')}.`} Other sites${row.lane ? ' and scans of this site' : ' and applications on this site'} can keep working.`,
    };
  }
  begin(url) {
    const wait = this.status(url);
    if (!wait) return null;
    if (wait.waiting) throw new SiteWaitError(wait);
    const token = randomUUID();
    this.save({...this.row(url), token, leaseUntil: this.now() + minute});
    return token;
  }
  // Once the wait is over, the first action on a page of that site is its one
  // access probe, as a navigation would be. The page observed after the action
  // completes the probe with the returned token.
  assertAction(url) {
    return this.status(url) ? this.begin(url) : null;
  }
  // Only the explicit user-response path may retire an old cooldown early.
  // A later incident or an in-flight probe must not be cleared by a stale card.
  // A later incident that already recovered blocks nothing: the old card
  // still retires its own wait, and the recovered row stays for its task.
  acknowledge(waits) {
    const later = (row, wait) => row.blockedAt !== wait.blockedAt;
    for (const wait of waits) {
      const row = this.stored(wait.site, wait.lane);
      if (
        row &&
        !(row.recovered && later(row, wait)) &&
        (later(row, wait) || row.leaseUntil > this.now())
      )
        throw Error('This site has a new access wait. See Attention needed.');
    }
    for (const wait of waits) {
      const row = this.stored(wait.site, wait.lane);
      if (row && !(row.recovered && later(row, wait)))
        this.db
          .prepare('DELETE FROM browser_site_waits WHERE site=?')
          .run(waitKey(wait.site, wait.lane));
    }
    this.changed();
  }
  // A successful page probe lets the scan continue, but must not give a scan
  // that keeps failing a fresh retry budget. Retire it only when that task ends.
  finish(waits) {
    for (const wait of waits) {
      const row = this.stored(wait.site, wait.lane);
      if (row?.recovered && row.blockedAt === wait.blockedAt)
        this.db
          .prepare('DELETE FROM browser_site_waits WHERE site=?')
          .run(waitKey(wait.site, wait.lane));
    }
    this.changed();
  }
  // retryDelays is a site's own wait before each automatic retry (its
  // extension's stated cooldown); without it the fixed policy applies.
  block(url, reason, retryAfter, token, retryDelays = undefined) {
    const previous = this.row(url);
    // Re-reading an existing barrier must not keep extending the wait.
    if (
      previous &&
      !previous.recovered &&
      (previous.attempts >= 3 ||
        previous.retryAt > this.now() ||
        (previous.leaseUntil > this.now() && previous.token !== token))
    )
      return this.status(url);
    const now = this.now(),
      settled = previous?.recovered && now - previous.blockedAt > ATTEMPT_RESET,
      attempts = (settled ? 0 : (previous?.attempts ?? 0)) + 1;
    // The workspace policy uses fixed delays, independent of Retry-After.
    const delay = retryDelays ? (retryDelays[attempts - 1] ?? null) : siteRetryDelay(attempts);
    this.save({
      site: siteKey(url),
      ...(this.lane ? {lane: this.lane} : {}),
      reason,
      attempts,
      blockedAt: now,
      retryAt: delay === null ? null : now + delay,
      token: null,
      leaseUntil: 0,
    });
    this.incidents.set(siteKey(url), {
      at: now,
      count: (this.incidents.get(siteKey(url))?.count ?? 0) + 1,
    });
    return this.status(url);
  }
  // Milliseconds the caller should wait before navigating to this site. Each
  // call reserves the next slot, so concurrent workers queue instead of bursting.
  // minGap is the site's own minimum spacing (a robots.txt crawl delay); after
  // an incident the larger gap applies. jitter adds up to that many random
  // milliseconds, so a site's requests do not arrive at a fixed beat.
  pace(url, minGap = 0, jitter = 0) {
    const site = siteKey(url),
      now = this.now(),
      row = this.incidents.has(site) ? null : this.row(url);
    const incident =
      this.incidents.get(site) ??
      (row && row.reason !== 'budget' ? {at: row.blockedAt, count: row.attempts} : null);
    const recent = incident && now - incident.at <= PACE_WINDOW;
    const gap =
        Math.max(recent ? Math.min(PACE_STEP * incident.count, PACE_MAX) : PACE_MIN, minGap) +
        Math.floor(Math.random() * jitter),
      next = Math.max(now, (this.paced.get(site) ?? 0) + gap);
    this.paced.set(site, next);
    // Every request to a site reserves a slot here, so the slots are the
    // site's request log for the Sources page (RAM only, last hour).
    this.requests.set(site, [
      ...(this.requests.get(site) ?? []).filter((at) => now - at < REQUEST_LOG_MS),
      next,
    ]);
    return next - now;
  }
  // How fast this app reaches a site, across lanes and workspaces: requests
  // in the last ten minutes and hour, the site's minimum gap, and its budget
  // use when it states one (counted under budgetKey when the reads reserve
  // their own key, see reserve).
  requestRate(url, {minIntervalMs = 0, jitterMs = 0, budget = undefined} = {}, budgetKey = null) {
    const site = siteKey(url),
      now = this.now(),
      log = (this.requests.get(site) ?? []).filter((at) => at <= now && now - at < REQUEST_LOG_MS);
    const used = budget
      ? Number(
          this.db
            .prepare('SELECT count(*) AS n FROM site_requests WHERE site=? AND at>?')
            .get(budgetKey ?? site, now - budget.windowMs).n,
        )
      : null;
    return {
      lastTenMinutes: log.filter((at) => now - at < 10 * minute).length,
      lastHour: log.length,
      minGapMs: Math.max(PACE_MIN, minIntervalMs),
      jitterMs,
      ...(budget ? {budget: {requests: budget.requests, windowMs: budget.windowMs, used}} : {}),
    };
  }
  // A request budget counted under its own key (for example logged-in page
  // views, kept apart from a site's API budget), for reads that wait in
  // place instead of parking a task. Records the request and returns 0 when
  // the budget has room; otherwise the milliseconds until a slot frees.
  reserve(key, {requests, windowMs}) {
    const now = this.now();
    this.db.prepare('DELETE FROM site_requests WHERE site=? AND at<=?').run(key, now - windowMs);
    const used = this.db
      .prepare('SELECT count(*) AS n, min(at) AS first FROM site_requests WHERE site=?')
      .get(key);
    if (Number(used.n) >= requests) return Number(used.first) + windowMs - now;
    this.db.prepare('INSERT INTO site_requests(site,at) VALUES(?,?)').run(key, now);
    return 0;
  }
  // A site's stated request budget: at most `requests` requests within
  // `windowMs`, counted across lanes and workspaces and kept in the database,
  // so an app restart does not hand the site a fresh budget. A request
  // over budget is not sent and does not wait in the task: the site gets a
  // shared wait until the oldest counted request leaves the window, which
  // parks and resumes the task like a rate limit but is no incident.
  spend(url, {requests, windowMs}) {
    const site = siteKey(url),
      now = this.now();
    this.db.prepare('DELETE FROM site_requests WHERE site=? AND at<=?').run(site, now - windowMs);
    const reads = this.db
      .prepare('SELECT at FROM site_requests WHERE site=? ORDER BY at')
      .all(site)
      .map((row) => Number(row.at));
    if (reads.length < requests) {
      this.db.prepare('INSERT INTO site_requests(site,at) VALUES(?,?)').run(site, now);
      return null;
    }
    const previous = this.row(url);
    if (previous && !previous.recovered && previous.retryAt > now) return this.status(url);
    // An unfinished incident keeps its reason and retry count.
    const open = previous && !previous.recovered ? previous : null;
    this.save({
      site,
      ...(this.lane ? {lane: this.lane} : {}),
      reason: open?.reason ?? 'budget',
      attempts: open?.attempts ?? 0,
      blockedAt: now,
      // Until enough requests leave the window to free a slot; a lowered budget
      // can find more requests than it allows.
      retryAt: reads[reads.length - requests] + windowMs,
      token: null,
      leaseUntil: 0,
    });
    return this.status(url);
  }
  unreachable(url, error) {
    if (!networkFailure(error)) return null;
    const site = waitKey(siteKey(url), this.lane),
      now = this.now(),
      failures = [
        ...(this.failures.get(site) ?? []).filter((f) => now - f.at <= UNREACHABLE_WINDOW),
        {at: now, url},
      ];
    this.failures.set(site, failures);
    if (new Set(failures.map((f) => f.url)).size < UNREACHABLE_FAILURES) return null;
    this.failures.delete(site);
    return this.block(url, 'unreachable');
  }
  // A verification challenge that the same tab got past (a new successful
  // document of that site without a barrier) proves access again. Rate limits
  // and IP blocks keep their wait: one page view says nothing about pacing.
  recoverVerification(url, blockedAt) {
    const previous = this.row(url);
    if (
      !previous ||
      previous.recovered ||
      previous.reason !== 'verification' ||
      previous.blockedAt !== blockedAt
    )
      return false;
    this.save({...previous, recovered: true, token: null, leaseUntil: 0, retryAt: null});
    return true;
  }
  complete(url, token, {status, reason, retryAfter, retryDelays} = {}) {
    if (!reason && status >= 200 && status < 400)
      this.failures.delete(waitKey(siteKey(url), this.lane));
    if (reason) return this.block(url, reason, retryAfter, token, retryDelays);
    const previous = this.row(url);
    if (!previous || !token || previous.token !== token) return null;
    if (status >= 200 && status < 400) {
      this.save({...previous, recovered: true, token: null, leaseUntil: 0, retryAt: null});
      return null;
    }
    // A failed/uncertain probe is not proof that access recovered.
    return this.block(
      url,
      previous.reason === 'budget' ? 'rate_limit' : previous.reason,
      retryAfter,
      token,
      retryDelays,
    );
  }
}
