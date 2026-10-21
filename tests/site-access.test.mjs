import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SiteAccess,
  accessBarrier,
  retryAfterTime,
  networkFailure,
} from '../app/browser/site-access.mjs';
import {JevBrowser} from '../app/jev/browser.mjs';
import {documentReadiness} from '../app/jev/document.mjs';
const url = 'https://www.kleinanzeigen.de/list',
  minute = 60000;

test('a user response retires only its incident; observing a real challenge blocks again', () => {
  const db = new DatabaseSync(':memory:');
  let now = 100000;
  const gate = new SiteAccess(db, {now: () => now});
  try {
    const first = gate.block(url, 'verification');
    gate.acknowledge([first]);
    assert.equal(gate.status(url), null);
    now++;
    const next = gate.complete(url, null, {status: 403, reason: 'verification'});
    assert.ok(next.waiting);
    assert.throws(() => gate.acknowledge([first]), /new access wait/);
    assert.equal(gate.status(url).blockedAt, next.blockedAt);
    now = next.retryAt;
    gate.begin(url);
    assert.throws(() => gate.acknowledge([next]), /new access wait/);
  } finally {
    db.close();
  }
});

test('only explicit access barriers cause a shared wait', () => {
  assert.equal(accessBarrier({status: 403, text: 'Forbidden'}), null);
  assert.equal(
    accessBarrier({
      status: 200,
      text: 'An article about Your IP address has been temporarily blocked.',
    }),
    null,
  );
  assert.equal(
    accessBarrier({status: 403, text: 'Your IP address has been temporarily blocked.\nTry later'}),
    'ip_block',
  );
  assert.equal(accessBarrier({status: 429}), 'rate_limit');
});
const challenge = {
  title: 'Just a moment...',
  text: 'Link: Indeed Home — https://www.indeed.com/\nFind jobs\nAdditional Verification Required\nYour Ray ID for this request is synthetic-ray\nTroubleshooting Cloudflare Errors\nContact us',
};
test('Cloudflare challenge detection requires the verification title and body together', () => {
  for (const status of [200, 403])
    assert.equal(accessBarrier({status, ...challenge}), 'verification');
  assert.equal(accessBarrier({...challenge, title: 'Cloudflare Security Engineer'}), null);
  assert.equal(
    accessBarrier({
      ...challenge,
      text: 'A listing mentions Additional Verification Required and Cloudflare.',
    }),
    null,
  );
  assert.equal(
    accessBarrier({title: 'Just a moment...', text: 'Loading the job description'}),
    null,
  );
  assert.equal(
    accessBarrier({title: 'Just a moment...', text: 'Additional Verification Required'}),
    null,
  );
  assert.equal(
    accessBarrier({
      title: 'Just a moment...',
      text: 'himalayas.app\nPerforming security verification\nThis website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\nRay ID:\na44a19d13d8ee525\nPerformance and Security by\nLink: Cloudflare, opens in a new tab — https://www.cloudflare.com/\nCloudflare',
    }),
    'verification',
    'the newer interstitial wording',
  );
  assert.equal(
    accessBarrier({
      title: 'Just a moment...',
      text: 'Link: Cloudflare, opens in a new tab — https://www.cloudflare.com/privacypolicy/\nPrivacy',
    }),
    null,
    'footer links alone are not a verification body',
  );
});
test('browser observation detects a challenge before creating listing evidence and shares its wait', async () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db),
    browser = new JevBrowser('/unused', {siteAccess: gate, challengeGraceMs: 0});
  // A record tab gets no checkbox attempt.
  browser.automationTabs.set('owned', 'record:1');
  let reads = 0;
  const slot = {
    id: 'owned',
    http: {url, status: 200},
    page: {evaluate: async () => (++reads === 1 ? {loading: false} : {url, ...challenge})},
  };
  try {
    await assert.rejects(
      browser.observeOnce(slot),
      (error) =>
        error.code === 'SITE_WAIT' && error.wait.reason === 'verification' && error.url === url,
    );
    assert.equal(slot.observed, undefined);
    assert.equal(reads, 2);
    assert.match(gate.status(url).message, /access verification/);
    assert.throws(() => gate.begin(url + '/another'), {code: 'SITE_WAIT'});
    assert.equal(gate.begin('https://other.example/list'), null);
  } finally {
    db.close();
  }
});
test('a challenge that passes on its own during the grace period starts no site wait', async () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db),
    browser = new JevBrowser('/unused', {siteAccess: gate, challengeGraceMs: 50});
  const listing = {url, title: 'Staff Engineer', text: 'Listing description'};
  const slot = {
    id: 'owned',
    http: {url, status: 200},
    page: {
      evaluate: async (fn) => (fn === documentReadiness ? {url, loading: false} : listing),
    },
  };
  try {
    const result = await browser.awaitSelfClearingChallenge(slot, {url, ...challenge});
    assert.equal(result.title, 'Staff Engineer');
    assert.equal(gate.status(url), null);
    const again = {url, ...challenge};
    assert.equal(
      await browser.awaitSelfClearingChallenge(slot, again),
      again,
      'one grace period per response',
    );
  } finally {
    db.close();
  }
});
test('a challenge that outlasts the grace period still starts the shared wait', async () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db),
    browser = new JevBrowser('/unused', {siteAccess: gate, challengeGraceMs: 30});
  browser.automationTabs.set('owned', 'record:1');
  const slot = {
    id: 'owned',
    http: {url, status: 200},
    page: {
      evaluate: async (fn) =>
        fn === documentReadiness ? {url, loading: false} : {url, ...challenge},
    },
  };
  try {
    await assert.rejects(browser.observeOnce(slot), (error) => error.code === 'SITE_WAIT');
    assert.equal(gate.status(url).reason, 'verification');
  } finally {
    db.close();
  }
});
test('a 429 challenge page is judged from its loaded document and gets the native checkbox attempt, not a rate-limit wait', async () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db),
    browser = new JevBrowser('/unused', {siteAccess: gate});
  const calls = [];
  let readiness = 0;
  const page = {
    evaluate: async (fn) => {
      if (fn === documentReadiness) {
        calls.push('readiness');
        // The challenge document is still parsing when the response arrives.
        return ++readiness === 1
          ? {url, loading: true, reason: 'document_loading'}
          : {url, loading: false};
      }
      if (typeof fn === 'function') return fn();
      calls.push('reader');
      return {url, ...challenge};
    },
    frames: () => [],
    locator: () => ({evaluateAll: async () => false}),
  };
  const slot = {id: 'owned', http: {url, status: 429}, page};
  try {
    const result = await browser.observeOnce(slot);
    assert.equal(result.status, 'verification_pending');
    assert.equal(result.captcha.kind, 'cloudflare_checkbox');
    assert.deepEqual(calls, ['readiness', 'readiness', 'reader']);
    assert.equal(gate.status(url), null, 'no site wait while the checkbox attempt is pending');
    assert.equal(gate.begin(url + '/another'), null);
  } finally {
    db.close();
  }
});
test('an ordinary 429 page still starts the rate-limit wait from its loaded document', async () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db),
    browser = new JevBrowser('/unused', {siteAccess: gate});
  const slot = {
    id: 'owned',
    http: {url, status: 429},
    page: {
      evaluate: async (fn) =>
        fn === documentReadiness
          ? {url, loading: false}
          : {url, title: 'Too Many Requests', text: 'Rate limit exceeded. Try again later.'},
      frames: () => [],
    },
  };
  try {
    await assert.rejects(
      browser.observeOnce(slot),
      (error) =>
        error.code === 'SITE_WAIT' && error.wait.reason === 'rate_limit' && error.url === url,
    );
    assert.equal(slot.observed, undefined);
    assert.ok(gate.status(url).waiting);
  } finally {
    db.close();
  }
});
test('a 429 navigation that gives up before its document loads leaves the decision to the observation', async () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db);
  const slotFor = () => {
    const slot = {
      id: 'owned',
      page: {
        addInitScript: async () => {},
        evaluate: async () => {},
        goto: async () => {
          slot.http = {url, status: 429};
          throw Error('page.goto: Timeout 20000ms exceeded.');
        },
      },
    };
    return slot;
  };
  try {
    const verifying = new JevBrowser('/unused', {siteAccess: gate}),
      pending = slotFor();
    await assert.rejects(verifying.navigate(pending, url), /Timeout/);
    assert.equal(gate.status(url), null, 'no rate-limit wait before the document is read');
    assert.deepEqual(
      pending.accessProbe,
      {url, token: null},
      'the probe stays for the observation',
    );
  } finally {
    db.close();
  }
});
test('persistent host wait retries at five and ten minutes, then requires intervention', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-wait-')),
    file = path.join(dir, 'state.sqlite');
  let db = new DatabaseSync(file),
    now = 10000000;
  t.after(async () => {
    db.close();
    await rm(dir, {recursive: true, force: true});
  });
  let gate = new SiteAccess(db, {now: () => now});
  gate.block(url, 'ip_block');
  assert.equal(gate.status(url).retryAt, now + 5 * minute);
  assert.throws(() => gate.begin('https://kleinanzeigen.de/another'), {code: 'SITE_WAIT'});
  assert.equal(gate.begin('https://www.ebay.de/list'), null);
  now += minute;
  gate.block(url, 'ip_block');
  assert.equal(gate.status(url).attempts, 1);
  db.close();
  db = new DatabaseSync(file);
  gate = new SiteAccess(db, {now: () => now});
  now = gate.status(url).retryAt;
  const token = gate.begin(url);
  const other = new SiteAccess(db, {now: () => now});
  assert.throws(() => other.begin(url), {code: 'SITE_WAIT'});
  gate.complete(url, token, {status: 403, reason: 'ip_block'});
  assert.equal(gate.status(url).retryAt, now + 10 * minute);
  now = gate.status(url).retryAt;
  gate.complete(url, gate.begin(url), {status: 429, reason: 'rate_limit'});
  assert.equal(gate.status(url).retryAt, null);
  const stopped = gate.status(url);
  assert.equal(stopped.exhausted, true);
  assert.equal(stopped.attempts, 3);
  now += 24 * 60 * minute;
  assert.throws(() => gate.begin(url), {code: 'SITE_WAIT'});
  gate.complete(url, 'stale', {status: 200});
  assert.equal(gate.status(url).exhausted, true);
  db.close();
  db = new DatabaseSync(file);
  gate = new SiteAccess(db, {now: () => now});
  assert.equal(gate.status(url).exhausted, true);
  gate.acknowledge([stopped]);
  assert.equal(gate.status(url), null);
  assert.equal(gate.block(url, 'rate_limit').attempts, 1);
});
test('the explicit retry policy is five then ten minutes, including uncertain probes', () => {
  const db = new DatabaseSync(':memory:');
  let now = 10000000;
  const gate = new SiteAccess(db, {now: () => now});
  try {
    gate.block(url, 'rate_limit', '180');
    assert.equal(gate.status(url).retryAt, now + 5 * minute);
    now += 5 * minute;
    const token = gate.begin(url);
    gate.complete(url, token, {status: 403});
    assert.ok(gate.status(url).waiting);
    assert.equal(gate.status(url).attempts, 2);
    assert.equal(gate.status(url).retryAt, now + 10 * minute);
    now += 10 * minute;
    gate.complete(url, gate.begin(url), {});
    assert.equal(gate.status(url).exhausted, true);
    assert.equal(retryAfterTime(new Date(now + 5 * minute).toUTCString(), now), now + 5 * minute);
    assert.equal(retryAfterTime('invalid', now), null);
  } finally {
    db.close();
  }
});

