# Az ilanla erken biten kaynak taramaları

29 Eylül 2026'da Berlin profilindeki üç gerçek Claude/Jev turu incelendi.
80 adım ve 10 dakika sınırına rağmen her tur 3–4 adımda, 32–44 saniyede
bitmişti. Yalnız ilk sonuç sayfası ve 1–2 ilan detayı açılmıştı. Agent kapsamın
eksik olduğunu açıkça yazmış, uygulama yine de `completed` kabul etmişti.
WG-Gesucht'ta yalnızca not edilmesi istenen süreli kira şartı eleme sebebi
yapılmıştı.

Varsayılan üretim taraması artık kurulum/örnek araştırma talimatını kullanmıyor.
Kaynak bitiş aracı kapsam ve kalan gözlenmiş adresleri istiyor. Eksik tur aynı
görev kimliğiyle devam ediyor; bağımlı işlemler erken açılmıyor. Kriter talimatı,
asgari şartı kesin değere çevirmemeyi ve istenmeyen eleme şartı eklememeyi
belirtiyor. Kaynak satırları toplam kayıt sayısını gösteriyor.

## Canlı kontrol

Kullanıcının Berlin profilinde, yalnız WG-Gesucht kaynağı Claude/sonnet + Jev
ve gözlem modunda yeniden çalıştırıldı. Başlangıçta profilin 5 normal kaydı vardı.
İlk turda 7 yeni kayıt ve kalan 11 adres kaydedildi; durum `partial` oldu.
İkinci tur otomatik başladı, aynı görev kimliğini korudu ve ilk sayfayı yeniden
taramak yerine bekleyen detay adreslerini açtı. Son kontrol anında 11 yeni kayıt
eklenmiş, profil toplamı 16'ya ulaşmıştı. Süreli kiralar kısıtlarıyla kaydedildi.
İşlem girişimi sıfırdı. Tarama devam ediyordu; bütün sayfalar gezildiği veya
bütün konum/uygunluk değerlendirmeleri doğru olduğu iddia edilmedi.

Yerel denetim: `/tmp/loop-berlin-scan-audit.json`. Kontrol testleri kapsam
zorunluluğunu, üç sayfalık devamı, kapanış rezervasyonunu, yeniden başlatmayı,
uydurulmuş adresleri ve ilerlemeyen devam noktalarını sınar. Ayrı Electron
uygulamasındaki mevcut UI/IPC/MCP akışı da geçti.

## Erken devam döngüsü ve sekme birikmesi

Takip kontrolünde Claude, 80 adım / 10 dakika sınırına rağmen 2–3 adım ve
26–37 saniye sonra bütçenin dolduğunu bildiriyordu. Kısmi bitişin koşulsuz
kabul edilmesi kısa turları sürekli yeniden başlatıyordu. Jev uyarlayıcısı ise
her farklı ilan URL'sinde yeni sekme açıyordu.

Kısmi bitiş artık gerçek adım sayısını ve süreyi kontrol eder. Adımlar bitmeden
veya süre sonundaki kayıt payına girilmeden yeni tura geçilmez. Gerçek bir engel
ve tamamlanmış kapsam hemen bildirilebilir. `currentRun.budget`, kalan adım,
saniye ve `canYield` değerlerini verir. Kaynak turları eski terminal konuşmasını
yeniden yüklemez; kayıtlı plan, sonuçlar ve devam noktasıyla başlar.

Jev gözlem taramaları, denemeler ve kurulum araştırması worker başına kayıtlı
bir okuma sekmesini yeniden kullanır. Sekme sahipliği URL eşleştirmesiyle
kurulmaz. Başvuru/taslak sekmeleri ve başka worker'ların sekmeleri kullanılmaz;
kullanıcının başka adrese götürdüğü sekme korunur. Gönderim içeren görevler bu
okuma sekmesi kuralına dahil değildir.

`node scripts/smoke-automation-tabs.mjs`: gerçek yerel Chrome/Jev ile 30 sayfa,
3 tur, tek okuma sekmesi; ikinci worker, açık taslak, kullanıcının adres
değişikliği ve kapatılan sekmeden toparlanma doğrulandı. Bu test canlı sitedeki
tüm ilanların tarandığı anlamına gelmez.

Düzeltme sonrası canlı Claude/sonnet + Jev kontrolü de yapıldı. İlk bağlantı
beklemesinin ardından aynı turda 5 farklı WG-Gesucht detay adresi açıldı.
Kayıtlı Chrome sahipliği yalnız ana sayfa ve `read:main` sekmesini gösterdi
(2 toplam sekme, 1 tarama sekmesi). 3 yeni kayıt eklendi, normal kayıt sayısı
40'tan 43'e çıktı. Kontrol 82 saniyede tarafımızdan duraklatıldı; agent erken
yeni tura geçmedi. Kalan taramanın tamamlandığı iddia edilmedi.
