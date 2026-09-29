import {DatabaseSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {WorkspaceStore} from './workspace-store.mjs';
import {assertDataSchemaVersion,markDataSchemaVersion} from './data-management-schema.mjs';

export class WorkspaceDatabase {
 constructor(file,{registry}={}){
  this.directory=dirname(file);this.db=new DatabaseSync(file);
  try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON');assertDataSchemaVersion(this.db);this.workspaces=new WorkspaceStore(this.db,{registry});markDataSchemaVersion(this.db);}
  catch(error){this.db.close();throw error;}
 }
 close(){this.db.close();}
}
