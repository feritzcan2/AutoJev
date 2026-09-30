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

`browser.observe`, `browser.evaluate`, `browser.prepare` ve `browser.act` bütün yerleşik template’lerde ortaktır. Template dosyaları çalıştırılabilir JavaScript içermez. Yeni bir entegrasyon yeni bir yetenek gerektirebilir; mevcut yetenekleri kullanan bir template için yeni ekran gerekmez.

## Kaynaklar ve sorular

Her kaynak ad, kapsam, etkinlik, tarama aralığı, işlem modu, skill, araç ve devam noktası saklar. Toplu tarama aralığı kapalı kaynaklara da uygulanır; başka çalışma alanını değiştirmez. Kaynak yetkisi çalışma alanının yetkisini aşamaz. Engelli kaynaklar kendi yeniden deneme durumunu korur.

`get_workspace_source_instructions` atanmış kaynağın skill ve CLI açıklamasını verir. `run_workspace_source_tool` yalnızca atanmış kaynağın kayıtlı aracını çalıştırır. Sonuçlar ve tarama ilerlemesi ortak otomasyon araçlarına kaydedilir.

Hazır template seçimi kurulum agent’ını ilk mesajı beklemeden başlatır. Agent template alanlarını ve kayıtlı belgeleri kullanarak eksik bilgileri sorar. Özel boş çalışma alanında kullanıcı önce amacını yazar. Kurulum turları önceki sağlayıcı oturumunu sürdürmez; ortak depodaki plan, sorular, yanıtlar ve mesajlarla yeni oturum açar.

`ask_workspace_question` bütün template’lerde metin, sayı, tarih, evet/hayır, tek seçim ve çoklu seçim formları oluşturur. Aynı yanıtsız soru tekrar oluşturulmaz. `workspace-answer` yanıtları çalışma alanı kimliğine göre doğrular; yanıt ve yapılandırılmış değerler agent bağlamında saklanır. Kullanıcı form yerine serbest metinle de yanıtlayabilir. Taslak yanıtlar çalışma alanı/soru kimliğiyle yerelde korunur. Son bekleyen form yanıtı kaydedilince kurulum agent’ı otomatik devam eder. Başlatma hatasında yanıt korunur ve tekrar devam düğmesi gösterilir. Kurulum sırasında soru kaydedip bitiş aracı çağırmadan duran agent, form yanıtı bekliyor olarak gösterilir; soru veya sonuç kaydetmeyen duruş hata olarak kalır. Bekleyen ilgili sorular işlem rezervasyonunu engeller; yanıt vermek işlem yetkisi sağlamaz.

## Entegrasyonlar

`workspace-support-services.mjs` arka plan becerilerini ve Telegram servislerini bütün çalışma alanları için kaydeder. `WorkspaceSupport` ortak kayıtları mevcut taşıma protokollerine uyarlar. Bu uyumluluk görünümü eski iş arama yürütücüsünü çalıştırmaz. Bildirim, posta ve arka plan tabloları `workspaces` kimliğine bağlıdır.

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
