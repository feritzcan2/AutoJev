# Template ve ortak çalışma alanı altyapısı

İş arama, ev arama, randevu ve özel template’ler aynı otomasyon ekranını ve `browser` yürütücüsünü kullanır. İş arama, `app/templates/job-search.mjs` içinde alanları, tablo sütunlarını ve talimatları tanımlar. Üretim başlangıcı eski `Campaigns` veya aday MCP servislerini yüklemez.

## Ortak akış

`TemplateRegistry` → `AutomationStore` → `WebTasks` → `WorkspaceTasks` → `AgentSessions` → ortak MCP ve Chrome/Jev.

- `workspace_records`: sonuçlar, taslaklar, durumlar, kanıtlar ve tablo hücreleri.
- `workspace_tasks`: kaynak/kayıt görevleri, bağımlılıklar ve worker rezervasyonları.
- `workspace_workers`: worker kimlikleri ve adları.
- `workspaces`: kimlik, template, agent ayarları, tarayıcı profili ve tablo.
- `automations`: hedef, kriterler, yetki, kaynak ayarları, sorular ve tarama ilerlemesi.
- `workspace_events`: ortak soru/kayıt bildirimleri.

`src/renderer.js` bütün çalışma alanlarını `automationsPage` ile açar. Kaynaklar, takip tablosu, profil, Agent, belgeler, arka plan işleri ve bildirimler aynı bileşenleri kullanır. Workspace seçimi ve menü sıralaması aynı kimlik üzerinden saklanır.

## Template sözleşmesi

`template-contract.mjs` tanımları sürüm 2’ye normalize eder. Sürüm 1 dosyaları içe aktarılabilir.

- `fields`: kurulum alanları ve türleri.
- `table`: başlık ve sütunlar.
- `records`: alan eşlemeleri, tekilleştirme ve sınıflandırma geçişleri.
- `workflow`: yetenek, kaynak/kayıt kapsamı, talimat ve bağımlılıklar.
- `execution`: kayıtlı yürütücü ve worker sınırı.
- `mail`: posta tarama talimatı ve izin verilen sonuç kimlikleri/etiketleri. Tanımlanmayan template'ler ortak onay, yanıt, güncelleme ve olumsuz dönüş sonuçlarını kullanır; iş arama template'i işe alım sonuçlarını tanımlar. Alan JSON dışa/içe aktarımında korunur.

`browser.observe`, `browser.evaluate`, `browser.prepare` ve `browser.act` bütün yerleşik template’lerde ortaktır. Template dosyaları çalıştırılabilir JavaScript içermez. Yeni bir entegrasyon yeni bir yetenek gerektirebilir; mevcut yetenekleri kullanan bir template için yeni ekran gerekmez.

## Kaynaklar ve sorular

Her kaynak ad, kapsam, etkinlik, tarama aralığı, işlem modu, skill, araç ve devam noktası saklar. Toplu tarama aralığı kapalı kaynaklara da uygulanır; başka çalışma alanını değiştirmez. Kaynak yetkisi çalışma alanının yetkisini aşamaz. Engelli kaynaklar kendi yeniden deneme durumunu korur.

`get_workspace_source_instructions` atanmış kaynağın skill ve CLI açıklamasını verir. `run_workspace_source_tool` yalnızca atanmış kaynağın kayıtlı aracını çalıştırır. Sonuçlar ve tarama ilerlemesi ortak otomasyon araçlarına kaydedilir.

Hazır template seçimi kurulum agent’ını ilk mesajı beklemeden başlatır. Agent template alanlarını ve kayıtlı belgeleri kullanarak eksik bilgileri sorar. Özel boş çalışma alanında kullanıcı önce amacını yazar. Kurulum turları önceki sağlayıcı oturumunu sürdürmez; ortak depodaki plan, sorular, yanıtlar ve mesajlarla yeni oturum açar.

`ask_workspace_question` bütün template’lerde metin, sayı, tarih, evet/hayır, tek seçim ve çoklu seçim formları oluşturur. Aynı yanıtsız soru tekrar oluşturulmaz. `workspace-answer` yanıtları çalışma alanı kimliğine göre doğrular; yanıt ve yapılandırılmış değerler agent bağlamında saklanır. Kullanıcı form yerine serbest metinle de yanıtlayabilir. Taslak yanıtlar çalışma alanı/soru kimliğiyle yerelde korunur. Son bekleyen form yanıtı kaydedilince kurulum agent’ı otomatik devam eder. Başlatma hatasında yanıt korunur ve tekrar devam düğmesi gösterilir. Kurulum sırasında soru kaydedip bitiş aracı çağırmadan duran agent, form yanıtı bekliyor olarak gösterilir; soru veya sonuç kaydetmeyen duruş hata olarak kalır. Bekleyen ilgili sorular işlem rezervasyonunu engeller; yanıt vermek işlem yetkisi sağlamaz.

