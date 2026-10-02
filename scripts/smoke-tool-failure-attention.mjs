// Synthetic UI fixture: exercise the real attention panel through the browser.
// It uses no providers, real source tabs or user database.
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
const html=`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Tool hatası testi</title><link rel="stylesheet" href="/src/automations.css"><link rel="stylesheet" href="/src/automation-attention.css"><style>:root{--warning:#d5ad56;--bg-app:#151820;--bg-raised:#24262e;--text-muted:#c3cbd8}body{background:#151820;color:#eee;font:15px system-ui;margin:0;padding:32px}main{max-width:1100px;margin:auto}button{cursor:pointer;background:#333c50;color:white;border:1px solid #667088;border-radius:8px;padding:10px}#audit{white-space:pre-wrap;border-top:1px solid #666;padding-top:20px}.automation-help-instructions{color:#c3cbd8}[hidden]{display:none!important}</style><body class="automation-workspace"><main><header><h1>Tool hatası ve erişim engeli</h1><p>Sentetik test: iki ayrı müdahale, bir çalışan kaynak.</p></header><div id="now-panel"></div><pre id="audit" aria-label="Test sonucu">Henüz işlem yapılmadı.</pre></main><script type="module">
import {automationAttentionPanel} from '/src/automation-attention.js';
const technical='https://tools.example/',access='https://captcha.example/',working='https://working.example/';
const message='Kaynak taraması durduruldu: aynı işlem 3 kez aynı hata türüyle başarısız oldu. Son hata: arguments.evidence: String too long: received 642 characters; maximum 600. Shorten this field before retrying';
const state={automation:{revision:1,reviewedRevision:1,trial:{status:'passed',revision:1}},sources:[{url:technical,name:'Tool hatası',enabled:true,blocked:true,lastRunId:'tool-run',lastStatus:'blocked',lastResult:message},{url:access,name:'CAPTCHA',enabled:true,blocked:true,lastResult:'Güncel sekmede doğrulama gerekiyor.'},{url:working,name:'Çalışan kaynak',enabled:true,scanning:true}],runs:[{id:'tool-run',sourceUrl:technical,status:'blocked',toolFailure:{tool:'report_scan_page',message,count:3}}],activeRuns:[{id:'working-run',sourceUrl:working,status:'running'}]};
const api={workspaceTabs:async()=>[],automationSourceRun:async(id,url)=>{if(id!=='fixture'||url!==technical)throw Error('Yanlış kaynak');state.sources[0].blocked=false;document.querySelector('#audit').textContent='PASS: yalnızca tool hatası olan kaynak yeniden denendi. CAPTCHA kartı ve çalışan kaynak korundu.';}};
const refresh=()=>panel.update('fixture',state);const panel=automationAttentionPanel(api,{navigate:()=>{},refresh});refresh();
</script></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return;}
  const url=new URL(req.url,'http://localhost'),file=path.resolve('.'+url.pathname);
  if(!file.startsWith(process.cwd()+path.sep)||!/^\/(?:src|app)\/[\w/-]+\.(?:m?js|css)$/.test(url.pathname)){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
server.listen(0,'127.0.0.1',()=>console.log('Tool failure UI fixture: http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>server.close());
