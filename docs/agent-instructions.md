# Agent talimatları

**Agent → Talimatlar** seçili çalışma alanının kurallarını ve oturum kayıtlarını
gösterir. İş başvurusu uzantısı yüklenmeden de çalışır.

- **Talimat parçaları:** sistem dosyaları, template, kayıtlı kriterler ve son
  konuşma mesajları. Kaynak ve metin filtresi kullanılabilir. Kaydedilen en son
  içerikle güncel içerik farklıysa kart bunu gösterir. Worker ve oturum filtresi
  karşılaştırmanın kapsamını belirler.
- **Gönderim geçmişi:** başlangıç ve devam mesajları, sağlayıcının teslim
  bildirimleri, oturumda erişilebilir dosyalar, sunulan MCP araç tanımları ve
  dönen bağlam/tarayıcı yanıtları. Bir olayı açınca o andaki metin görüntülenir;
  bugünkü ayarlardan yeniden oluşturulmaz. Daha eski olaylar sayfalanır.

Dosya görüntüsü bir okuma kanıtı değildir. Başlatma/mesaj isteğinin kabul edilmesi
modelin mesajı okuduğu veya uyguladığı anlamına gelmez. Terminal tuşları,
sağlayıcının kendi sistem talimatları, modelin düşünceleri ve başka MCP
sunucularının yanıtları kaydedilmez. Özellikten önceki oturumlar için geçmiş
üretilmez. Geçmiş araması yüklenen olay başlıkları ve parça adları üzerindedir;
tam metin her olayın içinde açılır.

Kayıtlar yerel `workspace_instruction_events` tablosunda tutulur (şema 6).
30 gün, çalışma alanı başına 500 ve toplam 2.000 olay sınırı vardır. Her olayın
metni toplam 128.000 karakterle sınırlıdır; kesilen parçalar açıkça belirtilir.
Görsel/ses çıktılarının ikili içeriği kaydedilmez. Bilinen yapılandırılmış sır
alanları gizlenir ve kimlik bilgisi araçlarının sonuçları alınmaz. Kullanıcının
veya sayfanın serbest metnine yazılmış sırlar otomatik ayıklanmış sayılmaz.

**Veriler ve yedekler → Logları temizle** bu geçmişi de temizler. Çalışma alanı
silinince ilişkili geçmiş silinir. Taşınabilir yedeklerden çıkarılır; geri yükleme
eski oturum geçmişini temizler. Yerel kurtarma yedekleri kendi saklama kurallarına
tabidir.

Doğrulama: `node --test tests/instruction-log.test.mjs` ve
`pnpm build && pnpm test:instructions`. Electron testi geçici veri kullanır;
gerçek AI sağlayıcısı başlatmaz ve dış sitelere işlem göndermez.
