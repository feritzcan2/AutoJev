# Tarayıcı çıktısının context kullanımı

> **Not (2026-10-02):** Buradaki `get_source_instructions` ve `record_job_rank` araçları artık yok. Değişmeyen sayfa metninin modele yeniden gönderilmemesi artık uygulama tarafında yapılır; bkz. [context-payload-budget.md](context-payload-budget.md) “Unchanged page text is not resent”.

27 Eylül 2026 tarihli EY başvuru konuşmasında modelin bildirdiği giriş
context'i 43.982 tokendan 760.956 tokena çıktı. Görev yaklaşık 6 dakika sürdü.
Bu değerler konuşma boyunca toplanan token sayısı değildir; ilgili model
isteğinin giriş boyutudur. Görev bitince 17:45:57 İstanbul saatinde otomatik
context restart kaydedildi.

Tarayıcı yanıtlarının `observationMode=delta` olmasına rağmen `controls`
listesi her seferinde tamamen gönderiliyordu. 55 gözlemdeki 4.099 kontrol
kaydının 3.471'i yeni kodla tekrar gönderilmiyor. İlk tam gözlem, sonraki
değişiklikler ve kaldırılan kimliklerle bütün kontrol haritası kayıpsız
yeniden oluşturulabiliyor.

## Ölçüm

| Aynı 55 gözlem | JSON karakter sayısı |
| --- | ---: |
| Önce | 1.212.525 |
| Sonra | 494.383 |
| Azalma | %59,23 |

Bu, kayıt üzerinde tekrar çalıştırılarak ölçülmüş çıktı boyutudur; canlı
model token tasarrufu ölçümü değildir. PDF ve ekran görüntülerinin base64
boyutları token olarak sayılmadı. İlk istek talimatları, form incelemeleri
ve durum güncelleme yanıtları bu değişiklikle küçültülmedi.

## Araç sözleşmesi

- Her sekme ayrı tutulur. `full` gözlemi önceki haritayı değiştirir.
- `delta` içindeki `controls`, eklenen veya değişen kayıtları taşır.
  `controlId` ile birleştirilir; `removedControls` kimlikleri silinir.
- Delta içinde bulunmayan kontrol değişmemiştir. Boş liste, bütün
  kontrollerin kaybolduğu anlamına gelmez. Dizi sırası hedef kimliği değildir.
- `clickTargets` targetId, `fillFields` fieldId, `scrollTargets` controlId
  üzerinden birleştirilir. `removedClickTargets`, `removedFillFields` ve
  `removedScrollTargets` kimlikleri silinir. Kullanılan tıklama/alan kimliği
  tüketilir; değişmeyen diğer kimlikler sonraki gözlemde korunabilir.
- `uploads` her yanıtta tam olarak değiştirilir.
- Genişletilmiş harita farkları `mapDeltas=true` ile belirtilir. Bu bayrak
  yoksa eski sunucunun clickTargets/scrollTargets/fillFields listeleri tam
  değiştirme olarak uygulanır; controls fark protokolü aynı kalır.
- `observe` her çağrıda canlı sayfayı okur; varsayılan yanıt yalnızca
  değişiklikleri taşır. Başarılı işlemin gözlemi zaten günceldir.
- Önceki `baseObservationId` context'te yoksa `observe({tabId, full:true})`
  ile bir kez tam gözlem alınır. İlk okuma, URL veya oturum sahibi değişimi
  de tam gözlem üretir. Yeni oturum eski oturumun kimliklerini kullanamaz.
- Sunucudaki sahiplik, DOM kimliği, alan durumu ve görünürlük kontrolleri
  her işlemde çalışmaya devam eder. Tam onay metinleri kısaltılmaz.

Claude ve Codex aynı Jev MCP sunucusunu ve bu sözleşmeyi kullanır.

## Doğrulama

`node scripts/audit-jev-context.mjs /path/to/old-conversation.jsonl`
eski Claude kaydını salt okunur olarak inceler; yalnızca toplam boyutları
yazar. Aday bilgileri veya araç içerikleri çıktıya yazılmaz.