test('a healthy probe preserves the scan retry budget until completion and stale completions cannot clear new incidents', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1000000;
  const gate = new SiteAccess(db, {now: () => now});
  try {
    const first = gate.block(url, 'rate_limit');
    now = first.retryAt;
    gate.complete(url, gate.begin(url), {status: 200});
    assert.equal(gate.status(url), null);
    const second = gate.block(url + '?page=2', 'verification');
    assert.equal(second.attempts, 2);
    assert.equal(second.retryAt, now + 10 * minute);
    gate.finish([first]);
    assert.equal(gate.status(url).attempts, 2);
    now = second.retryAt;
    gate.complete(url, gate.begin(url), {status: 200});
    gate.finish([first]);
    assert.equal(gate.row(url).attempts, 2);
    gate.finish([second]);
    assert.equal(gate.row(url), null);
    assert.equal(gate.block(url, 'ip_block').attempts, 1);
  } finally {
    db.close();
  }
});

test('a site that recovered and worked for an hour starts a new incident with a fresh retry budget', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1000000;
  const gate = new SiteAccess(db, {now: () => now});
  try {
    const first = gate.block(url, 'rate_limit');
    now = first.retryAt;
    gate.complete(url, gate.begin(url), {status: 200});
    now += 30 * minute;
    assert.equal(gate.block(url, 'rate_limit').attempts, 2, 'soon after recovery it continues');
    now = gate.status(url).retryAt;
    gate.complete(url, gate.begin(url), {status: 200});
    now += 2 * 60 * minute;
    const fresh = gate.block(url, 'rate_limit');
    assert.equal(fresh.attempts, 1);
    assert.equal(fresh.retryAt, now + 5 * minute);
    // A wait that was never probed successfully keeps counting.
    now = fresh.retryAt + 2 * 60 * minute;
    gate.complete(url, gate.begin(url), {status: 429, reason: 'rate_limit'});
    assert.equal(gate.status(url).attempts, 2);
  } finally {
    db.close();
  }
});

