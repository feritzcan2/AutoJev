import {scanPageLabel} from '../app/scan-page.mjs';
import {recipeSummary,RECIPE_PAGINATION_KINDS} from '../app/source-recipe.mjs';
import {workspaceSourceTabs} from './workspace-tabs.js';
import {sourceLibraryPanel} from './source-library.js';

const modes={observe:'Sadece bul',prepare:'Hazırla, onayımı bekle',auto:'Otomatik gönder'};
const paginationLabels={auto:'Otomatik tespit',url_param:'Sayfa parametresi (page=2)',next_link:'Sonraki bağlantısı',next_click:'Sonraki düğmesi',load_more:'Daha fazla yükle',infinite_scroll:'Sonsuz kaydırma',none:'Tek sayfa'};
const methodLabels={none:'Henüz yok · deneme turunda öğrenilecek',url_template:'URL şablonu',search_form:'Arama formu',discovery:'Keşif · agent her turda kendisi arar'};
const runOutcomes={completed:'Başarılı',failed:'Başarısız',blocked:'Engellendi',timeout:'Süre doldu',interrupted:'Durduruldu',partial:'Kısmi tamamlandı'};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const time=at=>at?new Date(at).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
function timeUntil(at){
 const remaining=at-Date.now();if(remaining<=0)return 'sırası geldi';if(remaining<60000)return '1 dk içinde';
 const minutes=Math.ceil(remaining/60000),parts=[[Math.floor(minutes/1440),'gün'],[Math.floor(minutes/60)%24,'saat'],[minutes%60,'dk']];
 return parts.filter(([value])=>value).slice(0,2).map(([value,unit])=>`${value} ${unit}`).join(' ')+' sonra';
}
const updateNextRun=node=>{node.textContent=node.dataset.sourceNextLabel+' '+timeUntil(Number(node.dataset.sourceNextAt))+(node.dataset.sourceNextSuffix??'');};

