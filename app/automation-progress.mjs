import {sourceTrialReady} from './automation-trial.mjs';
import {providerLimitAttention} from './provider-limit.mjs';
import {isConversation,conversationWaiting} from './workspace-conversation.mjs';
const action=(id,label)=>({id,label});
const failures=new Set(['failed','blocked','timeout']);
export const runKindLabel=kind=>({'record-score':'İlan puanlanıyor','record-prepare':'İşlem hazırlanıyor','record-execute':'İşlem uygulanıyor','record-verify':'Sonuç doğrulanıyor',interview:'Kurulum konuşması',trial:'Deneme',run:'Kaynak taraması'}[kind]??'Çalışma');
// Task operations are queue identifiers; people see what the worker is doing, not the id.
export const runOperationLabel=(operation,kind)=>({'record-score':'İlan puanlanıyor','record-prepare':'İşlem hazırlanıyor','record-execute':'İşlem uygulanıyor','record-verify':'Sonuç doğrulanıyor',interview:'Kurulum konuşması',trial:'Deneme taraması',run:'Kaynak taraması',scan:'Kaynak taraması',detail:'İlan ayrıntısı okunuyor',inspect:'İlan ayrıntısı okunuyor',verify:'Sonuç doğrulanıyor'}[operation]??runKindLabel(kind));

