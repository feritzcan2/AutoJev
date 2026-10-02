import {DatabaseSync} from 'node:sqlite';
import {removeSourceExtensions,copyExistingSourceSkills} from './source-settings-migration.mjs';
import {dirname} from 'node:path';
import {WorkspaceStore} from './workspace-store.mjs';
import {assertDataSchemaVersion,markDataSchemaVersion,discardPersistentPageCaches} from './data-management-schema.mjs';

export class WorkspaceDatabase {
 constructor(file,{registry}={}){
  this.directory=dirname(file);this.db=new DatabaseSync(file);
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON');assertDataSchemaVersion(this.db);discardPersistentPageCaches(this.db);removeSourceExtensions(this.db);copyExistingSourceSkills(this.db);this.workspaces=new WorkspaceStore(this.db,{registry});markDataSchemaVersion(this.db);}
  catch(error){this.db.close();throw error;}
 }
 close(){this.db.close();}
}
