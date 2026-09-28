import {readdir,realpath,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
const extensions=new Set(['.pdf','.docx','.txt','.md','.png','.jpg','.jpeg']);
const excluded=new Set(['runtime','node_modules','AGENTS.md','CLAUDE.md']);
export async function documentPath(root,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative))throw Error('Geçersiz dosya');
 const base=await realpath(root),file=await realpath(path.resolve(base,relative));
 if(!file.startsWith(base+path.sep)||relative.split(/[\\/]/).some(p=>p.startsWith('.')||excluded.has(p))||!extensions.has(path.extname(file).toLowerCase())||!(await stat(file)).isFile())throw Error('Bu dosya görüntülenemez');
 return file;
}
export async function listDocuments(root){
 const result=[];
 async function walk(dir,depth=0){
  if(depth>5)return;
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const entry of entries){
   if(entry.name.startsWith('.')||excluded.has(entry.name)||entry.isSymbolicLink())continue;
   const file=path.join(dir,entry.name);
   if(entry.isDirectory()){await walk(file,depth+1);continue;}
   if(!entry.isFile()||!extensions.has(path.extname(entry.name).toLowerCase()))continue;
   try{const relative=path.relative(root,file),safe=await documentPath(root,relative),info=await stat(safe);result.push({path:relative,name:entry.name,size:info.size,updatedAt:info.mtime.toISOString(),preview:['.txt','.md'].includes(path.extname(entry.name).toLowerCase())});}catch{}
  }
 }
 await walk(root);return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export async function readDocument(root,relative){const file=await documentPath(root,relative);if(!['.txt','.md'].includes(path.extname(file).toLowerCase()))throw Error('Metin önizlemesi desteklenmiyor');if((await stat(file)).size>1024*1024)throw Error('Dosya önizleme için çok büyük; dosyayı açabilirsin.');return readFile(file,'utf8');}
