import {readFile} from 'node:fs/promises';
import {crc32} from 'node:zlib';
import path from 'node:path';
import {documentPath} from './artifacts.mjs';

// Small uncompressed ZIP: employer documents are already compressed. UTF-8
// filenames and fixed DOS date keep exports portable without a native zip tool.
export function zipFiles(files){
 const parts=[],directory=[];let offset=0;
 for(const {name,data} of files){
  const filename=Buffer.from(name),body=Buffer.from(data),crc=crc32(body),local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(filename.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
  parts.push(local,filename,body);directory.push(central,filename);offset+=local.length+filename.length+body.length;
 }
 const index=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...parts,index,end]);
}
export async function exportPreparation(store,candidate,jobId){
 const job=store.job(candidate,jobId),p=job.preparation;if(!p)throw Error('Hazırlık paketi bulunamadı');
 const files=[],seen=new Set();let total=0;
 for(const r of p.requirements??[]){
  if(r.kind!=='document'||!r.documentPath||seen.has(r.documentPath))continue;
  const file=await documentPath(store.candidateDirectory(candidate),r.documentPath),data=await readFile(file);total+=data.length;
  if(total>40*1024*1024)throw Error('Paket 40 MB üzerinde. Belgeleri ayrı ayrı açabilirsin.');
  seen.add(r.documentPath);files.push({name:`${r.id}-${path.basename(file)}`,data});
 }
 files.push({name:'answers.txt',data:(p.requirements??[]).filter(r=>r.kind==='answer'&&r.answer).map(r=>`${r.label}\n\n${r.answer}`).join('\n\n---\n\n')});
 files.push({name:'requirements.txt',data:[`${job.company} — ${job.role}`,p.formUrl,p.coverageNote,p.note,'',...(p.requirements??[]).map(r=>`${r.label} | ${r.required} | ${r.status}${r.note?' | '+r.note:''}`)].filter(value=>value!==undefined).join('\n')});
 return {name:`application-${job.id.slice(0,8)}.zip`,base64:zipFiles(files).toString('base64')};
}
