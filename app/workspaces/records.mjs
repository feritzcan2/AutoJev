// @ts-check
import {randomUUID} from 'node:crypto';
import {
  RecordIdentity,
  activeRecordSql,
  foundRecordSql,
  foundRunSql,
} from '../records/identity.mjs';

const parse = (row) => (row ? JSON.parse(row.data) : null);
// One durable record table. Domain extensions keep their own fields in data;
// bindings in the template expose those fields through the same record contract.
export class WorkspaceRecords {
  constructor(workspaces) {
    this.workspaces = workspaces;
    this.db = workspaces.db;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS workspace_records(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,record_key TEXT NOT NULL,identity TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,UNIQUE(workspace_id,record_key));
    CREATE INDEX IF NOT EXISTS workspace_records_owner ON workspace_records(workspace_id);
    CREATE INDEX IF NOT EXISTS workspace_records_found ON workspace_records(workspace_id,${foundRunSql}) WHERE ${foundRecordSql};
    CREATE TABLE IF NOT EXISTS workspace_record_descriptions(record_id TEXT PRIMARY KEY REFERENCES workspace_records(id) ON DELETE CASCADE,url TEXT NOT NULL,text TEXT NOT NULL,read_at INTEGER NOT NULL);`);
    this.identities = new RecordIdentity(this);
  }
  get(id, recordId) {
    this.workspaces.get(id);
    const record = this.identities.resolve(id, recordId);
    if (!record) throw Error('The record does not belong to this workspace');
    return record;
  }
  usesUrl(id) {
    return this.workspaces.definition(id).records.identity === 'url';
  }
  find(id, key) {
    this.workspaces.get(id);
    const exact = parse(
      this.db
        .prepare('SELECT data FROM workspace_records WHERE workspace_id=? AND record_key=?')
        .get(id, key),
    );
    return exact ? this.get(id, exact.id) : this.usesUrl(id) ? this.identities.find(id, key) : null;
  }
  list(id, {offset = 0, limit = 500, descending = true} = {}) {
    this.workspaces.get(id);
    return this.db
      .prepare(
        `SELECT data FROM workspace_records WHERE workspace_id=? AND ${activeRecordSql} ORDER BY rowid ${descending ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset)
      .map(parse);
  }
  count(id) {
    this.workspaces.get(id);
    return this.db
      .prepare(
        `SELECT count(*) AS n FROM workspace_records WHERE workspace_id=? AND ${activeRecordSql}`,
      )
      .get(id).n;
  }
  search(id, {query, offset = 0, limit = 25}) {
    this.workspaces.get(id);
    const fold = (value) => value.normalize('NFKC').toLowerCase(),
      needle = fold(query),
      records = [];
    let total = 0;
    // Search locally so agents need not load every record to find one listing.
    // JS case folding also covers non-ASCII company names, unlike SQLite lower.
    for (const row of this.db
      .prepare(
        `SELECT data FROM workspace_records WHERE workspace_id=? AND ${activeRecordSql} ORDER BY rowid ASC`,
      )
      .iterate(id)) {
      const record = parse(row),
        text = JSON.stringify([
          record.title,
          record.role,
          record.company,
          record.location,
          record.url,
          record.key,
          record.sourceUrl,
          record.summary,
          record.cells,
        ]);
      if (!fold(text).includes(needle)) continue;
      if (total >= offset && records.length < limit) records.push(record);
      total++;
    }
    return {records, total};
  }
  put(id, key, value) {
    return this.identities.atomic(() => {
      this.workspaces.get(id);
      const record = {...value, id: value.id ?? randomUUID()},
        existing = this.db
          .prepare('SELECT workspace_id FROM workspace_records WHERE id=?')
          .get(record.id);
      if (existing && existing.workspace_id !== id)
        throw Error('The record does not belong to this workspace');
      if (existing && this.get(id, record.id).id !== record.id)
        throw Error('This record was merged; read the current main record again');
      if (this.usesUrl(id))
        for (const url of this.identities.urls(record)) {
          const other = this.identities.find(id, url);
          if (other && other.id !== record.id)
            throw Error('This listing is already recorded; use the existing record');
        }
      this.db
        .prepare(
          'INSERT INTO workspace_records(id,workspace_id,record_key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(record.id, id, key, JSON.stringify(record));
      if (this.usesUrl(id)) this.identities.bind(id, record);
      return record;
    });
  }
  // A listing's description is kept beside its record, outside the record
  // JSON, so workspace snapshots do not carry every listing's full text.
  saveDescription(id, recordId, {url, text, readAt}) {
    const record = this.get(id, recordId);
    this.db
      .prepare(
        'INSERT INTO workspace_record_descriptions(record_id,url,text,read_at) VALUES(?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET url=excluded.url,text=excluded.text,read_at=excluded.read_at',
      )
      .run(record.id, url, text, readAt);
  }
  // The main record's description, else the newest one of a record merged into it.
  description(id, recordId) {
    const record = this.get(id, recordId),
      row = this.db
        .prepare(
          `SELECT d.url,d.text,d.read_at AS readAt FROM workspace_record_descriptions d JOIN workspace_records r ON r.id=d.record_id
   WHERE r.workspace_id=? AND (r.id=? OR json_extract(r.data,'$.mergedInto')=?) ORDER BY r.id=? DESC,d.read_at DESC LIMIT 1`,
        )
        .get(id, record.id, record.id, record.id);
    return row ? {...row} : null;
  }
  update(id, recordId, change) {
    return this.identities.atomic(() => {
      const before = this.get(id, recordId),
        value = change(before);
      if (value.id !== before.id) throw Error('The record id cannot be changed');
      return this.put(
        id,
        value.key ??
          this.db.prepare('SELECT record_key FROM workspace_records WHERE id=?').get(value.id)
            .record_key,
        value,
      );
    });
  }
  project(id, record, definition) {
    const fields = {...record.cells};
    for (const [key, source] of Object.entries(definition.records.bindings))
      if (record[source] !== undefined) fields[key] = record[source];
    if (!fields.source && record.url)
      try {
        fields.source = new URL(record.url).hostname;
      } catch {}
    return {
      ...record,
      id: record.id,
      workspaceId: id,
      url: record.url,
      fields,
      state: record.workflowState ?? record.status,
      operationState: record.status,
      documents: record.documents ?? [],
      evidence: record.evidence ?? null,
      updatedAt: record.updatedAt,
      ...this.workspaces.registry.driver(definition).projectRecord?.(record),
    };
  }
}
