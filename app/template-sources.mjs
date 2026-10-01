import {integration} from './source-catalog.mjs';

export function normalizeTemplateSources(input=[]){
 if(!Array.isArray(input)||input.length>20)throw Error('Template en fazla 20 başlangıç kaynağı içerebilir');
 const seen=new Set();
 return input.map(source=>{
  let url;try{url=new URL(source.url);}catch{throw Error('Geçersiz template kaynak adresi');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Template kaynağı kullanıcı bilgisi içermeyen HTTP(S) adresi olmalı');
  url.hash='';const address=url.href;if(seen.has(address))throw Error('Template kaynak adresleri benzersiz olmalı');seen.add(address);
  const name=source.name??url.hostname,query=source.query??'',intervalMinutes=source.intervalMinutes??30,enabled=source.enabled??true;
  if(typeof name!=='string'||!name.trim()||name.length>120||typeof query!=='string'||query.length>6000)throw Error('Geçersiz template kaynak açıklaması');
  if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080||typeof enabled!=='boolean')throw Error('Geçersiz template kaynak zamanlaması');
  const searchMethod=source.searchMethod??'free',integrationId=source.integrationId??null,fallback=source.fallback??'web';
  if(!['free','browser','tool'].includes(searchMethod)||!['web','browser','none'].includes(fallback)||integrationId&&!integration(integrationId)||searchMethod==='tool'&&!integrationId)throw Error('Geçersiz template kaynak aracı');
  return {url:address,name:name.trim(),query,intervalMinutes,enabled,searchMethod,integrationId,fallback};
 });
}
