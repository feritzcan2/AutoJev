export async function openSourcePanel(api,candidate,source,onSaved){
 const [config,integrations]=await Promise.all([api.sourceInstructions(candidate,source.id),api.sourceIntegrations()]);
 const dialog=document.createElement('dialog');dialog.className='source-skill-dialog';
 dialog.innerHTML=`<header><h2></h2><button type="button" data-close>✕</button></header><form>
 <div class="source-settings-grid"><label>Arama yöntemi<select name="searchMethod"><option value="free">Serbest arama</option><option value="browser">Tarayıcı</option><option value="tool">Kaynağa özel araç</option></select></label>
 <label>Hazır araç<select name="integrationId"><option value="">Yok / özel araç</option></select></label>
 <label>Araç çalışmazsa<select name="fallback"><option value="web">Web araması</option><option value="browser">Tarayıcı</option><option value="none">Engeli bildir</option></select></label></div>
 <p data-origin></p><label>Kaynak skill’i<textarea name="skillText" rows="12" maxlength="60000" required spellcheck="false"></textarea></label>
 <section class="source-learned-skill" data-learned hidden><h3>Agent’ın öğrendiği kaynak skill’i</h3><p data-learned-note></p><label>Sürüm geçmişi<select data-skill-version></select></label><p data-skill-summary></p><pre data-learned-text></pre></section>
 <details><summary>Özel yerel araç (isteğe bağlı)</summary><p>Hazır araç yerine kullanılır. Komut kabuk üzerinden çalıştırılmaz.</p><label>Çalıştırılabilir dosyanın tam yolu<input name="command" placeholder="/tam/yol/arac"></label><label>Sabit argümanlar (JSON dizisi)<input name="args" placeholder='["/tam/yol/script.js"]'></label></details>
 <details><summary>AutoJev çalışma kuralları</summary><pre data-workflow></pre></details>
 <details><summary>Orijinal skill ve sürüm</summary><pre data-reference></pre></details>
 <details><summary>Son çalışma</summary><pre data-last></pre></details>
 <p data-result role="status"></p><footer><button type="button" class="quiet" data-test>Kaydedilmiş aracı test et</button><button class="primary" type="submit">Kaydet</button></footer></form>`;
 dialog.querySelector('h2').textContent=source.name+' · Skill ve araçlar';
 const form=dialog.querySelector('form'),f=form.elements;
 const learned=dialog.querySelector('[data-learned]'),versions=dialog.querySelector('[data-skill-version]');
 const showSkill=skill=>{
  learned.hidden=!skill;if(!skill)return;
  dialog.querySelector('[data-learned-note]').textContent=(skill.needsReview?'Tarayıcı veya yöntem değişti; yeniden kontrol edilecek. ':'')+'Agent bu bölümü deneme ve taramalarda günceller. Yukarıdaki talimatların korunur. Henüz doğrulanmamış adımlar metinde belirtilir.';
  dialog.querySelector('[data-skill-summary]').textContent=new Date(skill.updatedAt).toLocaleString('tr-TR')+' · '+skill.summary;
  dialog.querySelector('[data-learned-text]').textContent=skill.skillText;
 };
 for(const version of config.skillHistory??[])versions.append(new Option(`Sürüm ${version.version} · ${new Date(version.updatedAt).toLocaleString('tr-TR')}`,String(version.version)));
 showSkill(config.learnedSkill);
 versions.onchange=async()=>{
  versions.disabled=true;
  try{const value=await api.sourceInstructions(candidate,source.id,Number(versions.value));if(dialog.isConnected)showSkill(value.learnedSkill);}
  catch(error){dialog.querySelector('[data-skill-summary]').textContent=error.message;}
  finally{versions.disabled=false;}
 };
 for(const item of integrations)f.integrationId.append(new Option(item.name,item.id));
 f.searchMethod.value=config.searchMethod;f.integrationId.value=source.integrationId??'';f.fallback.value=config.fallback;f.skillText.value=config.skillText;
 dialog.querySelector('[data-origin]').textContent=config.skillOrigin==='upstream'?'Bu metin, sabitlenen GitHub sürümündeki orijinal SKILL.md dosyasıdır.':config.skillOrigin==='custom'?'Bu kaynak için özelleştirilmiş skill kullanılıyor.':'Bu kaynak AutoJev’in serbest arama talimatını kullanıyor.';
 dialog.querySelector('[data-workflow]').textContent=config.workflow;
 f.command.value=source.customTool?.command??'';f.args.value=JSON.stringify(source.customTool?.args??[]);
 dialog.querySelector('[data-reference]').textContent=[config.upstream?`Sürüm: ${config.upstream.commit}\n${config.upstream.repository}\nLisans: ${config.upstream.license}`:'Hazır araç seçilmedi.',config.tool?JSON.stringify(config.tool,null,2):'',config.toolReference??''].join('\n\n');
 dialog.querySelector('[data-last]').textContent=source.lastRunAt?`${new Date(source.lastRunAt).toLocaleString('tr-TR')}\n${source.lastFound} yeni ilan\n${source.lastResult}`:'Henüz tarama yapılmadı.';
 const output=dialog.querySelector('[data-result]');
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
 dialog.querySelector('[data-test]').onclick=async e=>{e.target.disabled=true;output.textContent='Araç açılışı kontrol ediliyor…';try{const r=await api.testSource(candidate,source.id);output.textContent=(r.ok?'Araç çalıştırılabiliyor. Bu kontrol search --help çalıştırır; canlı portal erişimini doğrulamaz.\n':'Araç çalıştırılamadı.\n')+(r.diagnostic||r.output).slice(0,3000);}catch(e){output.textContent=e.message;}finally{e.target.disabled=false;}};
 form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{await api.saveSource(candidate,{...source,searchMethod:f.searchMethod.value,integrationId:f.integrationId.value||null,fallback:f.fallback.value,skillText:f.skillText.value,customTool:f.command.value.trim()?{command:f.command.value.trim(),args:JSON.parse(f.args.value||'[]')}:null});await onSaved();dialog.close();}catch(e){output.textContent=e.message;}finally{button.disabled=false;}};
 document.body.append(dialog);dialog.showModal();
}
