// @ts-check
import {listingIdentity} from '../records/job-urls.mjs';
const sameUrl = (a, b) =>
  a === b ||
  Boolean(listingIdentity(a)?.key && listingIdentity(a)?.key === listingIdentity(b)?.key);
const scope = (run) =>
  JSON.stringify([
    run.automationId,
    run.taskId ?? run.id,
    run.scan?.work?.activeSearchId ?? 'default',
    run.recordId ?? '',
  ]);

// Bounded RAM cache only. A new app process starts empty; pages are read again.
export class BrowserEvidenceStore {
  constructor(now = Date.now) {
    this.now = now;
    this.pages = new Map();
    this.identities = new Map();
  }
  rememberIdentity(run, page) {
    if (!page?.url || !page.canonicalUrl || page.readiness?.loading) return;
    const key = scope(run),
      rows = this.identities.get(key) ?? [];
    this.identities.set(
      key,
      [
        ...rows.filter((r) => r.url !== page.url),
        {url: page.url, canonicalUrl: page.canonicalUrl},
      ].slice(-100),
    );
  }
  aliases(run, url) {
    return (this.identities.get(scope(run)) ?? [])
      .filter((p) => sameUrl(p.url, url) || sameUrl(p.canonicalUrl, url))
      .flatMap((p) => [p.url, p.canonicalUrl]);
  }
  save(run, page) {
    if (!page?.text?.trim() || page.text.length > 1000000 || this.pages.has(page.id)) return;
    this.pages.set(page.id, {
      owner: run.automationId,
      taskId: run.taskId ?? run.id,
      scope: scope(run),
      value: structuredClone({...page, runId: run.id, at: this.now()}),
    });
    const owned = [...this.pages].filter(([, row]) => row.owner === run.automationId);
    for (const [id] of owned.slice(0, Math.max(0, owned.length - 64))) this.pages.delete(id);
  }
  get(run, id) {
    const row = this.pages.get(id);
    return row?.scope === scope(run) ? structuredClone(row.value) : null;
  }
  known(id) {
    return this.pages.has(id);
  }
  latest(run, url) {
    return structuredClone(
      [...this.pages.values()]
        .reverse()
        .find((row) => row.scope === scope(run) && sameUrl(row.value.url, url))?.value ?? null,
    );
  }
  release(owner, taskId) {
    for (const [id, row] of this.pages)
      if (row.owner === owner && (taskId === undefined || row.taskId === taskId))
        this.pages.delete(id);
    for (const key of this.identities.keys()) {
      const [savedOwner, savedTask] = JSON.parse(key);
      if (savedOwner === owner && (taskId === undefined || savedTask === taskId))
        this.identities.delete(key);
    }
  }
}