// One row per source: who it is, what it is doing now, and the recipe that
// lets the next scan skip discovery. Everything else opens on demand.
export function automationSourcesPanel(host,api,{refresh,notice,ask}){
 let data,owner,editing=null,memory=null,adding=false,saving=false,bulkSaving=false;
 host.innerHTML='<div class="sources-head"><div><h2>Kaynaklar</h2><p></p></div><div class="sources-head-actions"></div></div><div data-add></div><ul class="source-list"></ul><div class="sources-foot"></div>';
 const head=host.querySelector('.sources-head'),headActions=head.querySelector('.sources-head-actions'),list=host.querySelector('.source-list'),addHost=host.querySelector('[data-add]'),foot=host.querySelector('.sources-foot');
 const rows=new Map(),otherHost=el('li',null,'source-tabs-other'),empty=el('li',null,'source-empty');
 empty.append(el('strong','Henüz kaynak yok'),document.createTextNode('Bir ilan sitesi ekle, listeden seç veya agent’tan bulmasını iste. İlk turda agent siteyi bir kez çözer ve arama reçetesini kaydeder.'));
 list.append(otherHost);
 const countdown=setInterval(()=>{if(!host.isConnected){clearInterval(countdown);return;}if(host.getClientRects().length)for(const node of host.querySelectorAll('[data-source-next-at]'))updateNextRun(node);},30000);
 const tabsControl=workspaceSourceTabs(api,{notice});
 const library=sourceLibraryPanel(api,{refresh,notice});head.after(library.host);
 const action=fn=>async event=>{event?.preventDefault();if(saving)return;saving=true;notice('');try{await fn();}catch(error){notice(error.message);}finally{saving=false;}};
 const button=(label,fn,cls='quiet')=>{const b=el('button',label,cls);b.type='button';b.onclick=action(fn);return b;};
 const busySource=url=>(data.activeRuns??[]).some(run=>run.kind!=='interview'&&(run.sourceUrl?run.sourceUrl===url:(run.sources??data.automation.sources).includes(url)));

 // Header actions: add, pick from the library, ask the agent. Export lives in the footer.
 const add=button('＋ Kaynak ekle',()=>{adding=!adding;render();},'primary');headActions.append(add);
 const fromLibrary=button('Listeden ekle',()=>library.toggle());fromLibrary.dataset.openSourceLibrary='';headActions.append(fromLibrary);
 if(ask){const discover=button('Agent ile bul',ask);discover.dataset.sourceDiscover='';headActions.append(discover);}
 const exportButton=button('Kaynak tanımlarını dışa aktar',async()=>{const file=await api.automationSourceExport(owner);if(file)notice('Kaynak tanımları ve reçeteleri dışa aktarıldı. Arama kriterleri ve geçmiş dahil edilmedi.');});

 // Bulk settings fold away; a single form applies mode and interval to every source.
 const bulk=el('details',null,'source-bulk');bulk.innerHTML='<summary>Tüm kaynaklara uygula</summary>';
 const bulkForm=el('form',null,'source-bulk-form');
 bulkForm.innerHTML='<label>İşlem modu<select name="mode"><option value="">Değiştirme</option></select></label><label for="automation-sources-interval">Tarama aralığı (dk)<input id="automation-sources-interval" name="intervalMinutes" type="number" min="1" max="10080" step="1" placeholder="Değiştirme"></label><button type="submit" class="quiet">Tümüne uygula</button><small role="status"></small>';
 for(const [mode,label] of Object.entries(modes))bulkForm.elements.mode.append(new Option(label,mode));
 bulk.append(bulkForm);foot.before(bulk);foot.append(exportButton);
 bulkForm.onsubmit=action(async()=>{
  if(!owner||!data?.sources?.length||!bulkForm.reportValidity())return;
  const scope=owner,mode=bulkForm.elements.mode.value,interval=bulkForm.elements.intervalMinutes.value;
  if(!mode&&!interval){notice('Değiştirilecek bir ayar seç.');return;}
  bulkSaving=true;render();
  try{
   if(mode)await api.automationSourceModes(scope,mode);
   if(interval)await api.automationSourcesInterval(scope,Number(interval));
   if(owner===scope&&host.isConnected){bulkForm.reset();await refresh();if(owner===scope&&host.isConnected)notice('Ayar tüm kaynaklara uygulandı.');}
  }finally{bulkSaving=false;render();}
 });

 const proposal=el('section',null,'source-proposal');proposal.setAttribute('aria-label','Agent’ın kaynak önerileri');proposal.hidden=true;head.after(proposal);
 function renderProposal(){
  const draft=data.automation.sourceDraft;proposal.hidden=!draft;proposal.replaceChildren();if(!draft)return;
  const scope=owner,current=data.automation.sources,added=draft.sources.filter(url=>!current.includes(url)),removed=current.filter(url=>!draft.sources.includes(url));
  proposal.append(el('h3','Agent’ın kaynak önerileri'),el('p','Değişiklikleri inceleyip uygula. Yeni kaynakların ilk turu denemedir.'));
  const changes=el('ul');for(const [label,urls] of [['Eklenecek',added],['Kaldırılacak',removed]])for(const url of urls){const item=el('li');item.append(el('b',label+': '),el('span',url));changes.append(item);}proposal.append(changes);
  const actions=el('div',null,'actions'),apply=button('Önerileri uygula',async()=>{await api.automationSourceDraft(scope,draft.id,true);await refresh();notice('Kaynak önerileri uygulandı.');},'primary');
  apply.disabled=removed.some(busySource)||bulkSaving;
  const discard=button('Önerileri kaldır',async()=>{await api.automationSourceDraft(scope,draft.id,false);await refresh();notice('Kaynak önerileri kaldırıldı.');});discard.disabled=bulkSaving;actions.append(apply,discard);proposal.append(actions);
  if(removed.some(busySource))proposal.append(el('small','Uygulamak için kaldırılacak kaynakların çalışan görevlerini durdur.'));
 }

 function sourceRow(url){
  const view={row:el('li',null,'source-row'),toggle:el('input',null,'switch'),main:el('div',null,'source-main'),actions:el('div',null,'source-actions'),tabHost:el('div',null,'source-tabs-control'),run:button('',()=>{}),edit:button('',()=>{},'quiet source-edit'),memoryButton:button('',()=>{},'quiet source-memory-toggle'),pending:null};
  view.toggle.type='checkbox';view.row.dataset.sourceId=url;
  view.actions.append(view.run,view.edit,view.memoryButton,view.tabHost);
  view.row.append(view.toggle,view.main,view.actions);
  rows.set(url,view);return view;
 }
 async function scanAction(view,scope,url,stop){
  if(view.pending)return;
  const current=()=>owner===scope&&rows.get(url)===view&&host.isConnected;
  view.pending=stop?'stop':'start';notice('');render();
  try{
   await (stop?api.automationSourceStop(scope,url):api.automationSourceRun(scope,url));
   if(current()){await refresh();if(current())notice(stop?'Tarama durduruldu. Kaydedilen ilerleme korundu.':'Tarama isteği alındı. Kaynak hazır olduğunda başlayacak.');}
  }catch(error){if(current())notice(error.message);}
  finally{view.pending=null;if(current())render();}
 }

 // Status: one bold state, one supporting line. The recipe chip stands alone.
 function statusLine(source){
  const status=el('div',null,'source-status');
  const state=source.blocker?.stop?.retryExhausted?'Erişim sorunu sürüyor':source.siteWait?.exhausted?'Otomatik deneme durduruldu':source.siteWait?'Site için ortak bekleme':source.scanning?(source.trialRunning?'Deneme sürüyor':source.scanIssue?'Sayfa yüklenemedi':'Taranıyor'):source.recovery&&data.automation.status==='enabled'?'Otomatik devam bekleniyor':source.blocked?(source.lastStatus==='failed'||source.blocker?.stop?.kind==='technical'?'Tarama tamamlanamadı':'Kaynak engelli'):source.lastStatus==='partial'?`Kısmi tarama · ${source.scan?.pendingUrls.length??0} adres kaldı`:(source.lastRun?.finishedAt??source.lastRunAt)?`Toplam ${source.resultCount??source.lastFound??0} kayıt`:'Henüz taranmadı';
  status.append(el('b',state));
  const outcome=source.lastRun??{status:source.lastStatus,summary:source.lastResult,finishedAt:source.lastRunAt};
  const detail=source.scanning?(source.scanIssue?`${source.scanIssue.url} · ${source.scanIssue.attempts}. deneme`:scanPageLabel(source.pageProgress)?'Son doğrulanan: '+scanPageLabel(source.pageProgress):null):source.siteWait?.message??outcome.summary??null;
  if(detail){const small=el('small',detail);small.title=source.scanIssue?.evidence??detail;status.append(small);}
  return {status,outcome};
 }
 function metaLine(source,outcome){
  const meta=el('div',null,'source-meta');
  const plan=el('span',null,'source-plan');plan.append(el('b',`Her ${source.intervalMinutes} dk`),document.createTextNode(' · '+modes[source.mode]));meta.append(plan);
  const timing=el('span',null,'source-timing'),nextRun=el('b',!source.enabled?'Kapalı':source.scanning?'Şu anda taranıyor':source.blocked?'Yeniden başlatılmayı bekliyor':data.automation.status!=='enabled'?'Takip duraklatıldı':'Sıradaki tarama');
  const nextAt=source.enabled?(source.siteWait?.retryAt??(!source.scanning&&!source.blocked&&data.automation.status==='enabled'?source.nextRunAt:null)):null;
  if(nextAt){nextRun.dataset.sourceNextAt=String(nextAt);nextRun.dataset.sourceNextLabel=source.siteWait?'Erişim kontrolü':'Sonraki tarama';nextRun.title=nextRun.dataset.sourceNextLabel+' '+time(nextAt);updateNextRun(nextRun);}
  timing.append(nextRun);meta.append(timing);
  const outcomeLabel=runOutcomes[outcome.status],lastRun=el('span',outcomeLabel?`Son tur: ${outcomeLabel}`:source.scanning?'Son tur: İlk tarama sürüyor':'Son tur: Henüz çalışmadı','source-last-run');
  lastRun.dataset.status=outcomeLabel?outcome.status:'none';if(outcomeLabel)lastRun.title=[outcome.finishedAt?time(outcome.finishedAt):null,outcome.summary].filter(Boolean).join(' · ');meta.append(lastRun);
  if(!source.trial||source.trial.status==='failed'){const trial=el('small',source.trialRunning?'Denemede işlem gönderilmez':source.trial?.status==='failed'?'Deneme tamamlanamadı':'İlk turda denenecek','source-trial-status');trial.dataset.status=source.trialRunning?'running':source.trial?.status??'pending';meta.append(trial);}
  return meta;
 }
 function recipeChip(source){
  const summary=recipeSummary(source.recipe??null,source.recipeState??null);
  const chip=button(summary.label,()=>{editing=source.url;render();list.querySelector('.source-editor .source-recipe-editor')?.scrollIntoView({block:'nearest'});},'source-recipe');
  chip.dataset.status=summary.status;chip.title=summary.detail+(source.recipeState?.verifiedAt?` · Doğrulandı ${time(source.recipeState.verifiedAt)}`:'');
  return chip;
 }

 // Memory: scan facts, recipe history and the pending queue. Rules fold away.
 function progressDetails(source){
  const section=el('section',null,'source-progress-details source-memory'),page=source.pageProgress,scan=source.scan,state=source.scanState,cycle=state?.active??state?.lastCompleted,pending=scan?.complete===false?scan.pendingUrls??[]:[];
  section.dataset.sourceId=source.url;section.setAttribute('aria-label','Tarama hafızası');section.append(el('h3','Tarama hafızası'));
  const facts=el('dl',null,'source-progress-facts');
  for(const [label,value] of [['Tarama türü',cycle?.mode==='incremental'?'Yeni kayıt kontrolü':cycle?'Tam tarama':source.trial?.status==='passed'?'İlk taramada tüm sayfalar':'İlk turda kaynak denemesi'],['Son tam tarama',time(state?.lastFullScanAt)],['Bu turun başlangıcı',time(cycle?.startedAt)],['Yeni kayıtlar için tarih sınırı',cycle?.mode==='incremental'?time(cycle.cutoffAt):'Son sayfaya kadar'],['Toplam kayıt',source.resultCount??0],['Son bildirilen sayfa',page?`${page.currentPage}. sayfa${page.totalPages?` / ${page.totalPages}`:''}`:'Henüz bildirilmedi']]){const fact=el('div');fact.append(el('dt',label),el('dd',String(value)));facts.append(fact);}
  section.append(facts);
  const note=(label,text)=>{const group=el('div',null,'source-progress-note');group.append(el('b',label),el('p',text));section.append(group);};
  const address=url=>button(url,()=>api.openLink(url),'source-progress-url');
  const recipe=el('div',null,'source-progress-note source-progress-recipe'),summary=recipeSummary(source.recipe??null,source.recipeState??null),rs=source.recipeState;
  recipe.append(el('b','Arama reçetesi'));
  const lines=[summary.label+' · '+summary.detail];
  if(source.recipe?.entry.kind==='url_template')lines.push('Şablon: '+source.recipe.entry.template);
  if(source.recipe?.entry.kind==='search_form')lines.push('Form: '+source.recipe.entry.url+' · '+source.recipe.entry.fields.map(f=>`${f.key}=“${f.label}”`).join(', '));
  if(source.recipe?.terms?.length)lines.push('Arama terimleri: '+source.recipe.terms.join(', '));
  if(source.recipe&&source.recipe.entry.kind!=='discovery')lines.push('Sayfalama: '+paginationLabels[source.recipe.pagination??'auto']);
  if(rs?.verifiedAt)lines.push(`Son doğrulama ${time(rs.verifiedAt)} · ${rs.successCount} başarılı, ${rs.failCount} başarısız`);
  if(rs?.lastFailure)lines.push(`Son hata ${time(rs.lastFailure.at)}: ${rs.lastFailure.reason}${rs.lastFailure.url?' · '+rs.lastFailure.url:''}`);
  recipe.append(el('p',lines.join('\n')));section.append(recipe);
  const reasons={initial:'İlk başarılı tam tarama henüz yapılmadı.',periodic:'Düzenli tam tarama zamanı geldi.',ordering_unverified:'Yeniden eskiye sıralama doğrulanamadı; tüm sayfalar taranacak.',start_unverified:'Taramanın ilk sayfadan başladığı doğrulanamadı; tüm sayfalar taranacak.',dates_unverified:'İlan tarihleri eksik veya belirsiz; tüm sayfalar taranacak.',ordering_changed:'İlanların tarih sırası tutarlı değil; tüm sayfalar taranacak.'};
  if(reasons[cycle?.reason])note('Kapsamın nedeni',reasons[cycle.reason]);
  if(page?.url){const group=el('div',null,'source-progress-note');group.append(el('b','Son bildirilen sonuç sayfası'),address(page.url));section.append(group);}
  else if(cycle?.checkpoint?.url){const group=el('div',null,'source-progress-note');group.append(el('b','Devam sayfası'),address(cycle.checkpoint.url));section.append(group);}
  if(cycle?.checkpoint?.cursor)note('Kaydedilen devam işareti',cycle.checkpoint.cursor);
  if(source.recovery)note('Otomatik devam',`${time(source.recovery.readyAt)} · Agent oturumu kesildi; aynı kaynak ve devam noktası yeniden devralınacak.`);
  if(cycle?.boundary)note('Tarih sınırı','Bu sayfadaki tüm kayıtlar tarih sınırından eski olarak bildirildi ve doğrulandı.');
  if(scan?.reason)note(scan.complete?'Tamamlanma notu':'Devam notu',scan.reason);
  if(source.observedPage&&page&&source.observedPage.currentPage!==page.currentPage)note('Son açılan sonuç sayfası',`${source.observedPage.currentPage}. sayfa. Kayıtlı ilerleme ve kalan adresler korunuyor.`);
  if(scan?.work?.searches.length>1){
   const searches=el('div',null,'source-progress-note');searches.append(el('b','Aramalar'));
   for(const search of scan.work.searches)searches.append(el('p',`${search.label} · ${search.status==='completed'?'Tamamlandı':`${search.pendingUrls.length} adres bekliyor`}${search.pageProgress?` · ${search.pageProgress.currentPage}. sayfa`:''}${search.id===scan.work.activeSearchId?' · Seçili arama':''}`));
   section.append(searches);
  }
  if(pending.length){
   const details=el('details',null,'source-progress-pending'),urls=el('ol');details.open=pending.length===1;details.append(el('summary',`Devam edilecek adresler (${pending.length})`));
   let shown=0;const more=button('Sonraki 100 adresi göster',()=>append());
   const append=()=>{for(const url of pending.slice(shown,shown+100)){const item=el('li');item.append(address(url));urls.append(item);}shown=Math.min(shown+100,pending.length);more.hidden=shown>=pending.length;};
   append();details.append(urls,more);section.append(details);
  }
  if(source.lastResult)note('Son çalışma sonucu',source.lastResult);
  const rules=el('details',null,'source-progress-rules');rules.append(el('summary','Takip kuralı'),el('p','İlk turda kaynak denenir, reçete kaydedilir ve işlem gönderilmez. Sonraki ilk taramada ve 7 günde bir tüm sayfalar taranır. Diğer turlarda, güvenilir tarih sıralaması varsa son başarılı turun başlangıcından 24 saat öncesine kadar kontrol edilir. Reçete iki ardışık turda sonuç vermezse kaynak yeniden öğrenilir.'));
  section.append(rules);
  return section;
 }

 // Editor: the source itself, then its search recipe. Skill text is no longer edited here.
 function recipeFields(form,recipe){
  const f=form.elements;f.method.value=recipe?recipe.entry.kind:'none';
  f.template.value=recipe?.entry.kind==='url_template'?recipe.entry.template:'';
  f.formUrl.value=recipe?.entry.kind==='search_form'?recipe.entry.url:'';
  f.queryLabel.value=recipe?.entry.kind==='search_form'?recipe.entry.fields.find(x=>x.key==='query')?.label??'':'';
  f.locationLabel.value=recipe?.entry.kind==='search_form'?recipe.entry.fields.find(x=>x.key==='location')?.label??'':'';
  f.terms.value=recipe?.terms?.join(', ')??'';
  f.pagination.value=recipe?.pagination??'auto';f.notes.value=recipe?.notes??'';
  syncRecipeFields(form);
 }
 function syncRecipeFields(form){
  const method=form.elements.method.value;
  form.querySelector('[data-recipe-template]').hidden=method!=='url_template';
  form.querySelector('[data-recipe-form]').hidden=method!=='search_form';
  form.querySelector('[data-recipe-terms]').hidden=form.querySelector('[data-recipe-pagination]').hidden=!['url_template','search_form'].includes(method);
  form.querySelector('[data-recipe-notes]').hidden=method==='none';
  form.elements.template.required=method==='url_template';form.elements.formUrl.required=form.elements.queryLabel.required=method==='search_form';
 }
 function readRecipe(form,existing){
  const f=form.elements,method=f.method.value;
  if(method==='none')return null;
  const keep=existing&&existing.entry.kind===method&&existing.loginRequired!==undefined?{loginRequired:existing.loginRequired}:{};
  if(method==='discovery')return {entry:{kind:'discovery'},pagination:'auto',...keep,...(f.notes.value.trim()?{notes:f.notes.value.trim()}:{})};
  const terms=f.terms.value.split(',').map(t=>t.trim()).filter(Boolean);
  const base={pagination:f.pagination.value,...keep,...(terms.length?{terms}:{}),...(f.notes.value.trim()?{notes:f.notes.value.trim()}:{})};
  if(method==='url_template')return {...base,entry:{kind:'url_template',template:f.template.value.trim()}};
  return {...base,entry:{kind:'search_form',url:f.formUrl.value.trim(),fields:[{key:'query',label:f.queryLabel.value.trim()},...(f.locationLabel.value.trim()?[{key:'location',label:f.locationLabel.value.trim()}]:[])]}};
 }
 function editor(source){
  const form=el('form',null,source?'source-editor':'source-add');form.dataset.sourceId=source?.url??'';
  form.innerHTML=`<fieldset class="source-editor-section"><legend>Kaynak</legend>
<label>Kaynak adı<input name="name" required maxlength="120"></label><label>Başlangıç adresi<input name="url" type="url" required></label>
<label class="source-editor-wide">Arama kapsamı<textarea name="query" required maxlength="2000"></textarea><small>Reçetede arama terimi yoksa {query} yer tutucusuna bu metin yazılır.</small></label>
<label>Tarama aralığı (dk)<input name="intervalMinutes" type="number" min="1" max="10080" required></label><label>İşlem modu<select name="mode"></select></label></fieldset>
<fieldset class="source-editor-section source-recipe-editor"><legend>Arama reçetesi <small class="source-recipe-legend"></small></legend>
<label class="source-editor-wide">Arama yöntemi<select name="method"></select><small>Deneme turunda agent siteyi çözer ve reçeteyi kendisi kaydeder. Biliyorsan elle de yazabilirsin; uygulama ilk taramada doğrular.</small></label>
<label class="source-editor-wide" data-recipe-template>URL şablonu<input name="template" maxlength="2000" placeholder="https://site/jobs?q={query}&l={location}&sort=date" spellcheck="false"><small>{query} arama terimini veya kapsamı alır. {location} gibi diğer yer tutucular aynı adlı kriter alanından doldurulur. Yer tutucusuz sabit adres de olabilir.</small></label>
<div class="source-editor-wide source-recipe-form" data-recipe-form><label>Arama formu sayfası<input name="formUrl" type="url" placeholder="https://site/jobs"></label><label>Arama alanı etiketi<input name="queryLabel" maxlength="120" placeholder="Stichwort"></label><label>Konum alanı etiketi (isteğe bağlı)<input name="locationLabel" maxlength="120" placeholder="Ort"></label></div>
<label class="source-editor-wide" data-recipe-terms>Arama terimleri<input name="terms" maxlength="500" placeholder="Compliance, AI Governance, Data Protection" spellcheck="false"><small>Arama kapsamı anahtar kelime değilse virgülle en fazla 5 terim yaz; her terim ayrı arama olur.</small></label>
<label data-recipe-pagination>Sayfalama<select name="pagination"></select></label>
<label class="source-editor-wide" data-recipe-notes>Agent’a not<textarea name="notes" maxlength="1000" placeholder="Filtreler, sıralama, dikkat edilecekler…"></textarea></label>
<label class="source-editor-wide">Çalışma talimatı<textarea name="instructions" maxlength="6000" placeholder="Bu kaynak için ek kurallar (isteğe bağlı)"></textarea></label></fieldset>
<div class="source-editor-foot"></div>`;
  const f=form.elements,footer=form.querySelector('.source-editor-foot'),scope=owner;
  for(const [mode,label] of Object.entries(modes)){const option=new Option(label,mode);option.disabled=Object.keys(modes).indexOf(mode)>Object.keys(modes).indexOf(data.automation.mode);f.mode.append(option);}
  for(const [value,label] of Object.entries(methodLabels))f.method.append(new Option(label,value));
  for(const value of RECIPE_PAGINATION_KINDS)f.pagination.append(new Option(paginationLabels[value],value));
  f.name.value=source?.name??'';f.url.value=source?.url??'';f.url.disabled=Boolean(source);f.query.value=source?.query??data.automation.goal;f.intervalMinutes.value=source?.intervalMinutes??data.automation.intervalMinutes;f.mode.value=source?.mode??data.automation.mode;
  f.instructions.value=source?.instructions??'';recipeFields(form,source?.recipe??null);f.method.onchange=()=>syncRecipeFields(form);
  if(source){
   const relearn=button('Yeniden öğren',async()=>{await api.automationSourceRelearn(scope,source.url);editing=null;await refresh();notice('Kaynağın sıradaki turu deneme olacak; agent reçeteyi yeniden çıkaracak.');});relearn.title='Deneme turunu yeniden çalıştırır ve reçeteyi güçlü agentle yeniden öğrenir.';relearn.dataset.sourceRelearn='';
   const remove=button('Kaynağı sil',async()=>{await api.automationSourceRemove(scope,source.url);if(owner===scope){if(editing===source.url)editing=null;if(memory===source.url)memory=null;await refresh();notice('Kaynak silindi. Bulunan kayıtlar korundu.');}},'quiet source-remove');remove.title='Kaynağı ve reçetesini sil; bulunan kayıtlar korunur.';
   footer.append(relearn,remove);
  }
  const cancel=button('Vazgeç',()=>{editing=null;adding=false;render();});cancel.dataset.cancel='';footer.append(cancel);
  const submit=el('button',source?'Kaydet':'Kaynağı ekle','primary');submit.type='submit';footer.append(submit);
  form.onsubmit=action(async()=>{
   const input={name:f.name.value,url:f.url.value,query:f.query.value,instructions:f.instructions.value,recipe:readRecipe(form,source?.recipe??null),intervalMinutes:Number(f.intervalMinutes.value),mode:f.mode.value};
   submit.disabled=true;
   try{if(source)await api.automationSourceSave(scope,source.url,input);else await api.automationSourceAdd(scope,input);editing=null;adding=false;await refresh();notice(source?'Kaynak kaydedildi.':'Kaynak eklendi. İlk turunda otomatik denenir.');}
   finally{submit.disabled=false;}
  });
  return form;
 }
 function updateEditor(form,source){
  const locked=Boolean(source.scanning);
  for(const field of form.querySelectorAll('input,textarea,select,button'))if(field.type!=='button')field.disabled=locked&&field.type==='submit'||field.name==='url'||locked&&field.tagName!=='TEXTAREA';
  for(const field of form.querySelectorAll('textarea'))field.readOnly=locked;
  for(const b of form.querySelectorAll('[data-source-relearn],.source-remove'))b.disabled=locked||busySource(source.url);
  const summary=recipeSummary(source.recipe??null,source.recipeState??null),legend=form.querySelector('.source-recipe-legend');
  legend.textContent=summary.label+(source.recipeState?.verifiedAt?` · ${time(source.recipeState.verifiedAt)}`:'');legend.dataset.status=summary.status;
  form.querySelector('.source-editor-foot').title=locked?'Kaynak çalışıyor. Değiştirmek için önce taramayı durdur.':'';
 }

 function render(){
  if(!data)return;const sources=data.sources??[],active=Boolean(data.activeRuns?.length),enabled=sources.filter(s=>s.enabled),blocked=enabled.filter(s=>s.blocked),upcoming=enabled.filter(s=>!s.scanning&&!s.blocked&&s.nextRunAt).sort((a,b)=>a.nextRunAt-b.nextRunAt)[0];
  const verified=sources.filter(s=>s.recipeState?.status==='verified').length;
  const overview=head.querySelector('p');overview.textContent=`${enabled.length} etkin kaynak${sources.length-enabled.length?`, ${sources.length-enabled.length} kapalı`:''}${blocked.length?`, ${blocked.length} engelli`:''}${sources.length?` · ${verified} reçete doğrulandı`:''}. `;
  if(data.automation.status==='enabled'&&upcoming){const next=el('span');next.dataset.sourceNextAt=String(upcoming.nextRunAt);next.dataset.sourceNextLabel='Sıradaki tarama';next.dataset.sourceNextSuffix=`: ${upcoming.name}.`;next.title=time(upcoming.nextRunAt);updateNextRun(next);overview.append(next);}
  else overview.append(document.createTextNode('Her kaynak kendi aralığında takip edilir.'));
  for(const control of bulkForm.querySelectorAll('input,select,button'))control.disabled=bulkSaving||active&&control.name==='mode'||!sources.length;
  bulkForm.setAttribute('aria-busy',String(bulkSaving));bulkForm.querySelector('[role=status]').textContent=bulkSaving?'Kaydediliyor…':active&&sources.length?'İşlem modu çalışan tur bitince değiştirilebilir.':'';
  bulk.hidden=!sources.length;list.inert=bulkSaving;addHost.inert=bulkSaving;
  library.update(owner,sources);fromLibrary.disabled=bulkSaving;library.host.inert=bulkSaving;renderProposal();add.disabled=bulkSaving;add.setAttribute('aria-expanded',String(adding));exportButton.hidden=!sources.length;
  if(adding){if(!addHost.firstChild)addHost.append(editor(null));}else addHost.replaceChildren();
  const kept=list.querySelector('.source-editor'),keptMemory=list.querySelector('.source-memory'),tabHosts=new Map(),urls=new Set(sources.map(source=>source.url));
  for(const [url,view] of rows)if(!urls.has(url)){view.row.remove();rows.delete(url);}
  let previous=null;
  for(const source of sources){
   const view=rows.get(source.url)??sourceRow(source.url),{row,toggle,main,run,edit,memoryButton,tabHost}=view,open=editing===source.url,memoryOpen=memory===source.url,scope=owner;
   const next=previous?previous.nextElementSibling:list.firstElementChild;if(next!==row)list.insertBefore(row,next);previous=row;
   row.dataset.open=String(open||memoryOpen);row.dataset.tone=source.scanning?'scanning':!source.enabled?'off':source.blocked?'blocked':source.lastFound?'found':'none';
   toggle.checked=source.enabled;toggle.disabled=Boolean(source.stopping||view.pending);toggle.setAttribute('aria-label',source.name+' aktif');
   toggle.onchange=action(async()=>{const enabled=toggle.checked;toggle.disabled=true;let saved=false;try{await api.automationSourceSave(scope,source.url,{enabled});saved=true;await refresh();}catch(error){if(!saved)toggle.checked=source.enabled;throw error;}finally{toggle.disabled=false;}});
   const name=el('div',source.name,'source-name'),link=button(new URL(source.url).hostname.replace(/^www\./,''),()=>api.openLink(source.url),'source-url');link.title=source.url;name.append(link);
   const query=el('p',source.query,'source-scope');query.title=source.query;
   const {status,outcome}=statusLine(source),meta=metaLine(source,outcome);meta.append(recipeChip(source));
   main.replaceChildren(name,query,status,meta);
   const closing=(data.activeRuns??[]).some(r=>r.sourceUrl===source.url&&!r.recordId&&!r.recordOperation)&&!source.scanning;
   let runLabel=closing?'Oturum kapanıyor…':source.blocked||source.siteWait?.exhausted?'Tekrar dene':'Şimdi tara',runDisabled=closing||source.siteWait?.waiting&&!source.siteWait?.exhausted||!source.enabled||!data.progress?.reviewed;
   run.title=source.trial?.status==='passed'?'':'İlk tur denemedir: agent siteyi çözer ve arama reçetesini kaydeder.';
   if(source.scanning||source.stopping){runLabel=source.stopping?'Durduruluyor…':'Taramayı durdur';runDisabled=source.stopping;run.dataset.sourceStop=source.url;}else delete run.dataset.sourceStop;
   if(view.pending){runLabel=view.pending==='stop'?'Durduruluyor…':'Başlatılıyor…';runDisabled=true;}
   if(run.textContent!==runLabel)run.textContent=runLabel;run.disabled=Boolean(runDisabled);run.setAttribute('aria-busy',String(Boolean(view.pending||source.stopping)));
   run.onclick=event=>{event.preventDefault();if(!run.disabled)void scanAction(view,scope,source.url,Boolean(source.scanning));};
   edit.textContent=open?'Kapat':'Düzenle';edit.onclick=action(()=>{editing=open?null:source.url;render();});edit.setAttribute('aria-expanded',String(open));
   memoryButton.textContent=memoryOpen?'Detayı kapat':'Detay';memoryButton.onclick=action(()=>{memory=memoryOpen?null:source.url;render();});memoryButton.setAttribute('aria-expanded',String(memoryOpen));
   tabHosts.set(source.url,tabHost);
   row.querySelector(':scope > .source-memory')?.remove();if(!open)row.querySelector(':scope > .source-editor')?.remove();
   if(open){const form=kept?.dataset.sourceId===source.url?kept:editor(source);updateEditor(form,source);if(form.parentElement!==row)row.append(form);}
   if(memoryOpen){const details=progressDetails(source),previousPending=keptMemory?.dataset.sourceId===source.url?keptMemory.querySelector('.source-progress-pending'):null,pending=details.querySelector('.source-progress-pending');if(previousPending&&pending)pending.open=previousPending.open;row.append(details);}
  }
  if(!sources.length){if(!empty.isConnected)list.insertBefore(empty,otherHost);}else empty.remove();
  tabsControl.update(owner,sources.map(source=>({id:source.url,url:source.url})),tabHosts,otherHost,list);
 }
 return {update(snapshot,id){if(owner!==id){editing=null;memory=null;adding=false;addHost.replaceChildren();bulkForm.reset();for(const view of rows.values())view.row.remove();rows.clear();}owner=id;data=snapshot;render();}};
}
