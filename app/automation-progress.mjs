import {automationTrialReady} from './automation-trial.mjs';
import {providerLimitAttention} from './provider-limit.mjs';
const action=(id,label)=>({id,label});
const failures=new Set(['failed','blocked','timeout']);
export const runKindLabel=kind=>({interview:'Kurulum konuşması',trial:'Deneme',run:'Kaynak taraması'}[kind]??'Çalışma');
// Task operations are queue identifiers; people see what the worker is doing, not the id.
export const runOperationLabel=(operation,kind)=>({interview:'Kurulum konuşması',trial:'Deneme taraması',run:'Kaynak taraması',scan:'Kaynak taraması',detail:'İlan ayrıntısı okunuyor',inspect:'İlan ayrıntısı okunuyor',verify:'Sonuç doğrulanıyor'}[operation]??runKindLabel(kind));

// One presentation of the durable run outcome and the next allowed step.
// A saved result and a provider process that is still closing are separate states.
export function automationProgress(snapshot,{dirty=false}={}){
 const {automation:a,runs=[],missing=[],messages=[]}=snapshot;
 const activeRuns=(snapshot.activeRuns??(snapshot.activeRun?[snapshot.activeRun]:[])).map(run=>runs.find(r=>r.id===run.id)??run);
 const current=activeRuns.find(run=>run.status==='running')??activeRuns[0]??null;
 const latest=runs[0],reviewed=a.reviewedRevision===a.revision,passed=automationTrialReady(a);
 const skipped=a.trial?.status==='skipped'&&passed;
 const relevant=latest?.revision===a.revision?latest:null;
 const reply=[...messages].reverse().find(m=>m.role==='assistant');
 // A workspace nobody has written to yet is a blank page, not a list of missing fields.
 const fresh=!current&&!runs.length&&!messages.some(m=>m.role==='user')&&!a.goal&&!reviewed;
 const result={stage:0,tone:'neutral',title:'Ne yapmak istediğini anlat',label:'Kurulum',detail:'Agent sorularla kriterlerini ve kaynaklarını hazırlayacak.',next:'İlk mesajını Agent sayfasına yaz; gerisini agent sorar.',primary:action('message','Agent’a yaz'),secondary:[],running:Boolean(current),finishedRun:!current&&latest?.finishedAt?latest:null,reply,reviewed,passed,fresh};
 const set=value=>Object.assign(result,value);
 if(current){
  const closing=current.status!=='running',waiting=current.state==='AwaitingInput';
  set({stage:current.kind==='interview'?0:current.kind==='trial'?1:2,tone:waiting?'waiting':'active',label:closing?'Sonuç kaydedildi':waiting?'Giriş / onay gerekiyor':'Çalışıyor',title:closing?'Oturum kapanıyor…':waiting?'Devam etmek için terminali kontrol et':({interview:'Agent kurulumu hazırlıyor',trial:'Deneme sürüyor',run:'Kaynaklar taranıyor'}[current.kind]),detail:closing?current.summary:current.kind==='trial'?'Kaynaklar açılıyor ve okunabildiği kontrol ediliyor. Denemede işlem gönderilmez.':current.kind==='interview'?'Template ve kayıtlı bilgiler inceleniyor; kurulum soruları, profil ve kaynaklar hazırlanıyor.':a.goal,next:closing?'Sonraki adım oturum kapandığında açılacak.':waiting?'Sağlayıcının giriş veya araç izni isteğini aşağıdaki canlı terminalde yanıtla.':'Bu tur bittiğinde sonucu ve sonraki adımı burada göreceksin.',primary:waiting?action('terminal','Terminale git'):null,secondary:closing?[]:[action('stop','Durdur')]});
  if(!closing&&current.usageLimit){const limit=providerLimitAttention(current.usageLimit);set({tone:'waiting',label:'Kullanım limiti',title:limit.title,detail:limit.detail,next:'Görev ve kaydedilen ilerleme korunuyor.',primary:action('terminal','Terminale git')});}
 }else if(dirty){
  set({title:'Profil değişiklikleri kaydedilmedi',label:'Kaydetmen gerekiyor',detail:'Yeni bilgiler kaydedilince deneme ve çalışma adımları güncellenecek.',next:'Çalışma alanı profilini kontrol edip kaydet.',primary:action('profile','Profili aç')});
 }else if((a.questions??[]).some(q=>q.answer==null)){
  set({tone:'waiting',title:'Sorularını yanıtla',label:'Yanıt bekliyor',detail:'Agent devam etmek için formdaki bilgileri bekliyor.',next:'Formu gönderince agent kayıtlı yanıtlarınla otomatik devam eder.',primary:action('questions','Formu doldur')});
 }else if(a.status==='complete'){
  set({stage:3,tone:'success',title:'Takip tamamlandı',label:'Tamamlandı',detail:latest?.summary??'Çalışma alanının bitiş koşuluna ulaşıldı.',next:'Kaydedilen sonuçları inceleyebilirsin.',primary:action('results','Sonuçları gör')});
 }else if(relevant&&!(skipped&&relevant.kind==='trial')&&failures.has(relevant.status)&&(a.status!=='enabled'||relevant.kind!=='run')){
  const trial=relevant.kind==='trial',setup=relevant.kind==='interview';
  set({stage:setup?0:trial?1:2,tone:'waiting',title:trial?'Deneme tamamlanamadı':setup?'Kurulum konuşması tamamlanamadı':'Çalışma tamamlanamadı',label:relevant.status==='timeout'?'Süre doldu':'İşlem gerekiyor',detail:relevant.summary,next:trial?'Belirtilen engeli gider veya agent’a düzeltmesini yaz. Ardından denemeyi tekrar çalıştır.':setup?'Kayıtlı bilgiler ve yanıtlarla kurulumu sürdürebilirsin.':'Sonuçları kontrol et; engel giderildikten sonra yeniden çalıştırabilirsin.',primary:setup?action('setup','Kuruluma devam et'):trial?action('trial','Denemeyi tekrar çalıştır'):action('run','Tekrar çalıştır'),secondary:setup?[]:[action('browser','Tarayıcıyı aç'),action('message','Agent ile düzelt')]});
  if(trial){
   let attempts=0;for(const run of runs){if(run.revision!==a.revision||run.kind!=='trial'||!failures.has(run.status))break;attempts++;}
   if(attempts>1)set({next:`Bu kurulumla art arda ${attempts} deneme tamamlanamadı. Agent ile engeli çöz veya kaynakları güncelle; ardından tekrar dene.`,primary:action('message','Agent ile engeli çöz'),secondary:[action('browser','Tarayıcıyı aç'),action('trial','Denemeyi tekrar çalıştır')]});
  }
  if(!trial&&!setup&&a.status==='paused'&&reviewed&&passed&&relevant.sourceUrl&&!relevant.recordId&&(snapshot.sources??[]).some(s=>s.enabled&&!s.blocked))set({title:'Diğer kaynakların takibi kapalı',next:'Düzenli takibi açınca engelli olmayan kaynaklar kendi aralıklarında çalışır. Engelli kaynağı Kaynaklar sayfasından ayrıca yönetebilirsin.',primary:action('enable','Düzenli takibi sürdür'),secondary:[action('sources','Kaynakları gör'),action('message','Agent ile düzelt')]});
 }else if(fresh){
  // keep the blank-page invitation
 }else if(!reviewed){
  if(missing.length)set({title:latest?.kind==='interview'?'Kurulum için yanıtın gerekiyor':'Kurulumu tamamlayalım',label:'Bilgi bekliyor',detail:reply?.text??result.detail,next:'Eksik bilgiler: '+missing.join(', '),primary:action('message','Yanıt yaz')});
  else set({title:'Kurulum taslağı hazır',label:'İncelemen gerekiyor',detail:latest?.kind==='interview'?latest.summary:'Agent kriterleri ve kaynakları hazırladı.',next:'Profili ve işlem yetkisini kontrol edip kaydet. Sonraki adım kaynakları denemek.',primary:action('profile','Profili incele ve kaydet')});
 }else if(!passed){
  set({stage:1,title:relevant?.kind==='trial'&&relevant.status==='interrupted'?'Deneme durduruldu':'Kurulum tamamlandı',label:'Deneme bekliyor',detail:relevant?.kind==='trial'?relevant.summary:'Kriterlerin ve kaynakların kaydedildi.',next:'Deneme, kaynakların okunabildiğini kontrol eder. Başvuru, mesaj veya rezervasyon göndermez.',primary:action('trial',relevant?.kind==='trial'?'Denemeyi tekrar çalıştır':'Denemeyi başlat'),secondary:[action('profile','Profili düzenle')]});
 }else if(a.status==='enabled'){
  set({stage:2,tone:'success',title:'Düzenli takip açık',label:latest?.status==='completed'?'Son tur tamamlandı':'Sıradaki kontrol bekleniyor',detail:latest?.kind==='run'?latest.summary:'Kaynaklar belirlediğin aralıklarla kontrol edilecek.',next:`Her ${a.intervalMinutes} dakikada bir kontrol edilir. Sonraki kontrol: ${a.nextRunAt?new Date(a.nextRunAt).toLocaleString('tr-TR'):'sırada'}. Uygulama açık kalmalı.`,primary:action('results','Sonuçları gör'),secondary:[action('stop','Takibi duraklat')]});
  const sources=snapshot.sources??[],blocked=sources.filter(s=>s.enabled&&s.blocked);
  if(sources.length)set({next:`Kaynaklar kendi tarama aralıklarında çalışır. Sonraki kontrol: ${a.nextRunAt?new Date(a.nextRunAt).toLocaleString('tr-TR'):'planlanmış kontrol yok'}. Uygulama açık kalmalı.`});
  if(blocked.length)set({tone:'waiting',label:`${blocked.length} kaynak engelli`,title:blocked.length===sources.filter(s=>s.enabled).length?'Kaynaklar müdahale bekliyor':'Diğer kaynakların takibi sürüyor',detail:blocked.map(s=>`${s.name}: ${s.lastResult??'Erişim engeli'}`).join('\n'),next:'Engelli kaynaklar otomatik tekrar denenmez. Kaynaklar sayfasından her birini ayrı çalıştırabilirsin.'});
 }else{
  const ran=relevant?.kind==='run',paused=a.status==='paused';
  set({stage:2,tone:ran||paused?'neutral':'success',title:paused?'Takip duraklatıldı':ran?'Bu tur tamamlandı':skipped?'Deneme atlandı':'Deneme başarılı',label:paused?'Duraklatıldı':ran?'Tur bitti':'Çalışmaya hazır',detail:skipped&&!ran?'Kaynaklar denenmeden devam edilecek.':relevant?.summary??'Kaynaklar okunabiliyor.',next:`Düzenli takip kapalı. Bir kez çalıştırabilir veya her ${a.intervalMinutes} dakikada bir kontrolü açabilirsin.`,primary:action('enable',paused?'Düzenli takibi sürdür':'Düzenli takibi başlat'),secondary:[action('run','Bir kez çalıştır'),action('results','Sonuçları gör')]});
 }
 if(!current&&!dirty&&reviewed&&!passed&&result.stage===1)result.secondary.unshift(action('skip-trial','Denemeyi geç'));
 // An expired end date cannot be fixed by retrying the same task.
 if(!current&&a.status!=='complete'&&a.endAt&&a.endAt<=Date.now())set({tone:'waiting',label:'Bitiş tarihi geçti',next:'Devam etmek için profildeki bitiş tarihini güncelle.',primary:action('profile','Bitiş tarihini düzenle'),secondary:[]});
 result.steps=[{label:'Kurulum',state:reviewed?'done':result.stage===0?'current':'pending'},{label:skipped?'Deneme atlandı':'Deneme',state:passed?'done':result.stage===1?'current':'pending'},{label:'Takip',state:a.status==='complete'?'done':result.stage>=2?'current':'pending'}];
 return result;
}
