import {scanPageLabel} from '../app/scan-page.mjs';
import {workspaceSourceTabs} from './workspace-tabs.js';
const modes={observe:'Sadece bul',prepare:'Hazırla, onayımı bekle',auto:'Otomatik gönder'};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const time=at=>at?new Date(at).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';

// Keep the original source-row layout and controls, backed by scoped web tasks.
export function automationSourcesPanel(host,api,{refresh,notice,ask}){
 let data,owner,editing=null,memory=null,adding=false,saving=false,intervalSaving=false,intervalDirty=false;
 host.innerHTML='<div class="sources-head"><div><h2>Kaynaklar</h2><p></p></div></div><div class="source-bulk-mode"><span>Tüm kaynaklar</span></div><div data-add></div><ul class="source-list"></ul>';
 const head=host.querySelector('.sources-head'),list=host.querySelector('.source-list'),addHost=host.querySelector('[data-add]'),bulk=host.querySelector('.source-bulk-mode');
 const tabsControl=workspaceSourceTabs(api,{notice});
 const action=fn=>async event=>{event?.preventDefault();if(saving)return;saving=true;notice('');try{await fn();}catch(error){notice(error.message);}finally{saving=false;}};
 const button=(label,fn,cls='quiet')=>{const b=el('button',label,cls);b.type='button';b.onclick=action(fn);return b;};
 const add=button('＋ Kaynak ekle',()=>{adding=!adding;render();},'primary');head.append(add);if(ask){const discover=button('Agent ile kaynak bul',ask);discover.dataset.sourceDiscover='';head.append(discover);}
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
  for(const [label,value] of [['Tarama türü',cycle?.mode==='incremental'?'Yeni ilan kontrolü':cycle?'Tam tarama':'İlk turda tam tarama'],['Son başarılı turun başlangıcı',time(state?.lastSuccessfulStartAt)],['Son tam tarama',time(state?.lastFullScanAt)],['Bu turun başlangıcı',time(cycle?.startedAt)],['Yeni ilanlar için tarih sınırı',cycle?.mode==='incremental'?time(cycle.cutoffAt):'Son sayfaya kadar'],['Kayıtlı ilanlar',source.resultCount??0],['Son bildirilen sayfa',page?`${page.currentPage}. sayfa`:'Henüz bildirilmedi'],['Toplam sayfa',page?.totalPages??'Bilinmiyor'],['Son sayfa bildirimi',time(page?.at)]]){const fact=el('div');fact.append(el('dt',label),el('dd',value));facts.append(fact);}section.append(facts);
  const detail=(label,text)=>{const group=el('div',null,'source-progress-note');group.append(el('b',label),el('p',text));section.append(group);};
  const address=url=>button(url,()=>api.openLink(url),'source-progress-url');
  detail('Takip kuralı','İlk tur ve 7 günde bir tüm sayfalar taranır. Diğer turlarda, güvenilir tarih ve yeniden eskiye sıralama varsa son başarılı turun başlangıcından 24 saat öncesine kadar kontrol edilir. Kesinti veya engel bu tarihi ileri taşımaz.');
  const reasons={initial:'İlk başarılı tam tarama henüz yapılmadı.',periodic:'Düzenli tam tarama zamanı geldi.',ordering_unverified:'Yeniden eskiye sıralama doğrulanamadı; tüm sayfalar taranacak.',start_unverified:'Taramanın ilk sayfadan başladığı doğrulanamadı; tüm sayfalar taranacak.',dates_unverified:'İlan tarihleri eksik veya belirsiz; tüm sayfalar taranacak.',ordering_changed:'İlanların tarih sırası tutarlı değil; tüm sayfalar taranacak.'};
  if(reasons[cycle?.reason])detail('Kapsamın nedeni',reasons[cycle.reason]);
  if(cycle?.checkpoint?.url&&!page?.url){const group=el('div',null,'source-progress-note');group.append(el('b','Devam sayfası'),address(cycle.checkpoint.url));section.append(group);}
  if(cycle?.checkpoint?.cursor)detail('Kaydedilen devam işareti',cycle.checkpoint.cursor);
  if(source.recovery)detail('Otomatik devam',`${time(source.recovery.readyAt)} · Agent oturumu kesildi; aynı kaynak ve devam noktası yeniden devralınacak.`);
  if(cycle?.boundary)detail('Tarih sınırı','Bu sayfadaki tüm ilanlar tarih sınırından eski olarak bildirildi ve doğrulandı.');
  if(page?.url){const group=el('div',null,'source-progress-note');group.append(el('b','Son bildirilen sonuç sayfası'),address(page.url));section.append(group);}
  if(page?.evidence)detail('Sayfadaki doğrulama metni',page.evidence);
  if(scan?.reason)detail(scan.complete?'Tamamlanma notu':'Devam notu',scan.reason);
  if(pending.length){const details=el('details',null,'source-progress-pending'),urls=el('ol');details.open=pending.length===1;details.append(el('summary',`Devam edilecek adresler (${pending.length})`));for(const url of pending){const item=el('li');item.append(address(url));urls.append(item);}details.append(urls);section.append(details);}
  else if(!scan)detail('Devam noktası','Bu kaynak için henüz bir devam noktası kaydedilmedi.');
  if(source.lastResult)detail('Son çalışma sonucu',source.lastResult);
  return section;
 }
 function updateEditor(form,source){
  for(const field of form.querySelectorAll('input,textarea,select,button[type="submit"]'))field.disabled=Boolean(source.scanning)||field.name==='url';
  form.querySelector('.source-remove').disabled=Boolean(data.activeRuns?.length);
 }
 function editor(source){
  const form=el('form',null,source?'source-editor':'source-add');form.dataset.sourceId=source?.url??'';
  form.innerHTML='<label>Kaynak adı<input name="name" required maxlength="120"></label><label>Başlangıç adresi<input name="url" type="url" required></label><label class="source-query">Arama kapsamı<textarea name="query" required maxlength="2000"></textarea></label><div class="source-editor-foot"><label>Tarama aralığı (dk)<input name="intervalMinutes" type="number" min="1" max="10080" required></label><label>İşlem modu<select name="mode"></select></label></div>';
  const f=form.elements,foot=form.lastElementChild,scope=owner;
  for(const [mode,label] of Object.entries(modes)){const option=new Option(label,mode);option.disabled=Object.keys(modes).indexOf(mode)>Object.keys(modes).indexOf(data.automation.mode);f.mode.append(option);}
  f.name.value=source?.name??'';f.url.value=source?.url??'';f.url.disabled=Boolean(source);f.query.value=source?.query??data.automation.goal;f.intervalMinutes.value=source?.intervalMinutes??data.automation.intervalMinutes;f.mode.value=source?.mode??data.automation.mode;
  if(source){const remove=button('Kaynağı kaldır',async()=>{await api.automationSourceRemove(scope,source.url);editing=null;await refresh();},'quiet source-remove');remove.disabled=Boolean(data.activeRuns?.length);foot.append(remove);}
  foot.append(button('Vazgeç',()=>{editing=null;adding=false;render();}));
  const submit=el('button',source?'Kaydet':'Kaynağı ekle','primary');submit.type='submit';foot.append(submit);
  form.onsubmit=action(async()=>{const input={name:f.name.value,url:f.url.value,query:f.query.value,intervalMinutes:Number(f.intervalMinutes.value),mode:f.mode.value};submit.disabled=true;try{if(source)await api.automationSourceSave(scope,source.url,input);else await api.automationSourceAdd(scope,input);editing=null;adding=false;await refresh();notice(source?'Kaynak kaydedildi.':'Kaynak eklendi. Güncellenen profili kaydedip denemeyi çalıştır.');}finally{submit.disabled=false;}});
  return form;
 }
 function render(){
  if(!data)return;const sources=data.sources??[],active=Boolean(data.activeRuns?.length),enabled=sources.filter(s=>s.enabled),blocked=enabled.filter(s=>s.blocked),upcoming=enabled.filter(s=>!s.blocked&&s.nextRunAt).sort((a,b)=>a.nextRunAt-b.nextRunAt)[0];
  if(!intervalDirty){const common=sources.length&&sources.every(source=>source.intervalMinutes===sources[0].intervalMinutes);intervalForm.elements.intervalMinutes.value=common?String(sources[0].intervalMinutes):'';intervalForm.elements.intervalMinutes.placeholder=sources.length?'Farklı':'Dakika';}
  for(const control of intervalForm.querySelectorAll('input,button'))control.disabled=intervalSaving||!sources.length;
  intervalForm.setAttribute('aria-busy',String(intervalSaving));intervalForm.querySelector('[role=status]').textContent=intervalSaving?'Kaydediliyor…':'';
  list.inert=intervalSaving;addHost.inert=intervalSaving;bulk.inert=intervalSaving;
  head.querySelector('p').textContent=`${enabled.length} etkin kaynak, ${sources.length-enabled.length} kapalı${blocked.length?`, ${blocked.length} engelli`:''}. `+(data.automation.status==='enabled'&&upcoming?`Sıradaki tarama ${time(upcoming.nextRunAt)}: ${upcoming.name}.`:'Her kaynak kendi aralığı ve durumuyla takip edilir.');
  add.disabled=active||intervalSaving;add.setAttribute('aria-expanded',String(adding));
  for(const b of bulk.querySelectorAll('button')){b.disabled=active||!sources.length||Object.keys(modes).indexOf(b.dataset.mode)>Object.keys(modes).indexOf(data.automation.mode);b.setAttribute('aria-pressed',String(sources.length>0&&sources.every(s=>s.mode===b.dataset.mode)));}
  if(adding){if(!addHost.firstChild)addHost.append(editor(null));}else addHost.replaceChildren();
  const kept=list.querySelector('.source-editor'),keptMemory=list.querySelector('.source-memory'),tabHosts=new Map();list.replaceChildren();
  for(const source of sources){
   const row=el('li',null,'source-row'),open=editing===source.url,memoryOpen=memory===source.url;row.dataset.sourceId=source.url;row.dataset.open=String(open||memoryOpen);row.dataset.tone=source.scanning?'scanning':!source.enabled?'off':source.blocked?'blocked':source.lastFound?'found':'none';
   const toggle=el('input',null,'switch');toggle.type='checkbox';toggle.checked=source.enabled;toggle.setAttribute('aria-label',source.name+' aktif');const scope=owner;toggle.onchange=action(async()=>{toggle.disabled=true;try{await api.automationSourceSave(scope,source.url,{enabled:toggle.checked});await refresh();}finally{toggle.disabled=false;}});
   const main=el('div',null,'source-main'),name=el('div',source.name,'source-name'),link=button(new URL(source.url).hostname,()=>api.openLink(source.url),'source-url');link.title=source.url;name.append(link);const query=el('p',source.query,'source-scope');query.title=source.query;main.append(name,query,el('small',data.automation.browserMode==='jev'?'Jev tarayıcı':'Tarayıcı','source-method'));
   const plan=el('div',null,'source-plan');plan.append(el('b',`Her ${source.intervalMinutes} dk`),document.createTextNode(modes[source.mode]));
   const status=el('div',null,'source-status'),count=`Toplam ${source.resultCount??source.lastFound??0} kayıt`;
   status.append(el('b',source.scanning?'Taranıyor':source.recovery&&data.automation.status==='enabled'?'Otomatik devam bekleniyor':source.blocked?'Kaynak engelli':source.lastStatus==='partial'?`Kısmi tarama · ${source.scan?.pendingUrls.length??0} adres kaldı`:source.lastRunAt?count:'Henüz taranmadı'));
   if(source.scanning||source.blocked||source.lastStatus==='partial')status.append(el('small',count));
   if(source.lastResult){const detail=el('small',source.lastResult);detail.title=source.lastResult;status.append(detail);}
   const pageLabel=scanPageLabel(source.pageProgress);if(pageLabel){const progress=el('small',(source.scanning?'':'Son bildirilen: ')+pageLabel,'source-page-progress');progress.title=`Agent’ın bildirdiği sonuç sayfası; tamamlanma oranı değildir.\n${source.pageProgress.evidence}\n${time(source.pageProgress.at)}`;status.append(progress);}
   const timing=el('div',null,'source-timing');timing.append(el('b',!source.enabled?'Kapalı':source.scanning?'Şu anda taranıyor':source.blocked?'Yeniden başlatılmayı bekliyor':data.automation.status!=='enabled'?'Takip duraklatıldı':source.nextRunAt?`Sonraki tarama ${time(source.nextRunAt)}`:'Sıradaki tarama'),document.createTextNode(source.lastRunAt?`Son tarama ${time(source.lastRunAt)}`:'Henüz taranmadı'));
   const actions=el('div',null,'source-actions'),run=button(source.blocked?'Tekrar dene':'Şimdi tara',async()=>{await api.automationSourceRun(scope,source.url);await refresh();});run.disabled=source.scanning||!source.enabled||!data.progress?.reviewed||!data.progress?.passed;
   const memoryButton=button(memoryOpen?'Hafızayı kapat':'Tarama hafızası',()=>{memory=memoryOpen?null:source.url;render();},'quiet source-memory-toggle');memoryButton.setAttribute('aria-expanded',String(memoryOpen));
   const edit=button(open?'Kapat':'Düzenle',()=>{editing=open?null:source.url;render();},'quiet source-edit'),tabHost=el('div',null,'source-tabs-control');edit.setAttribute('aria-expanded',String(open));actions.append(run,tabHost,memoryButton,edit);tabHosts.set(source.url,tabHost);row.append(toggle,main,plan,status,timing,actions);
   if(memoryOpen){const details=progressDetails(source),previous=keptMemory?.dataset.sourceId===source.url?keptMemory.querySelector('.source-progress-pending'):null,pending=details.querySelector('.source-progress-pending');if(previous&&pending)pending.open=previous.open;row.append(details);}
   if(open){const form=kept?.dataset.sourceId===source.url?kept:editor(source);updateEditor(form,source);row.append(form);}list.append(row);
  }
  if(!sources.length)list.append(el('li','Henüz kaynak yok. Kaynak ekle veya agent’tan bulmasını iste.','source-empty'));
  const otherHost=el('li',null,'source-tabs-other');list.append(otherHost);
  tabsControl.update(owner,data.automation.browserMode,sources.map(source=>({id:source.url,url:source.url})),tabHosts,otherHost,list);
 }
 return {update(snapshot,id){if(owner!==id){editing=null;memory=null;adding=false;intervalDirty=false;addHost.replaceChildren();}owner=id;data=snapshot;render();}};
}
