import {normalizeSourceRecipe} from './source-recipe.mjs';


export function normalizeTemplateSources(input=[]){
 if(!Array.isArray(input)||input.length>20)throw Error('Template en fazla 20 başlangıç kaynağı içerebilir');
 const seen=new Set();
 return input.map(source=>{
  if(!source||typeof source!=='object'||Array.isArray(source))throw Error('Geçersiz kaynak tanımı');
  let url;try{url=new URL(source.url);}catch{throw Error('Geçersiz template kaynak adresi');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Template kaynağı kullanıcı bilgisi içermeyen HTTP(S) adresi olmalı');
  url.hash='';const address=url.href;if(seen.has(address))throw Error('Template kaynak adresleri benzersiz olmalı');seen.add(address);
  const name=source.name??url.hostname,query=source.query??'',intervalMinutes=source.intervalMinutes??30,enabled=source.enabled??true;
  if(typeof name!=='string'||!name.trim()||name.length>120||typeof query!=='string'||query.length>6000)throw Error('Geçersiz template kaynak açıklaması');
  if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080||typeof enabled!=='boolean')throw Error('Geçersiz template kaynak zamanlaması');
  const instructions=source.instructions??'';
  if(typeof instructions!=='string'||instructions.length>6000)throw Error('Kaynak talimatı en fazla 6000 karakter olmalı');
  if(source.skill!==undefined&&(typeof source.skill!=='string'||source.skill.length>60000))throw Error('Kaynak skilli en fazla 60000 karakter olmalı');
  const recipe=normalizeSourceRecipe(source.recipe);
  return {url:address,name:name.trim(),query,intervalMinutes,enabled,...(instructions?{instructions:instructions.trim()}:{}),...(source.skill!==undefined?{skill:source.skill}:{}),...(recipe?{recipe}:{})};
 });
}
