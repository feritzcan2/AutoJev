import {technicalRetryDelay} from '../automation/recovery.mjs';
import {checkUrl, givenUpUrls, PAGE_CHECK_LIMIT} from './browser-check.mjs';
import {skipScanUrls} from './scan-work.mjs';

// Readiness checks run without an LLM or a worker lease. One in-flight check
// per durable task; a late result cannot revive a stopped or changed workspace.
export class SourceRetryChecks {
  constructor(db, {probe, now = Date.now, changed = () => {}, isClosed = () => false} = {}) {
    Object.assign(this, {db, probe, now, changed, isClosed});
    this.pending = new Map();
  }
  ready(id, task) {
    if (!this.probe || !task.technicalRecovery) return true;
    const a = this.db.get(id),
      recovery = task.technicalRecovery;
    if (
      recovery.probe?.ready &&
      recovery.probe.revision === a.revision &&
      this.now() - recovery.probe.at < 30000
    )
      return true;
    if (this.pending.has(task.id) || task.retryAt > this.now()) return false;
    const request = task.retryAt,
      revision = a.revision,
      url = checkUrl(task);
    const work = Promise.resolve()
      .then(() => this.probe(id, task))
      .then((result) => {
        if (this.isClosed()) return;
        const current = this.db.get(id),
          queue = this.db.store.workspaces.tasks,
          saved = queue.get(id, task.id),
          source = current.sourceState?.[task.sourceUrl];
        if (
          current.revision !== revision ||
          current.status !== 'enabled' ||
          !current.sources.includes(task.sourceUrl) ||
          current.sourceSettings?.[task.sourceUrl]?.enabled === false ||
          source?.stopping ||
          source?.blocked ||
          saved.state !== 'pending' ||
          saved.stopRequested ||
          saved.retryAt !== request
        )
          return;
        const checkedAt = this.now(),
          probeAttempts =
            (saved.technicalRecovery?.probeAttempts ?? 0) +
            (result.ready || result.deferred ? 0 : 1);
        const failures = {...saved.technicalRecovery?.failures};
        if (!result.ready && !result.deferred) failures[url] = (failures[url] ?? 0) + 1;
        // A page just given up: try another page of the source without the long wait.
        const moved =
          checkUrl({...saved, technicalRecovery: {...saved.technicalRecovery, failures}}) !== url;
        const retryAt = result.ready
          ? null
          : checkedAt +
            (result.deferred ? 5000 : technicalRetryDelay(moved ? 1 : probeAttempts + 1));
        // Another page of the source loads: the given-up pages are skipped.
        const skipped = result.ready
            ? givenUpUrls(saved.technicalRecovery).filter((failed) => failed !== url)
            : [],
          scan = skipped.length ? skipScanUrls(saved.scan, skipped) : saved.scan;
        const technicalRecovery = {
          ...saved.technicalRecovery,
          urls: (saved.technicalRecovery?.urls ?? []).filter((failed) => !skipped.includes(failed)),
          failures,
          probeAttempts,
          readyAt: retryAt,
          probe: {
            ready: result.ready === true,
            at: checkedAt,
            revision,
            evidence: String(result.evidence ?? '').slice(0, 600),
          },
        };
        queue.put({...saved, retryAt, technicalRecovery, scan});
        if (!result.deferred)
          this.db.put({
            ...current,
            sourceState: {
              ...current.sourceState,
              [task.sourceUrl]: {
                ...source,
                ...(skipped.length ? {scan} : {}),
                recovery: {...technicalRecovery, reason: 'technical_page'},
                nextRunAt: retryAt ?? checkedAt,
                lastResult: skipped.length
                  ? `${skipped.length} sayfa ${PAGE_CHECK_LIMIT} denemede açılmadı ve atlandı; site erişilebilir, kaydedilen görev devam edecek.`
                  : result.ready
                    ? 'Sayfa yeniden erişilebilir; kaydedilen görev devam edecek.'
                    : 'Sayfa hâlâ yüklenemiyor. Agent açılmadan yeniden kontrol edilecek.',
              },
            },
          });
        this.changed(id);
      })
      .catch(() => {
        // A failed readiness service is not permission to start a provider. Retry
        // its check later; do not enqueue a second copy of the source task.
        if (this.isClosed()) return;
        try {
          const queue = this.db.store.workspaces.tasks,
            saved = queue.get(id, task.id);
          if (
            saved.state === 'pending' &&
            saved.retryAt === request &&
            this.db.get(id).revision === revision
          )
            queue.put({...saved, retryAt: this.now() + 30000});
        } catch {}
      })
      .finally(() => this.pending.delete(task.id));
    this.pending.set(task.id, work);
    return false;
  }
}
