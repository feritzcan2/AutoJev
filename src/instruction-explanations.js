const descriptions={
 criteria:'Bütçe, konum, oda sayısı gibi seçim şartların. Agent bulduğu seçenekleri bu şartlarla karşılaştırır.',
 preferences:'Aradığın iş, konum, çalışma biçimi ve diğer tercihlerin. Agent ilanları bunlara göre değerlendirir.',
 instructions:'Bu çalışma alanı için eklediğin özel çalışma kuralları. Örneğin ilanları tek tek incelemesini veya belirli seçenekleri elemesini burada söyleyebilirsin.',
 facts:'Senin hakkında kaydettiğin bilgiler. Agent uygunluğu değerlendirirken, yanıt veya mesaj hazırlarken bunlara başvurur.',
 mode:'Agent’ın yalnızca araştırması, taslak hazırlaması ya da izin verdiğin işlemleri yapması gerektiğini belirtir.',
 authorization:'Agent’ın araştırma, hazırlık veya gönderim yapabileceği sınırı belirtir. Göreve özel izinler ayrıca görev bilgisinde verilebilir.',
 applicationPolicy:'Form doldurma, onay kutuları ve bilinmeyen bilgilerde sana soru sorma gibi başvuru kuralları.',
 goal:'Bu çalışma alanında ulaşılmasını istediğin sonuç. Agent yapacağı işi ve neyi başarı sayacağını buna göre yorumlar.',
 sources:'Araştırılacak siteler ve başlangıç adresleri. Bir worker’a yalnızca o görevde inceleyeceği kaynaklar verilebilir.',
 maxActionsPerDay:'Bir günde yapılabilecek dış işlemlerin üst sınırı. Agent planı okurken öğrenir; uygulama da ilgili işlem kayıtlarında bu sınırı kontrol eder.',
 maxBrowserSteps:'Bir çalışma turunda kullanılabilecek tarayıcı adımı sınırı. Agent bu bilgiyle çalışmasını planlar; uygulama adımları ayrıca sayar.',
 timeoutMinutes:'Bir çalışma turunun süre sınırı. Agent planı okurken öğrenir; süre takibini uygulama yapar.',
 guidance:'Seçtiğin template’in bu iş türüne özgü kuralları. Örneğin ev ararken hangi bilgilerin inceleneceğini anlatır.',
 workflow:'Template’in görev adımları ve sıralaması. Agent’a o turda yapacağı adım ayrıca atanır; bütün adımları aynı turda yapması beklenmez.',
 fields:'Kurulumda hangi bilgilerin sorulacağını tanımlar. Agent eksik bilgileri toplarken bu alanları kullanır.',
 title:'Çalışma alanının veya template’in adı. Agent’ın hangi iş üzerinde çalıştığını anlamasına yardımcı olur.',
 records:'Kayıt alanlarını, durumlarını ve kullanılabilir geçişleri tanımlar.',
 execution:'Template’in hangi yürütücü ve tarayıcı seçenekleriyle çalışacağını tanımlar.',
 table:'Sonuç tablosunun sütunlarını ve alan türlerini tanımlar. Agent sonuçları bu yapıya göre kaydeder.'
};
export function instructionExplanation(part){
 const key=part.key,field=key.split(':').at(-1);
 if(key.startsWith('agent-profile:'))return {purpose:'Seçilen agent’ın görevini ve çalışma kurallarını tanımlar.',timing:'Bu agent için oturum açılırken Codex’e geliştirici talimatı, Claude’a ek sistem talimatı olarak doğrudan verilir.',change:'Kaydettiğin sürüm sonraki oturumda kullanılır. Açık oturumun talimatları değişmez; farklı sürümdeki eski konuşma sürdürülmez.'};
 if(key.startsWith('file:'))return {
  purpose:part.source==='skill'?'Belirli bir işi nasıl yapacağını anlatan beceri dosyası. Her görevde bütün becerilerin okunması gerekmez.':'Agent’ın çalışma biçimini belirleyen talimat dosyasının bir bölümü.',
  timing:part.source==='skill'?'Oturum hazırlanırken dosya erişime açılır. Agent ilgili görev için bu dosyayı açıp okursa içeriği öğrenir.':'Oturum hazırlanırken çalışma klasörüne konur. Sağlayıcı veya agent bu dosyayı okuduğunda içeriği öğrenir.',
  change:'Dosyaya erişim kaydı, okuma kanıtı değildir. Güncel dosyanın açık konuşmaya yeniden okunduğunu bu sayfadan kesinleştiremeyiz.'
 };
 if(key==='startup-routing'||key==='browser-profile')return {
  purpose:key==='startup-routing'?'Agent’a verilen göreve nasıl başlayacağını ve hangi talimatları izleyeceğini söyler.':'Seçilen tarayıcının ve profilin nasıl kullanılacağını anlatır.',
  timing:'Agent oturumu başlatılırken ilk mesajın içine eklenir. Önceki konuşma sürdürülse de yeni başlatmada tekrar iletilir.',
  change:'Buradaki güncel metin, açık oturuma kendiliğinden yeni bir mesaj olarak gönderilmez. Sonraki başlatmada yeni metin kullanılır.'
 };
 if(key.includes(':messages:'))return {
  purpose:part.source==='user'?'Bu çalışma alanındaki konuşmada yazdığın mesaj. Agent isteğini ve önceki yanıtlarını hatırlamak için kullanır.':'Çalışma alanının kayıtlı konuşmasından bir mesaj; sonraki turda konuşmanın devamını anlamaya yardımcı olur.',
  timing:'Kurulum agent’ı kayıtlı görev bilgilerini istediğinde, boyut sınırına sığan son mesajlarla birlikte verilir. Deneme ve Çalışma agent’larına ham kurulum sohbeti gönderilmez.',
  change:'Bir mesajın burada listelenmesi tek başına o oturuma iletildiğini göstermez. Gönderim geçmişindeki bağlam yanıtını kontrol edebilirsin.'
 };
 if(key.startsWith('tool:get_'))return {
  purpose:descriptions[field]??(part.source==='template'?'Seçili template’in bu çalışma için tanımladığı bilgi.':'Çalışma alanında kayıtlı görev bilgisi.'),
  timing:key.includes('get_task_context')?'Yeni bir görev başlarken agent kayıtlı görev bilgilerini ister. Bu bilgi, o isteğe verilen yanıtın içinde iletilir.':'Agent kurulum sohbeti, deneme veya normal çalışma turuna başlarken kayıtlı planı ister. Bu bilgi, o isteğe verilen yanıtın içinde iletilir.',
  change:'Kaydettiğin değişiklik açık konuşmaya otomatik olarak eklenmez. Agent görev bilgilerini yeniden istediğinde güncel değer verilir. Her tıklamada tekrar gönderilmez.'
 };
 return {purpose:part.source==='tool'?'Agent’ın kullanabildiği bir aracın açıklaması veya araçtan dönen bilgi.':'Agent’ın çalışırken kullanabileceği talimat veya bilgi.',timing:part.when??'İlgili görev ya da araç isteği sırasında iletilir.',change:'İletilen gerçek metni ve zamanı Gönderim geçmişi bölümünden inceleyebilirsin.'};
}
