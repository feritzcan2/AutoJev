# Başvuru hazırlığı

> **Not (2026-10-02):** Bu belgedeki `get_task_context`, `ask_candidate` ve skill dosyası referansları eski mimariye aittir. Güncel akış için [agent-workers.md](agent-workers.md) ve [automation-templates.md](automation-templates.md) belgelerine bak.

İlan satırındaki **Hazırla**, gerçek başvuru formunu inceleyip o ilana bağlı bir paket oluşturur. Kaynak modu veya aday yetkisi **Hazırla** olduğunda yeni uygun işler de aynı göreve atanır.

Paket; zorunlu/isteğe bağlı/bilinmeyen gereksinimleri, form kanıtını, dil ve formatı, dosya/metin sınırlarını, yerel belge yollarını, cevap taslaklarını ve eksikleri içerir. Çok adımlı formun tamamı görülemediyse kısmi kapsam açıkça gösterilir. Hazırlık paneli belgeleri açar, metinleri önizler ve düzenler, dosyalarla cevapları ZIP olarak indirir. **Başvur** kayıtlı paketi normal başvuru akışına aktarır.

## Görev ve yetki

- `kind=preparation`, mevcut tarayıcı, checkpoint, soru ve worker altyapısını kullanır. Talimat: `skills/prepare-application/SKILL.md`.
- `preparation.requestId` yalnızca eşleşen göreve hazırlık yetkisi verir. Elle Hazırla seçimi bu ilan için kaynak, puan, araştırma yetkisi ve kampanya hedefini aşabilir.
- `preparation.hold=true` uygulama durumundan bağımsızdır. Genel otomatik gönderim, yeniden başlatma, soru yanıtı veya teknik yeniden deneme bu kaydı kaldırmaz. Scheduler ve gönderim durum geçişi hold'u denetler; Jev'in gönderim kontrolü de aynı kaydı denetler.
- Kullanıcının ayrı **Başvur** eylemi hold'u kaldırıp mevcut ilan bazlı gönderim yetkisini oluşturur. Hazırlık sırasında final gönderim yasaktır. Yerel paket hazırlamak siteye dosya yükleme veya yeni onay verme yetkisi oluşturmaz.

## Kayıt ve dosyalar

`save_preparation`, güncel `revision` ve `profileKey` ile paket kaydeder. Aşamalar: `queued`, `inspecting`, `drafting`, `waiting`, `partial`, `ready`. `ready`, tam form kapsamı ve tüm zorunlu gereksinimlerin tamamlanmasını gerektirir. `partial` erişilebilen hazırlığın bittiğini, eksiklerin sürdüğünü belirtir. Kullanıcının yanıtlayabileceği zorunlu bilgi eksiklerinde mevcut `ask_candidate` akışı kullanılır.

Dosyalar `get_task_context.documentRoot/documents/<job-id>/` altında sürümlenir; kayıtlı yollar `documentRoot` dizinine göredir. Ek worker'lar da bu ortak aday dizinini kullanır. Hazır belgelerde dosyanın varlığı, aday dizini sınırı, boyutu ve bildirilmiş uzantı kısıtları doğrulanır. Belge içerik özeti kaydedilir. Metin düzenlemeleri yeni dosya üretir; önceki sürümü değiştirmez. Kullanıcı düzenlemeleri sonraki agent güncellemelerinde korunur. PDF/DOCX belgeler açılır; uygulama içi belge düzenleme Markdown/TXT içindir.

Profil veya CV revizyonu değişince paket **Güncellenmeli** görünür. Agent, gönderime geçerken gerçek formu ve etkilenen içerikleri yeniden kontrol eder. Yerel paket, sitenin formunun doldurulduğuna veya bir başvurunun gönderildiğine ilişkin kanıt değildir.

## Kontrol

`node --test tests/preparation.test.mjs` yetki sınırını, yeniden başlatmayı, soru dönüşünü, worker sahipliğini, dosya doğrulamayı, sürüm korumayı ve ZIP içeriğini sınar.

`node scripts/build.mjs && node scripts/smoke-preparation-ui.mjs` geçici aday verisi ve devre dışı provider/tarayıcı başlangıçlarıyla gerçek Electron IPC ve arayüzü kontrol eder. Gerçek işverene başvuru göndermez. Masaüstü ve dar ekran görüntülerini çıktıda belirtilen geçici dizine kaydeder.
