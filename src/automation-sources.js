const modes={observe:'Sadece bul',prepare:'Hazırla, onayımı bekle',auto:'Otomatik gönder'};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const time=at=>at?new Date(at).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';

// Keep the original source-row layout and controls, backed by scoped web tasks.
export function automationSourcesPanel(host,api,{refresh,notice}){
 let data,owner,editing=null,adding=false,saving=false;
 host.innerHTML='<div class="sources-head"><div><h2>Kaynaklar</h2><p></p></div></div><div class="source-bulk-mode"><span>Tüm kaynaklar</span></div><div data-add></div><ul class="source-list"></ul>';
 const head=host.querySelector('.sources-head'),list=host.querySelector('.source-list'),addHost=host.querySelector('[data-add]'),bulk=host.querySelector('.source-bulk-mode');
 const action=fn=>async event=>{event?.preventDefault();if(saving)return;saving=true;notice('');try{await fn();}catch(error){notice(error.message);}finally{saving=false;}};
 const button=(label,fn,cls='quiet')=>{const b=el('button',label,cls);b.type='button';b.onclick=action(fn);return b;};
 const add=button('＋ Kaynak ekle',()=>{adding=!adding;render();},'primary');head.append(add);
 for(const [mode,label] of Object.entries(modes)){const b=button(label,async()=>{await api.automationSourceModes(owner,mode);await refresh();});b.dataset.mode=mode;bulk.append(b);}
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
  head.querySelector('p').textContent=`${enabled.length} etkin kaynak, ${sources.length-enabled.length} kapalı${blocked.length?`, ${blocked.length} engelli`:''}. `+(data.automation.status==='enabled'&&upcoming?`Sıradaki tarama ${time(upcoming.nextRunAt)}: ${upcoming.name}.`:'Her kaynak kendi aralığı ve durumuyla takip edilir.');
  add.disabled=active;add.setAttribute('aria-expanded',String(adding));
  for(const b of bulk.querySelectorAll('button')){b.disabled=active||!sources.length||Object.keys(modes).indexOf(b.dataset.mode)>Object.keys(modes).indexOf(data.automation.mode);b.setAttribute('aria-pressed',String(sources.length>0&&sources.every(s=>s.mode===b.dataset.mode)));}
  if(adding){if(!addHost.firstChild)addHost.append(editor(null));}else addHost.replaceChildren();
  const kept=list.querySelector('.source-editor');list.replaceChildren();
  for(const source of sources){
   const row=el('li',null,'source-row'),open=editing===source.url;row.dataset.sourceId=source.url;row.dataset.open=String(open);row.dataset.tone=source.scanning?'scanning':!source.enabled?'off':source.blocked?'blocked':source.lastFound?'found':'none';
   const toggle=el('input',null,'switch');toggle.type='checkbox';toggle.checked=source.enabled;toggle.setAttribute('aria-label',source.name+' aktif');const scope=owner;toggle.onchange=action(async()=>{toggle.disabled=true;try{await api.automationSourceSave(scope,source.url,{enabled:toggle.checked});await refresh();}finally{toggle.disabled=false;}});
   const main=el('div',null,'source-main'),name=el('div',source.name,'source-name'),link=button(new URL(source.url).hostname,()=>api.openLink(source.url),'source-url');link.title=source.url;name.append(link);const query=el('p',source.query,'source-scope');query.title=source.query;main.append(name,query,el('small',data.automation.browserMode==='jev'?'Jev tarayıcı':'Tarayıcı','source-method'));
   const plan=el('div',null,'source-plan');plan.append(el('b',`Her ${source.intervalMinutes} dk`),document.createTextNode(modes[source.mode]));
   const status=el('div',null,'source-status');status.append(el('b',source.scanning?'Taranıyor':source.blocked?'Kaynak engelli':source.lastStatus==='partial'?`Kısmi tarama · ${source.scan?.pendingUrls.length??0} adres kaldı`:source.lastRunAt?`Toplam ${source.resultCount??source.lastFound??0} kayıt`:'Henüz taranmadı'));if(source.lastStatus==='partial')status.append(el('small',`Toplam ${source.resultCount??0} kayıt`));if(source.lastResult){const detail=el('small',source.lastResult);detail.title=source.lastResult;status.append(detail);}
   const timing=el('div',null,'source-timing');timing.append(el('b',!source.enabled?'Kapalı':source.scanning?'Şu anda taranıyor':source.blocked?'Yeniden başlatılmayı bekliyor':data.automation.status!=='enabled'?'Takip duraklatıldı':source.nextRunAt?`Sonraki tarama ${time(source.nextRunAt)}`:'Sıradaki tarama'),document.createTextNode(source.lastRunAt?`Son tarama ${time(source.lastRunAt)}`:'Henüz taranmadı'));
   const actions=el('div',null,'source-actions'),run=button(source.blocked?'Tekrar dene':'Şimdi tara',async()=>{await api.automationSourceRun(scope,source.url);await refresh();});run.disabled=source.scanning||!source.enabled||!data.progress?.reviewed||!data.progress?.passed;
   const edit=button(open?'Kapat':'Düzenle',()=>{editing=open?null:source.url;render();},'quiet source-edit');edit.disabled=source.scanning;edit.setAttribute('aria-expanded',String(open));actions.append(run,edit);row.append(toggle,main,plan,status,timing,actions);
   if(open)row.append(kept?.dataset.sourceId===source.url?kept:editor(source));list.append(row);
  }
  if(!sources.length)list.append(el('li','Henüz kaynak yok. Kaynak ekle veya agent’tan bulmasını iste.','source-empty'));
 }
 return {update(snapshot,id){if(owner!==id){editing=null;adding=false;addHost.replaceChildren();}owner=id;data=snapshot;render();}};
}