// One presentation of the durable run outcome and the next allowed step.
// A saved result and a provider process that is still closing are separate states.
export function automationProgress(snapshot,{dirty=false}={}){
 const {automation:a,runs=[],missing=[],messages=[]}=snapshot;
 const activeRuns=(snapshot.activeRuns??(snapshot.activeRun?[snapshot.activeRun]:[])).map(run=>runs.find(r=>r.id===run.id)??run);
 const current=activeRuns.find(run=>run.status==='running'&&!isConversation(run))??activeRuns.find(run=>run.status==='running')??activeRuns[0]??null;
 const enabledSources=(a.sources??[]).filter(url=>a.sourceSettings?.[url]?.enabled!==false);
 const latest=runs[0],reviewed=a.reviewedRevision===a.revision,passed=enabledSources.length>0&&enabledSources.every(url=>sourceTrialReady(a,url));
 const relevant=latest?.revision===a.revision?latest:null;
 const reply=[...messages].reverse().find(m=>m.role==='assistant');
 // A workspace nobody has written to yet is a blank page, not a list of missing fields.
 const fresh=!current&&!runs.length&&!messages.some(m=>m.role==='user')&&!a.goal&&!reviewed;
 const result={stage:0,tone:'neutral',title:'Ne yapmak istediğini anlat',label:'Kurulum',detail:'Agent sorularla kriterlerini ve kaynaklarını hazırlayacak.',next:'İlk mesajını Agent sayfasına yaz; gerisini agent sorar.',primary:action('message','Agent’a yaz'),secondary:[],running:Boolean(current),finishedRun:!current&&latest?.finishedAt?latest:null,reply,reviewed,passed,fresh};
 const set=value=>Object.assign(result,value);
 if(current&&isConversation(current)){
  const waiting=conversationWaiting(current);
  set({stage:reviewed?2:0,tone:waiting?'neutral':'active',label:waiting?'Mesaj bekliyor':'Çalışıyor',title:waiting?'Sohbet açık':'Agent yanıtını hazırlıyor',detail:waiting?'Yeni mesajını aynı sohbetten gönderebilirsin.':'Agent mesajını inceliyor. Kaynaklar kendi görevlerine devam eder.',next:'Sohbeti kapatana kadar oturum açık kalır.',running:!waiting,primary:waiting?action('message','Mesaj yaz'):null,secondary:[]});
  if(current.usageLimit){const limit=providerLimitAttention(current.usageLimit);set({tone:'waiting',label:'Kullanım limiti',title:limit.title,detail:limit.detail,primary:action('terminal','Terminale git')});}
 }else if(current){
  const closing=current.status!=='running',waiting=current.state==='AwaitingInput';
  set({stage:current.kind==='interview'?0:2,tone:waiting?'waiting':'active',label:closing?'Sonuç kaydedildi':waiting?'Giriş / onay gerekiyor':'Çalışıyor',title:closing?'Oturum kapanıyor…':waiting?'Devam etmek için terminali kontrol et':({interview:'Agent kurulumu hazırlıyor',trial:'Deneme sürüyor',run:'Kaynaklar taranıyor'}[current.kind]),detail:closing?current.summary:current.kind==='trial'?'Bu kaynağın okunabildiği kontrol ediliyor. Denemede işlem gönderilmez.':current.kind==='interview'?'Template ve kayıtlı bilgiler inceleniyor; kurulum soruları, profil ve kaynaklar hazırlanıyor.':a.goal,next:closing?'Sonraki adım oturum kapandığında açılacak.':waiting?'Sağlayıcının giriş veya araç izni isteğini aşağıdaki canlı terminalde yanıtla.':'Bu tur bittiğinde sonucu ve sonraki adımı burada göreceksin.',primary:waiting?action('terminal','Terminale git'):null,secondary:closing?[]:[action('stop','Durdur')]});
  if(!closing&&current.usageLimit){const limit=providerLimitAttention(current.usageLimit);set({tone:'waiting',label:'Kullanım limiti',title:limit.title,detail:limit.detail,next:'Görev ve kaydedilen ilerleme korunuyor.',primary:action('terminal','Terminale git')});}
 }else if(dirty){
  set({title:'Profil değişiklikleri kaydedilmedi',label:'Kaydetmen gerekiyor',detail:'Yeni bilgiler kaydedilince takip ayarları güncellenecek.',next:'Çalışma alanı profilini kontrol edip kaydet.',primary:action('profile','Profili aç')});
 }else if((a.questions??[]).some(q=>q.answer==null)){
  set({tone:'waiting',title:'Sorularını yanıtla',label:'Yanıt bekliyor',detail:'Agent devam etmek için formdaki bilgileri bekliyor.',next:'Formu gönderince agent kayıtlı yanıtlarınla otomatik devam eder.',primary:action('questions','Formu doldur')});
 }else if(a.status==='complete'){
  set({stage:3,tone:'success',title:'Takip tamamlandı',label:'Tamamlandı',detail:latest?.summary??'Çalışma alanının bitiş koşuluna ulaşıldı.',next:'Kaydedilen sonuçları inceleyebilirsin.',primary:action('results','Sonuçları gör')});
 }else if(relevant&&failures.has(relevant.status)&&(a.status!=='enabled'||relevant.kind==='interview'||!relevant.sourceUrl&&relevant.kind!=='trial')){
  const trial=relevant.kind==='trial',setup=relevant.kind==='interview';
  set({stage:setup?0:2,tone:'waiting',title:trial?'Deneme tamamlanamadı':setup?'Kurulum konuşması tamamlanamadı':'Çalışma tamamlanamadı',label:relevant.status==='timeout'?'Süre doldu':'İşlem gerekiyor',detail:relevant.summary,next:trial?'Kaynaklar sayfasından engelli kaynağı kontrol edip tekrar çalıştırabilirsin.':setup?'Kayıtlı bilgiler ve yanıtlarla kurulumu sürdürebilirsin.':'Sonuçları kontrol et; engel giderildikten sonra yeniden çalıştırabilirsin.',primary:setup?action('setup','Kuruluma devam et'):trial?action('sources','Kaynakları gör'):action('run','Tekrar çalıştır'),secondary:setup?[]:[action('browser','Tarayıcıyı aç'),action('message','Agent ile düzelt')]});
  if(!setup&&a.status==='paused'&&reviewed&&relevant.sourceUrl&&!relevant.recordId&&(snapshot.sources??[]).some(s=>s.enabled&&!s.blocked))set({title:'Diğer kaynakların takibi kapalı',next:'Düzenli takibi açınca engelli olmayan kaynaklar kendi aralıklarında çalışır. Engelli kaynağı Kaynaklar sayfasından ayrıca yönetebilirsin.',primary:action('enable','Düzenli takibi sürdür'),secondary:[action('sources','Kaynakları gör'),action('message','Agent ile düzelt')]});
 }else if(fresh){
  // keep the blank-page invitation
 }else if(!reviewed){
  if(missing.length)set({title:latest?.kind==='interview'?'Kurulum için yanıtın gerekiyor':'Kurulumu tamamlayalım',label:'Bilgi bekliyor',detail:reply?.text??result.detail,next:'Eksik bilgiler: '+missing.join(', '),primary:action('message','Yanıt yaz')});
  else set({title:'Kurulum taslağı hazır',label:'İncelemen gerekiyor',detail:latest?.kind==='interview'?latest.summary:'Agent kriterleri ve kaynakları hazırladı.',next:'Profili ve işlem yetkisini kontrol edip kaydet. Her kaynak ilk işlendiği turda otomatik denenir.',primary:action('profile','Profili incele ve kaydet')});
 }else if(a.status==='enabled'){
  set({stage:2,tone:'success',title:'Düzenli takip açık',label:latest?.status==='completed'?'Son tur tamamlandı':'Sıradaki kontrol bekleniyor',detail:latest?.kind==='run'?latest.summary:'Kaynaklar belirlediğin aralıklarla kontrol edilecek.',next:`Kaynaklar kendi tarama aralıklarında kontrol edilir. Sonraki kontrol: ${a.nextRunAt?new Date(a.nextRunAt).toLocaleString('tr-TR'):'sırada'}. Uygulama açık kalmalı.`,primary:action('results','Sonuçları gör'),secondary:[action('stop','Takibi duraklat')]});
  const sources=snapshot.sources??[],blocked=sources.filter(s=>s.enabled&&s.blocked);
  if(sources.length)set({next:`Kaynaklar kendi tarama aralıklarında çalışır. Sonraki kontrol: ${a.nextRunAt?new Date(a.nextRunAt).toLocaleString('tr-TR'):'planlanmış kontrol yok'}. Uygulama açık kalmalı.`});
  if(blocked.length)set({tone:'waiting',label:`${blocked.length} kaynak engelli`,title:blocked.length===sources.filter(s=>s.enabled).length?'Kaynaklar müdahale bekliyor':'Diğer kaynakların takibi sürüyor',detail:blocked.map(s=>`${s.name}: ${s.lastResult??'Erişim engeli'}`).join('\n'),next:'Engelli kaynaklar otomatik tekrar denenmez. Kaynaklar sayfasından her birini ayrı çalıştırabilirsin.'});
 }else{
  const ran=relevant?.kind==='run',paused=a.status==='paused';
  set({stage:2,tone:ran||paused?'neutral':'success',title:paused?'Takip duraklatıldı':ran?'Bu tur tamamlandı':'Kurulum tamamlandı',label:paused?'Duraklatıldı':ran?'Tur bitti':'Çalışmaya hazır',detail:relevant?.summary??'Kriterlerin ve kaynakların kaydedildi.',next:`Düzenli takip kapalı. Her kaynağın ilk turu denemedir; işlem göndermez. Bir kez çalıştırabilir veya kaynakların kendi tarama aralıklarıyla düzenli takibi açabilirsin.`,primary:action('enable',paused?'Düzenli takibi sürdür':'Düzenli takibi başlat'),secondary:[action('run','Bir kez çalıştır'),action('results','Sonuçları gör')]});
 }
 result.steps=[{label:'Kurulum',state:reviewed?'done':result.stage===0?'current':'pending'},{label:'Takip',state:a.status==='complete'?'done':result.stage>=2?'current':'pending'}];
 return result;
}