test('every site keeps eight seconds between navigations; one that rate-limited recently waits longer', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const gate = new SiteAccess(db, {now: () => now});
  try {
    assert.equal(gate.pace('https://calm.test/a'), 0);
    assert.equal(gate.pace('https://calm.test/b'), 8000, 'a calm site keeps the minimum gap');
    assert.equal(gate.pace('https://other.test/a'), 0, 'other sites do not queue behind it');
    gate.block(url, 'rate_limit');
    now += 6 * minute;
    assert.equal(gate.pace(url), 0, 'the first navigation after the wait leaves immediately');
    assert.equal(gate.pace(url), 10000, 'the next one keeps a ten second gap');
    assert.equal(
      gate.pace('https://kleinanzeigen.de/other'),
      20000,
      'the same site queues the following slot',
    );
    now += 40000;
    assert.equal(gate.pace(url), 0, 'elapsed time frees the slot');
    gate.acknowledge([gate.status(url)]);
    assert.equal(gate.status(url), null);
    assert.equal(gate.pace(url), 10000, 'a user answer clears the wait, not the pacing');
    now += 7 * 60 * minute;
    assert.equal(gate.pace(url), 0, 'the incident gap expires hours after the last incident');
    assert.equal(gate.pace(url), 8000, 'the minimum gap stays');
    const fresh = new SiteAccess(db, {now: () => now});
    gate.block(url, 'verification');
    assert.ok(fresh.pace(url) >= 0, 'a new process derives pacing from the saved incident');
  } finally {
    db.close();
  }
});

