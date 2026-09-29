# Kurulum, deneme ve takip deneyimi

Eski Agent sayfası ve terminal bileşeni korunur. `automation-progress.mjs` kayıtlı çalışma sonucundan tek bir durum görünümü üretir. Sayfa başlığı, ana düğme, ilerleme adımları ve terminalin sonuç alanı bu görünümü kullanır.

- Kurulum konuşması bittiğinde eksik cevaplar veya profili inceleyip kaydetme adımı gösterilir. Agent'ın güncel yanıtı terminalin dışında okunabilir.
- Kaydedilen profil için açıkça **Denemeyi başlat** denir. Denemenin kaynak okuma kontrolü olduğu açıklanır.
- Deneme sonucu kaydedilip süreç henüz kapanmadıysa **Oturum kapanıyor** görünür. Yeni çalışma başlatılmaz.
- Başarısız denemede engel özeti ve düzeltme seçenekleri görünür. Arka arkaya başarısız denemeler, agent ile engeli çözme adımını öne çıkarır.
- Başarılı denemeden sonra **Bir kez çalıştır** ve **Düzenli takibi başlat** ayrı işlemlerdir. Tek turun bitmesi, takibin veya hedefin tamamlanması anlamına gelmez.
- Terminal yalnızca oturum açıkken görünür. Oturum bitince durum özeti ve sonraki adım görünür kalır; eski çıktıya çalışma geçmişinden erişilir.
- Yanıt alanı deneme veya takip turu bittikten sonra da erişilebilir kalır. Kullanıcı buradan soruları yanıtlayıp yeni konuşma turu açar. Eski bir konuşmanın yanıtı yeni turun sonucu olarak gösterilmez.

## Doğrulama

`tests/automation-progress.test.mjs` eksik bilgi, profil incelemesi, başarısız/başarılı deneme, kapanış, paralel çalışma, tekrar eden engel ve takip durumlarını sınar.

`scripts/smoke-automations.mjs` gerçek Electron, IPC, MCP, SQLite ve yerel Chrome sayfasıyla bu geçişleri kontrol eder. Sağlayıcı yanıtları kontrollüdür; dış sitelerde mesaj veya başvuru göndermez. Eski iş arama ve çoklu worker ekranları kendi Electron kontrolleriyle doğrulanır.
