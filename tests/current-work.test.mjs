import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currentWork} from '../app/automation/current-work.mjs';

const source = (url, extra = {}) => ({url, name: new URL(url).hostname, enabled: true, ...extra});

test('current work lists a running scan with its live search and page progress', () => {
  const rows = currentWork({
    automation: {status: 'enabled', questions: []},
    workers: [{id: 'main', name: 'Worker 1'}],
    activeRuns: [{id: 'r1'}],
    runs: [
      {
        id: 'r1',
        kind: 'run',
        operation: 'scan',
        status: 'running',
        workerId: 'main',
        sourceUrl: 'https://jobs.example/',
        startedAt: 1,
        foundCount: 2,
        pageProgress: {currentPage: 3, totalPages: 4, at: 5},
      },
    ],
    sources: [
      source('https://jobs.example/', {
        scanning: true,
        activity: {
          step: 'listing',
          done: 1,
          total: 4,
          title: 'Backend',
          company: 'Acme',
          browser: true,
        },
        scan: {
          work: {
            activeSearchId: 'b',
            searches: [
              {id: 'a', label: 'backend', status: 'completed', pendingUrls: [], excluded: [{}, {}]},
              {
                id: 'b',
                label: 'platform',
                status: 'pending',
                pendingUrls: ['x', 'y'],
                excluded: [{}],
              },
            ],
          },
        },
      }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    {...rows[0], progress: undefined, now: undefined},
    {
      id: 'r1',
      title: 'Source scan',
      subject: 'jobs.example',
      worker: 'Worker 1',
      state: 'Running',
      tone: 'running',
      progress: undefined,
      now: undefined,
      startedAt: 1,
      updatedAt: 5,
      stop: {sourceUrl: 'https://jobs.example/'},
    },
  );
  assert.equal(
    rows[0].progress,
    'Search 2/2 (platform) · page 3/4 · 2 addresses pending · 3 excluded · 2 new records',
  );
  assert.equal(rows[0].now, 'Now: Reading listing 2/4 in the browser: Backend @ Acme');
});

test('a running scan shows the search its run moved to before the source saved it', () => {
  const work = (activeSearchId, first) => ({
    work: {
      activeSearchId,
      searches: [
        {id: 'a', label: 'staff', status: first, pendingUrls: []},
        {id: 'b', label: 'backend', status: 'pending', pendingUrls: []},
      ],
    },
  });
  const [row] = currentWork({
    automation: {status: 'enabled', questions: []},
    activeRuns: [{id: 'r1'}],
    runs: [
      {
        id: 'r1',
        kind: 'run',
        operation: 'scan',
        status: 'running',
        sourceUrl: 'https://jobs.example/',
        scan: work('b', 'completed'),
      },
    ],
    sources: [source('https://jobs.example/', {scan: work('a', 'pending')})],
  });
  assert.equal(row.progress, 'Search 2/2 (backend) · 0 new records');
});

test('current work shows queued tasks oldest first and the waits, skipping the setup chat', () => {
  const rows = currentWork({
    automation: {
      status: 'enabled',
      questions: [
        {id: 'q1', text: 'Maaş beklentin?', recordId: 'rec1', answer: null, createdAt: 9},
        {id: 'q2', text: 'eski', answer: 'tamam'},
        {id: 'q3', text: 'sohbet', answer: null, conversation: true},
      ],
    },
    workers: [{id: 'main', name: 'Worker 1'}],
    activeRuns: [{id: 'chat', kind: 'interview', status: 'running'}],
    runs: [],
    results: [{id: 'rec1', title: 'Staff Engineer'}],
    tasks: [
      {id: 't2', state: 'pending', operation: 'record-score', recordId: 'rec1', createdAt: 2},
      {id: 'done', state: 'completed', operation: 'scan', sourceUrl: 'https://b.example/'},
      {id: 't1', state: 'paused', operation: 'scan', sourceUrl: 'https://a.example/', createdAt: 1},
    ],
    sources: [
      source('https://a.example/', {recovery: {readyAt: 7}}),
      source('https://b.example/', {siteWait: {retryAt: 8, message: 'Çok fazla istek'}}),
      source('https://c.example/', {siteWait: {retryAt: 8, exhausted: true}}),
      source('https://d.example/', {recovery: {readyAt: 7}, enabled: false}),
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.title, r.subject, r.state]),
    [
      ['t1', 'Source scan', 'a.example', 'Paused'],
      ['t2', 'Scoring listing', 'Staff Engineer', 'Queued'],
      ['wait:https://b.example/', 'Access wait', 'b.example', 'Waiting'],
      ['question:q1', 'Waiting for your answer', 'Staff Engineer', 'Waiting'],
    ],
  );
  assert.equal(rows[2].resumesAt, 8);
  assert.equal(rows[2].progress, 'Çok fazla istek');
});

test('a long queue shows its first tasks and a count of the rest', () => {
  const tasks = Array.from({length: 25}, (_, i) => ({
    id: 't' + i,
    state: 'pending',
    operation: 'record-prepare',
  }));
  const rows = currentWork({automation: {status: 'paused'}, tasks});
  assert.equal(rows.length, 21);
  assert.equal(rows.at(-1).title, '5 more tasks queued');
});
