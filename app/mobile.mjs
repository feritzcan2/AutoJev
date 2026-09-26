import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

// Phone access: the desktop app serves a mobile build of the same UI on the local network.
// Every IPC handler the renderer can call is reachable over HTTP for a paired phone, except these,
// which act on this Mac's screen (dialogs, Finder, external browser) or manage phone access itself.
export const DESKTOP_ONLY=new Set(['pick-cv','import-setup-cv','open-link','open-document','background-pick-skill','background-connect-gmail','mobile-status','mobile-enable','mobile-rotate']);
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
const COOKIE='jobloop_mobile',MAX_JSON=2*1024*1024,MAX_UPLOAD=15*1024*1024,DEFAULT_PORT=4780;
const LOCKED=`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JobLoop</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1e2325;color:#dededf;font:15px/1.6 -apple-system,system-ui,sans-serif;padding:24px;box-sizing:border-box"><main style="max-width:360px"><div style="width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:rgba(102,179,255,.12);color:#8ec8ff;font-weight:700;font-size:26px;margin-bottom:20px">j.</div><h1 style="font-size:22px;margin:0 0 10px">Bu telefon bağlı değil</h1><p style="margin:0;color:#9aa0a1">Bilgisayarındaki JobLoop’ta <b style="color:#dededf">Yapılandırma → Telefon</b> bölümünü aç ve oradaki QR kodu telefonunun kamerasıyla tara.</p></main></body></html>`;

// IPv4 addresses a phone can reach. Tailscale (100.64.0.0/10) is listed after the local network.
export function lanAddresses(){
 const list=[];
 for(const [name,entries] of Object.entries(os.networkInterfaces()))for(const entry of entries??[]){
  if(entry.family!=='IPv4'||entry.internal)continue;
  const [a,b]=entry.address.split('.').map(Number);
  list.push({address:entry.address,interface:name,label:a===100&&b>=64&&b<=127?'Tailscale':'Yerel ağ'});
 }
 return list.sort((x,y)=>(x.label==='Yerel ağ'?0:1)-(y.label==='Yerel ağ'?0:1));
}

