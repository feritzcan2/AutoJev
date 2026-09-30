import {guideSections,SOURCE_GUIDE_STATES} from '../app/source-guide.mjs';

export async function openSourcePanel(api,candidate,source,onSaved){
 const [config,integrations]=await Promise.all([api.sourceInstructions(candidate,source.id),api.sourceIntegrations()]);
 const dialog=document.createElement('dialog');dialog.className='source-skill-dialog';
 dialog.innerHTML=`<header><h2></h2><button type="button" data-close aria-label="Kapat">✕</button></header><form>
 <div class="source-settings-grid"><label>Arama yöntemi<select name="searchMethod"><option value="free">Serbest arama</option><option value="browser">Tarayıcı</option><option value="tool">Kaynağa özel araç</option></select></label>
 <label>Hazır araç<select name="integrationId"><option value="">Yok / özel araç</option></select></label>
 <label>Araç çalışmazsa<select name="fallback"><option value="web">Web araması</option><option value="browser">Tarayıcı</option><option value="none">Engeli bildir</option></select></label></div>
 <section class="source-guide"><h3>Kaynak rehberi</h3><p class="source-guide-help">Agent öğrendikçe bu rehberi günceller. Düzenlediğin bölümler korunur; hedef ve seçim kriterleri çalışma alanından alınır.</p>
 <div class="source-guide-history"><label>Sürüm geçmişi<select data-skill-version></select></label><button type="button" class="quiet" data-restore hidden>Bu sürümü kullan</button></div><p data-skill-summary></p>
 <div class="source-guide-document"><label>Ek talimatların<textarea name="skillText" rows="3" maxlength="60000" spellcheck="false" placeholder="Bu kaynağa özel bir talimat ekleyebilirsin."></textarea></label><div data-guide-sections></div><p data-guide-empty hidden>İlk denemeden sonra arama, sayfalama, detay okuma ve erişim adımları burada görünecek.</p></div>
 <details data-evidence hidden><summary>Gözlem kanıtları</summary><pre></pre></details></section>
 <details><summary>Özel yerel araç (isteğe bağlı)</summary><p>Hazır araç yerine kullanılır. Komut kabuk üzerinden çalıştırılmaz.</p><label>Çalıştırılabilir dosyanın tam yolu<input name="command" placeholder="/tam/yol/arac"></label><label>Sabit argümanlar (JSON dizisi)<input name="args" placeholder='["/tam/yol/script.js"]'></label></details>
 <details><summary>AutoJev çalışma kuralları</summary><pre data-workflow></pre></details>
 <details><summary>Orijinal araç rehberi ve sürüm</summary><pre data-reference></pre></details>
 <details><summary>Son çalışma</summary><pre data-last></pre></details>
 <p data-result role="status"></p><footer><button type="button" class="quiet" data-test>Kaydedilmiş aracı test et</button><button class="primary" type="submit">Kaydet</button></footer></form>`;
 dialog.querySelector('h2').textContent=source.name+' · Kaynak rehberi';
 const form=dialog.querySelector('form'),f=form.elements,versions=dialog.querySelector('[data-skill-version]'),restore=dialog.querySelector('[data-restore]'),submit=form.querySelector('[type=submit]'),output=dialog.querySelector('[data-result]');
 const supportsGuide=Object.hasOwn(config,'guideOverrides');
 const general=config.skillOrigin==='jobloop'?'':config.skillText;
 let draft={general,overrides:{...config.guideOverrides}},shownSkill=config.learnedSkill,preview=false;
 const resize=field=>{field.style.height='auto';field.style.height=field.scrollHeight+'px';};
 const capture=()=>{
  const overrides={};
  for(const field of dialog.querySelectorAll('[data-guide-key]')){
   const original=config.learnedSkill?.sections.find(s=>s.key===field.dataset.guideKey)?.instructions;
   if(field.value!==original)overrides[field.dataset.guideKey]=field.value;
  }
  return {general:f.skillText.value,overrides};
 };
 const render=(skill,overrides,readOnly)=>{
  shownSkill=skill;preview=readOnly;f.skillText.readOnly=readOnly||!supportsGuide;restore.hidden=!readOnly;submit.disabled=readOnly||!supportsGuide;
  if(!supportsGuide)output.textContent='Yeni rehber düzenleyicisini kullanmak için çalışan görevler bittikten sonra AutoJev’i yeniden başlat.';
  const host=dialog.querySelector('[data-guide-sections]');host.replaceChildren();
  const sections=guideSections(skill,overrides);
  dialog.querySelector('[data-guide-empty]').hidden=sections.length>0;
  dialog.querySelector('[data-skill-summary]').textContent=(readOnly?'Geçmiş öğrenme sürümü · ':config.learnedSkill?'Güncel rehber · ':'')+(skill?`Sürüm ${skill.version} · ${new Date(skill.updatedAt).toLocaleString('tr-TR')} · ${skill.summary}`:'Henüz kaynak denemesi yapılmadı.')+(skill?.needsReview?' Yöntem değişti; yeniden kontrol gerekiyor.':'');
  for(const section of sections){
   const block=document.createElement('section');block.className='source-guide-section';
   const heading=document.createElement('h4');heading.textContent=section.title;
   const status=document.createElement('small');status.textContent=section.userEdited?'Senin düzenlemen · Kontrol edilecek':SOURCE_GUIDE_STATES[section.status];
   const field=document.createElement('textarea');field.dataset.guideKey=section.key;field.setAttribute('aria-label',section.title);field.value=section.instructions;field.maxLength=6000;field.required=true;field.spellcheck=false;field.readOnly=readOnly||!supportsGuide;
   field.oninput=()=>{resize(field);status.textContent='Senin düzenlemen · Kontrol edilecek';};
   block.append(heading,status,field);
   if(!readOnly&&section.userEdited&&config.learnedSkill?.sections.some(s=>s.key===section.key)){
    const reset=document.createElement('button');reset.type='button';reset.className='quiet';reset.textContent='Agent’in güncel metnini kullan';reset.onclick=()=>{draft=capture();delete draft.overrides[section.key];render(config.learnedSkill,draft.overrides,false);};block.append(reset);
   }
   host.append(block);
  }
  const evidence=dialog.querySelector('[data-evidence]');evidence.hidden=!skill?.sections.some(s=>s.evidence?.length);
  evidence.querySelector('pre').textContent=skill?.sections.flatMap(s=>(s.evidence??[]).map(e=>`${e.url}\n${e.quote}`)).join('\n\n')??'';
  for(const field of dialog.querySelectorAll('.source-guide-document textarea'))resize(field);
 };
 versions.append(new Option('Güncel rehber','current'));
 for(const version of config.skillHistory??[])versions.append(new Option(`Öğrenilen sürüm ${version.version} · ${new Date(version.updatedAt).toLocaleString('tr-TR')}`,String(version.version)));
 dialog.querySelector('.source-guide-history').hidden=!config.skillHistory?.length;
 versions.onchange=async()=>{
  if(!preview)draft=capture();
  const selected=versions.value;versions.disabled=true;submit.disabled=true;restore.disabled=true;output.textContent='';
  try{
   if(selected==='current'){f.skillText.value=draft.general;render(config.learnedSkill,draft.overrides,false);}
   else{const value=await api.sourceInstructions(candidate,source.id,Number(selected));if(dialog.isConnected){f.skillText.value=draft.general;render(value.learnedSkill,{},true);}}
  }catch(error){output.textContent=error.message;versions.value=preview?String(shownSkill.version):'current';submit.disabled=preview||!supportsGuide;}
  finally{versions.disabled=false;restore.disabled=false;}
 };
 restore.onclick=()=>{draft=capture();versions.value='current';render(config.learnedSkill,draft.overrides,false);output.textContent='Seçtiğin sürüm düzenlemeye alındı. Uygulamak için Kaydet’e bas.';};
 for(const item of integrations)f.integrationId.append(new Option(item.name,item.id));
 f.searchMethod.value=config.searchMethod;f.integrationId.value=source.integrationId??'';f.fallback.value=config.fallback;f.skillText.value=general;f.skillText.oninput=()=>resize(f.skillText);
 dialog.querySelector('[data-workflow]').textContent=config.workflow;
 f.command.value=source.customTool?.command??'';f.args.value=JSON.stringify(source.customTool?.args??[]);
 dialog.querySelector('[data-reference]').textContent=[config.upstream?`Sürüm: ${config.upstream.commit}\n${config.upstream.repository}\nLisans: ${config.upstream.license}`:'Hazır araç seçilmedi.',config.tool?JSON.stringify(config.tool,null,2):'',config.toolReference??(config.skillOrigin==='upstream'?config.skillText:'')].join('\n\n');
 dialog.querySelector('[data-last]').textContent=source.lastRunAt?`${new Date(source.lastRunAt).toLocaleString('tr-TR')}\n${source.lastFound} yeni ilan\n${source.lastResult}`:'Henüz tarama yapılmadı.';
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
 dialog.querySelector('[data-test]').onclick=async e=>{e.target.disabled=true;output.textContent='Araç açılışı kontrol ediliyor…';try{const r=await api.testSource(candidate,source.id);output.textContent=(r.ok?'Araç çalıştırılabiliyor. Bu kontrol search --help çalıştırır; canlı portal erişimini doğrulamaz.\n':'Araç çalıştırılamadı.\n')+(r.diagnostic||r.output).slice(0,3000);}catch(e){output.textContent=e.message;}finally{e.target.disabled=false;}};
 form.onsubmit=async e=>{e.preventDefault();if(preview||!supportsGuide)return;submit.disabled=true;try{const edited=capture();await api.saveSource(candidate,{...source,searchMethod:f.searchMethod.value,integrationId:f.integrationId.value||null,fallback:f.fallback.value,skillText:edited.general.trim()?edited.general:null,guideOverrides:edited.overrides,guideBaseVersion:config.learnedSkill?.version??0,customTool:f.command.value.trim()?{command:f.command.value.trim(),args:JSON.parse(f.args.value||'[]')}:null});await onSaved();dialog.close();}catch(e){output.textContent=e.message;}finally{submit.disabled=false;}};
 document.body.append(dialog);dialog.showModal();render(config.learnedSkill,draft.overrides,false);
 const observer=new ResizeObserver(()=>{for(const field of dialog.querySelectorAll('.source-guide-document textarea'))resize(field);});observer.observe(dialog.querySelector('.source-guide-document'));dialog.addEventListener('close',()=>observer.disconnect(),{once:true});
}
