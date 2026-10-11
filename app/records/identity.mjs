// @ts-check
import {jevDetailKey} from '../jev/detail-urls.mjs';

// Navigation keeps the observed address. Only universally known provenance is
// removed from the comparison key; query IDs and SPA routes remain significant.
export function recordUrlKey(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    return jevDetailKey(u.href);
  } catch {
    return null;
  }
}
export const activeRecordSql = "json_extract(data,'$.mergedInto') IS NULL";
const parse = (row) => (row ? JSON.parse(row.data) : null);
const priority = (r) =>
  ({
    executing: 8,
    uncertain: 7,
    completed: 6,
    submitted: 6,
    already_submitted: 6,
    dismissed: 5,
    prepared: 4,
    found: 1,
  })[r.status] ?? 2;
const unique = (values) => [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];

// Merged rows are durable history, not deleted data. Old IDs resolve to the
// survivor; foreign keys, receipts and documents therefore remain recoverable.
export class RecordIdentity {
  constructor(records) {
    this.records = records;
    this.db = records.db;
    this.sequence = 0;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS workspace_record_urls(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,url_key TEXT NOT NULL,record_id TEXT NOT NULL REFERENCES workspace_records(id) ON DELETE CASCADE,PRIMARY KEY(workspace_id,url_key));`,
    );
  }
  atomic(fn) {
    const name = 'record_identity_' + ++this.sequence;
    this.db.exec('SAVEPOINT ' + name);
    try {
      this.db.exec('UPDATE workspace_records SET data=data WHERE 0');
      const value = fn();
      this.db.exec('RELEASE ' + name);
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK TO ' + name + '; RELEASE ' + name);
      throw error;
    }
  }
  raw(owner, id) {
    if (typeof id !== 'string') return null;
    return parse(
      this.db
        .prepare('SELECT data FROM workspace_records WHERE workspace_id=? AND id=?')
        .get(owner, id),
    );
  }
  resolve(owner, id) {
    const seen = new Set();
    let value = this.raw(owner, id);
    while (value?.mergedInto) {
      if (seen.has(value.id)) throw Error('Record merge cycle');
      seen.add(value.id);
      value = this.raw(owner, value.mergedInto);
    }
    return value;
  }
  find(owner, url) {
    const key = recordUrlKey(url);
    if (!key) return null;
    const row = this.db
      .prepare('SELECT record_id FROM workspace_record_urls WHERE workspace_id=? AND url_key=?')
      .get(owner, key);
    return row ? this.resolve(owner, row.record_id) : null;
  }
  urls(record) {
    return unique([record.url, ...(record.urlAliases ?? [])].filter((url) => recordUrlKey(url)));
  }
  bind(owner, record) {
    for (const url of this.urls(record)) {
      const key = recordUrlKey(url),
        other = this.find(owner, url);
      if (other && other.id !== record.id)
        throw Error('This address matches another record; merge the records first.');
      this.db
        .prepare(
          'INSERT INTO workspace_record_urls VALUES(?,?,?) ON CONFLICT(workspace_id,url_key) DO UPDATE SET record_id=excluded.record_id',
        )
        .run(owner, key, record.id);
    }
  }
  merge(owner, ids, {reason = 'verified_alias', allowActive = false} = {}) {
    return this.atomic(() => {
      const resolved = ids.map((id) => this.resolve(owner, id));
      if (resolved.some((v) => !v))
        throw Error('The record to merge does not belong to this workspace');
      const values = unique(resolved.map((r) => r.id)).map((id) => this.raw(owner, id));
      if (values.some((v) => !v))
        throw Error('The record to merge does not belong to this workspace');
      if (values.length < 2) return values[0];
      if (
        !allowActive &&
        this.records.workspaces.tasks
          ?.list(owner, {states: ['running', 'reported', 'paused']})
          .some((t) =>
            [t.recordId, ...(t.recordIds ?? [])].some((id) =>
              values.some((v) => v.id === this.resolve(owner, id)?.id),
            ),
          )
      )
        throw Error('Stop the running tasks of these records before merging');
      values.sort(
        (a, b) =>
          Number(Boolean(a.trial)) - Number(Boolean(b.trial)) ||
          priority(b) - priority(a) ||
          (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) ||
          a.id.localeCompare(b.id),
      );
      const [first, ...rest] = values,
        now = Date.now();
      const survivor = {
        ...first,
        urlAliases: unique(values.flatMap((r) => this.urls(r))),
        mergedRecordIds: unique(values.flatMap((r) => [r.id, ...(r.mergedRecordIds ?? [])])).filter(
          (id) => id !== first.id,
        ),
        documents: unique(values.flatMap((r) => r.documents ?? [])),
        starred: values.some((r) => r.starred),
        cells: Object.assign(
          {},
          ...values
            .slice()
            .reverse()
            .map((r) => r.cells ?? {}),
        ),
        updatedAt: now,
      };
      // Keep the winning assessment, approval and outcome together. Never promote
      // an uncertain attempt to completed by borrowing another row's receipt.
      if (first.cells) survivor.cells = {...survivor.cells, ...first.cells};
      for (const record of rest)
        this.db
          .prepare('UPDATE workspace_records SET data=? WHERE workspace_id=? AND id=?')
          .run(
            JSON.stringify({...record, mergedInto: first.id, mergedAt: now, mergeReason: reason}),
            owner,
            record.id,
          );
      this.db
        .prepare('UPDATE workspace_records SET data=? WHERE workspace_id=? AND id=?')
        .run(JSON.stringify(survivor), owner, first.id);
      const update = this.db.prepare(
        'UPDATE workspace_record_urls SET record_id=? WHERE workspace_id=? AND record_id=?',
      );
      for (const r of rest) update.run(first.id, owner, r.id);
      this.bind(owner, survivor);
      const tasks = this.records.workspaces.tasks;
      if (tasks)
        for (const task of tasks.list(owner, {states: ['pending']}))
          if (
            [task.recordId, ...(task.recordIds ?? [])].some((id) => rest.some((r) => r.id === id))
          )
            tasks.put(task);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='automations'").get()) {
        const a = parse(this.db.prepare('SELECT data FROM automations WHERE id=?').get(owner));
        if (a?.questions?.some((q) => rest.some((r) => r.id === q.recordId))) {
          a.questions = a.questions.map((q) =>
            rest.some((r) => r.id === q.recordId)
              ? {...q, originalRecordId: q.originalRecordId ?? q.recordId, recordId: first.id}
              : q,
          );
          this.db.prepare('UPDATE automations SET data=? WHERE id=?').run(JSON.stringify(a), owner);
        }
      }
      return survivor;
    });
  }
  // Run at startup, before workers exist. This imports already established
  // legacy relationships and exact normalized URLs, never fuzzy title matches.
  rebuild(owner, {merge = true} = {}) {
    return this.atomic(() => {
      const rows = this.db
        .prepare('SELECT data FROM workspace_records WHERE workspace_id=? ORDER BY rowid')
        .all(owner)
        .map(parse);
      this.db.prepare('DELETE FROM workspace_record_urls WHERE workspace_id=?').run(owner);
      if (merge && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='job_members'").get()) {
        const groups = new Map();
        for (const row of this.db
          .prepare('SELECT job_id,canonical_id FROM job_members WHERE candidate_id=?')
          .all(owner)) {
          if (!this.raw(owner, row.job_id) || !this.raw(owner, row.canonical_id)) continue;
          const ids = groups.get(row.canonical_id) ?? [row.canonical_id];
          ids.push(row.job_id);
          groups.set(row.canonical_id, ids);
        }
        for (const ids of groups.values())
          this.merge(owner, ids, {reason: 'legacy_canonical', allowActive: true});
      }
      for (const old of rows) {
        let record = this.resolve(owner, old.id);
        if (!record || record.id !== old.id) continue;
        const matches = unique(
          this.urls(record)
            .map((url) => this.find(owner, url)?.id)
            .filter(Boolean),
        );
        if (matches.some((id) => id !== record.id)) {
          if (!merge) continue;
          record = this.merge(owner, [record.id, ...matches], {
            reason: 'normalized_url',
            allowActive: true,
          });
        }
        this.bind(owner, record);
      }
    });
  }
}
