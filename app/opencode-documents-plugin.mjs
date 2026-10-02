import {open,stat} from 'node:fs/promises';
import path from 'node:path';

// OpenCode's native read attaches PDFs as file content. The scoring profile
// tool already extracts bounded text locally, including for text-only models.
export default async function({directory}){
 return {'tool.execute.before':async(input,output)=>{
  if(input.tool!=='read'||typeof output.args?.filePath!=='string')return;
  const file=path.resolve(directory,output.args.filePath);
  let pdf=path.extname(file).toLowerCase()==='.pdf',handle;
  if(!pdf)try{if((await stat(file)).isFile()){handle=await open(file,'r');const bytes=Buffer.alloc(5);await handle.read(bytes,0,5,0);pdf=bytes.toString()==='%PDF-';}}catch{}finally{await handle?.close();}
  if(pdf)throw Error('PDF attachments are not supported in this worker. For the saved CV, call jobloop_read_scoring_profile with {"source":"cv","offset":0,"limit":6000}; use nextOffset if more text is needed. It extracts text locally without attaching the file. Do not retry native read or attach/base64 the PDF. For other documents obtain a text version.');
 }};
}
