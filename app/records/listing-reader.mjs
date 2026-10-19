// @ts-check
// Before a scoring task starts, each assigned record whose address a site
// extension reads — the API collector of this workspace's template, or an
// HTTP reader — is read through that reader, as the scan read it, and kept as
// the task's saved listing text (RAM only, ../browser/evidence-store.mjs). The
// agent then scores the same text a scan assesses instead of opening the site.
// Without a reader, or when the read fails or carries no description of its
// own, the task reads the listing in the browser as before.
import {randomUUID} from 'node:crypto';
import {collectorExtension} from '../sources/collectors.mjs';
import {siteExtensionFor, siteReaderFor} from '../site-extensions/index.mjs';
import {taskRecordIds} from './task-scope.mjs';

const PARALLEL = 3,
  RECORDS = 100;
/** @type {Map<string, {read: any[], failed: any[]}>} */
const outcomes = new Map();
// What the readers did for this run: read listings and failed reads.
export const recordListingReads = (runId) => outcomes.get(runId) ?? null;

async function readOne(db, a, run, item, {signal, wait}) {
  const collector = collectorExtension(a, item.url),
    reader = collector ? null : siteReaderFor(item.url),
    extension = collector ?? (reader ? siteExtensionFor(item.url) : null);
  if (!extension) return null;
  let page;
  if (collector) {
    const adapter = collector.collector;
    if (!adapter.readDetail) return null;
    // Reads follow the site's shared pacing and request budget, like a scan.
    const job = await adapter.readDetail(item.url, {signal, siteAccess: db.siteAccess, wait});
    if (job?.url !== item.url || !job.title?.trim() || !job.description?.trim())
      throw Error('The listing read is incomplete or does not match the record address.');
    page = adapter.detail(job);
  } else page = await reader.read(item.url, {signal, siteAccess: db.siteAccess, wait});
  // Only a listing with its own description replaces the browser read.
  if (!page?.listing || !page.text?.trim())
    throw Error('The site reader returned no description of the listing.');
  return {extension: extension.id, kind: collector ? 'api' : 'http', page};
}

export async function readRecordListings(db, run, {signal = undefined, wait = undefined} = {}) {
  if (run.recordOperation !== 'score') return null;
  const a = db.get(run.automationId),
    items = taskRecordIds(run)
      .slice(0, RECORDS)
      .map((itemId) => db.result(run.automationId, itemId))
      .filter((item) => !db.browserEvidence.latest(run, item.url)),
    read = [],
    failed = [];
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const item = items[next++];
      signal?.throwIfAborted();
      try {
        const result = await readOne(db, a, run, item, {signal, wait});
        if (!result) continue;
        const snapshot = {
          id: randomUUID(),
          url: item.url,
          text: result.page.text,
          reader: {extension: result.extension, kind: result.kind},
        };
        db.browserEvidence.save(run, snapshot);
        read.push({itemId: item.id, url: item.url, snapshotId: snapshot.id, ...snapshot.reader});
      } catch (error) {
        signal?.throwIfAborted();
        const extension = siteExtensionFor(item.url)?.id ?? null;
        failed.push({
          itemId: item.id,
          url: item.url,
          extension,
          error: String(error?.message ?? error).slice(0, 500),
        });
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(PARALLEL, items.length)}, work));
  if (!read.length && !failed.length) return null;
  outcomes.set(run.id, {read, failed});
  while (outcomes.size > 200) outcomes.delete(outcomes.keys().next().value);
  return {read, failed};
}
