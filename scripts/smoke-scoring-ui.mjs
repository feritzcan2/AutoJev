// Run this local fixture, then inspect its URL with the browser UI.
// It contains synthetic data only and cannot submit applications.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {calculateScorecard,scoringPolicy,SCORE_DIMENSIONS} from '../app/scoring-policy.mjs';
const proof={listingQuote:'Required program ownership',candidateSource:'facts',candidateQuote:'Verified compliance experience',reason:'Related experience; required program ownership is not verified.'};
const card={dimensions:SCORE_DIMENSIONS.map(key=>({key,level:'direct',...proof})),requirements:[{kind:'qualification',match:'unknown',...proof,candidateQuote:''}]};
const calculation=calculateScorecard(card,scoringPolicy({criteria:{ranking:'Eşik 60/100'}}),{listing:proof.listingQuote,sources:{facts:{text:proof.candidateQuote,digest:'synthetic'}}});
const files=new Map(['/src/score-breakdown.js','/src/scoring-state.js','/src/automation-results.js','/src/record-table.js','/src/record-operation-status.js','/src/workspace-tabs.js','/src/automations.css','/src/style.css'].map(p=>[p,new URL('..'+p,import.meta.url)]));
const server=createServer(async(req,res)=>{
 try{
  if(files.has(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(files.get(req.url)));return;}
  if(req.url!=='/'){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Puanlama arayüz kontrolü</title><link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/automations.css"><body style="display:block;padding:24px;max-width:1000px;margin:auto;overflow:auto;height:auto"><h1>Puanlama arayüz kontrolü</h1><p id="status" role="status">Kontrol ediliyor…</p><main></main><h2>Kayıt puanları</h2><section id="records"></section><script type="module">
  import {scoreBreakdown} from '/src/score-breakdown.js';
  import {automationResultsTable} from '/src/automation-results.js';
  const root=document.querySelector('main'),c=${JSON.stringify(calculation)};
  root.append(scoreBreakdown({score:c.score,calculation:c}),scoreBreakdown({score:88}));
  const rows=root.querySelectorAll('tbody tr');
  const safe=scoreBreakdown({score:0,calculation:{...c,dimensions:[{...c.dimensions[0],reason:'<img src=x onerror=alert(1)>'}],requirements:[]}});
  if(rows.length!==4||!root.textContent.includes('Ağırlıklı toplam: 100/100')||!root.textContent.includes('agent değerlendirmesine göre')||safe.querySelector('img'))throw Error('Puan görünümü hatalı');
  const records=document.querySelector('#records'),button=(label,click,className='')=>{const b=document.createElement('button');b.textContent=label;b.onclick=click;b.className=className;return b;};
  const table=automationResultsTable(records,{button,time:()=> '01.10.2026',api:{},refresh:()=>{}});
  const record=(id,title,score,revision,scoringVersion=4,eligibility='unverified')=>({id,title,url:'https://example.com/'+id,status:'found',summary:'Sentetik kayıt',updatedAt:1790875496005,assessment:{score,revision,scoringVersion,eligibility,eligibilityReason:'Sentetik zorunlu şart değerlendirmesi',summary:'Agent değerlendirmesi',scoredAt:1790875496005}});
  table.update({automation:{id:'synthetic',revision:5,browserMode:'disabled',table:{columns:[{key:'title',label:'Kayıt',type:'text'},{key:'score',label:'Puan',type:'number'}]}},definition:{records:{states:[{id:'found',label:'Bulundu'}]}},results:[record('current','Güncel agent puanı',75,5),record('older','Profil değişmeden önceki puan',60,4),record('unavailable','Değerlendirilemeyen kayıt',null,5),record('legacy','Önceki yöntemden kalan puan',39,5,3),record('blocked','Yüksek uyum, zorunlu şart eksik',87,5,4,'mismatch')]},false);
  const current=records.querySelector('[data-result-id="current"]'),older=records.querySelector('[data-result-id="older"]');
  if(!current.textContent.includes('75/100')||current.querySelector('.record-score-stale')||!older.textContent.includes('Eski değerlendirme')||!records.querySelector('[data-result-id=legacy]').textContent.includes('Eski yöntem')||!records.querySelector('[data-result-id=blocked]').textContent.includes('Zorunlu şart karşılanmıyor'))throw Error('Puan güncellik etiketi hatalı');
  current.querySelector('[data-record-score]').click();
  const detail=records.querySelector('#automation-result-detail-current');
  if(detail.hidden||!detail.textContent.includes('agent değerlendirmesine göre')||!detail.textContent.includes('Sentetik zorunlu şart değerlendirmesi'))throw Error('Doğrudan puan detayı hatalı');
  table.dispose();
  document.querySelector('#status').textContent='PASS · Puan dökümü, doğrudan agent puanı ve profil değişikliği uyarısı doğrulandı.';
  </script></body></html>`);
 }catch(error){res.writeHead(500).end(error.message);}
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