## Entegrasyonlar

`workspace-support-services.mjs` arka plan becerilerini ve Telegram servislerini bütün çalışma alanları için kaydeder. `WorkspaceSupport` ortak kayıtları mevcut taşıma protokollerine uyarlar. Bu uyumluluk görünümü eski iş arama yürütücüsünü çalıştırmaz. Bildirim, posta ve arka plan tabloları `workspaces` kimliğine bağlıdır.

Telegram kayıt düğmeleri masaüstüyle aynı `WebTasks.runRecord` ve `dismissRecord` akışlarını kullanır. Açık kullanıcı isteği yalnızca seçilen kaydı işler; kaynak taramasını başlatmaz. Belirsiz kayıt yalnızca doğrulanır. Kartın işlem kimliği kayıt içeriğine ve kurulum sürümüne bağlıdır; eski kart yenilenmeden işlem başlatılamaz. Bekleyen görevler de kuyruk ve sabitleme durumuna dahildir. Kart başlıkları ve durumları çalışma alanının tablo/template tanımından gelir.

Kayıt, ilişkili çalışma durumu ve `workspace_events` olayı tek transaction içinde yazılır. Görev isteği commit edildikten sonra worker uyandırılır ve arayüz bilgilendirilir. Bu sınırlar yazma hatasında eksik bildirim veya açık kalmış işlem bırakmaz.

Varsayılan Gmail becerisi template'in `mail` sözleşmesini okur; ortak araçta kayıt eşlemesi `recordId` kullanır. Kişisel skill seçildiğinde yalnızca bağlam ve bitiş araçları verilir. Eski posta kayıtları ve taşıma kimlikleri korunur. Şema 9'a geçişten önce mevcut yedek mekanizması çalışır; eski template'lerde eksik `mail` alanı okuma sırasında varsayılanlarla tamamlanır. Aday modelinden taşınmış kişisel template'ler işe alım sonuçlarını korur; kaydedilmiş özel posta sözleşmeleri değiştirilmez.

`tests/workspace-record-lifecycle.test.mjs` dört template'in Telegram kuyruğunu, eski kartları, eleme akışını ve yazma hatasında geri almayı sınar. `tests/workspace-mail.test.mjs` posta sözleşmesini, eski veri geçişini ve yedekten geri yüklemeyi doğrular. `scripts/smoke-workspace-mail.mjs` ayrı Electron verisiyle ev arama, iş arama ve özel posta sonuçlarını gerçek eşleştirme arayüzünde kontrol eder.

## Eski verilerin geçişi

Şema 8 öncesinde mevcut yedek mekanizması çalışır. `upgradeWorkspaces` eski aday alanlarını bir kez ortak otomasyona taşır:

- Çalışma alanı, worker, kayıt ve soru kimlikleri korunur.
- Kaynak aralıkları, durumları, araçları ve devam noktaları korunur.
- Soruların alanları ve önceki yanıtları taşınır.
- Gönderilmiş kayıtlar `completed`, sonucu belirsiz girişimler `uncertain` olur. Tekrar gönderim için uygun sayılmazlar.
- Eski profil, başvuru politikası, puanlama ayarları ve görev geçmişi referans verisi olarak korunur.
- Dosya ve tarayıcı dizinleri yerinde kalır; ortak dizin çözümleyicisi bunları kullanır.
- Kişisel iş arama template’leri de `browser` yürütücüsüne taşınır.

Taşınan alan duraklatılır; kullanıcı profili kontrol edip kaynak denemesini yaptıktan sonra devam eder. Eski görevler kesilmiş geçmiş olarak kalır. `workspace_imports` makbuzu yeniden açılışta eski verinin değişiklikleri ezmesini veya silinen alanın geri gelmesini engeller. Silme işlemi eski alana bağlı kayıtları ve dosyaları da kaldırır.

