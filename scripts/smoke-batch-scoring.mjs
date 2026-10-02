// Synthetic table fixture; no agent or external website is contacted.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const assets=['automation-results.js','record-table.js','record-operation-status.js','workspace-tabs.js','score-breakdown.js','scoring-state.js','style.css','board.css','automations.css','termloop-theme.css'];
const server=createServer(async(req,res)=>{
 try{
  const name=req.url?.replace('/src/','');
  if(req.url?.startsWith('/src/')&&assets.includes(name)){res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL('../src/'+name,import.meta.url)));return;}
  if(req.url!=='/'){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toplu puanlama kontrolü</title>
  ${['style.css','board.css','automations.css','termloop-theme.css'].map(file=>'<link rel="stylesheet" href="/src/'+file+'">').join('')}
  <body style="display:block;overflow:auto;height:auto;padding:24px"><main class="automations-page" style="max-width:1150px;margin:auto"><h1>Toplu puanlama</h1><p id="status" role="status">Testler çalışıyor…</p><header class="section-title"><h2>Takip kayıtları ve sonuçlar</h2></header><section id="records"></section><p id="request" role="status"></p></main>
  <script type="module">
  import {automationResultsTable} from '/src/automation-results.js';
  const root=document.querySelector('#records'),status=document.querySelector('#status'),calls=[];
  const button=(text,click,className='quiet')=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=click;b.className=className;return b;};
  const definition={recordOperations:{score:{label:'Puanla'}},records:{states:[{id:'found',label:'Bulundu'},{id:'completed',label:'Tamamlandı'}]}};
  const makeSnapshot=id=>({automation:{id,revision:1,browserMode:'separate',table:{columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'İlan',type:'text'},{key:'score',label:'Puan',type:'number'}]}},definition,results:Array.from({length:13},(_,i)=>({id:'r'+(i+1),title:'Yazılım Geliştirici '+(i+1),url:'https://example.test/jobs/'+i,summary:'Sentetik test ilanı',status:i===12?'completed':'found',updatedAt:1790928000000-i*1000,cells:{score:70+i},recordAction:{scoreOperation:i===12?null:{label:'Yeniden puanla',disabled:false}}}))});
  let snapshot=makeSnapshot('first'),fail=false,release;
  const api={automationRecordsScore:async(workspace,ids)=>{calls.push({workspace,ids});document.querySelector('#request').textContent='Toplu istek: '+ids.length+' kayıt · '+calls.length+' çağrı';if(fail)throw Error('Örnek bağlantı hatası');await new Promise(resolve=>{release=resolve;});},automationStar:async()=>{},openLink:()=>{}};
  const table=automationResultsTable(root,{button,badge:text=>document.createTextNode(text),time:()=> '02.10.2026',api,refresh:async()=>table.update(snapshot,false)});
  table.update(snapshot,false);
  const check=(condition,message)=>{if(!condition)throw Error(message);},select=id=>root.querySelector('[data-record-select="'+id+'"]'),bulk=()=>root.querySelector('[data-records-score]'),page=()=>root.querySelector('[data-records-select-page]'),findButton=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text),pause=()=>new Promise(resolve=>setTimeout(resolve,0));
  try{
   check(root.querySelectorAll('[data-record-select]').length===10,'Sayfa boyutu');select('r1').click();select('r2').click();check(page().indeterminate,'Kısmi seçim');
   findButton('Sonraki').click();select('r11').click();check(select('r13').disabled,'Tamamlanan kayıt seçilemez');check(bulk().textContent.includes('(3)'),'Sayfalar arası seçim');
   findButton('Önceki').click();check(select('r1').checked&&select('r2').checked,'Önceki seçim korunur');
   document.querySelector('#automation-result-search').value='Geliştirici 2';document.querySelector('#automation-result-search').dispatchEvent(new Event('input'));check(bulk().textContent.includes('(3)'),'Filtre seçimi korur');
   document.querySelector('#automation-result-search').value='';document.querySelector('#automation-result-search').dispatchEvent(new Event('input'));table.update(snapshot,false);check(select('r1').checked,'Yenileme seçimi korur');
   const pending=bulk().onclick();check(bulk().disabled,'Gönderilirken pasif');await bulk().onclick();check(calls.length===1,'Çift tıklama tek istek');check(JSON.stringify(calls[0])===JSON.stringify({workspace:'first',ids:['r1','r2','r11']}),'Tam seçim tek çağrıda');release();await pending;check(root.querySelector('.record-selection-toolbar').hidden,'Başarıdan sonra seçim temiz');
   select('r3').click();fail=true;await bulk().onclick();check(select('r3').checked,'Hatada seçim korunur');check(root.querySelector('[role="alert"]').textContent.includes('bağlantı'),'Hata görünür');fail=false;
   findButton('Seçimi temizle').click();page().click();check(bulk().textContent.includes('(10)'),'Sayfayı seç');page().click();check(root.querySelector('.record-selection-toolbar').hidden,'Sayfa seçimini kaldır');
   select('r4').click();snapshot.results[3].recordAction.scoreOperation.disabled=true;table.update(snapshot,false);check(!select('r4').checked&&select('r4').disabled,'Artık uygun olmayan seçimi kaldır');
   select('r5').click();snapshot=makeSnapshot('second');table.update(snapshot,false);check(!select('r5').checked,'Çalışma alanı değişimi');
   select('r1').click();select('r2').click();select('r3').click();
   // Completed scores remain successful when the shared batch stops.
   snapshot.results[0].assessment={score:88,revision:1,scoringVersion:4,eligibility:'verified',summary:'Puan kaydedildi'};
   snapshot.results[0].recordAction={...snapshot.results[0].recordAction,scoringComplete:true,task:null,lastTask:null,retryOperation:null};
   snapshot.results[1].recordAction={...snapshot.results[1].recordAction,scoringComplete:false,lastTask:{kind:'score',state:'blocked',at:1790930000000,summary:'3 kaydın 1 puanı kaydedildi; 2 kayıt kaldı.'},retryOperation:{kind:'score',disabled:false}};
   table.update(snapshot,false);
   check(!root.querySelector('[data-result-id="r1"]').textContent.includes('İşlem engellendi'),'Kaydedilen puan başarısız görünmez');
   check(root.querySelector('[data-result-id="r2"]').textContent.includes('2 kayıt kaldı'),'Kalan kaydın açıklaması görünür');
   // Keep manual interaction functional after the automatic checks.
   api.automationRecordsScore=async(workspace,ids)=>{document.querySelector('#request').textContent='Tek toplu istek alındı: '+ids.length+' kayıt ('+ids.join(', ')+')';};
   status.textContent='PASS · Çoklu seçim, sayfalama, filtre, yenileme, tek toplu istek, çift tıklama, hata ve çalışma alanı değişimi doğrulandı.';
  }catch(error){status.textContent='FAIL · '+error.message;console.error(error);}
  </script></body></html>`);
 }catch(error){res.writeHead(500).end(error.message);}
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
