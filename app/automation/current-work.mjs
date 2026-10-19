// @ts-check
import {runOperationLabel} from './progress.mjs';
import {isConversation} from '../workspaces/conversation.mjs';
import {sourceActivityText} from '../sources/activity-text.mjs';

const QUEUED_ROWS = 20;

// One row per piece of work that is running or waiting: what it is, which
// worker runs it, its state and live progress. Built from the workspace view
// the renderer already holds, so it adds no store reads.
export function currentWork(view) {
  const {automation: a, sources = [], results = [], workers = [], tasks = [], runs = []} = view;
  const sourceOf = (url) => sources.find((s) => s.url === url) ?? null,
    workerName = (id) => workers.find((w) => w.id === (id ?? 'main'))?.name ?? null,
    sourceUrl = (work) =>
      work.recordId
        ? null
        : (work.sourceUrl ?? (work.sources?.length === 1 ? work.sources[0] : null));
  const subject = (work) => {
    if (work.recordId) {
      const record = results.find((r) => r.id === work.recordId),
        more = (work.recordIds?.length ?? 1) - 1;
      return (
        (record?.title || record?.url || 'Record') +
        (more > 0 ? ` +${more} ${more === 1 ? 'record' : 'records'}` : '')
      );
    }
    const url = sourceUrl(work);
    return url ? (sourceOf(url)?.name ?? url) : null;
  };
  const rows = [],
    covered = new Set();
  for (const slot of view.activeRuns ?? []) {
    const run = runs.find((r) => r.id === slot.id) ?? slot;
    if (isConversation(run) || run.kind === 'interview') continue;
    const source = sourceOf(sourceUrl(run));
    if (source) covered.add(source.url);
    rows.push({
      id: run.id,
      title: runOperationLabel(run.operation, run.kind),
      subject: subject(run),
      worker: workerName(run.workerId),
      state:
        run.status !== 'running'
          ? 'Finishing'
          : source?.scanIssue
            ? 'Page failed to load'
            : 'Running',
      tone: source?.scanIssue ? 'blocked' : 'running',
      progress: source ? scanProgress(source, run) : null,
      now: source?.scanning ? sourceActivityText(source.activity) : null,
      startedAt: run.startedAt ?? null,
      updatedAt: run.pageProgress?.at ?? null,
      stop: source ? {sourceUrl: source.url} : {workerId: run.workerId ?? 'main'},
    });
  }
  // The view holds the newest tasks first; the queue runs oldest first.
  const queued = tasks
    .filter((t) => ['pending', 'paused'].includes(t.state) && t.operation !== 'interview')
    .reverse();
  for (const task of queued.slice(0, QUEUED_ROWS)) {
    const url = sourceUrl(task);
    if (url) covered.add(url);
    rows.push({
      id: task.id,
      title: runOperationLabel(task.operation),
      subject: subject(task),
      worker: task.workerId ? workerName(task.workerId) : null,
      state: task.state === 'paused' ? 'Paused' : 'Queued',
      tone: task.state === 'paused' ? 'blocked' : 'queued',
      progress: null,
      queuedAt: task.createdAt ?? null,
    });
  }
  if (queued.length > QUEUED_ROWS)
    rows.push({
      id: 'queued-more',
      title: `${queued.length - QUEUED_ROWS} more ${queued.length - QUEUED_ROWS === 1 ? 'task' : 'tasks'} queued`,
      tone: 'queued',
    });
  for (const source of sources) {
    if (covered.has(source.url) || !source.enabled) continue;
    const wait = source.siteWait && !source.siteWait.exhausted ? source.siteWait : null;
    const turn = !wait && source.siteTurn;
    if (turn) {
      rows.push({
        id: 'turn:' + source.url,
        title: turn.scanning
          ? `Waiting for “${turn.workspace}” to finish`
          : 'Waiting for its turn on the site',
        subject: source.name,
        state: 'Waiting',
        tone: 'waiting',
        progress: `Workspaces scan ${turn.site} one at a time; this scan starts 30 min after “${turn.workspace}” ends.`,
        resumesAt: turn.until ?? null,
      });
      continue;
    }
    if (!wait && !(source.recovery && a.status === 'enabled')) continue;
    rows.push({
      id: 'wait:' + source.url,
      title: wait ? 'Access wait' : 'Waiting to resume automatically',
      subject: source.name,
      state: 'Waiting',
      tone: 'waiting',
      progress: wait?.message ?? null,
      resumesAt: wait ? (wait.retryAt ?? null) : (source.recovery.readyAt ?? null),
    });
  }
  for (const question of (a.questions ?? []).filter((q) => q.answer == null && !q.conversation)) {
    const record = question.recordId && results.find((r) => r.id === question.recordId);
    rows.push({
      id: 'question:' + question.id,
      title: 'Waiting for your answer',
      subject: record?.title || sourceOf(question.sourceUrl)?.name || null,
      state: 'Waiting',
      tone: 'blocked',
      progress: question.text,
      queuedAt: question.createdAt ?? null,
    });
  }
  return rows;
}

// "Search 4/5 (platform engineer) · page 3/4 · 12 addresses pending · 47 excluded · 0 new records"
// The run's own scan is newer than the source's saved one: a collector reads
// pages and moves to the next search before the agent saves anything.
function scanProgress(source, run) {
  const work = (run.scan?.work ? run.scan : source.scan)?.work,
    searches = work?.searches ?? [],
    active = searches.find((s) => s.id === work?.activeSearchId),
    page = run.pageProgress ?? active?.pageProgress ?? null,
    parts = [];
  if (searches.length > 1) {
    const done = searches.filter((s) => s.status === 'completed').length;
    parts.push(
      `Search ${Math.min(done + 1, searches.length)}/${searches.length}` +
        (active?.label ? ` (${active.label})` : ''),
    );
  }
  if (page?.currentPage)
    parts.push(`page ${page.currentPage}${page.totalPages ? '/' + page.totalPages : ''}`);
  if (active?.pendingUrls?.length)
    parts.push(
      `${active.pendingUrls.length} ${active.pendingUrls.length === 1 ? 'address' : 'addresses'} pending`,
    );
  const excluded = searches.reduce((n, s) => n + (s.excluded?.length ?? 0), 0);
  if (excluded) parts.push(`${excluded} excluded`);
  parts.push(`${run.foundCount ?? 0} new ${run.foundCount === 1 ? 'record' : 'records'}`);
  return parts.join(' · ');
}
