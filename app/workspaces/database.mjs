// @ts-check
import {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {WorkspaceStore} from './store.mjs';
import {assertDataSchemaVersion, markDataSchemaVersion} from '../system/data-management-schema.mjs';

export class WorkspaceDatabase {
  constructor(file, {registry = undefined} = {}) {
    this.directory = dirname(file);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON',
      );
      // Run bodies are large: with the 2 MB default, every UI refresh read
      // the same record and task pages from disk again.
      this.db.exec('PRAGMA cache_size=-65536');
      assertDataSchemaVersion(this.db);
      this.workspaces = new WorkspaceStore(this.db, {registry});
      markDataSchemaVersion(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