test("a site's request budget parks requests over it as a shared wait that is no incident", () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const gate = new SiteAccess(db, {now: () => now}),
    budget = {requests: 2, windowMs: 30 * minute},
    site = 'https://budget.test/';
  try {
    assert.equal(gate.spend(site + 'a', budget), null);
    now += minute;
    assert.equal(gate.spend(site + 'b', budget), null);
    assert.equal(gate.spend('https://other.test/', budget), null, 'other sites keep their own');
    const held = gate.spend(site + 'c', budget);
    assert.equal(held.waiting, true);
    assert.equal(held.reason, 'budget');
    assert.equal(held.attempts, 0, 'a used budget is no access failure');
    assert.equal(held.retryAt, 1_000_000 + 30 * minute, 'until the oldest request leaves');
    assert.match(held.message, /request budget/);
    assert.throws(() => gate.begin(site + 'c'), {code: 'SITE_WAIT'});
    assert.equal(gate.pace(site + 'd'), 0, 'the budget wait adds no incident gap');
    assert.equal(gate.pace(site + 'e'), 8000);
    now = held.retryAt;
    const token = gate.begin(site + 'f');
    assert.equal(gate.spend(site + 'f', budget), null, 'the freed slot is spent');
    gate.complete(site + 'f', token, {status: 200});
    gate.finish([held]);
    assert.equal(gate.status(site), null, 'a successful request retires the wait');
    // A 429 during a budget wait's probe is a rate limit.
    now += 30 * minute;
    gate.spend(site + 'g', budget);
    gate.spend(site + 'h', budget);
    const again = gate.spend(site + 'i', budget);
    now = again.retryAt;
    gate.complete(site + 'i', gate.begin(site + 'i'), {status: 500});
    assert.equal(gate.status(site).reason, 'rate_limit');
    assert.equal(gate.status(site).attempts, 1);
    // A lowered budget waits until the window holds fewer requests than it allows.
    const lowered = 'https://lowered.test/';
    for (const step of [0, 1, 2, 3]) {
      now += minute;
      gate.spend(lowered + step, {requests: 4, windowMs: 30 * minute});
    }
    const start = now - 3 * minute;
    assert.equal(
      gate.spend(lowered + 'x', budget).retryAt,
      start + 2 * minute + 30 * minute,
      'the third request leaving frees a slot of two',
    );
  } finally {
    db.close();
  }
});

