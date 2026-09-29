import './data-management.css';

export function createDataManagement(api,{notice=()=>{}}={}){
 const element=document.createElement('section');element.id='config-data';element.className='config-section data-management';
 element.innerHTML=`<h3>Veriler ve yedekler</h3>
 <p>Otomasyonlarını, template’lerini, aday profillerini, belgelerini ve sonuç kayıtlarını bir yedek klasörüne aktar.</p>
 <p class="data-notice">Yedekler kişisel veriler içerir ve şifrelenmez; güvenli bir yerde sakla. Dışa aktarılan yedekte kayıtlı portal şifreleri, Telegram bağlantıları, Jev anahtarı ve agent oturumları bulunmaz. Geri yükledikten sonra bunları yeniden bağlamalısın.</p>
 <div class="data-actions"><button type="button" data-backup>Yedek dışa aktar</button><button type="button" class="quiet" data-restore>Yedekten geri yükle</button><button type="button" class="quiet" data-open>Otomatik yedekleri aç</button></div>
 <p class="data-restore-note">Geri yükleme mevcut otomasyonları, template’leri, adayları ve sonuçları seçilen yedekle değiştirir. Önce mevcut verilerin kurtarma yedeği alınır; uygulama yeniden başlar. Otomasyonlar, kampanyalar ve Telegram duraklatılmış olarak açılır. Otomasyonların kaynaklarını yeniden dene. Geri yüklenen eski bir yedek, sonradan yapılan başvuruları içermeyebilir; devam etmeden önce sonuçları kontrol et.</p>
 <h4>İşlem kayıtları</h4><p data-retention>Prompt ve tamamlanmış arka plan terminal kayıtları en fazla 30 gün tutulur.</p>
 <button type="button" class="quiet" data-clear>Prompt ve terminal kayıtlarını temizle</button>
 <p class="data-status" role="status" aria-live="polite"></p><ul class="data-backups" aria-label="Otomatik yedekler"></ul>`;
 const buttons=[...element.querySelectorAll('button')],status=element.querySelector('.data-status'),list=element.querySelector('.data-backups');let busy=false;
 async function load(){
  try{
   const data=await api.dataStatus();
   element.querySelector('[data-retention]').textContent=`Prompt kayıtları en fazla ${data.retention.days} gün, aday başına ${data.retention.promptsPerCandidate.toLocaleString('tr-TR')} ve toplam ${data.retention.promptsTotal.toLocaleString('tr-TR')} kayıt tutulur. Tamamlanan arka plan ve otomasyon terminal kayıtlarında ${data.retention.days} gün ve ${data.retention.terminalFiles} dosya sınırı vardır. Başvuru geçmişi, otomasyon konuşmaları ve sonuçlar bu temizliğe dahil değildir.`;
   status.textContent=`Sürüm ${data.appVersion} · ${data.prompts.toLocaleString('tr-TR')} prompt kaydı${data.pendingRestore?' · Geri yükleme için yeniden başlatma bekleniyor':''}`;
   list.replaceChildren();
   for(const backup of data.backups.slice(0,5)){const item=document.createElement('li');item.textContent=`${new Date(backup.createdAt).toLocaleString('tr-TR')} · ${backup.kind==='before-restore'?'Geri yükleme öncesi':'Güncelleme öncesi'} · ${backup.candidates} aday, ${backup.jobs} ilan`;list.append(item);}
   if(!data.backups.length){const item=document.createElement('li');item.textContent='İlk sürüm geçişinde otomatik yedek oluşturulur.';list.append(item);}
  }catch(error){status.textContent=error.message;}
 }
 async function run(action){if(busy)return;busy=true;for(const button of buttons)button.disabled=true;status.textContent='İşlem sürüyor…';try{await action();await load();}catch(error){status.textContent=error.message;notice(error.message);}finally{busy=false;for(const button of buttons)button.disabled=false;}}
 element.querySelector('[data-backup]').onclick=()=>run(async()=>{const result=await api.dataBackup();if(result)notice('Yedek oluşturuldu: '+result.path);});
 element.querySelector('[data-restore]').onclick=()=>run(async()=>{const result=await api.dataRestore();if(result?.restartRequired)notice('Yedek doğrulandı. JobLoop geri yüklemek için yeniden başlatılıyor.');});
 element.querySelector('[data-open]').onclick=()=>run(()=>api.dataOpenBackups());
 element.querySelector('[data-clear]').onclick=()=>run(async()=>{const result=await api.dataClearLogs();if(result)notice('Prompt ve terminal kayıtları temizlendi.');});
 return {element,load};
}
