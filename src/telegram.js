import './telegram.css';
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};

export function telegramPanel(api,root,{notice}){
 let candidate=null,status=null,pair=null,busy=false,version=0;
 root.innerHTML=`<div class="telegram-card"><div class="telegram-heading"><div><h4>Telegram botu</h4><p data-bot-status role="status">Yükleniyor…</p></div><span class="telegram-badge"></span></div>
 <form class="telegram-token"><label>Bot token’ı<input name="token" type="password" autocomplete="new-password" placeholder="BotFather’dan aldığın token" aria-label="Telegram bot token’ı"></label><button class="primary" type="submit">Kaydet ve aç</button><button type="button" class="quiet" data-toggle hidden>Kapat</button></form>
 <p class="telegram-hint">Telegram’da <button class="telegram-link" type="button" data-botfather>@BotFather</button> ile /newbot komutunu kullan. Token bu bilgisayarda sistem anahtarlığıyla şifrelenerek saklanır. Bot ayarı yalnızca seçili adaya aittir. Farklı bir bot kaydedersen bu adayı yeni bota yeniden bağla.</p><p class="telegram-error" data-error role="status" hidden></p>
 <div class="telegram-candidate"><h4 data-candidate-name>Aday bağlantısı</h4><p data-candidate-state></p><div data-candidate-actions></div><div data-pair hidden></div><div class="telegram-preferences" hidden><label><input type="checkbox" name="newJobs"> Her yeni ilanı gönder</label><label><input type="checkbox" name="notifications"> Gönderilen başvuruları bildir</label><label><input type="checkbox" name="questions"> Bekleyen soruları gönder ve bottan yanıtlamaya izin ver</label></div><p class="telegram-hint" data-deliveries></p></div>
 <p class="telegram-foot">Mesajlaşmanın çalışması için JobLoop açık ve internete bağlı olmalı. Gönderilen ilan mesajları başvuru durumu değiştikçe güncellenir. Yeni ilan, başvuru ve soru bildirimleri seçtiğin tercihlere göre gönderilir.</p></div>`;
 const $=selector=>root.querySelector(selector),form=$('form'),token=form.elements.token;
 const button=(label,fn,cls='quiet')=>{const b=node('button',cls,label);b.type='button';b.disabled=busy;b.onclick=()=>act(fn);return b;};
 function render(){
  if(!status){
   $('[data-bot-status]').textContent=candidate?'Yükleniyor…':'Bot bağlamak için bir aday seç.';$('.telegram-badge').textContent='—';$('.telegram-badge').dataset.on='false';
   $('[data-toggle]').hidden=true;$('[data-error]').hidden=true;form.querySelector('[type=submit]').textContent='Kaydet ve aç';token.placeholder='BotFather’dan aldığın token';
   for(const control of form.elements)control.disabled=true;return;
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
  if(c?.connected){
   pair=null;
   const send=button('Gönderilmemiş ilanları gönder',async()=>{
    const owner=c.candidateId,result=await api.telegramSendUnsentJobs(owner);
    if(candidate===owner)notice(`${result.queued} ilan Telegram gönderim sırasına alındı.${result.alreadyQueued?` ${result.alreadyQueued} ilan zaten sırada.`:''}${result.queued||result.alreadyQueued?' İlanlar tek tek gönderilecek.':' Gönderilecek yeni ilan yok.'}`);
   },'primary');
   send.disabled=busy||!status.enabled||!status.configured;
   send.title='Seçili adayın başvurusu tamamlanmamış ve bu bota daha önce gönderilmemiş tüm ilanlarını tek tek gönderir.';
   actions.append(send,button('Bağlantıyı kaldır',()=>api.telegramUnlink(c.candidateId),'quiet danger'));
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
  $('[data-deliveries]').textContent=c?.connected?`${c.pending} mesaj / güncelleme sırada${c.failed?` · ${c.failed} işlem tamamlanamadı`:''}${c.lastError?' · '+c.lastError:''}`:'';
  if(c?.connected&&(c.failed||c.lastError))actions.append(button('Gönderimi yeniden dene',()=>api.telegramRetry(candidate)));
 }
 async function load(){
  const request=++version,owner=candidate;
  try{const next=await api.telegramStatus(owner);if(request!==version||owner!==candidate)return;status=next;render();}catch(error){if(request===version)notice(error.message);}
 }
 async function act(fn){if(busy)return;busy=true;render();try{await fn();await load();}catch(error){notice(error.message);}finally{busy=false;render();}}
 form.onsubmit=event=>{event.preventDefault();const owner=candidate,input={token:token.value,enabled:true};act(async()=>{await api.telegramConfigure(owner,input);if(candidate===owner){token.value='';notice('Bu adayın Telegram botu kaydedildi.');}});};
 $('[data-toggle]').onclick=()=>{const owner=candidate,input={enabled:!status.enabled};act(()=>api.telegramConfigure(owner,input));};
 $('[data-botfather]').onclick=()=>api.openLink('https://t.me/BotFather').catch(error=>notice(error.message));
 for(const key of ['newJobs','notifications','questions'])$(`[name=${key}]`).onchange=()=>{const input={newJobs:$('[name=newJobs]').checked,notifications:$('[name=notifications]').checked,questions:$('[name=questions]').checked};act(()=>api.telegramPreferences(candidate,input));};
 setInterval(()=>{if(!root.closest('[hidden]')&&!busy)load();},5000);
 render();
 return {select(id){if(candidate!==id){candidate=id;pair=null;status=null;token.value='';version++;$('[data-pair]').hidden=true;$('.telegram-preferences').hidden=true;$('[data-candidate-name]').textContent='Aday bağlantısı';$('[data-candidate-state]').textContent='Yükleniyor…';$('[data-deliveries]').textContent='';$('[data-candidate-actions]').replaceChildren();render();}if(!root.closest('[hidden]'))load();},load};
}
