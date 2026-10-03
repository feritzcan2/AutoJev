import './jev-settings.css';

export function jevSettingsPanel(api,root,{notice=()=>{}}={}){
 if(!api.jevSettingsStatus){root.hidden=true;return {load:async()=>{}};}
 let busy=false,status=null,version=0,errorMessage='';
 root.classList.add('jev-settings');
 root.innerHTML=`<div class="jev-settings-heading"><h4>Jev bağlantısı</h4><span data-state role="status">Yükleniyor…</span></div>
 <p>Jev’i tarayıcı olarak seçen bütün adaylar bu TypeSafe bağlantısını kullanır. Adayların site üyelik şifreleri Aday profili bölümünde ayrı tutulur.</p>
 <form><label>TypeSafe API anahtarı<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096" placeholder="TypeSafe konsolundaki API anahtarın"></label><label>Model<input name="model" value="jev-latest" maxlength="100" required spellcheck="false" autocomplete="off"></label><div class="jev-settings-actions"><button class="primary" type="submit">Kaydet</button><button class="quiet" type="button" data-test>Bağlantıyı test et</button><button class="quiet" type="button" data-remove>Kaydedilen anahtarı kaldır</button></div></form>
 <p class="jev-settings-hint">Anahtar bu bilgisayarda sistem anahtarlığıyla şifrelenir ve kaydettikten sonra gösterilmez. Test yalnızca TypeSafe’ten model listesini ister; aday belgesi veya tarayıcı içeriği göndermez ve model görevi başlatmaz.</p><p class="jev-settings-message" data-message role="status"></p>`;
 const $=selector=>root.querySelector(selector),form=$('form'),key=form.elements.apiKey;
 function render(){
  $('[data-state]').textContent=status?.error?'Anahtar açılamadı':status?.configured?'Anahtar yapılandırıldı':'Anahtar gerekli';
  key.placeholder=status?.saved?'Değiştirmek için yeni anahtar gir':'TypeSafe konsolundaki API anahtarın';
  for(const control of form.elements)control.disabled=busy;
  $('[data-test]').disabled=busy||!status?.configured;$('[data-remove]').disabled=busy||!status?.saved;
  const source=status?.source==='environment'?'TYPESAFE_API_KEY ortam değişkeni veya geliştirme dosyası kullanılıyor. Kaydettiğin anahtar bunun yerine kullanılır. ':'';
  $('[data-message]').textContent=source+(errorMessage||status?.error||status?.lastCheck?.message||'');
 }
 async function load(){if(busy)return;const request=++version;try{const next=await api.jevSettingsStatus();if(request!==version)return;status=next;if(document.activeElement!==form.elements.model)form.elements.model.value=status.model;render();}catch(error){notice(error.message);}}
 async function act(run){if(busy)return;busy=true;version++;errorMessage='';render();try{await run();}catch(error){errorMessage=error.message;notice(error.message);}finally{busy=false;render();}}
 form.onsubmit=event=>{event.preventDefault();act(async()=>{let input={apiKey:key.value,model:form.elements.model.value.trim()};key.value='';try{status=await api.saveJevSettings(input);notice('Jev ayarları kaydedildi.');}finally{input.apiKey='';}});};
 $('[data-remove]').onclick=()=>act(async()=>{status=await api.removeJevSettings();key.value='';form.elements.model.value=status.model;notice(status.configured?'Kaydedilen anahtar kaldırıldı. Geliştirme ortamındaki anahtar etkin.':'Jev anahtarı kaldırıldı.');});
 $('[data-test]').onclick=()=>act(async()=>{const check=await api.testJevConnection();status={...status,lastCheck:check};notice(check.message);});
 return {load};
}

export function dataDisclosure(root){
 root.classList.add('data-disclosure');
 root.innerHTML=`<h4>Verilerin nerede işlenir?</h4><ul><li><b>Bu bilgisayarda:</b> Aday profilleri, CV ve belgeler, başvuru geçmişi, tarayıcı profilleri ve uygulama kayıtları saklanır.</li><li><b>Seçtiğin AI sağlayıcısında:</b> Agent çalışırken görev talimatları, aday bilgileri, okuduğu belgeler, tarayıcı gözlemleri ve araç sonuçları işlenir. Sağlayıcı hesabının veri tercihleri geçerlidir.</li><li><b>TypeSafe / Jev’de:</b> Jev’den karar istendiğinde sayfa adresi, başlığı, metni, form alanlarının mevcut değerleri ve son işlemler paylaşılır. Formlardaki kişisel bilgiler de bu içeriğe girebilir.</li><li><b>CapSolver’da:</b> Otomatik CAPTCHA çözümünü açarsan sayfa adresi, doğrulama bilgileri ve gerektiğinde CAPTCHA görseli CapSolver ile paylaşılır.</li><li><b>Telegram’da:</b> Botu etkinleştirdiğinde seçtiğin ilan, başvuru ve soru bildirimleri, bunlara verdiğin yanıtlar ve sohbet kimliği Telegram üzerinden işlenir.</li><li><b>İş sitelerinde:</b> İzin verdiğin başvuru akışında doldurulan bilgiler ve yüklenen belgeler ilgili siteye gönderilir.</li></ul><p>Uygulamaya kaydettiğin portal şifreleri ve API anahtarları sistem anahtarlığıyla şifrelenir. Jev’in şifre doldurma aracı şifreyi doğrudan siteye aktarır; sohbet yanıtında göstermez. Yedeklerini ve dışa aktardığın aday belgelerini kişisel veri olarak koru.</p>`;
}