Eski `app/extensions/job-search` modülleri eski veri sözleşmesinin testleri ve geçiş uyumluluğu için depoda bulunur. Varsayılan uygulama bunları kaydetmez; eski `LOOP_EXTENSIONS=job-search` ayarı da ayrı bir çalışma yolu açmaz.

## Doğrulama

`workspace-upgrade.test.mjs` kimlik, geçmiş, soru, kaynak aralığı, yeniden açılış ve silme geçişini sınar. `workspace-questions.test.mjs` dört template’in ortak agent aracıyla form oluşturmasını, yanıt doğrulamasını ve çalışma alanları arasındaki yalıtımı sınar. `extensions.test.mjs` varsayılan başlangıçta eski yürütücü bağımlılığı olmadığını doğrular.

`scripts/smoke-generic-workspace-ui.mjs` izole Electron verisiyle eski iş arama ve yeni ev arama alanlarını açar; ortak kaynak ekranında aralıkları değiştirir, soru formlarını yanıtlar ve yeniden açılışta kaydı kontrol eder. Canlı portallara başvuru göndermez.

## Kayıt üzerinden işlem yapma

Tarayıcı template’leri `recordOperations.prepare`, `execute` ve `verify` tanımlarını paylaşır. Template düğme adlarını, görev talimatlarını ve başarı koşulunu belirler; kuyruk, izinler, belgeler ve sonuç kaydı ortak yürütücüde kalır. İş arama başvuru, ev arama mesaj, randevu template’i rezervasyon adlarını kullanır. Tanımlar template dışa/içe aktarımında korunur; bir işlem veya tamamı `false` ile kapatılabilir.

Varsayılan kaynak görevi yalnızca bulguları kaydeder. Kayıt işlemi kaynak taramasının tamamlanmasına bağlı değildir; kendi kayıt kilidi ve tarayıcı sekmesini kullanır. `observe` otomatik hazırlık/gönderim başlatmaz; `prepare` taslak oluşturur ve onay bekler; `auto` kayıtlı kapsam ve sınırlar içinde yürütür. Mevcut özel kayıt workflow’ları kendi bağımlılıklarını korur.

Tabloda kullanıcı taslağı hazırlar, içeriği inceler ve tek kayıt için onaylar. Bu onay taslak özeti (digest) ve kurulum sürümüne bağlıdır; çalışma alanının izin modunu değiştirmez. Değişen taslak yeniden onay gerektirir. Gönderim öncesinde kalıcı rezervasyon yapılır; günlük/toplam sınırlar ve yinelenen gönderim kontrolü uygulanır. İşlemden sonra güncel sayfa kanıtı gerekir. Kesilen gönderim `uncertain` kalır ve yalnızca doğrulama sunar.

Eksik bilgiler ortak soru formuyla kayda bağlı sorulur; yanıt aynı kayıt için hazırlığı sürdürür. `browser_upload_document` yalnızca gönderim rezervasyonu yapılmış kayıtta, taslakta adı bulunan ve gerçek yolu çalışma alanında kalan dosyaları yükler. Jev gözlenen `uploadId`, ayrı tarayıcı açık dosya seçicisini kullanır. Tarayıcı ve agent aynı çalışma alanı dosya dizinini paylaşır.

`tests/record-operations.test.mjs` izin, değişen taslak, limit, soru devamı, belge yolu, sekme yalıtımı ve belirsiz sonuç kontrollerini sınar. `scripts/smoke-record-operations.mjs` ayrı Electron verisi ve yerel HTTP formuyla hazırlama, inceleme, belge yükleme, gönderme ve doğrulamayı; üç template’in ortak düğmelerini kontrol eder. Provider kararları testte taklit edilir; canlı siteye başvuru gönderilmez.

Kullanıcının hazırlama isteği, sıradaki geçerli hazırlamalar için mevcut worker havuzunu açar. Tek iş için bir worker yeterlidir; birden çok kayıt varsa ekli worker’lar ihtiyaç kadar açılır. Yeni worker oluşturulmaz; kapasiteyi aşan işler sırada kalır. Onaylı uygulama ve doğrulama isteği, bütün worker’lar kapalıysa ana worker’ı açar. Tekrar seçilen kuyruk isteği aynı görevi korur. Arka plan döngüsü kullanıcının durdurduğu worker’ı kendiliğinden açmaz; yeni açık kullanıcı isteği bu tercihi yeniler. Çalışma alanının izin modu veya kaynak takibi değişmez.

