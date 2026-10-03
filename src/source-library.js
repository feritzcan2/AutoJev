const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};

export function sourceLibraryPanel(api,{refresh,notice}){
 const host=el('section',null,'source-library');host.hidden=true;host.dataset.sourceLibrary='';
 let owner,sources=[],entries=[],busy=false;
 host.append(el('h3','Kaynak kütüphanesi'),el('p','Seçilen kaynaklar talimatı ve arama reçetesiyle bağımsız kopyalanır. Reçete ilk taramada doğrulanır; sonra Kaynaklar’dan düzenleyebilirsin. Mevcut kaynakların sorgusu ve zamanlaması korunur.'));
 const form=el('form',null,'source-library-address'),url=el('input'),load=el('button','Listeyi yükle','quiet'),local=el('button','Yerleşik liste','quiet'),file=el('button','Dosyadan aç','quiet');
 url.type='url';url.placeholder='https://…/sources.json';url.setAttribute('aria-label','Public kaynak listesinin JSON adresi');url.dataset.libraryUrl='';url.required=true;load.type='submit';local.type=file.type='button';form.append(url,load,local,file);host.append(form);
 const status=el('p',null,'source-library-status'),list=el('div',null,'source-library-list'),actions=el('div',null,'actions'),add=el('button','Seçilenleri ekle','primary'),close=el('button','Kapat','quiet');
 status.setAttribute('role','status');add.type=close.type='button';actions.append(add,close);host.append(status,list,actions);
 const selected=()=>[...list.querySelectorAll('input:checked')].map(input=>entries[Number(input.value)]);
 const buttons=()=>{load.disabled=local.disabled=file.disabled=busy;add.disabled=busy||!selected().length;list.inert=busy;url.disabled=busy;};
 function render(){
  const checked=new Set(selected().map(s=>s.url));list.replaceChildren();
  for(const [index,source]of entries.entries()){
   const existing=sources.find(s=>s.url===source.url),enrich=existing&&(!existing.instructions&&!existing.skill&&(source.instructions||source.skill)||!existing.recipe&&source.recipe),installed=existing&&!enrich;
   const item=el('div',null,'source-library-item'),label=el('label'),input=el('input');input.type='checkbox';input.value=index;input.disabled=Boolean(installed)||Boolean(existing?.scanning);input.checked=!input.disabled&&checked.has(source.url);input.onchange=buttons;
   label.append(input,el('strong',source.name),el('span',existing?.scanning?'Kaynak çalışıyor':installed?'Yerel kopya var':enrich?'Yöntemi ve reçeteyi kopyala':'Yeni kaynak'));
   const details=el('details'),summary=el('summary','Çalışma yöntemi');details.append(summary,el('p',source.instructions||'Agent kaynağı yönetilen tarayıcıyla inceleyerek çalışır.'));
   const recipe=source.recipe?el('span',source.recipe.entry.kind==='url_template'?'Reçete: URL şablonu':source.recipe.entry.kind==='search_form'?'Reçete: arama formu':'Reçete: keşif','source-library-recipe'):el('span','Reçete yok · deneme turunda öğrenilir','source-library-recipe');
   if(source.recipe?.entry.template)recipe.title=source.recipe.entry.template;
   item.append(label,el('small',source.url),recipe,details);list.append(item);
  }
  buttons();
 }
 async function fetchList(address){
  if(busy)return;busy=true;buttons();status.textContent='Kaynak listesi yükleniyor…';const scope=owner;
  try{const loaded=await api.automationSourceLibrary(address);if(owner!==scope)return;entries=loaded;list.replaceChildren();render();status.textContent=`${entries.length} kaynak · ${address?'Public liste':'Uygulamayla gelen liste'}`;}
  catch(error){status.textContent=error.message;}finally{busy=false;buttons();}
 }
 form.onsubmit=event=>{event.preventDefault();if(form.reportValidity())void fetchList(url.value.trim());};local.onclick=()=>fetchList();close.onclick=()=>{host.hidden=true;};
 file.onclick=async()=>{if(busy)return;const scope=owner;busy=true;buttons();try{const loaded=await api.automationSourceLibraryFile();if(owner===scope&&loaded){entries=loaded;list.replaceChildren();render();status.textContent=`${entries.length} kaynak · Dosyadan`;}}catch(error){status.textContent=error.message;}finally{busy=false;buttons();}};
 add.onclick=async()=>{
  if(busy||!selected().length)return;const scope=owner,chosen=selected();busy=true;buttons();notice('');
  try{const result=await api.automationSourceImport(scope,chosen);if(owner!==scope)return;await refresh();notice(`${result.added} kaynak kopyalandı, ${result.enriched} kaynağa yöntem veya reçete kopyalandı${result.skipped?`, ${result.skipped} mevcut kaynak korundu`:''}. Kaynaklar’dan bağımsız olarak düzenleyebilirsin.`);render();host.hidden=true;}
  catch(error){notice(error.message);}finally{busy=false;buttons();}
 };
 return {host,async toggle(){host.hidden=!host.hidden;if(!host.hidden){if(entries.length)render();else await fetchList();}},update(id,current){if(owner!==id){owner=id;host.hidden=true;entries=[];list.replaceChildren();url.value='';status.textContent='';}sources=current;if(!host.hidden)render();}};
}