test("a site's own retry delays replace the default cooldown", () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const gate = new SiteAccess(db, {now: () => now}),
    retryDelays = [30 * minute, 90 * minute],
    site = 'https://slow-cooldown.test/';
  try {
    const first = gate.complete(site, null, {status: 429, reason: 'rate_limit', retryDelays});
    assert.equal(first.retryAt, now + 30 * minute);
    now = first.retryAt;
    const second = gate.complete(site, gate.begin(site), {
      status: 429,
      reason: 'rate_limit',
      retryDelays,
    });
    assert.equal(second.attempts, 2);
    assert.equal(second.retryAt, now + 90 * minute);
    now = second.retryAt;
    const third = gate.complete(site, gate.begin(site), {
      status: 429,
      reason: 'rate_limit',
      retryDelays,
    });
    assert.equal(third.exhausted, true, 'after the stated retries the wait needs the user');
    assert.equal(gate.block('https://default.test/', 'rate_limit').retryAt, now + 5 * minute);
  } finally {
    db.close();
  }
});

test('a request budget survives an app restart', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const budget = {requests: 2, windowMs: 30 * minute},
    site = 'https://restart-budget.test/';
  try {
    const before = new SiteAccess(db, {now: () => now});
    assert.equal(before.spend(site + 'a', budget), null);
    assert.equal(before.spend(site + 'b', budget), null);
    const after = new SiteAccess(db, {now: () => now});
    assert.equal(after.spend(site + 'c', budget).reason, 'budget', 'the restart keeps the count');
    now += 30 * minute;
    assert.equal(after.spend(site + 'd', budget), null, 'old requests leave the window');
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM site_requests').get().n,
      1,
      'expired requests are pruned',
    );
  } finally {
    db.close();
  }
});

test('a lowered page budget waits until enough pages leave the window, not one minute', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  try {
    const access = new SiteAccess(db, {now: () => now});
    for (let i = 0; i < 5; i++) {
      assert.equal(access.reserve('lowered.test browser', {requests: 5, windowMs: 60 * minute}), 0);
      now += minute;
    }
    // Five pages in the hour, now a budget of three: two must leave first.
    assert.equal(
      access.reserve('lowered.test browser', {requests: 3, windowMs: 60 * minute}),
      1_000_000 + 2 * minute + 60 * minute - now,
    );
  } finally {
    db.close();
  }
});

test('an old wait card retires even when a later incident of the site already recovered', () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const gate = new SiteAccess(db, {now: () => now}),
    site = 'https://card.test/';
  try {
    const old = gate.block(site, 'rate_limit');
    gate.acknowledge([old]);
    now += 60 * minute;
    const later = gate.block(site, 'rate_limit');
    now = later.retryAt;
    gate.complete(site, gate.begin(site), {status: 200});
    assert.doesNotThrow(() => gate.acknowledge([old]), 'the recovered incident blocks nothing');
    assert.equal(gate.row(site).recovered, true, 'the recovered row stays for its task');
    gate.save({...gate.row(site), recovered: false, retryAt: now + minute});
    assert.throws(() => gate.acknowledge([old]), /new access wait/);
  } finally {
    db.close();
  }
});

