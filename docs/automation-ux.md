# Kurulum, deneme ve takip deneyimi

Eski Agent sayfası ve terminal bileşeni korunur. `automation-progress.mjs` kayıtlı çalışma sonucundan tek bir durum görünümü üretir. Sayfa başlığı, ana düğme, ilerleme adımları ve terminalin sonuç alanı bu görünümü kullanır.

- Kurulum konuşması bittiğinde eksik cevaplar veya profili inceleyip kaydetme adımı gösterilir. Agent'ın güncel yanıtı terminalin dışında okunabilir.
- Profil kaydedilince **Bir kez çalıştır** veya **Düzenli takibi başlat** kullanılabilir. Kurulum sonrası ayrı bir deneme adımı yoktur.
- Her kaynak ilk işleme alındığı turda otomatik denenir. Agent tarayıcıda arama, sayfalama, detay okuma ve erişimi kontrol eder; işlem göndermez. Başarılı denemeden sonraki tur normal taramadır. Yeni kaynak eklemek, mevcut kaynakların denemelerini sıfırlamaz.
- **Skill ve araçlar** içinde agent’ın öğrendiği yöntemler ve sürüm geçmişi okunabilir. Kullanıcının yazdığı kaynak talimatları ayrı korunur. Sonraki taramalar güncel kriterleri bu yöntemlerle uygular; değişen yöntemi yeniden test edip yeni sürüm kaydeder. Kaynak satırı doğrulanan bölüm sayısını gösterir.
- Deneme sonucu kaydedilip süreç henüz kapanmadıysa **Oturum kapanıyor** görünür. Yeni çalışma başlatılmaz.
- Deneme durumu Kaynaklar sayfasında kaynak başına gösterilir. Başarısız deneme yalnızca o kaynağı engeller; diğer kaynakların takibi sürer. **Tekrar dene** aynı kaynağın denemesini tekrar çalıştırır.
- **Bir kez çalıştır** ve **Düzenli takibi başlat** ayrı işlemlerdir. Tek turun bitmesi, takibin veya hedefin tamamlanması anlamına gelmez.
- Terminal yalnızca oturum açıkken görünür. Oturum bitince durum özeti ve sonraki adım görünür kalır; eski çıktıya çalışma geçmişinden erişilir.
- Yanıt alanı deneme veya takip turu bittikten sonra da erişilebilir kalır. Kullanıcı buradan soruları yanıtlayıp yeni konuşma turu açar. Eski bir konuşmanın yanıtı yeni turun sonucu olarak gösterilmez.

## Doğrulama

`tests/automation-progress.test.mjs` eksik bilgi, profil incelemesi, başarısız/başarılı deneme, kapanış, paralel çalışma, tekrar eden engel ve takip durumlarını sınar.

`tests/source-trial.test.mjs` ilk tur, kaynak kapsamı, paralel çalışma, yeniden başlatma, soru yanıtları ve eski deneme verisinin yükseltilmesini sınar.

`tests/source-trial.test.mjs` kaynak denemelerini ve bağımsız zamanlamayı sınar. Electron denemesi gerçek sayfalama ve detay bağlantılarını kullanır; engelli kaynaktan devam etmeyi ve deneme durumunun yeniden açılışta korunmasını kontrol eder.

`scripts/smoke-source-trial.mjs` gerçek Electron, IPC, MCP, SQLite ve yerel Chrome sayfasıyla bu geçişleri kontrol eder. Sağlayıcı yanıtları kontrollüdür; dış sitelerde mesaj veya başvuru göndermez. Eski iş arama ve çoklu worker ekranları kendi Electron kontrolleriyle doğrulanır.
