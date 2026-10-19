import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {APPLY_LANE, SiteAccess, runSiteLane} from '../app/browser/site-access.mjs';

// Scans and applications keep separate shared waits for the same site.
let now = 1_000_000;
const access = new SiteAccess(new DatabaseSync(':memory:'), {now: () => now}),
  apply = access.forLane(APPLY_LANE),
  url = 'https://jobs.example.com/listing/1';

assert.equal(access.forLane(APPLY_LANE), apply);
assert.equal(apply.forLane(undefined), access);
assert.equal(runSiteLane({recordOperation: 'execute'}), APPLY_LANE);
assert.equal(runSiteLane({recordOperation: 'score'}), undefined);
assert.equal(runSiteLane({sourceUrl: url}), undefined);

// A scan rate limit leaves applications on that site free.
assert.equal(access.block(url, 'rate_limit').waiting, true);
assert.throws(() => access.begin(url), {code: 'SITE_WAIT'});
assert.equal(apply.status(url), null);
assert.equal(apply.begin(url), null);
assert.match(access.status(url).message, /shared wait for scans/);

// An application rate limit is its own wait with its own retry budget.
const wait = apply.block(url, 'rate_limit');
assert.equal(wait.lane, APPLY_LANE);
assert.equal(wait.attempts, 1);
assert.match(wait.message, /shared wait for applications/);
assert.equal(access.status(url).attempts, 1);

// Retiring one lane's wait keeps the other.
apply.acknowledge([wait]);
assert.equal(apply.status(url), null);
assert.equal(access.status(url).waiting, true);
access.acknowledge([access.status(url)]);
assert.equal(access.status(url), null);

// Pacing stays shared across lanes.
now += 10 * 60 * 60 * 1000;
const first = access.pace(url),
  second = apply.pace(url);
assert.equal(first, 0);
assert.ok(second > 0);
console.log('site wait lanes ok');