test('the request rate counts sent requests per site, with the budget it uses', () => {
  const db = new DatabaseSync(':memory:');
  let now = 10 * 60 * minute;
  const gate = new SiteAccess(db, {now: () => now}),
    budget = {requests: 30, windowMs: 60 * minute};
  try {
    gate.pace('https://rate.test/a');
    gate.spend('https://rate.test/a', budget);
    const queued = gate.pace('https://rate.test/b');
    assert.equal(
      gate.requestRate('https://www.rate.test/').lastHour,
      1,
      'a queued slot is not sent',
    );
    now += queued;
    let rate = gate.requestRate('https://rate.test/', {
      minIntervalMs: 45000,
      jitterMs: 30000,
      budget,
    });
    assert.equal(rate.lastTenMinutes, 2);
    assert.equal(rate.minGapMs, 45000);
    assert.deepEqual(rate.budget, {requests: 30, windowMs: 60 * minute, used: 1});
    assert.equal(gate.requestRate('https://other.test/').lastHour, 0, 'other sites count apart');
    now += 15 * minute;
    rate = gate.requestRate('https://rate.test/');
    assert.equal(rate.lastTenMinutes, 0);
    assert.equal(rate.lastHour, 2);
    assert.equal(rate.minGapMs, 8000, 'the minimum gap every site keeps');
    assert.equal(rate.budget, undefined);
    now += 60 * minute;
    assert.equal(gate.requestRate('https://rate.test/').lastHour, 0);
  } finally {
    db.close();
  }
});

test('jitter adds a random part to the gap', () => {
  const db = new DatabaseSync(':memory:');
  const gate = new SiteAccess(db, {now: () => 1_000_000});
  try {
    gate.pace('https://jitter.test/a', 15000, 10000);
    const gap = gate.pace('https://jitter.test/b', 15000, 10000);
    assert.ok(gap >= 15000 && gap < 25000, String(gap));
  } finally {
    db.close();
  }
});

test("a site's own minimum spacing (crawl delay) paces every request, not only after an incident", () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const gate = new SiteAccess(db, {now: () => now});
  try {
    // A stated gap above the minimum gap every site keeps.
    assert.equal(gate.pace('https://slow.test/a', 20000), 0, 'the first request leaves at once');
    assert.equal(gate.pace('https://slow.test/b', 20000), 20000, 'the next keeps the stated gap');
    assert.equal(gate.pace('https://slow.test/c', 20000), 40000, 'concurrent callers queue');
    assert.equal(gate.pace('https://other.test/', 0), 0, 'other sites never wait');
    now += 60000;
    assert.equal(gate.pace('https://slow.test/d', 20000), 0, 'elapsed time frees the slot');
    gate.block('https://slow.test/', 'rate_limit');
    now += 6 * minute;
    gate.pace('https://slow.test/e', 20000);
    assert.equal(
      gate.pace('https://slow.test/f', 1000),
      10000,
      'after an incident the larger gap applies',
    );
  } finally {
    db.close();
  }
});

