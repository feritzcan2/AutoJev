// Synthetic table fixture; no agent or external website is contacted.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const assets = [
  'automation-results.js',
  'record-table.js',
  'record-operation-status.js',
  'workspace-tabs.js',
  'score-breakdown.js',
  'scoring-state.js',
  'style.css',
  'board.css',
  'automations.css',
  'termloop-theme.css',
];
const server = createServer(async (req, res) => {
  try {
    const name = req.url?.replace('/src/', '');
    if (req.url?.startsWith('/src/') && assets.includes(name)) {
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL('../src/' + name, import.meta.url)));
      return;
    }
    if (req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toplu puanlama kontrolü</title>
  ${['style.css', 'board.css', 'automations.css', 'termloop-theme.css'].map((file) => '<link rel="stylesheet" href="/src/' + file + '">').join('')}
  <body style="display:block;overflow:auto;height:auto;padding:24px"><main class="automations-page" style="max-width:1150px;margin:auto"><h1>Toplu puanlama</h1><p id="status" role="status">Testler çalışıyor…</p><header class="section-title"><h2>Takip kayıtları ve sonuçlar</h2></header><section id="records"></section><p id="request" role="status"></p></main>
  <script type="module">
  import {automationResultsTable} from '/src/automation-results.js';
  const root=document.querySelector('#records'),status=document.querySelector('#status'),calls=[];
  const button=(text,click,className='quiet')=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=click;b.className=className;return b;};
  const definition={recordOperations:{score:{label:'Puanla'}},records:{states:[{id:'found',label:'Bulundu'},{id:'completed',label:'Tamamlandı'}]}};
  const makeSnapshot=id=>({automation:{id,revision:1,browserMode:'separate',table:{columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'İlan',type:'text'},{key:'score',label:'Puan',type:'number'}]}},definition,results:Array.from({length:13},(_,i)=>({id:'r'+(i+1),title:'Yazılım Geliştirici '+(i+1),url:'https://example.test/jobs/'+i,summary:'Sentetik test ilanı',status:i===12?'completed':'found',updatedAt:1790928000000-i*1000,cells:{score:70+i},recordAction:{scoreOperation:i===12?null:{label:'Yeniden puanla',disabled:false}}}))});
  let snapshot=makeSnapshot('first'),fail=false,release;
  const api={workspaceTabs:async()=>[],automationRecordsScore:async(workspace,ids)=>{calls.push({workspace,ids});document.querySelector('#request').textContent='Toplu istek: '+ids.length+' kayıt · '+calls.length+' çağrı';if(fail)throw Error('Örnek bağlantı hatası');await new Promise(resolve=>{release=resolve;});},automationStar:async()=>{},openLink:()=>{}};
  const table=automationResultsTable(root,{button,badge:text=>document.createTextNode(text),time:()=> '02.10.2026',api,refresh:async()=>table.update(snapshot,false)});
  table.update(snapshot,false);
  const check=(condition,message)=>{if(!condition)throw Error(message);},select=id=>root.querySelector('[data-record-select="'+id+'"]'),bulk=()=>root.querySelector('[data-records-score]'),page=()=>root.querySelector('[data-records-select-page]'),findButton=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text),pause=()=>new Promise(resolve=>setTimeout(resolve,0));
  try{
   check(root.querySelectorAll('[data-record-select]').length===10,'Sayfa boyutu');select('r1').click();select('r2').click();check(page().indeterminate,'Kısmi seçim');
   findButton('Next').click();select('r11').click();check(select('r13').disabled,'Tamamlanan kayıt seçilemez');check(bulk().textContent.includes('(3)'),'Sayfalar arası seçim');
   findButton('Previous').click();check(select('r1').checked&&select('r2').checked,'Önceki seçim korunur');
   document.querySelector('#automation-result-search').value='Geliştirici 2';document.querySelector('#automation-result-search').dispatchEvent(new Event('input'));check(bulk().textContent.includes('(3)'),'Filtre seçimi korur');
   document.querySelector('#automation-result-search').value='';document.querySelector('#automation-result-search').dispatchEvent(new Event('input'));table.update(snapshot,false);check(select('r1').checked,'Yenileme seçimi korur');
   const pending=bulk().onclick();check(bulk().disabled,'Gönderilirken pasif');await bulk().onclick();check(calls.length===1,'Çift tıklama tek istek');check(JSON.stringify(calls[0])===JSON.stringify({workspace:'first',ids:['r1','r2','r11']}),'Tam seçim tek çağrıda');release();await pending;check(root.querySelector('.record-selection-toolbar').hidden,'Başarıdan sonra seçim temiz');
   select('r3').click();fail=true;await bulk().onclick();check(select('r3').checked,'Hatada seçim korunur');check(root.querySelector('[role="alert"]').textContent.includes('bağlantı'),'Hata görünür');fail=false;
   findButton('Clear selection').click();page().click();check(bulk().textContent.includes('(10)'),'Sayfayı seç');page().click();check(root.querySelector('.record-selection-toolbar').hidden,'Sayfa seçimini kaldır');
   select('r4').click();snapshot.results[3].recordAction.scoreOperation.disabled=true;table.update(snapshot,false);check(!select('r4').checked&&select('r4').disabled,'Artık uygun olmayan seçimi kaldır');
   select('r5').click();snapshot=makeSnapshot('second');table.update(snapshot,false);check(!select('r5').checked,'Çalışma alanı değişimi');
   select('r1').click();select('r2').click();select('r3').click();
   // Completed scores remain successful when the shared batch stops.
   snapshot.results[0].assessment={score:88,revision:1,scoringVersion:4,eligibility:'verified',summary:'Puan kaydedildi'};
   snapshot.results[0].recordAction={...snapshot.results[0].recordAction,scoringComplete:true,task:null,lastTask:null,retryOperation:null};
   snapshot.results[1].recordAction={...snapshot.results[1].recordAction,scoringComplete:false,lastTask:{kind:'score',state:'blocked',at:1790930000000,summary:'Scores saved for 1 of 3 records; 2 left.'},retryOperation:{kind:'score',disabled:false}};
   table.update(snapshot,false);
   check(!root.querySelector('[data-result-id="r1"]').textContent.includes('Operation blocked'),'Kaydedilen puan başarısız görünmez');
   check(root.querySelector('[data-result-id="r2"]').textContent.includes('2 left'),'Kalan kaydın açıklaması görünür');
   const minimum=document.querySelector('#automation-result-score-minimum'),comparison=document.querySelector('#automation-result-score-comparison'),search=document.querySelector('#automation-result-search'),filter=document.querySelector('#automation-result-filter');
   const input=(field,value)=>{field.value=value;field.dispatchEvent(new Event(field===filter||field===comparison?'change':'input'));};
   snapshot.results[1].assessment={score:null,summary:'Değerlendirilemedi'};
   snapshot.results[2].cells.score='';snapshot.results[3].cells.score=0;snapshot.results[4].cells.score=60;snapshot.results[5].cells.score=61;snapshot.results[6].cells.score=100;delete snapshot.results[7].cells.score;
   table.update(snapshot,false);findButton('Next').click();input(minimum,'60');
   check(select('r1')&&select('r6')&&select('r7')&&!select('r5'),'Puan > sınırı kesin ve sayfa sıfırlanır');
   check(!select('r2')&&!select('r3')&&!select('r4')&&!select('r8'),'Null, boş ve eksik puan filtreye dahil olmaz');
   check(bulk().textContent.includes('(3)'),'Puan filtresi seçimi korur');
   input(minimum,'88');check(!select('r1')&&select('r7'),'Değerlendirme puanı önceliklidir ve eşitlik hariçtir');
   input(minimum,'100');check(root.querySelector('.pagination-count').textContent==='0 records','Üst sınırda boş sonuç');
   input(minimum,'101');check(root.querySelector('.pagination-count').textContent==='0 records','Aralık dışı eşik filtreyi kaldırmaz');
   input(minimum,'0');check(!select('r4')&&select('r5'),'Sıfır eşiği');
   input(minimum,'60');input(comparison,'lt');check(select('r4')&&!select('r5')&&!select('r6'),'Puan < sınırı kesin');
   check(!select('r2')&&!select('r3')&&!select('r8'),'Küçüktür filtresi eksik puanları dahil etmez');
   check(bulk().textContent.includes('(3)'),'Karşılaştırma değişince seçim korunur');
   input(minimum,'60.5');check(select('r5')&&!select('r6'),'Küçüktür ondalık sınırı');
   input(minimum,'0');check(root.querySelector('.pagination-count').textContent==='0 records','Sıfırdan küçük puan yok');
   input(minimum,'100');check(select('r1')&&!select('r7'),'100 puanı küçüktür filtresinde hariç');
   input(minimum,'90');input(search,'Geliştirici 1');input(filter,'completed');check(select('r13')&&root.querySelectorAll('[data-result-id]').length===1,'Küçüktür, arama ve durum birlikte çalışır');
   input(search,'');input(filter,'all');input(minimum,'');check(root.querySelector('.pagination-count').textContent.includes('/ 13 records'),'Küçüktür için boş sınır tüm kayıtları gösterir');
   findButton('Next').click();input(comparison,'gt');check(select('r1'),'Karşılaştırma değişince ilk sayfaya dönülür');
   input(minimum,'60');input(search,'Geliştirici 1');input(filter,'completed');check(select('r13')&&root.querySelectorAll('[data-result-id]').length===1,'Puan, arama ve durum birlikte çalışır');
   input(search,'');input(filter,'all');input(minimum,'');check(root.querySelector('.pagination-count').textContent.includes('/ 13 records'),'Puan filtresini temizle');
   input(minimum,'90');input(comparison,'lt');snapshot=makeSnapshot('delete-workspace');table.update(snapshot,false);check(minimum.value===''&&comparison.value==='gt','Çalışma alanı değişince puan filtresi temizlenir');

   const deletions=[],nativeConfirm=window.confirm;let accepted=false,confirmation='';
   window.confirm=message=>{confirmation=message;return accepted;};
   api.automationRecordsDelete=async(workspace,ids)=>{deletions.push({workspace,ids});if(fail)throw Error('Örnek silme hatası');await new Promise(resolve=>{release=resolve;});if(snapshot.automation.id===workspace)snapshot={...snapshot,results:snapshot.results.filter(result=>!ids.includes(result.id))};};
   const remove=()=>root.querySelector('[data-records-delete]');table.update(snapshot,false);
   select('r1').click();findButton('Next').click();select('r13').click();
   check(bulk().disabled&&!remove().disabled,'Tamamlanan kayıt silinebilir, puanlanamaz');
   await remove().onclick();check(deletions.length===0&&select('r13').checked&&confirmation.includes('2 selected record'),'Silme onayından vazgeçme');
   accepted=true;fail=true;await remove().onclick();check(select('r13').checked&&root.querySelector('.record-selection-error').textContent.includes('silme hatası'),'Silme hatasında seçim korunur');fail=false;
   const deleting=remove().onclick();check(remove().disabled&&bulk().disabled,'Silinirken işlemler pasif');await remove().onclick();check(deletions.length===2,'Çift tıklama tek silme isteği');
   check(JSON.stringify(deletions[1])===JSON.stringify({workspace:'delete-workspace',ids:['r1','r13']}),'Silme sayfalar arası tam seçimi gönderir');release();await deleting;
   check(!snapshot.results.some(result=>['r1','r13'].includes(result.id))&&root.querySelector('.record-selection-toolbar').hidden,'Silme sonrası kayıtlar ve seçim temizlenir');
   page().click();const deleteLastPage=remove().onclick();release();await deleteLastPage;check(root.querySelector('.pagination-count').textContent==='1–10 / 10 records','Son sayfa silinince önceki sayfa görünür');
   select('r2').click();snapshot.results[0].recordAction.task={state:'running',kind:'score'};snapshot.results[0].recordAction.scoreOperation.disabled=true;table.update(snapshot,false);check(select('r2').disabled&&!select('r2').checked,'Çalışan kayıt silinmek için seçilemez');
   select('r3').click();const oldDelete=remove().onclick();snapshot=makeSnapshot('new-workspace');table.update(snapshot,false);release();await oldDelete;check(snapshot.results.length===13&&!select('r3').checked,'Eski silme yeni çalışma alanını etkilemez');
   snapshot={...makeSnapshot('generic'),definition:{records:definition.records},automation:{...makeSnapshot('generic').automation,table:{columns:[{key:'title',label:'Kayıt',type:'text'}]}}};table.update(snapshot,false);
   select('r1').click();check(bulk().hidden&&!remove().disabled&&minimum.parentElement.hidden,'Puanlamasız çalışma alanında da silme kullanılabilir');
   window.confirm=nativeConfirm;
   snapshot=makeSnapshot('preview');table.update(snapshot,false);select('r1').click();select('r2').click();select('r3').click();
   api.automationRecordsDelete=async(workspace,ids)=>{snapshot={...snapshot,results:snapshot.results.filter(result=>!ids.includes(result.id))};};
   // Keep manual interaction functional after the automatic checks.
   api.automationRecordsScore=async(workspace,ids)=>{document.querySelector('#request').textContent='Tek toplu istek alındı: '+ids.length+' kayıt ('+ids.join(', ')+')';};
   status.textContent='PASS · Toplu silme, onay, hata, sayfalama, puan > / < filtresi, seçim ve çalışma alanı kapsamı doğrulandı.';
  }catch(error){status.textContent='FAIL · '+error.message;console.error(error);}
  </script></body></html>`);
  } catch (error) {
    res.writeHead(500).end(error.message);
  }
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