export class MobileAccess{
 constructor({data,dist,handlers,uploadCv,documentFile,log=()=>{}}){
  Object.assign(this,{configFile:path.join(data,'mobile.json'),dist:path.resolve(dist),handlers,uploadCv,documentFile,log});
  this.config={enabled:false,token:null,port:DEFAULT_PORT};this.server=null;this.clients=new Set();this.error=null;
 }
 async load(){
  try{this.config={...this.config,...JSON.parse(await readFile(this.configFile,'utf8'))};}catch{}
  if(!this.config.token){this.config.token=randomBytes(32).toString('base64url');await this.save();}
  if(this.config.enabled)await this.start().catch(error=>{this.error=error.message;});
 }
 async save(){await writeFile(this.configFile,JSON.stringify(this.config),{mode:0o600});}
 async setEnabled(on){this.config.enabled=Boolean(on);await this.save();if(this.config.enabled)await this.start();else await this.stop();return this.status();}
 // A new key signs every paired phone out; they have to scan the new QR code.
 async rotate(){this.config.token=randomBytes(32).toString('base64url');await this.save();this.disconnect();return this.status();}
 disconnect(){for(const client of this.clients)client.end();this.clients.clear();}
 async start(){
  if(this.server)return;this.error=null;
  const server=createServer((req,res)=>{this.route(req,res).catch(error=>{this.log(error);if(!res.headersSent)this.json(res,500,{ok:false,error:'Sunucu hatası'});else res.end();});});
  const listen=port=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',()=>{server.off('error',reject);resolve();});});
  try{await listen(this.config.port);}catch(error){if(error.code!=='EADDRINUSE'){this.error=error.message;throw error;}await listen(0);this.config.port=server.address().port;await this.save();}
  this.server=server;this.heartbeat=setInterval(()=>{for(const client of this.clients)client.write(': ping\n\n');},25000);
 }
 async stop(){
  clearInterval(this.heartbeat);this.disconnect();
  const server=this.server;this.server=null;
  if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(()=>resolve()));}
 }
 async status(){
  const port=this.server?.address().port??this.config.port;
  const urls=this.server?lanAddresses().map(a=>({label:a.label,address:a.address,url:`http://${a.address}:${port}/`})):[];
  return {enabled:this.config.enabled,running:Boolean(this.server),port,error:this.error,devices:this.clients.size,
   urls:await Promise.all(urls.map(async u=>{const pairUrl=`${u.url}?k=${this.config.token}`;return {...u,pairUrl,qr:await QRCode.toString(pairUrl,{type:'svg',margin:1,errorCorrectionLevel:'M',color:{dark:'#111417',light:'#ffffff'}})};}))};
 }
 broadcast(channel,value){
  if(!this.clients.size)return;
  let payload;try{payload=`data: ${JSON.stringify({channel,value})}\n\n`;}catch{return;}
  for(const client of this.clients)client.write(payload);
 }
 matches(value){if(typeof value!=='string'||!this.config.token)return false;const a=Buffer.from(value),b=Buffer.from(this.config.token);return a.length===b.length&&timingSafeEqual(a,b);}
 authorized(req){
  for(const part of (req.headers.cookie??'').split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===COOKIE)return this.matches(part.slice(i+1).trim());}
  return false;
 }
 async route(req,res){
  const url=new URL(req.url,'http://jobloop.local'),route=url.pathname;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  // The pairing link carries the key once; it is kept as an HttpOnly cookie. The link itself stays usable
  // so a home-screen shortcut made from it can sign in again in its own storage.
  if(req.method==='GET'&&(route==='/'||route==='/index.html')){
   const key=url.searchParams.get('k');let ok=this.authorized(req);
   if(key!==null){if(!this.matches(key))return this.send(res,401,TYPES['.html'],LOCKED,{'Cache-Control':'no-store'});res.setHeader('Set-Cookie',`${COOKIE}=${this.config.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);ok=true;}
   if(!ok)return this.send(res,401,TYPES['.html'],LOCKED,{'Cache-Control':'no-store'});
   return this.file(res,path.join(this.dist,'mobile.html'),{'Cache-Control':'no-store'});
  }
  if(req.method==='GET'&&route==='/manifest.webmanifest'){
   const start=this.authorized(req)?`/?k=${this.config.token}`:'/';
   return this.send(res,200,TYPES['.webmanifest'],JSON.stringify({name:'JobLoop',short_name:'JobLoop',start_url:start,scope:'/',display:'standalone',background_color:'#1e2325',theme_color:'#1e2325',icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png'},{src:'/icon-512.png',sizes:'512x512',type:'image/png'}]}),{'Cache-Control':'no-store'});
  }
  if(req.method==='GET'&&(/^\/(mobile\.(js|css)|icon-\d+\.png)$/.test(route)||route.startsWith('/assets/'))){
   const target=path.resolve(this.dist,'.'+decodeURIComponent(route));
   if(!target.startsWith(this.dist+path.sep))return this.send(res,404,TYPES['.txt'],'Bulunamadı');
   return this.file(res,target,{'Cache-Control':'no-cache'});
  }
  if(!this.authorized(req))return this.json(res,401,{ok:false,error:'Telefon bağlantısı gerekli. Bilgisayardaki QR kodu yeniden tara.'});
  if(req.method==='GET'&&route==='/events')return this.events(req,res);
  if(req.method==='GET'&&route.startsWith('/files/')){
   const [,,candidate,...rest]=route.split('/');
   let file;try{file=await this.documentFile(decodeURIComponent(candidate),rest.map(decodeURIComponent).join('/'));}catch(error){return this.send(res,404,TYPES['.txt'],error.message);}
   return this.file(res,file,{'Cache-Control':'no-store','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`});
  }
  // State-changing calls need a header a cross-site form cannot send.
  if(req.method!=='POST'||req.headers['x-jobloop']!=='1')return this.json(res,404,{ok:false,error:'Bulunamadı'});
  if(route==='/upload-cv'){
   try{const body=await this.body(req,MAX_UPLOAD);return this.json(res,200,{ok:true,value:await this.uploadCv(url.searchParams.get('candidate'),url.searchParams.get('name')??'',body)});}
   catch(error){return this.json(res,200,{ok:false,error:error.message});}
  }
  const match=route.match(/^\/api\/([a-z0-9-]+)$/),handler=match&&!DESKTOP_ONLY.has(match[1])?this.handlers.get(match[1]):null;
  if(!handler)return this.json(res,404,{ok:false,error:'Bu işlem telefondan yapılamaz'});
  let args;try{args=JSON.parse((await this.body(req,MAX_JSON)).toString('utf8')).args;}catch{return this.json(res,400,{ok:false,error:'Geçersiz istek'});}
  if(!Array.isArray(args))return this.json(res,400,{ok:false,error:'Geçersiz istek'});
  try{const value=await handler(...args);return this.json(res,200,{ok:true,value:value===undefined?null:value});}
  catch(error){return this.json(res,200,{ok:false,error:error?.message??String(error)});}
 }
 events(req,res){
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive'});
  res.write('retry: 3000\n\n');this.clients.add(res);
  req.on('close',()=>this.clients.delete(res));
 }
 body(req,limit){
  return new Promise((resolve,reject)=>{let size=0;const chunks=[];
   req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(Error('Dosya çok büyük'));req.destroy();return;}chunks.push(chunk);});
   req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});
 }
 async file(res,target,headers={}){
  let info;try{info=await stat(target);}catch{info=null;}
  if(!info?.isFile())return this.send(res,404,TYPES['.txt'],'Bulunamadı');
  res.writeHead(200,{'Content-Type':TYPES[path.extname(target).toLowerCase()]??'application/octet-stream','Content-Length':info.size,...headers});
  createReadStream(target).pipe(res);
 }
 send(res,status,type,body,headers={}){res.writeHead(status,{'Content-Type':type,...headers});res.end(body);}
 json(res,status,value){this.send(res,status,'application/json; charset=utf-8',JSON.stringify(value),{'Cache-Control':'no-store'});}
}
