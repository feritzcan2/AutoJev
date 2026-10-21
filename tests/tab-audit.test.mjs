import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {judgeTab, closableRecordIds, STALE_RECORD_TAB_MS} from '../app/browser/tab-audit.mjs';
import {configureTabLog, logTab, shortUrl, tabLogFile} from '../app/browser/tab-log.mjs';

const lookup = (runs = {}, records = {}, extra = {}) => ({
  run: (id) => runs[id] ?? null,
  record: (id) => records[id] ?? null,
  waiting: () => false,
  openTask: () => false,
  newerFinishedSourceRun: () => null,
  ...extra,
});
const tab = (fields) => ({tabId: 'T', url: 'https://jobs.example/1', role: 'task', ...fields});

test('tab audit keeps tabs that still have work', () => {
  assert.equal(judgeTab(tab({role: 'home'}), lookup()).verdict, 'keep');
  assert.equal(judgeTab(tab({role: 'spare', url: 'about:blank'}), lookup()).verdict, 'keep');
  const runs = {r: {id: 'r', status: 'running'}, b: {id: 'b', status: 'blocked', recordId: 'x'}};
  assert.equal(judgeTab(tab({runId: 'r'}), lookup(runs)).reason, 'run_running');
  assert.equal(
    judgeTab(tab({runId: 'b'}), lookup(runs, {x: {status: 'prepared'}})).reason,
    'record_prepared',
  );
  assert.equal(
    judgeTab(tab({runId: 'b'}), lookup(runs, {x: {status: 'found'}}, {waiting: () => true})).reason,
    'question',
  );
  assert.equal(
    judgeTab(tab({runId: 'b'}), lookup(runs, {x: {status: 'found'}}, {openTask: () => true}))
      .reason,
    'record_task_open',
  );
});

test('tab audit flags tabs a close rule should have closed or will never close', () => {
  const runs = {
    done: {id: 'done', status: 'completed', recordId: 'x'},
    blocked: {id: 'blocked', status: 'blocked', recordId: 'y'},
    scan: {id: 'scan', status: 'interrupted', sourceUrl: 'https://jobs.example/'},
    trial: {id: 'trial', status: 'completed', kind: 'trial', sourceUrl: 'https://jobs.example/'},
  };
  const records = {x: {status: 'completed'}, y: {status: 'found'}};
  assert.deepEqual(judgeTab(tab({runId: 'gone'}), lookup(runs)), {
    verdict: 'leak',
    reason: 'run_missing',
  });
  assert.equal(judgeTab(tab({runId: 'done'}), lookup(runs, records)).reason, 'record_completed');
  assert.deepEqual(judgeTab(tab({runId: 'blocked'}), lookup(runs, records)), {
    verdict: 'stale',
    reason: 'record_found_run_blocked',
  });
  assert.equal(judgeTab(tab({runId: 'scan'}), lookup(runs)).verdict, 'keep');
  assert.equal(
    judgeTab(tab({runId: 'scan'}), lookup(runs, {}, {newerFinishedSourceRun: () => runs.trial}))
      .verdict,
    'leak',
  );
  assert.equal(judgeTab(tab({runId: 'trial'}), lookup(runs)).reason, 'source_finished');
  assert.equal(judgeTab(tab({role: 'spare'}), lookup()).verdict, 'leak');
});

test('tab log writes one JSON line per event without query strings', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'tab-log-')), 'logs', 'tabs.jsonl');
  configureTabLog(file);
  assert.equal(tabLogFile(), file);
  assert.equal(shortUrl('https://jobs.example/a/b?token=secret#x'), 'https://jobs.example/a/b');
  logTab('open', {tab: 'T', url: shortUrl('https://jobs.example/?q=1')});
  logTab('closed', {tab: 'T', reason: 'run_finished'});
  for (let i = 0; i < 50 && !(await readFile(file, 'utf8').catch(() => '')).includes('closed'); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const lines = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => [line.event, line.tab, line.url ?? line.reason]),
    [
      ['open', 'T', 'https://jobs.example/'],
      ['closed', 'T', 'run_finished'],
    ],
  );
});

test('skipped, applied and deleted records have their idle tabs closed', () => {
  const runs = {
    done: {id: 'done', status: 'interrupted', recordId: 'skipped'},
    live: {id: 'live', status: 'running', recordId: 'skipped2'},
    asked: {id: 'asked', status: 'completed', recordId: 'applied2'},
  };
  const records = {
    skipped: {status: 'dismissed'},
    skipped2: {status: 'dismissed'},
    applied: {status: 'completed'},
    applied2: {status: 'completed'},
    open: {status: 'found'},
  };
  const tabs = [
    tab({tabId: '1', runId: 'done'}),
    tab({tabId: '2', runId: 'live'}),
    tab({tabId: '3', runId: 'asked'}),
    tab({tabId: '4', recordId: 'applied'}),
    tab({tabId: '5', recordId: 'deleted'}),
    tab({tabId: '6', recordId: 'open'}),
    tab({tabId: '7', role: 'home', recordId: 'skipped'}),
  ];
  assert.deepEqual(
    closableRecordIds(tabs, lookup(runs, records, {waiting: (run) => run === 'asked'})),
    ['skipped', 'applied', 'deleted'],
  );
});

test('stopped applications nothing picks up close their tabs after the grace time', () => {
  const now = 10 * STALE_RECORD_TAB_MS;
  const runs = {
    old: {id: 'old', status: 'blocked', recordId: 'a', finishedAt: now - STALE_RECORD_TAB_MS},
    recent: {id: 'recent', status: 'failed', recordId: 'b', finishedAt: now - 60000},
    queued: {id: 'queued', status: 'blocked', recordId: 'c', finishedAt: 0},
    form: {id: 'form', status: 'blocked', recordId: 'd', finishedAt: 0},
    check: {id: 'check', status: 'blocked', recordId: 'e', finishedAt: 0},
  };
  const records = {
    a: {status: 'found'},
    b: {status: 'found'},
    c: {status: 'found'},
    d: {status: 'uncertain'},
    e: {status: 'found'},
  };
  const tabs = [
    tab({tabId: '1', runId: 'old'}),
    tab({tabId: '2', runId: 'recent'}),
    tab({tabId: '3', runId: 'queued'}),
    tab({tabId: '4', runId: 'form'}),
    tab({tabId: '5', runId: 'check'}),
    tab({tabId: '6', runId: 'check', verification: true}),
  ];
  assert.deepEqual(
    closableRecordIds(tabs, lookup(runs, records, {openTask: (run) => run.id === 'queued'}), now),
    ['a'],
  );
});
