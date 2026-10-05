import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {collectHimalayas,himalayasApiUrl} from './himalayas-collector.mjs';
import {readHimalayasDetail,himalayasJobIdentity} from './himalayas-detail.mjs';

export function collectionArguments(args){
 const flags=new Map();
 for(let i=0;i<args.length;i++){
  const key=args[i];if(!['--source','--query','--country','--all','--url','--detail-url','--max-pages','--help'].includes(key)||flags.has(key))throw Error(`Geçersiz seçenek: ${key}`);
  if(['--all','--help'].includes(key))flags.set(key,true);
  else {const value=args[++i];if(!value||value.startsWith('--'))throw Error(`${key} için değer gerekli.`);flags.set(key,value);}
 }
 if(flags.has('--help'))return null;
 if((flags.get('--source')??'himalayas')!=='himalayas')throw Error('Desteklenen kaynak: himalayas');
 if(flags.has('--detail-url')){
  if([...flags.keys()].some(k=>!['--source','--detail-url'].includes(k)))throw Error('--detail-url arama seçenekleriyle birlikte kullanılamaz.');
  himalayasJobIdentity(flags.get('--detail-url'));return {detailUrl:flags.get('--detail-url')};
 }
 if(flags.has('--all')&&(flags.has('--query')||flags.has('--country')||flags.has('--url'))||flags.has('--url')&&(flags.has('--query')||flags.has('--country')))throw Error('--all, --url ve arama filtrelerini birlikte kullanma.');
 const url=new URL(flags.get('--url')??`https://himalayas.app/jobs/api${flags.has('--all')?'':'/search'}`);
 if(flags.has('--query'))url.searchParams.set('q',flags.get('--query'));
 if(flags.has('--country'))url.searchParams.set('country',flags.get('--country'));
 const maxPages=Number(flags.get('--max-pages')??1000);
 if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>10000)throw Error('--max-pages 1–10000 arasında olmalı.');
 return {searches:[{id:'collector-1',url:himalayasApiUrl(url.href)}],maxPages};
}

const send=message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve()));
async function collect(input,options){
 if(!input.detailUrl)return collectHimalayas(input,options);
 const job=await readHimalayasDetail(input.detailUrl,{signal:options.signal});
 await options.onPage({url:job.url,jobs:[job],complete:true});return {complete:true,pages:1,count:1};
}
async function main(){
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{
  if(process.argv.slice(2).includes('--worker')){
   if(!process.send)throw Error('Toplayıcı worker iletişim kanalı eksik.');
   process.once('disconnect',stop);
   const [request]=await once(process,'message',{signal:controller.signal});
   if(request?.type!=='start')throw Error('Toplayıcı başlatma isteği eksik.');
   const result=await collect(request.input,{signal:controller.signal,onPage:async page=>{
    const ack=once(process,'message',{signal:controller.signal});await send({type:'page',page});
    const [message]=await ack;if(message?.type!=='ack')throw Error('Toplayıcı sayfası kaydedilemedi.');
   }});
   await send({type:'done',result});
  }else{
   const input=collectionArguments(process.argv.slice(2));
   if(!input){process.stdout.write('Usage: node app/collect-cli.mjs --source himalayas [--query backend --country DE | --all | --url URL] [--max-pages 1000]\nSingle detail: --detail-url URL\nOutputs NDJSON page records and a final completion receipt; exit 2 means more pages remain.\n');return;}
   const result=await collect(input,{signal:controller.signal,onPage:async page=>{if(!process.stdout.write(JSON.stringify({type:'page',page})+'\n'))await once(process.stdout,'drain',{signal:controller.signal});}});
   process.stdout.write(JSON.stringify({type:'done',result})+'\n');if(!result.complete)process.exitCode=2;
  }
 }catch(error){
  const message=controller.signal.aborted?'Toplama iptal edildi; tamamlanmadı.':error.message;
  if(process.send&&process.connected)await send({type:'error',message}).catch(()=>{});else process.stderr.write(message+'\n');
  process.exitCode=controller.signal.aborted?130:1;
 }finally{if(process.connected)process.disconnect();}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