test('repeated transport failures across a site start a shared wait; one address or a success does not', () => {
  const db = new DatabaseSync(':memory:');
  let now = 100000;
  const gate = new SiteAccess(db, {now: () => now});
  const h2 = Object.assign(
    Error('net::ERR_HTTP2_PROTOCOL_ERROR at https://www.stepstone.de/x'),
    {},
  );
  try {
    assert.equal(
      gate.unreachable(url, Error('Timeout 20000ms exceeded')),
      null,
      'a timeout alone is not a transport failure',
    );
    assert.equal(
      gate.unreachable(url, Error('net::ERR_ABORTED')),
      null,
      'an interrupted navigation is not an outage',
    );
    for (let i = 0; i < 4; i++)
      assert.equal(gate.unreachable(url, h2), null, 'the same address never blocks the site');
    for (let i = 0; i < 3; i++)
      assert.equal(
        gate.unreachable(url + '?page=7&q=b', h2),
        null,
        'two refused pages are those pages, not the site',
      );
    gate.failures.clear();
    gate.failures.clear();
    assert.equal(gate.unreachable(url, h2), null);
    now += 1000;
    assert.equal(gate.unreachable(url + '?page=2', h2), null);
    now += 1000;
    gate.complete(url + '?page=3', null, {status: 200});
    assert.equal(
      gate.unreachable(url + '?page=4', h2),
      null,
      'a success in between resets the count',
    );
    now += 1000;
    assert.equal(gate.unreachable(url + '?page=5', h2), null);
    now += 1000;
    const wait = gate.unreachable(url + '?page=6', h2);
    assert.equal(wait.reason, 'unreachable');
    assert.equal(wait.attempts, 1);
    assert.equal(wait.retryAt, now + 5 * minute);
    assert.match(wait.message, /unreachable/);
    assert.throws(
      () => gate.begin(url),
      (error) => error.code === 'SITE_WAIT',
    );
    now = wait.retryAt;
    const token = gate.begin(url);
    assert.equal(gate.complete(url, token, {status: 200}), null);
    assert.equal(gate.status(url), null, 'a successful probe recovers the site');
    // A retained tab that only acts (no navigation) probes with its first action.
    const later = gate.block(url, 'rate_limit');
    assert.throws(
      () => gate.assertAction(url),
      (error) => error.code === 'SITE_WAIT',
    );
    now = later.retryAt;
    const action = gate.assertAction(url);
    assert.ok(action, 'the first action after the wait takes the probe');
    assert.throws(
      () => gate.assertAction(url),
      (error) => error.code === 'SITE_WAIT',
    );
    assert.equal(gate.complete(url, action, {status: 200}), null);
    assert.equal(gate.status(url), null);
    assert.ok(networkFailure(h2));
    assert.equal(networkFailure(Error('Navigation failed')), false);
  } finally {
    db.close();
  }
});

test('a verification the same tab got past ends the shared wait; rate limits and newer incidents stay', () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db);
  const url = 'https://jobs.example/listing/1';
  const verification = gate.block(url, 'verification');
  assert.equal(gate.status(url).waiting, true);
  // A stale incident marker cannot clear a newer wait.
  assert.equal(gate.recoverVerification(url, verification.blockedAt - 1), false);
  assert.equal(gate.status(url).waiting, true);
  assert.equal(gate.recoverVerification(url, verification.blockedAt), true);
  assert.equal(gate.status(url), null);
  gate.assertAction(url);
  const limited = gate.block('https://limited.example/', 'rate_limit');
  assert.equal(gate.recoverVerification('https://limited.example/', limited.blockedAt), false);
  assert.equal(gate.status('https://limited.example/').waiting, true);
  db.close();
});

test('a run of page views is followed by a shared break; a natural pause counts as one', () => {
  const db = new DatabaseSync(':memory:');
  let now = 100000;
  const gate = new SiteAccess(db, {now: () => now});
  const options = {views: [3, 3], pause: [4 * minute, 4 * minute]};
  for (let i = 0; i < 3; i++) {
    assert.equal(gate.rest('site browser', options), 0);
    now += 15000;
  }
  const wait = gate.rest('site browser', options);
  assert.equal(wait, 4 * minute);
  // A second reader of the same site waits for the same break.
  now += minute;
  assert.equal(gate.rest('site browser', options), 3 * minute);
  // Another site is not affected.
  assert.equal(gate.rest('other browser', options), 0);
  now += 3 * minute;
  assert.equal(gate.rest('site browser', options), 0);
  // Two more views, then a natural pause as long as a break starts a new run.
  now += 15000;
  assert.equal(gate.rest('site browser', options), 0);
  now += 4 * minute;
  for (let i = 0; i < 3; i++) {
    assert.equal(gate.rest('site browser', options), 0);
    now += 15000;
  }
  assert.ok(gate.rest('site browser', options) > 0);
});

test('the default break follows 15-30 views and lasts 4-10 minutes', () => {
  const db = new DatabaseSync(':memory:');
  let now = 100000;
  const gate = new SiteAccess(db, {now: () => now});
  let views = 0,
    wait = 0;
  while (!(wait = gate.rest('site browser'))) {
    views++;
    now += 12000;
  }
  assert.ok(views >= 15 && views <= 30, String(views));
  assert.ok(wait >= 4 * minute && wait <= 10 * minute, String(wait));
});
