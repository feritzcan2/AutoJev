import {mkdir,copyFile,chmod} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {listDocuments,documentPath,readDocument} from './artifacts.mjs';

const extensions={attachment:['pdf','docx','txt','md','png','jpg','jpeg'],cv:['pdf','docx','txt']};

export class WorkspaceDocuments {
 constructor(workspaces,{dialog,shell,window}){Object.assign(this,{workspaces,dialog,shell,window});}
 directory(id){return this.workspaces.template(id).directory(id);}
 list(id){return listDocuments(this.directory(id));}
 read(id,file){return readDocument(this.directory(id),file);}
 async open(id,file){const error=await this.shell.openPath(await documentPath(this.directory(id),file));if(error)throw Error(error);}
 async pick(id,{purpose='attachment'}={}){
  const driver=this.workspaces.template(id);
  const validate=()=>{this.workspaces.assertMutable(id);if(!extensions[purpose]||!driver.documentPurposes.includes(purpose))throw Error('Bu belge türü çalışma alanında desteklenmiyor');driver.beforeDocument?.(id,purpose);};
  validate();
  const picked=await this.dialog.showOpenDialog(this.window(),{properties:['openFile'],filters:[{name:purpose==='cv'?'CV':'Belgeler',extensions:extensions[purpose]}]});
  if(picked.canceled)return null;
  validate();
  const source=picked.filePaths[0],extension=path.extname(source).slice(1).toLowerCase();
  if(!extensions[purpose].includes(extension))throw Error('Desteklenmeyen belge türü');
  this.workspaces.changing.add(id);
  try{
   const root=this.directory(id),relative=purpose==='cv'?`CV.${extension}`:path.join('documents',`${randomUUID()}.${extension}`),target=path.join(root,relative);
   await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(source,target);await chmod(target,0o600);
   await driver.documentAdded?.(id,{purpose,path:target,relative,name:path.basename(source)});
   this.workspaces.changed(id);return target;
  }finally{this.workspaces.changing.delete(id);}
 }
}