Giriş soruları, `accessCheck` ile son gözlem kimliği ve görünür giriş engelinden alıntı taşır. Kaynak/kayıt çalışmasında giriş isteyen soru kaydedilmeden sayfa yeniden okunur. Kayıt bağlantısı, `/signup` adresi, gizli kontroller, yüklenmekte olan sayfa ve önceki turun raporu tek başına giriş engeli sayılmaz. Güncel giriş formu veya açık giriş zorunluluğu metni gerekir. Sayfa değişmişse agent güncel içeriği incelemeye yönlendirilir. Kayıt bağlamındaki önceki çalışmalar aynı kayıtla sınırlandırılır.

Soru formundaki “Giriş durumunu yeniden kontrol et” eylemi, giriş yapıldığını iddia etmeden ve gönderim onayı vermeden güncel başvuru akışının kontrolünü ister. Eski sorular da bu kontrolü sunar; kullanıcıdan parola veya doğrulama kodu istenmez. `login-question.test.mjs` eski/gizli kanıtı, gerçek giriş formunu ve kontrol sırasında kaybolan engeli sınar; kayıt işlemleri UI testi gerçek soru formundan yeniden kontrole dönüşü doğrular.

Explicit direct execution (`execute`, `request.direct: true`) can start from a found record without a preparation task or draft-review dialog. The shared UI uses each template’s execute label and retains optional prepare/review actions. The agent inspects the real form, saves verified answers/documents as a proposal within that same task, reserves under the existing limits, submits, then records fresh confirmation. This authority is restricted to the assigned record and configuration revision; it never changes source permissions or permits resending completed/uncertain actions. Record questions retain their originating task ID so answers resume an outstanding direct request; stopping/cancelling it or changing setup removes that carry-over authority. Exact-digest reviewed execution keeps its existing changed-draft checks.


## Görev devamı ve teknik hata kontrolü

Aynı yarım kalmış kuyruk görevi yeniden başladığında kendi son sağlayıcı konuşmasını sürdürür. Başka bir kaydın ya da yeni tarama turunun konuşması kullanılmaz. Kurulum revizyonu, sağlayıcı ayarları veya işlem türü değiştiğinde yeni konuşma gerekir. Sonuç bildirmeden boşta kalan kaynak agentine aynı oturumda bir kez devam mesajı gönderilir; tekrar boşta kalırsa mevcut gecikmeli kurtarma uygulanır.

Başlangıç bağlamı atanmış kayıt, ilgili sorular ve yanıtlar, geçerli kurallar, işlem izinleri ve kaydedilmiş ilerleme ile sınırlıdır. Diğer kayıtlar gerektiğinde arama araçlarından okunur. Yanıtların yapılandırılmış değerleri ve işlem sınırları aynen korunur.

Jev kaynaklarında teknik hatadan sonraki otomatik deneme öncesinde uygulama, kayıtlı hatalı adresi geçici sekmede kontrol eder. Bu kontrol model veya worker başlatmaz; kendi açtığı sekmeyi kapatır. Sayfa hâlâ yüklenemiyorsa kontroller arasındaki süre uzar. Kontrol denemeleri, mevcut üç agent denemesi sınırından ayrı sayılır. Durdurulan veya değiştirilen görev, geç gelen kontrol sonucuyla yeniden başlatılmaz. Ayrı tarayıcı modu mevcut gecikmeli deneme davranışını korur.

### Source scan work

Source scans use the same durable work ledger for every template. `scan.work`
contains named searches with separate pending/processed URL sets, page progress,
and scan plans. `save_scan_searches` adds search scopes and `select_scan_search`
restores a scope without changing another scope's work.

`report_scan_page` records an observation. Revisiting an earlier page for access
recovery cannot replace the saved frontier or pending queue. `save_scan_progress`
adds `pendingUrls` and explicitly retires `processedUrls`; omission never removes
work. The 100-URL limit applies to one tool request/response, not the stored queue.
Use repeated saves and paged `get_scan_queue` reads for larger queues. Keep a
results page pending until all of its relevant links have been saved.

`complete_scan_search` verifies one scope's empty queue and end/cutoff evidence.
A source with multiple searches cannot finish until all scopes have completed.
Each scope retains its own chronology, so a page number or date cutoff from one
search cannot complete another. Template criteria control relevance and priority;
the common runtime controls persistence, ownership, recovery and completion.
