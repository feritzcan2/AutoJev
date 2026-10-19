import test from 'node:test';
import assert from 'node:assert/strict';
import {siteTurn, SITE_TURN_GAP_MS} from '../app/sources/site-turns.mjs';
import {currentWork} from '../app/automation/current-work.mjs';

const workspace = (id, title, sources, extra = {}) => ({
  id,
  title,
  status: 'enabled',
  sources: Object.keys(sources),
  sourceState: sources,
  ...extra,
});
const store = (...list) => ({list: () => list});
const linkedin = 'https://www.linkedin.com/jobs/',
  now = 10 * 60 * 60000;

test('a workspace waits while another workspace scans the same site, on any of its hosts', () => {
  const s = store(
    workspace('a', 'Ferit', {[linkedin]: {}}),
    workspace('b', 'Irem', {'https://de.linkedin.com/jobs/search': {batchId: 'round'}}),
  );
  assert.deepEqual(siteTurn(s, 'a', linkedin, now), {
    workspaceId: 'b',
    workspace: 'Irem',
    site: 'linkedin.com',
    scanning: true,
  });
  assert.equal(siteTurn(s, 'b', linkedin, now), null, 'its own round is no reason to wait');
  assert.equal(siteTurn(s, 'a', 'https://de.indeed.com/jobs', now), null, 'other sites run freely');
});

test('the next workspace starts 30 minutes after the last other round on the site ended', () => {
  const ended = now - 10 * 60000;
  const s = store(
    workspace('a', 'Ferit', {[linkedin]: {}}),
    workspace('b', 'Irem', {[linkedin]: {roundEndedAt: ended}}),
    workspace('c', 'US', {[linkedin]: {roundEndedAt: ended - 60 * 60000}}),
  );
  assert.equal(siteTurn(s, 'a', linkedin, now).until, ended + SITE_TURN_GAP_MS);
  assert.equal(siteTurn(s, 'a', linkedin, ended + SITE_TURN_GAP_MS), null);
});

test('a paused workspace or a disabled source does not hold the site', () => {
  const s = store(
    workspace('a', 'Ferit', {[linkedin]: {}}),
    workspace('b', 'Irem', {[linkedin]: {batchId: 'round'}}, {status: 'paused'}),
    workspace(
      'c',
      'US',
      {[linkedin]: {batchId: 'round'}},
      {sourceSettings: {[linkedin]: {enabled: false}}},
    ),
  );
  assert.equal(siteTurn(s, 'a', linkedin, now), null);
});

test('Background work lists a source that waits for its turn', () => {
  const rows = currentWork({
    automation: {status: 'enabled', questions: []},
    sources: [
      {
        url: linkedin,
        name: 'LinkedIn',
        enabled: true,
        siteTurn: {workspace: 'Irem', site: 'linkedin.com', scanning: true},
      },
    ],
  });
  assert.equal(rows[0].title, 'Waiting for “Irem” to finish');
  assert.equal(rows[0].subject, 'LinkedIn');
});

test('of two open rounds on one site the earlier goes on and the later waits, then takes the gap', () => {
  const s = store(
    workspace('a', 'Ferit', {[linkedin]: {batchId: 'r1', roundStartedAt: 100}}),
    workspace('b', 'Irem', {[linkedin]: {batchId: 'r2', roundStartedAt: 200}}),
  );
  assert.equal(
    siteTurn(s, 'a', linkedin, now, {startedAt: 100}),
    null,
    'the earlier round goes on',
  );
  assert.equal(siteTurn(s, 'b', linkedin, now, {startedAt: 200}).workspace, 'Ferit');
  const old = store(
    workspace('a', 'Ferit', {[linkedin]: {batchId: 'r1'}}),
    workspace('b', 'Irem', {[linkedin]: {batchId: 'r2'}}),
  );
  assert.equal(
    siteTurn(old, 'a', linkedin, now, {}),
    null,
    'rounds without a start time: id order',
  );
  assert.equal(siteTurn(old, 'b', linkedin, now, {}).workspace, 'Ferit');
  const ended = store(
    workspace('a', 'Ferit', {[linkedin]: {roundEndedAt: now - 60000}}),
    workspace('b', 'Irem', {[linkedin]: {batchId: 'r2', roundStartedAt: 200}}),
  );
  assert.equal(
    siteTurn(ended, 'b', linkedin, now, {startedAt: 200}).until,
    now - 60000 + SITE_TURN_GAP_MS,
  );
  assert.equal(
    siteTurn(ended, 'b', linkedin, now, {startedAt: now}),
    null,
    'a round that ended before this one began is no reason to wait',
  );
});
