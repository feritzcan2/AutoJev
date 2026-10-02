import {scanPageLabel} from '../app/scan-page.mjs';
import {workspaceSourceTabs} from './workspace-tabs.js';
import {sourceLibraryPanel} from './source-library.js';
import {SOURCE_TOOL_IDS} from '../app/source-tool-ids.mjs';
import {copySourceSkill} from '../app/source-copy.mjs';
const modes={observe:'Sadece bul',prepare:'Hazırla, onayımı bekle',auto:'Otomatik gönder'};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const time=at=>at?new Date(at).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const runOutcomes={completed:'Başarılı',failed:'Başarısız',blocked:'Engellendi',timeout:'Süre doldu',interrupted:'Durduruldu',partial:'Kısmi tamamlandı'};
function timeUntil(at){
 const remaining=at-Date.now();if(remaining<=0)return 'sırası geldi';if(remaining<60000)return '1 dk içinde';
 const minutes=Math.ceil(remaining/60000),parts=[[Math.floor(minutes/1440),'gün'],[Math.floor(minutes/60)%24,'saat'],[minutes%60,'dk']];
 return parts.filter(([value])=>value).slice(0,2).map(([value,unit])=>`${value} ${unit}`).join(' ')+' sonra';
}
const updateNextRun=node=>{node.textContent=node.dataset.sourceNextLabel+' '+timeUntil(Number(node.dataset.sourceNextAt))+(node.dataset.sourceNextSuffix??'');};

