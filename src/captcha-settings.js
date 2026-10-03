import './jev-settings.css';

export function captchaSettingsPanel(api,root,{notice=()=>{}}={}){
 if(!api.captchaSettingsStatus){root.hidden=true;return {load:async()=>{}};}
 let busy=false,status=null,error='',version=0;
 root.classList.add('jev-settings');
 root.innerHTML=`<div class="jev-settings-heading"><h4>CapSolver bağlantısı</h4><span data-state role="status">Yükleniyor…</span></div>
 <p>Aktif CAPTCHA doğrulandığında otomatik çözüm denenir. Desteklenmeyen veya çözülemeyen doğrulamalarda mevcut sekmeden yardım isteyebilirsin.</p>
 <form><label>CapSolver API anahtarı<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096" placeholder="CapSolver hesabındaki API anahtarın"></label>
 <label>Otomatik çözüm<select name="enabled"><option value="false">Kapalı</option><option value="true">Açık</option></select></label>
 <label>Günlük çözüm isteği sınırı<input name="dailyLimit" type="number" min="1" max="10000" value="100" required></label>
 <div class="jev-settings-actions"><button class="primary" type="submit">Kaydet</button><button class="quiet" type="button" data-test>Bağlantı ve bakiyeyi kontrol et</button><button class="quiet" type="button" data-remove>Anahtarı kaldır</button></div></form>
 <p data-usage></p><p class="jev-settings-hint">Çözüm için sayfa adresi, CAPTCHA bilgileri veya yalnızca CAPTCHA görseli CapSolver ile paylaşılır. Anahtar sistem anahtarlığıyla şifrelenir. Her görsel tur ayrı bir istek sayılır; günlük sayaç UTC’ye göre yenilenir ve yeniden başlatmayla sıfırlanmaz. Bağlantı testi yalnızca bakiyeyi sorgular.</p><p class="jev-settings-message" data-message role="status"></p>`;
 const $=selector=>root.querySelector(selector),form=$('form');
 function render(){
  $('[data-state]').textContent=status?.error?'Anahtar açılamadı':status?.enabled?'Otomatik çözüm açık':status?.configured?'Otomatik çözüm kapalı':'Anahtar gerekli';
  for(const control of form.elements)control.disabled=busy;
  $('[data-test]').disabled=busy||!status?.configured;$('[data-remove]').disabled=busy||!status?.saved;
  $('[data-usage]').textContent=status?`Bugün ${status.usedToday} / ${status.dailyLimit} çözüm isteği`:'';
  $('[data-message]').textContent=error||status?.error||status?.lastCheck?.message||'';
  form.elements.apiKey.placeholder=status?.saved?'Değiştirmek için yeni anahtar gir':'CapSolver hesabındaki API anahtarın';
 }
 async function load(){if(busy)return;const request=++version;try{const next=await api.captchaSettingsStatus();if(request!==version)return;status=next;if(!form.contains(document.activeElement)){form.elements.enabled.value=String(status.enabled);form.elements.dailyLimit.value=status.dailyLimit;}render();}catch(e){notice(e.message);}}
 async function act(run){if(busy)return;busy=true;version++;error='';render();try{await run();}catch(e){error=e.message;notice(error);}finally{busy=false;render();}}
 form.onsubmit=event=>{event.preventDefault();const input={apiKey:form.elements.apiKey.value,enabled:form.elements.enabled.value==='true',dailyLimit:Number(form.elements.dailyLimit.value)};form.elements.apiKey.value='';void act(async()=>{try{status=await api.saveCaptchaSettings(input);notice('CAPTCHA ayarları kaydedildi.');}finally{input.apiKey='';}});};
 $('[data-test]').onclick=()=>act(async()=>{const check=await api.testCaptchaConnection();status={...status,lastCheck:check};});
 $('[data-remove]').onclick=()=>act(async()=>{status=await api.removeCaptchaSettings();form.elements.enabled.value='false';form.elements.apiKey.value='';notice('CapSolver anahtarı kaldırıldı.');});
 return {load};
}
