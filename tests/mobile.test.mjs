import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MobileAccess,DESKTOP_ONLY} from '../app/mobile.mjs';

async function fixture(){
  const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-mobile-')),dist=path.join(data,'dist');
  await import('node:fs/promises').then(fs=>fs.mkdir(dist));
  await writeFile(path.join(dist,'mobile.html'),'<!doctype html><title>JobLoop</title>');
  await writeFile(path.join(dist,'mobile.js'),'console.log(1)');
  await writeFile(path.join(data,'secret.txt'),'do not serve');
  const calls=[],uploads=[];
  const handlers=new Map([['snapshot',id=>{calls.push(['snapshot',id]);return {id};}],['answer',(a,b,c)=>{calls.push(['answer',a,b,c]);}],['fails',()=>{throw Error('Aday bulunamadı');}],['pick-cv',()=>'dialog'],['mobile-rotate',()=>'rotated']]);
  const mobile=new MobileAccess({data,dist,handlers,uploadCv:async(id,name,bytes)=>{uploads.push({id,name,size:bytes.length});return '/cv/'+name;},documentFile:async(id,file)=>{if(file!=='note.txt')throw Error('Belge bulunamadı');return path.join(data,'secret.txt');}});
  await mobile.load();await mobile.setEnabled(true);
  const base=`http://127.0.0.1:${mobile.server.address().port}`;
  return {mobile,base,calls,uploads,data};
}
const cookieFrom=response=>response.headers.get('set-cookie')?.split(';')[0];
const api=(base,cookie,channel,args=[],headers={})=>fetch(`${base}/api/${channel}`,{method:'POST',headers:{'Content-Type':'application/json','X-JobLoop':'1',...(cookie?{cookie}:{}),...headers},body:JSON.stringify({args})});

test('pairing link sets a cookie; without it the app and API stay locked',async()=>{
  const {mobile,base}=await fixture();
  try{
    assert.equal((await fetch(base+'/')).status,401);
    assert.equal((await fetch(base+'/?k=wrong')).status,401);
    assert.equal((await api(base,null,'snapshot',['c1'])).status,401);
    const paired=await fetch(`${base}/?k=${mobile.config.token}`);
    assert.equal(paired.status,200);
    const cookie=cookieFrom(paired);
    assert.match(paired.headers.get('set-cookie'),/HttpOnly/);assert.match(paired.headers.get('set-cookie'),/SameSite=Strict/);
    assert.equal((await fetch(base+'/',{headers:{cookie}})).status,200);
    assert.deepEqual(await (await api(base,cookie,'snapshot',['c1'])).json(),{ok:true,value:{id:'c1'}});
  }finally{await mobile.stop();}
});

test('API passes arguments through, reports handler errors, and refuses desktop-only or unknown channels',async()=>{
  const {mobile,base,calls}=await fixture();
  try{
    const cookie=`jobloop_mobile=${mobile.config.token}`;
    assert.deepEqual(await (await api(base,cookie,'answer',['c1','q1',{mode:'Hibrit'}])).json(),{ok:true,value:null});
    assert.deepEqual(calls.at(-1),['answer','c1','q1',{mode:'Hibrit'}]);
    assert.deepEqual(await (await api(base,cookie,'fails')).json(),{ok:false,error:'Aday bulunamadı'});
    for(const channel of ['pick-cv','mobile-rotate','nope'])assert.equal((await api(base,cookie,channel)).status,404,channel);
    assert.ok(DESKTOP_ONLY.has('open-link')&&DESKTOP_ONLY.has('mobile-enable'));
    // A plain cross-site form post cannot add the custom header.
    assert.equal((await api(base,cookie,'snapshot',['c1'],{'X-JobLoop':'0'})).status,404);
  }finally{await mobile.stop();}
});

test('static files are served without traversal, documents only through the resolver',async()=>{
  const {mobile,base}=await fixture();
  try{
    const cookie=`jobloop_mobile=${mobile.config.token}`;
    assert.equal((await fetch(base+'/mobile.js')).status,200);
    assert.equal((await fetch(base+'/assets/..%2F..%2Fsecret.txt')).status,404);
    assert.equal((await fetch(base+'/files/c1/note.txt')).status,401);
    const doc=await fetch(base+'/files/c1/note.txt',{headers:{cookie}});
    assert.equal(doc.status,200);assert.equal(await doc.text(),'do not serve');
    assert.equal((await fetch(base+'/files/c1/other.txt',{headers:{cookie}})).status,404);
    const manifest=await (await fetch(base+'/manifest.webmanifest',{headers:{cookie}})).json();
    assert.equal(manifest.start_url,`/?k=${mobile.config.token}`);
    assert.equal((await (await fetch(base+'/manifest.webmanifest')).json()).start_url,'/');
  }finally{await mobile.stop();}
});

test('CV upload reaches the handler; events stream to paired phones; rotating the key signs phones out',async()=>{
  const {mobile,base,uploads,data}=await fixture();
  try{
    const cookie=`jobloop_mobile=${mobile.config.token}`;
    const upload=await fetch(`${base}/upload-cv?candidate=c1&name=CV.pdf`,{method:'POST',headers:{cookie,'X-JobLoop':'1','Content-Type':'application/octet-stream'},body:Buffer.from('%PDF-1.4 test')});
    assert.deepEqual(await upload.json(),{ok:true,value:'/cv/CV.pdf'});
    assert.deepEqual(uploads,[{id:'c1',name:'CV.pdf',size:13}]);

    const stream=await fetch(base+'/events',{headers:{cookie}});
    assert.equal(stream.headers.get('content-type'),'text/event-stream; charset=utf-8');
    const reader=stream.body.getReader();await reader.read();
    mobile.broadcast('changed',{candidateId:'c1'});
    const {value}=await reader.read();
    assert.match(new TextDecoder().decode(value),/"channel":"changed","value":\{"candidateId":"c1"\}/);

    const before=mobile.config.token;
    const status=await mobile.rotate();
    assert.notEqual(mobile.config.token,before);
    assert.equal((await reader.read()).done,true);
    assert.equal((await api(base,cookie,'snapshot',['c1'])).status,401);
    assert.equal(JSON.parse(await readFile(path.join(data,'mobile.json'),'utf8')).token,mobile.config.token);
    assert.equal(status.running,true);
  }finally{await mobile.stop();}
});

test('disabling closes the server and the choice persists',async()=>{
  const {mobile,data}=await fixture();
  await mobile.setEnabled(false);
  assert.equal(mobile.server,null);
  assert.equal(JSON.parse(await readFile(path.join(data,'mobile.json'),'utf8')).enabled,false);
  const status=await mobile.status();
  assert.equal(status.running,false);assert.deepEqual(status.urls,[]);
});