// Keep the original source-row layout and controls, backed by scoped web tasks.
export function automationSourcesPanel(host,api,{refresh,notice,ask}){
 let data,owner,editing=null,memory=null,adding=false,saving=false,intervalSaving=false,intervalDirty=false;
 host.innerHTML='<div class="sources-head"><div><h2>Kaynaklar</h2><p></p></div></div><div class="source-bulk-mode"><span>Tüm kaynaklar</span></div><div data-add></div><ul class="source-list"></ul>';
 const head=host.querySelector('.sources-head'),list=host.querySelector('.source-list'),addHost=host.querySelector('[data-add]'),bulk=host.querySelector('.source-bulk-mode');
 const rows=new Map(),otherHost=el('li',null,'source-tabs-other'),empty=el('li','Henüz kaynak yok. Kaynak ekle veya agent’tan bulmasını iste.','source-empty');
 list.append(otherHost);
 const countdown=setInterval(()=>{if(!host.isConnected){clearInterval(countdown);return;}if(host.getClientRects().length)for(const node of host.querySelectorAll('[data-source-next-at]'))updateNextRun(node);},30000);
 const tabsControl=workspaceSourceTabs(api,{notice});
 const library=sourceLibraryPanel(api,{refresh,notice});head.after(library.host);
 const action=fn=>async event=>{event?.preventDefault();if(saving)return;saving=true;notice('');try{await fn();}catch(error){notice(error.message);}finally{saving=false;}};
 const button=(label,fn,cls='quiet')=>{const b=el('button',label,cls);b.type='button';b.onclick=action(fn);return b;};
 function sourceRow(url){
  const view={row:el('li',null,'source-row'),toggle:el('input',null,'switch'),main:el('div',null,'source-main'),plan:el('div',null,'source-plan'),status:el('div',null,'source-status'),timing:el('div',null,'source-timing'),actions:el('div',null,'source-actions'),tabHost:el('div',null,'source-tabs-control'),run:button('',()=>{}),memoryButton:button('',()=>{},'quiet source-memory-toggle'),edit:button('',()=>{},'quiet source-edit'),remove:button('Kaynağı sil',()=>{},'quiet source-remove'),pending:null};
  view.toggle.type='checkbox';view.row.dataset.sourceId=url;
  view.actions.append(view.run,view.tabHost,view.memoryButton,view.edit,view.remove);
  view.row.append(view.toggle,view.main,view.plan,view.status,view.timing,view.actions);
  rows.set(url,view);return view;
 }
 async function scanAction(view,scope,url,stop){
  if(view.pending)return;
  // Each source owns its request, independently of other source edits or scans.
  const current=()=>owner===scope&&rows.get(url)===view&&host.isConnected;
  view.pending=stop?'stop':'start';notice('');render();
  try{
   await (stop?api.automationSourceStop(scope,url):api.automationSourceRun(scope,url));
   if(current()){
    await refresh();
    if(current())notice(stop?'Tarama durduruldu. Kaydedilen ilerleme korundu; sonraki tarama mevcut aralığa göre yapılacak.':'Tarama isteği alındı. Kaynak çalışmaya hazır olduğunda başlayacak.');
   }
  }catch(error){if(current())notice(error.message);}
  finally{view.pending=null;if(current())render();}
 }
 const add=button('＋ Kaynak ekle',()=>{adding=!adding;render();},'primary');head.append(add);if(ask){const discover=button('Agent ile kaynak bul',ask);discover.dataset.sourceDiscover='';head.append(discover);}
 const fromLibrary=button('Listeden ekle',()=>library.toggle());fromLibrary.dataset.openSourceLibrary='';head.append(fromLibrary);
 head.append(button('Dışa aktar',async()=>{const file=await api.automationSourceExport(owner);if(file)notice('Kaynak tanımları dışa aktarıldı. Arama kriterleri ve geçmiş dahil edilmedi.');}));
 const proposal=el('section',null,'source-proposal');proposal.setAttribute('aria-label','Agent’ın kaynak önerileri');proposal.hidden=true;head.after(proposal);
 const busySource=url=>(data.activeRuns??[]).some(run=>run.kind!=='interview'&&(run.sourceUrl?run.sourceUrl===url:(run.sources??data.automation.sources).includes(url)));
 function renderProposal(){
  const draft=data.automation.sourceDraft;proposal.hidden=!draft;proposal.replaceChildren();if(!draft)return;
  const scope=owner,current=data.automation.sources,added=draft.sources.filter(url=>!current.includes(url)),removed=current.filter(url=>!draft.sources.includes(url));
  proposal.append(el('h3','Agent’ın kaynak önerileri'),el('p','Değişiklikleri inceleyip uygula. Yeni kaynakların ilk turu denemedir.'));
  const changes=el('ul');for(const [label,urls] of [['Eklenecek',added],['Kaldırılacak',removed]])for(const url of urls){const item=el('li');item.append(el('b',label+': '),el('span',url));changes.append(item);}proposal.append(changes);
  const actions=el('div',null,'actions'),apply=button('Kaynak önerilerini uygula',async()=>{await api.automationSourceDraft(scope,draft.id,true);await refresh();notice('Kaynak önerileri uygulandı.');},'primary');
  apply.disabled=removed.some(busySource)||intervalSaving;
  const discard=button('Önerileri kaldır',async()=>{await api.automationSourceDraft(scope,draft.id,false);await refresh();notice('Kaynak önerileri kaldırıldı.');});discard.disabled=intervalSaving;actions.append(apply,discard);proposal.append(actions);
  if(removed.some(busySource))proposal.append(el('small','Uygulamak için kaldırılacak kaynakların çalışan görevlerini durdur.'));
 }
 for(const [mode,label] of Object.entries(modes)){const b=button(label,async()=>{await api.automationSourceModes(owner,mode);await refresh();});b.dataset.mode=mode;bulk.append(b);}
 const intervalForm=el('form',null,'source-bulk-interval');
 intervalForm.innerHTML='<label for="automation-sources-interval">Tarama aralığı (dk)</label><input id="automation-sources-interval" name="intervalMinutes" type="number" min="1" max="10080" step="1" required aria-describedby="automation-sources-interval-help"><button type="submit" class="quiet">Tümüne uygula</button><small id="automation-sources-interval-help">Kapalı kaynaklar dahil tüm kaynaklara uygulanır.</small><small role="status"></small>';
 bulk.after(intervalForm);
 intervalForm.elements.intervalMinutes.oninput=()=>{intervalDirty=true;};
 intervalForm.onsubmit=action(async()=>{
  if(!owner||!data?.sources?.length||!intervalForm.reportValidity())return;
  const scope=owner,intervalMinutes=Number(intervalForm.elements.intervalMinutes.value);
  intervalSaving=true;render();
  try{
   await api.automationSourcesInterval(scope,intervalMinutes);
   if(owner===scope&&host.isConnected){
    const form=list.querySelector('.source-editor');if(form)form.elements.intervalMinutes.value=String(intervalMinutes);
    intervalDirty=false;await refresh();
    if(owner===scope&&host.isConnected)notice(`Tüm kaynakların tarama aralığı ${intervalMinutes} dakika olarak ayarlandı.`);
   }
  }finally{intervalSaving=false;render();}
 });
 function progressDetails(source){
  const section=el('section',null,'source-progress-details source-memory'),page=source.pageProgress,scan=source.scan,state=source.scanState,cycle=state?.active??state?.lastCompleted,pending=scan?.complete===false?scan.pendingUrls??[]:[];
  section.dataset.sourceId=source.url;section.setAttribute('aria-label','Tarama hafızası');section.append(el('h3','Tarama hafızası'));
  const facts=el('dl',null,'source-progress-facts');
  for(const [label,value] of [['Tarama türü',cycle?.mode==='incremental'?'Yeni kayıt kontrolü':cycle?'Tam tarama':source.trial?.status==='passed'?'İlk taramada tüm sayfalar':'İlk turda kaynak denemesi'],['Son başarılı turun başlangıcı',time(state?.lastSuccessfulStartAt)],['Son tam tarama',time(state?.lastFullScanAt)],['Bu turun başlangıcı',time(cycle?.startedAt)],['Yeni kayıtlar için tarih sınırı',cycle?.mode==='incremental'?time(cycle.cutoffAt):'Son sayfaya kadar'],['Toplam kayıt',source.resultCount??0],['Son bildirilen sayfa',page?`${page.currentPage}. sayfa`:'Henüz bildirilmedi'],['Toplam sayfa',page?.totalPages??'Bilinmiyor'],['Son sayfa bildirimi',time(page?.at)]]){const fact=el('div');fact.append(el('dt',label),el('dd',value));facts.append(fact);}section.append(facts);
  const detail=(label,text)=>{const group=el('div',null,'source-progress-note');group.append(el('b',label),el('p',text));section.append(group);};
  const address=url=>button(url,()=>api.openLink(url),'source-progress-url');
  detail('Takip kuralı','İlk turda kaynak denenir ve işlem gönderilmez. Denemeden sonraki ilk taramada ve 7 günde bir tüm sayfalar taranır. Diğer turlarda, güvenilir tarih ve yeniden eskiye sıralama varsa son başarılı turun başlangıcından 24 saat öncesine kadar kontrol edilir. Kesinti veya engel bu tarihi ileri taşımaz.');
  const reasons={initial:'İlk başarılı tam tarama henüz yapılmadı.',periodic:'Düzenli tam tarama zamanı geldi.',ordering_unverified:'Yeniden eskiye sıralama doğrulanamadı; tüm sayfalar taranacak.',start_unverified:'Taramanın ilk sayfadan başladığı doğrulanamadı; tüm sayfalar taranacak.',dates_unverified:'İlan tarihleri eksik veya belirsiz; tüm sayfalar taranacak.',ordering_changed:'İlanların tarih sırası tutarlı değil; tüm sayfalar taranacak.'};
  if(reasons[cycle?.reason])detail('Kapsamın nedeni',reasons[cycle.reason]);
  if(cycle?.checkpoint?.url&&!page?.url){const group=el('div',null,'source-progress-note');group.append(el('b','Devam sayfası'),address(cycle.checkpoint.url));section.append(group);}
  if(cycle?.checkpoint?.cursor)detail('Kaydedilen devam işareti',cycle.checkpoint.cursor);
  if(source.recovery)detail('Otomatik devam',`${time(source.recovery.readyAt)} · Agent oturumu kesildi; aynı kaynak ve devam noktası yeniden devralınacak.`);
  if(cycle?.boundary)detail('Tarih sınırı','Bu sayfadaki tüm kayıtlar tarih sınırından eski olarak bildirildi ve doğrulandı.');
  if(page?.url){const group=el('div',null,'source-progress-note');group.append(el('b','Son bildirilen sonuç sayfası'),address(page.url));section.append(group);}
  if(page?.evidence)detail('Sayfadaki doğrulama metni',page.evidence);
  if(scan?.reason)detail(scan.complete?'Tamamlanma notu':'Devam notu',scan.reason);
  if(scan?.work?.searches.length){
   const searches=el('div',null,'source-progress-note');searches.append(el('b','Aramalar'));
   for(const search of scan.work.searches){const text=`${search.label} · ${search.status==='completed'?'Tamamlandı':`${search.pendingUrls.length} adres bekliyor`}${search.pageProgress?` · ${search.pageProgress.currentPage}. sayfa`:''}${search.id===scan.work.activeSearchId?' · Seçili arama':''}`;searches.append(el('p',text));}section.append(searches);
  }
  if(source.observedPage&&page&&source.observedPage.currentPage!==page.currentPage)detail('Son açılan sonuç sayfası',`${source.observedPage.currentPage}. sayfa. Kayıtlı ilerleme ve kalan adresler korunuyor.`);
  if(pending.length){
   const details=el('details',null,'source-progress-pending'),urls=el('ol');details.open=pending.length===1;details.append(el('summary',`Devam edilecek adresler (${pending.length})`));
   let shown=0;const more=button('Sonraki 100 adresi göster',()=>append());
   const append=()=>{for(const url of pending.slice(shown,shown+100)){const item=el('li');item.append(address(url));urls.append(item);}shown=Math.min(shown+100,pending.length);more.hidden=shown>=pending.length;};
   append();details.append(urls,more);section.append(details);
  }
  else if(!scan)detail('Devam noktası','Bu kaynak için henüz bir devam noktası kaydedilmedi.');
  if(source.lastResult)detail('Son çalışma sonucu',source.lastResult);
  return section;
 }
 function updateEditor(form,source){
  for(const field of form.querySelectorAll('input,textarea,select,button[type="submit"]')){
   if(field.tagName==='TEXTAREA'){field.readOnly=Boolean(source.scanning);field.disabled=false;}
   else field.disabled=Boolean(source.scanning)||field.name==='url';
  }
  form.querySelector('.source-method-note').textContent=source.scanning?'Kaynak çalışıyor. Talimatı ve skilli değiştirmek için önce taramayı durdur.':'Bu talimat ve skill yalnızca bu kaynağa aittir; kütüphane güncellemelerinden etkilenmez.';
 }
 function editor(source){
  const form=el('form',null,source?'source-editor':'source-add');form.dataset.sourceId=source?.url??'';
  form.innerHTML='<label>Kaynak adı<input name="name" required maxlength="120"></label><label>Başlangıç adresi<input name="url" type="url" required></label><label>Araç<select name="tool"></select></label><label class="source-query">Çalışma talimatı<textarea name="instructions" maxlength="6000" placeholder="Bu sitede nasıl aranır? Filtreler, sayfalama ve araç kullanımı…"></textarea></label><details class="source-skill"><summary>Skill · kullanım rehberi</summary><label>Skill metni<textarea name="skill" maxlength="60000" spellcheck="false" placeholder="Kaynağın arama, filtreleme ve araç kullanımı rehberi"></textarea></label></details><small class="source-method-note source-query">Bu talimat ve skill yalnızca bu kaynağa aittir; kütüphane güncellemelerinden etkilenmez.</small><label class="source-query">Arama kapsamı<textarea name="query" required maxlength="2000"></textarea></label><div class="source-editor-foot"><label>Tarama aralığı (dk)<input name="intervalMinutes" type="number" min="1" max="10080" required></label><label>İşlem modu<select name="mode"></select></label></div>';
  const f=form.elements,foot=form.lastElementChild,scope=owner;
  for(const [mode,label] of Object.entries(modes)){const option=new Option(label,mode);option.disabled=Object.keys(modes).indexOf(mode)>Object.keys(modes).indexOf(data.automation.mode);f.mode.append(option);}
  f.tool.append(new Option('Agent tarayıcıyla çalışsın',''));for(const id of SOURCE_TOOL_IDS)f.tool.append(new Option(id,id));if(source?.tool&&!SOURCE_TOOL_IDS.includes(source.tool))f.tool.append(new Option(source.tool+' (bu sürümde yok)',source.tool));f.tool.value=source?.tool??'';f.instructions.value=source?.instructions??'';f.skill.value=source?.skill??'';f.tool.onchange=()=>{if(!f.skill.value)f.skill.value=copySourceSkill({tool:f.tool.value}).skill??'';};
  f.name.value=source?.name??'';f.url.value=source?.url??'';f.url.disabled=Boolean(source);f.query.value=source?.query??data.automation.goal;f.intervalMinutes.value=source?.intervalMinutes??data.automation.intervalMinutes;f.mode.value=source?.mode??data.automation.mode;
  foot.append(button('Vazgeç',()=>{editing=null;adding=false;render();}));
  const submit=el('button',source?'Kaydet':'Kaynağı ekle','primary');submit.type='submit';foot.append(submit);
  form.onsubmit=action(async()=>{const input={name:f.name.value,url:f.url.value,query:f.query.value,instructions:f.instructions.value,skill:f.skill.value,tool:f.tool.value,intervalMinutes:Number(f.intervalMinutes.value),mode:f.mode.value};submit.disabled=true;try{if(source)await api.automationSourceSave(scope,source.url,input);else await api.automationSourceAdd(scope,input);editing=null;adding=false;await refresh();notice(source?'Kaynak kaydedildi.':'Kaynak eklendi. İlk turunda otomatik denenir.');}finally{submit.disabled=false;}});
  return form;
 }
 function render(){
  if(!data)return;const sources=data.sources??[],active=Boolean(data.activeRuns?.length),enabled=sources.filter(s=>s.enabled),blocked=enabled.filter(s=>s.blocked),upcoming=enabled.filter(s=>!s.scanning&&!s.blocked&&s.nextRunAt).sort((a,b)=>a.nextRunAt-b.nextRunAt)[0];
  if(!intervalDirty){const common=sources.length&&sources.every(source=>source.intervalMinutes===sources[0].intervalMinutes);intervalForm.elements.intervalMinutes.value=common?String(sources[0].intervalMinutes):'';intervalForm.elements.intervalMinutes.placeholder=sources.length?'Farklı':'Dakika';}
  for(const control of intervalForm.querySelectorAll('input,button'))control.disabled=intervalSaving||!sources.length;
  intervalForm.setAttribute('aria-busy',String(intervalSaving));intervalForm.querySelector('[role=status]').textContent=intervalSaving?'Kaydediliyor…':'';
  list.inert=intervalSaving;addHost.inert=intervalSaving;bulk.inert=intervalSaving;
  const overview=head.querySelector('p');overview.textContent=`${enabled.length} etkin kaynak, ${sources.length-enabled.length} kapalı${blocked.length?`, ${blocked.length} engelli`:''}. `;
  if(data.automation.status==='enabled'&&upcoming){const next=el('span');next.dataset.sourceNextAt=String(upcoming.nextRunAt);next.dataset.sourceNextLabel='Sıradaki tarama';next.dataset.sourceNextSuffix=`: ${upcoming.name}.`;next.title=time(upcoming.nextRunAt);updateNextRun(next);overview.append(next);}
  else overview.append(document.createTextNode('Her kaynak kendi aralığında takip edilir. İlk turu denemedir; işlem gönderilmez.'));
  library.update(owner,sources);fromLibrary.disabled=intervalSaving;library.host.inert=intervalSaving;renderProposal();add.disabled=intervalSaving;add.setAttribute('aria-expanded',String(adding));
  for(const b of bulk.querySelectorAll('button')){b.disabled=active||!sources.length||Object.keys(modes).indexOf(b.dataset.mode)>Object.keys(modes).indexOf(data.automation.mode);b.setAttribute('aria-pressed',String(sources.length>0&&sources.every(s=>s.mode===b.dataset.mode)));}
  if(adding){if(!addHost.firstChild)addHost.append(editor(null));}else addHost.replaceChildren();
  const kept=list.querySelector('.source-editor'),keptMemory=list.querySelector('.source-memory'),tabHosts=new Map(),urls=new Set(sources.map(source=>source.url));
  for(const [url,view] of rows)if(!urls.has(url)){view.row.remove();rows.delete(url);}
  let previous=null;
  for(const source of sources){
   const view=rows.get(source.url)??sourceRow(source.url),{row,toggle,main,plan,status,timing,run,memoryButton,edit,remove,tabHost}=view,open=editing===source.url,memoryOpen=memory===source.url;
   // Keep controls attached while snapshots arrive between pointer down and up.
   const next=previous?previous.nextElementSibling:list.firstElementChild;if(next!==row)list.insertBefore(row,next);previous=row;
   row.dataset.open=String(open||memoryOpen);row.dataset.tone=source.scanning?'scanning':!source.enabled?'off':source.blocked?'blocked':source.lastFound?'found':'none';
   toggle.checked=source.enabled;toggle.disabled=Boolean(source.stopping||view.pending);toggle.setAttribute('aria-label',source.name+' aktif');const scope=owner;toggle.onchange=action(async()=>{const enabled=toggle.checked;toggle.disabled=true;let saved=false;try{await api.automationSourceSave(scope,source.url,{enabled});saved=true;await refresh();}catch(error){if(!saved)toggle.checked=source.enabled;throw error;}finally{toggle.disabled=false;}});
   const name=el('div',source.name,'source-name'),link=button(new URL(source.url).hostname,()=>api.openLink(source.url),'source-url');link.title=source.url;name.append(link);const query=el('p',source.query,'source-scope');query.title=source.query;main.replaceChildren(name,query);
   const method=button((source.tool||(data.automation.browserMode==='jev'?'Jev tarayıcı':'Tarayıcı'))+' · Skill',()=>{editing=source.url;render();const details=list.querySelector('.source-editor .source-skill');if(details){details.open=true;details.scrollIntoView({block:'nearest'});}},'source-method');method.title='Bu kaynağın talimatını ve skillini görüntüle veya düzenle';main.append(method);
   plan.replaceChildren(el('b',`Her ${source.intervalMinutes} dk`),document.createTextNode(modes[source.mode]));
   status.replaceChildren();const count=`Toplam ${source.resultCount??source.lastFound??0} kayıt`;
   status.append(el('b',source.blocker?.stop?.retryExhausted?'Erişim sorunu sürüyor':source.siteWait?'Site için ortak bekleme':source.scanning?(source.trialRunning?'Deneme sürüyor':source.scanIssue?'Sayfa yüklenemedi':'Taranıyor'):source.recovery&&data.automation.status==='enabled'?'Otomatik devam bekleniyor':source.blocked?(source.lastStatus==='failed'||source.blocker?.stop?.kind==='technical'?'Tarama tamamlanamadı':'Kaynak engelli'):source.lastStatus==='partial'?`Kısmi tarama · ${source.scan?.pendingUrls.length??0} adres kaldı`:(source.lastRun?.finishedAt??source.lastRunAt)?count:'Henüz taranmadı'));
   if(source.scanning||source.blocked||source.lastStatus==='partial')status.append(el('small',count));
   const outcome=source.lastRun??{status:source.lastStatus,summary:source.lastResult,finishedAt:source.lastRunAt},outcomeLabel=runOutcomes[outcome.status];
   const lastRun=el('span',outcomeLabel?`Son tur: ${outcomeLabel}`:source.scanning?'Son tur: İlk tarama sürüyor':'Son tur: Henüz çalışmadı','source-last-run');lastRun.dataset.status=outcomeLabel?outcome.status:'none';
   if(outcomeLabel)lastRun.title=[outcome.finishedAt?time(outcome.finishedAt):null,outcome.summary].filter(Boolean).join(' · ');status.append(lastRun);
   const trialStatus=source.trialRunning?'Denemede işlem gönderilmez':source.trial?.status==='passed'?'Deneme başarılı':source.trial?.status==='failed'?'Deneme tamamlanamadı':'İlk turda denenecek';
   const trialLabel=el('small',trialStatus,'source-trial-status');trialLabel.dataset.status=source.trialRunning?'running':source.trial?.status??'pending';status.append(trialLabel);
   if(source.siteWait)status.append(el('small',source.siteWait.message));
   const currentDetail=source.scanning?(source.scanIssue?`${source.scanIssue.url} · ${source.scanIssue.attempts}. deneme`:null):outcome.summary??source.lastResult;
   if(currentDetail){const detail=el('small',currentDetail);detail.title=source.scanIssue?.evidence??currentDetail;status.append(detail);}
   const pageLabel=scanPageLabel(source.pageProgress);if(pageLabel){const progress=el('small','Son doğrulanan: '+pageLabel,'source-page-progress');progress.title=`Agent’ın bildirdiği sonuç sayfası; tamamlanma oranı değildir.\n${source.pageProgress.evidence}\n${time(source.pageProgress.at)}`;status.append(progress);}
   const nextRun=el('b',!source.enabled?'Kapalı':source.scanning?'Şu anda taranıyor':source.blocked?'Yeniden başlatılmayı bekliyor':data.automation.status!=='enabled'?'Takip duraklatıldı':'Sıradaki tarama');
   const nextAt=source.enabled?(source.siteWait?.retryAt??(!source.scanning&&!source.blocked&&data.automation.status==='enabled'?source.nextRunAt:null)):null;
   if(nextAt){nextRun.dataset.sourceNextAt=String(nextAt);nextRun.dataset.sourceNextLabel=source.siteWait?'Erişim kontrolü':'Sonraki tarama';nextRun.title=nextRun.dataset.sourceNextLabel+' '+time(nextAt);updateNextRun(nextRun);}
   const lastAt=outcome.finishedAt??source.lastRunAt;timing.replaceChildren(nextRun,document.createTextNode(lastAt?`Son tarama ${time(lastAt)}`:'Henüz taranmadı'));
   const closing=(data.activeRuns??[]).some(run=>run.sourceUrl===source.url&&!run.recordId&&!run.recordOperation)&&!source.scanning;
   let runLabel=closing?'Oturum kapanıyor…':source.blocked?'Tekrar dene':'Şimdi tara',runDisabled=closing||source.siteWait?.waiting||!source.enabled||!data.progress?.reviewed;
   if(source.scanning||source.stopping){runLabel=source.stopping?'Durduruluyor…':'Taramayı durdur';runDisabled=source.stopping;run.dataset.sourceStop=source.url;}else delete run.dataset.sourceStop;
   if(view.pending){runLabel=view.pending==='stop'?'Durduruluyor…':'Başlatılıyor…';runDisabled=true;}
   if(run.textContent!==runLabel)run.textContent=runLabel;run.disabled=Boolean(runDisabled);
   run.setAttribute('aria-busy',String(Boolean(view.pending||source.stopping)));
   run.onclick=event=>{event.preventDefault();if(!run.disabled)void scanAction(view,scope,source.url,Boolean(source.scanning));};
   memoryButton.textContent=memoryOpen?'Hafızayı kapat':'Tarama hafızası';memoryButton.onclick=action(()=>{memory=memoryOpen?null:source.url;render();});memoryButton.setAttribute('aria-expanded',String(memoryOpen));
   edit.textContent=open?'Kapat':'Düzenle';edit.onclick=action(()=>{editing=open?null:source.url;render();});edit.setAttribute('aria-expanded',String(open));remove.onclick=action(async()=>{await api.automationSourceRemove(scope,source.url);if(owner===scope){if(editing===source.url)editing=null;if(memory===source.url)memory=null;await refresh();notice('Kaynak silindi. Bulunan kayıtlar korundu.');}});remove.disabled=Boolean(view.pending)||busySource(source.url)||closing;remove.title=remove.disabled?'Silmek için önce bu kaynağın çalışan görevini durdur.':'Kaynağı ve yerel skillini sil; bulunan kayıtlar korunur.';tabHosts.set(source.url,tabHost);
   row.querySelector(':scope > .source-memory')?.remove();if(!open)row.querySelector(':scope > .source-editor')?.remove();
   if(memoryOpen){const details=progressDetails(source),previous=keptMemory?.dataset.sourceId===source.url?keptMemory.querySelector('.source-progress-pending'):null,pending=details.querySelector('.source-progress-pending');if(previous&&pending)pending.open=previous.open;row.append(details);}
   if(open){const form=kept?.dataset.sourceId===source.url?kept:editor(source);updateEditor(form,source);if(form.parentElement!==row)row.append(form);}
  }
  if(!sources.length){if(!empty.isConnected)list.insertBefore(empty,otherHost);}else empty.remove();
  tabsControl.update(owner,data.automation.browserMode,sources.map(source=>({id:source.url,url:source.url})),tabHosts,otherHost,list);
 }
 return {update(snapshot,id){if(owner!==id){editing=null;memory=null;adding=false;intervalDirty=false;addHost.replaceChildren();for(const view of rows.values())view.row.remove();rows.clear();}owner=id;data=snapshot;render();}};
}