`node scripts/smoke-jev-context.mjs` izole Chrome üzerinde 70 alanlı
formu kullanır. Tam gözlem 16.657 bayt, tek seçim sonrası yanıt 1.037 bayt
ölçüldü. Korunan kimlikle işlem yapılması, değiştirilen/eski/başka oturuma
ait kimliklerin reddedilmesi ve gönderim yapılmaması doğrulandı.

## Tekrar okumalar ve talimat boyutu

İkinci düzeltmede `observe` da varsayılan olarak değişiklikleri döndürüyor.
Aynı 70 alanlı formun değişmeyen tekrar okuması 495 bayt: tam gözlemden
%97 daha küçük. Bu oran yalnızca bu testin araç yanıtına aittir.
Sayfada dışarıdan değişen alan değeri, yeni hata ve aynı URL'deki geç
başarı onayı sonraki delta içinde görüldü. `full:true` ve yeni oturum
sahibinin tam başlangıç gözlemi de doğrulandı.

Başvuru skill'inin ana metni 34.689 → 9.473 bayta, kampanya yönlendirme
skill'i 12.406 → 4.558 bayta indi. Giriş, CAPTCHA, belirsiz gönderim ve
onay kapsamının ayrıntıları yalnızca ilgili durumda okunan iki referansa
taşındı. Başlangıçtaki tarayıcı talimatından aynı iş akışının tekrarları
çıkarıldı. Ortak talimatlar ve araç sözleşmesi Claude ve Codex için geçerli.

Bu değişiklikler mevcut konuşmada birikmiş tokenları silmez. Daha küçük
talimatların başlangıç maliyetine etkisi yeni native konuşmada ölçülmelidir;
canlı modelin toplam token tasarrufu henüz ölçülmedi.

## 28 Eylül: görev yanıtları ve diğer tarayıcı haritaları

- Kaynak talimatı ile araç referansı aynıysa yalnızca talimat gönderilir.
  Özel talimat ile farklı araç referansı birlikte korunur.
- Arama/puanlamada Jev taslaklarını sunucu korur. Native tarayıcının
  turn-scoped handoff için gereken sekme kimlikleri döndürülmeye devam eder.
- Açık aday talimatları ve onaylar korunur. Kaynaklı, tarihli reusableAnswers
  içinde zaten bulunan global alan yanıtlarının eski soru kayıtları tekrarlanmaz.
- add_job ve record_job_rank kaydedilen kimlik, durum, puan ve rankDecision
  döndürür. Ayrıntılı kanıtlar veritabanında ve list_applications(jobId) içinde
  kalır; tekrar başvuru uyarısı ve tamamlanmış durumlar yanıtta korunur.
- Tıklama ve doldurma kimlikleri yalnızca aynı oturum, belge, DOM düğümü ve
  anlamda korunur. Kullanılan kimlik tüketilir. Her eylem güncel form durumu
  ve hedef erişilebilirliğini yine kontrol eder. Dosya yükleme haritası tam döner.

Kayıt üzerinde `audit-agent-payloads.mjs` ile aynı yanıtları yeniden biçimlendirme:

| Araç | Çağrı | Önce / sonra bayt | Azalma |
| --- | ---: | ---: | ---: |
| get_task_context | 5 | 78.888 / 64.471 | %18,3 |
| get_source_instructions | 2 | 12.504 / 7.679 | %38,6 |
| add_job | 15 | 21.623 / 7.485 | %65,4 |
| record_job_rank | 11 | 28.287 / 6.797 | %76 |

Bu tablo yalnızca belirtilen yanıtların JSON boyutudur; toplam model context'i
veya token tasarrufu değildir. Araç tam kayıtları değiştirmez, yalnızca okur.

`node scripts/smoke-jev-maps.mjs` 20 metin alanı ve düğmeler içeren izole
Chrome formunda tekrar okumaların küçülmesini, değişmeyen kimlikle işlem
yapılmasını, kullanılmış/değiştirilmiş/başka oturum kimliğinin reddini ve
gerçek dış değişikliklerin farklara yansımasını kontrol eder.
