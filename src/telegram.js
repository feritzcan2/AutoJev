import './telegram.css';
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};

export function telegramPanel(api,root,{notice}){
 let candidate=null,status=null,pair=null,busy=false,version=0,autoScoreDirty=false;
 root.innerHTML=`<div class="telegram-card"><div class="telegram-heading"><div><h4>Telegram botu</h4><p data-bot-status role="status">Yükleniyor…</p></div><span class="telegram-badge"></span></div>
 <form class="telegram-token"><label>Bot token’ı<input name="token" type="password" autocomplete="new-password" placeholder="BotFather’dan aldığın token" aria-label="Telegram bot token’ı"></label><button class="primary" type="submit">Kaydet ve aç</button><button type="button" class="quiet" data-toggle hidden>Kapat</button></form>
 <p class="telegram-hint">Telegram’da <button class="telegram-link" type="button" data-botfather>@BotFather</button> ile /newbot komutunu kullan. Token bu bilgisayarda sistem anahtarlığıyla şifrelenerek saklanır. Bot ayarı yalnızca seçili adaya aittir. Farklı bir bot kaydedersen bu adayı yeni bota yeniden bağla.</p><p class="telegram-error" data-error role="status" hidden></p>
 <div class="telegram-candidate"><h4 data-candidate-name>Aday bağlantısı</h4><p data-candidate-state></p>
 <form class="telegram-batch" hidden><div class="telegram-batch-controls">
 <label>Minimum puan<input name="minScore" type="number" min="0" max="100" step="1" placeholder="Sınır yok" value="70" aria-label="Minimum puan" aria-describedby="telegram-score-help"></label>
 <label>Gönderim kapsamı<select name="scope" aria-label="Gönderim kapsamı"><option value="unsent">Yalnızca gönderilmemiş ilanlar</option><option value="resend">Tümünü yeniden gönder</option></select></label>
 <button class="primary" type="submit">İlanları gönder</button></div>
 <p id="telegram-score-help" class="telegram-hint">Yalnızca yazdığın puanın üstündeki ilanlar gönderilir: 70 → 71–100. Boş bırakırsan puan filtresi uygulanmaz.</p>
 <p class="telegram-hint" data-batch-scope></p></form>
 <div data-candidate-actions></div><div data-pair hidden></div><div class="telegram-preferences" hidden><h4>Bildirim tercihleri</h4><p>Seçimlerin bu aday için otomatik kaydedilir.</p>
 <label><span><b>Yeni ilanları otomatik gönder</b><small data-auto-jobs-help>Yeni ilanlar, aşağıdaki puan filtresine göre gönderilir.</small></span><input class="switch" type="checkbox" name="newJobs" aria-label="Yeni ilanları otomatik gönder"></label>
 <label><span><b>Otomatik ilanlar için minimum puan</b><small>Yalnızca bu puanın üstündeki ilanlar gönderilir. Puanlanmamış veya sınırı geçmeyen ilanlar bekler. Boş: puan filtresi yok.</small></span><input class="telegram-auto-score" name="newJobsMinScore" type="number" min="0" max="100" step="1" placeholder="Sınır yok" aria-label="Otomatik ilanlar için minimum puan"></label>
 <label><span><b>Gönderilen başvuruları bildir</b><small>Bir başvuru gönderildiğinde ayrı bir bildirim al.</small></span><input class="switch" type="checkbox" name="notifications" aria-label="Gönderilen başvuruları bildir"></label>
 <label><span><b>Bekleyen soruları gönder</b><small>Agent’ın sorularını Telegram’dan yanıtla ve başvuruya devam et.</small></span><input class="switch" type="checkbox" name="questions" aria-label="Bekleyen soruları gönder ve bottan yanıtlamaya izin ver"></label></div><p class="telegram-hint" data-deliveries></p></div>
 <p class="telegram-foot">Mesajlaşmanın çalışması için JobLoop açık ve internete bağlı olmalı. Gönderilmiş kartların durumu ve puanı aynı mesajda güncellenir. Sıradaki ve aktif başvurular sabitlenir; tamamlanınca sabitleme kalkar.</p></div>`;
 const $=selector=>root.querySelector(selector),form=$('.telegram-token'),token=form.elements.token,batch=$('.telegram-batch'),autoScore=$('[name=newJobsMinScore]');
 const button=(label,fn,cls='quiet')=>{const b=node('button',cls,label);b.type='button';b.disabled=busy;b.onclick=()=>act(fn);return b;};
 function render(){
  if(!status){
   $('[data-bot-status]').textContent=candidate?'Yükleniyor…':'Bot bağlamak için bir aday seç.';$('.telegram-badge').textContent='—';$('.telegram-badge').dataset.on='false';
   $('[data-toggle]').hidden=true;$('[data-error]').hidden=true;form.querySelector('[type=submit]').textContent='Kaydet ve aç';token.placeholder='BotFather’dan aldığın token';
   batch.hidden=true;for(const control of form.elements)control.disabled=true;return;
  }
  $('[data-bot-status]').textContent=status.configured?`@${status.bot.username} · ${status.running?'Bağlantı açık':'Kapalı'}`:'Önce bir bot bağla.';
  $('.telegram-badge').textContent=status.error?'Bağlantı sorunu':status.running?'Açık':'Kapalı';
  $('.telegram-badge').dataset.on=String(status.running&&!status.error);
  $('[data-error]').hidden=!status.error;$('[data-error]').textContent=status.error??'';
  $('[data-toggle]').hidden=!status.configured;$('[data-toggle]').textContent=status.enabled?'Kapat':'Aç';
  token.placeholder=status.configured?'Yeni token girmek için buraya yaz':'BotFather’dan aldığın token';
  form.querySelector('[type=submit]').textContent=status.configured?'Token’ı güncelle':'Kaydet ve aç';
  for(const control of form.elements)control.disabled=busy||!status.candidate;
  const c=status.candidate,actions=$('[data-candidate-actions]');actions.replaceChildren();
  $('[data-candidate-name]').textContent=c?`${c.candidateName} · Telegram`:'Aday bağlantısı';
  $('[data-candidate-state]').textContent=!c?'Bağlamak için soldan kayıtlı bir aday seç.':c.connected?`${c.name} hesabı bağlı.`:'Bu aday henüz Telegram’a bağlı değil.';
  batch.hidden=!c?.connected;
  for(const control of batch.elements)control.disabled=busy||!c?.connected||!status.enabled||!status.configured;
  renderBatchScope();
  if(c?.connected){
   pair=null;
   actions.append(button('Bağlantıyı kaldır',()=>api.telegramUnlink(c.candidateId),'quiet danger'));
  }
  else if(c){const create=button(pair?'Yeni bağlantı oluştur':'Adayı Telegram’a bağla',async()=>{const owner=candidate,next=await api.telegramPair(owner);if(owner===candidate)pair=next;});create.disabled=busy||!status.enabled||!status.configured;actions.append(create);}
  const pairBox=$('[data-pair]');pairBox.replaceChildren();pairBox.hidden=!pair||!c||c.connected;
  if(!pairBox.hidden){
   const expired=pair.expires<=Date.now();pairBox.append(node('p','telegram-hint',expired?'Bağlantının süresi doldu. Yeni bağlantı oluştur.':'Bu bağlantıyı adaya ilet. Aday Telegram’da Başlat’a bastığında bağlanır. Bağlantı 10 dakika geçerli.'));
   const input=node('input');input.readOnly=true;input.value=pair.url;input.setAttribute('aria-label','Aday Telegram bağlantısı');pairBox.append(input);
   const copy=button('Bağlantıyı kopyala',async()=>{await navigator.clipboard.writeText(pair.url);notice('Telegram bağlantısı kopyalandı.');});copy.disabled=expired||busy;
   const open=button('Telegram’da aç',()=>api.openLink(pair.url));open.disabled=expired||busy;pairBox.append(copy,open);
  }
  $('.telegram-preferences').hidden=!c?.connected;
  for(const key of ['newJobs','notifications','questions']){const input=$(`[name=${key}]`);input.checked=c?.[key]??true;input.disabled=busy;}
  if(!autoScoreDirty)autoScore.value=c?.newJobsMinScore??'';autoScore.disabled=busy;
  $('[data-auto-jobs-help]').textContent=c?.newJobsMinScore==null?'Bulunan yeni ilanlar puanına bakılmadan gönderilir.':`Yalnızca ${c.newJobsMinScore} puanın üstündeki yeni ilanlar otomatik gönderilir (${c.newJobsMinScore} hariç).`;
  $('[data-deliveries]').textContent=c?.connected?`${c.pending} mesaj / güncelleme sırada${c.waitingScore?` · ${c.waitingScore} ilan puan sınırını geçmeyi bekliyor`:''}${c.failed?` · ${c.failed} işlem tamamlanamadı`:''}${c.lastError?' · '+c.lastError:''}`:'';
  if(c?.connected&&(c.failed||c.lastError))actions.append(button('Gönderimi yeniden dene',()=>api.telegramRetry(candidate)));
 }
 async function load(){
  const request=++version,owner=candidate;
  try{const next=await api.telegramStatus(owner);if(request!==version||owner!==candidate)return;status=next;render();}catch(error){if(request===version)notice(error.message);}
 }
 async function act(fn){if(busy)return;busy=true;render();try{await fn();await load();}catch(error){notice(error.message);}finally{busy=false;render();}}
 function renderBatchScope(){
  const resend=batch.elements.scope.value==='resend';
  batch.querySelector('[type=submit]').textContent=resend?'İlanları yeniden gönder':'İlanları gönder';
  $('[data-batch-scope]').textContent=resend?'Puan filtresine uyan tüm ilanlar yeniden gönderilir; silinen kartlar ve tamamlanmış başvurular dahildir. Her ilan için yeni bir mesaj oluşur.':'Başvurusu tamamlanmamış ve bu bota daha önce gönderilmemiş ilanlar gönderilir. Silinen kartlar tekrar gönderilmez.';
 }
 batch.elements.scope.onchange=renderBatchScope;
 batch.onsubmit=event=>{
  event.preventDefault();if(!batch.reportValidity())return;
  const owner=candidate,input={minScore:batch.elements.minScore.value===''?null:batch.elements.minScore.valueAsNumber,resend:batch.elements.scope.value==='resend'};
  act(async()=>{
   const result=await api.telegramSendUnsentJobs(owner,input);
   if(candidate===owner)notice(`${result.queued} ilan Telegram gönderim sırasına alındı.${result.alreadyQueued?` ${result.alreadyQueued} ilan zaten sırada.`:''}${result.filtered?` ${result.filtered} ilan puan filtresine uymuyor.`:''}${result.queued||result.alreadyQueued?' İlanlar tek tek gönderilecek.':' Bu seçimle gönderilecek ilan yok.'}`);
  });
 };
 form.onsubmit=event=>{event.preventDefault();const owner=candidate,input={token:token.value,enabled:true};act(async()=>{await api.telegramConfigure(owner,input);if(candidate===owner){token.value='';notice('Bu adayın Telegram botu kaydedildi.');}});};
 $('[data-toggle]').onclick=()=>{const owner=candidate,input={enabled:!status.enabled};act(()=>api.telegramConfigure(owner,input));};
 $('[data-botfather]').onclick=()=>api.openLink('https://t.me/BotFather').catch(error=>notice(error.message));
 function savePreferences(){
  if(!autoScore.reportValidity()){render();return;}
  const owner=candidate,input={newJobs:$('[name=newJobs]').checked,newJobsMinScore:autoScore.value===''?null:autoScore.valueAsNumber,notifications:$('[name=notifications]').checked,questions:$('[name=questions]').checked};
  act(async()=>{await api.telegramPreferences(owner,input);if(candidate===owner)autoScoreDirty=false;});
 }
 autoScore.oninput=()=>{autoScoreDirty=true;};autoScore.onchange=savePreferences;
 for(const key of ['newJobs','notifications','questions'])$(`[name=${key}]`).onchange=savePreferences;
 setInterval(()=>{if(!root.closest('[hidden]')&&!busy)load();},5000);
 render();
 return {select(id){if(candidate!==id){candidate=id;pair=null;status=null;token.value='';autoScoreDirty=false;autoScore.value='';batch.reset();version++;$('[data-pair]').hidden=true;$('.telegram-preferences').hidden=true;$('[data-candidate-name]').textContent='Aday bağlantısı';$('[data-candidate-state]').textContent='Yükleniyor…';$('[data-deliveries]').textContent='';$('[data-candidate-actions]').replaceChildren();render();}if(!root.closest('[hidden]'))load();},load};
}
