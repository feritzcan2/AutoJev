# AutoJev · Web otomasyonları

AutoJev, kişisel web işlerini template ve asistanla kurulan otomasyonlarla yöneten bir
masaüstü uygulamasıdır. İş arama arayüzündeki çalışma alanı seçimi, **Başvurular**
tablosu, Kaynaklar, Agent, Arka plan işleri ve Dosyalar sayfaları korunur. İş arama,
ev arama ve randevu takibi bu ortak düzeni kullanır. Agent ihtiyacını sorularla
öğrenir; profili ve tablo sütunlarını otomasyona göre düzenler. Bütün template’ler
aynı kayıt deposunu, görev kuyruğunu, 1–8 worker altyapısını, Agent terminalini ve tarayıcı yönetimini kullanır. Template soruları, sütunları, durumları ve işlem adımlarını tanımlar.

İş arama template’i mevcut JobLoop aday profillerini, CV’leri, başvuruları ve Telegram
bağlantılarını kullanır. Diğer otomasyonlar kendi konuşmasına, kaynaklarına, tarayıcı
ayarlarına, yetkilerine ve sonuç geçmişine sahiptir. Tekrar kullanılabilir template’ler
kaydedilebilir ve JSON dosyasıyla paylaşılabilir. Arayüz Türkçedir.

**Kaynaklar → Listeden ekle** ile yerleşik katalogdan, public JSON adresinden veya
dosyadan kaynak seçebilirsin. Her kaynak düzenlenebilir bir çalışma talimatı ve
isteğe bağlı bir skill metni taşır. Agent kaynak talimatını okur ve kaynağı Jev ile
yönetilen Chrome üzerinden tarar. Kaynakları
**Dışa aktar** ile paylaşabilirsin; sorgular ve çalışma geçmişi dışa aktarılmaz.
[Kaynak listesi ve katkı biçimi](source-library/README.md).

**Başlangıç:** Yeni çalışma alanı → template seç → Agent ile konuş → profili kaydet →
bir kez veya düzenli çalıştır. Her kaynağın ilk turu otomatik denemedir. Agent arama,
sayfalama, detay okuma ve erişimi Jev ile yönetilen Chrome üzerinden kontrol eder;
sonraki turlar güncel kriterlerle normal taramayı yapar. Zamanlama için uygulama ve bilgisayar açık
kalmalıdır. Uygulamanın eski adı JobLoop’tur; dağıtım kimliği ve veri
klasörü mevcut JobLoop kurulumlarıyla uyumluluk için korunur.

## Kurulum

[Sürümler](https://github.com/feritzcan2/AutoJev/releases) sayfasındaki işletim
sistemine uygun paketi kullan:

| Sistem | Paket | Mimari |
| --- | --- | --- |
| macOS | DMG / ZIP | Universal: Apple Silicon ve Intel |
| Windows | NSIS kurulum EXE | x64 |
| Linux | AppImage / DEB | x64 |

Güncel sürüm [v0.1.2](https://github.com/feritzcan2/AutoJev/releases/tag/v0.1.2)
yayımlandı. Ortak çalışma alanları, otomasyon şablonları ve yayın hazırlığında
toplanan yerel değişiklikleri (`1320b7e`) içerir.
macOS paketi Developer ID imzalı ve notarize edilmiştir; Windows EXE
bu sürümde kod imzası taşımaz. Bu yayında istek üzerine testler çalıştırılmadı; native derleme, imzalama ve
paket bütünlüğü kontrolleri uygulandı.

0.1.0 sürümünde profil hazırlığında kaldıysan uygulamayı kapat, yeni paketi kur ve
yeniden aç. Kayıtlı profil ve CV korunur; hazırlık yeniden denenir.

### Başlamadan önce

1. [Codex CLI](https://github.com/openai/codex) veya
   [Claude Code](https://code.claude.com/docs/en/overview) ya da
   [OpenCode](https://opencode.ai) (1.18.33–1.x) kur ve kendi hesabınla
   terminalde oturum aç. Sağlayıcı kullanımı hesabının ücret ve veri koşullarına tabidir.
2. Genel web otomasyonları için Google Chrome kur. Agent ayarlarından ayrı tarayıcı
   veya Jev seçebilirsin. Ayrı tarayıcı her otomasyon için kendi profilini açar;
   **Tarayıcıyı aç** düğmesinden hesaplarına giriş yapabilirsin. Jev kullanırken mevcut
   Chrome’da `chrome://inspect/#remote-debugging` bağlantısını aç ve bağlantı
   isteğine izin ver. Agent’ın kendi tarayıcı modunda araçları agent içinde etkinleştir.
3. Jev kullanacaksan **Yapılandırma → Jev** bölümünden TypeSafe API anahtarını
   kaydet ve bağlantıyı test et. Kaynaklar seçili tarayıcı üzerinden taranır.
4. **Template’ler** bölümünden başla ve çalışma alanı profilini kontrol et. İş arama
   template’inde aday profilini ve CV’yi ekle; başvuru yetkisini ve tercihleri seç.

Portal üyelik şifresi, o aday adına **yeni iş sitesi hesapları oluşturmak** için
saklanır. Her adayın kaydı ayrıdır. Mevcut bir hesabın şifresi olduğunu varsaymaz.

## Otomatik CAPTCHA çözümü

**Yapılandırma → CAPTCHA** bölümünde CapSolver API anahtarını kaydet, bağlantı ve
bakiyeyi kontrol et, otomatik çözümü aç. Günlük çözüm isteği sınırı bütün çalışma
alanları için ortaktır; UTC gününde yenilenir ve uygulama yeniden açıldığında korunur.
Görsel CAPTCHA’nın her yeni turu ayrı bir istek sayılır.

Uygulama görünür ve aktif doğrulamayı kontrol eder; yalnızca script, gizli widget
veya eski hata metni için ücretli istek göndermez. reCAPTCHA v2 görsel seçimi,
uygun reCAPTCHA v2/Turnstile token akışları ve cevap alanıyla açıkça ilişkilendirilmiş
CAPTCHA yazı görselleri desteklenir. Çözüm aynı sekmede sürer; diğer worker’lar
çalışmaya devam eder. Görev durdurulursa veya sayfa değişirse eski cevap uygulanmaz.

Otomatik çözüm açıkken, okuma sekmelerindeki tam sayfa doğrulama da incelenir.
Görünür, aktif Turnstile widget’ının sitekey’i ve sonuç callback’i doğrulanırsa
CapSolver token API’si kullanılır. Explicit render parametreleri sayfa yüklenirken
yakalanır; mevcut bir sayfanın kaçırılmış parametreleri tahmin edilmez ve otomatik
yenileme yapılmaz. Cevap yalnızca form içermeyen okuma sekmesinin doğrulama
callback’ine bir kez verilir. API cevabından sonra engelin kalkması ve sayfa
içeriğinin okunması ayrıca doğrulanır. Beklerken diğer worker’lar kuyrukta tutulmaz.

API bilgisi eksikse görünür Cloudflare kutusu bir kez denenebilir; bu yerel deneme
ücretli API isteği göndermez. Cloudflare’ın `chlPageData` gerektiren managed
Challenge akışı Turnstile API’sine gönderilmez; proxy/clearance entegrasyonu
desteklenmiyorsa nedeni bildirilir. Gerçek istek sınırlarında ortak bekleme korunur.

Gönderim yapabilecek formlar mevcut işlem yetkisini gerektirir. API cevabı tek
başına sitenin doğrulamayı kabul ettiğini göstermez. Desteklenmeyen bulmacalar,
devam eden tam sayfa erişim engelleri ve kabul edilmeyen cevaplar için mevcut sekmede müdahale
istenir. Anahtar şifreli saklanır ve taşınabilir yedeklere alınmaz. CAPTCHA görselleri
ve geçici çözüm bilgileri RAM’de tutulur; çözüm sırasında ilgili bilgiler CapSolver’a
gönderilir.

## Veriler ve güncellemeler

- **Yapılandırma → Veriler ve yedekler → Mevcut veri klasörünü aç** ile
  `jobloop.sqlite` içeren bir AutoJev veri klasörünü seçebilirsin. Uygulama yeniden
  başlar ve sonraki açılışlarda da o klasördeki kayıtları kullanır. Dışa aktarılmış
  yedekler için **Yedekten geri yükle** seçeneğini kullan.
- Profiller, CV’ler ve başvuru geçmişi uygulamanın yerel veri klasöründedir.
  Agent, Jev ve Telegram kullanıldığında ilgili bilgiler dış hizmetlere gönderilir.
- **Yapılandırma → Veriler ve yedekler** ile adayları ve belgeleri dışa aktarabilir,
  yedekten geri yükleyebilirsin. Uygulamanın kaydettiği şifreler ve API anahtarları
  taşınabilir yedekten çıkarılır; metinlere elle yazılmış sırlar ayıklanmaz.
  Kişisel veriler içerdikleri için yedekler güvenli bir yerde saklanmalıdır.
- **Güncellemeler** bölümünden kontrol ve indirme başlatılır. Kurulumdan önce
  görevleri durdurman istenir ve otomatik yedek alınır. Linux DEB kurulumları
  sürümler sayfasından güncellenir; uygulama içi güncelleme AppImage içindir.

## Kaynak koddan çalıştırma

Gereksinimler: Node.js 22.22.3+, pnpm 10.14.0, Rust 1.90.0, işletim sisteminin
yerel derleme araçları. Windows’ta MSVC araçları, macOS’ta Xcode Command Line Tools
gerekir.

```sh
git clone https://github.com/feritzcan2/AutoJev.git
cd AutoJev
corepack enable
pnpm bootstrap
pnpm start
```

TermLoop’un gereken Rust modülleri ve terminal paketleri sabit commit ve
SHA-256 manifestiyle `vendor/termloop` içinde bulunur; komşu bir TermLoop deposu
gerekmez. Jev anahtarı uygulamadan kaydedilebilir;
geliştirme alternatifi `.env.jev.example` dosyasıdır. Gerçek anahtarları Git’e ekleme.

```sh
pnpm vendor:verify
pnpm check
pnpm test
pnpm build
pnpm engine:build
pnpm test:ui
pnpm test:automations
pnpm test:automations:jev
```

Katkılar: [CONTRIBUTING](CONTRIBUTING.md).

## Destek ve lisans

Hata bildirimlerini [Issues](https://github.com/feritzcan2/AutoJev/issues)
üzerinden ilet. CV, aday bilgisi, bot token’ı veya ham terminal kaydı paylaşma.
Güvenlik açıkları için [SECURITY](SECURITY.md) içindeki özel kanalı kullan.

AutoJev GPL-3.0-or-later ve ticari lisans seçenekleriyle sunulur; [LICENSE](LICENSE).
Üçüncü taraf bileşenler kendi lisanslarına tabidir: [bildirimler](THIRD_PARTY_NOTICES.md).

### OpenCode

Agent ayarlarında OpenCode seçilebilir. TermLoop ile aynı OpenCode Go modelleri,
`default`, `plan` ve `bypassPermissions` izinleri kullanılır. Oturum devamı,
MCP araçları ve agent talimatları desteklenir. Kurulum için `opencode auth login`
kullanılır; durum takibi OpenCode 1.18.33–1.x gerektirir. OpenCode v2’nin başlatma
ayarları tanınır; durum takibi ve oturum devamı bulunmadığı için v2 henüz
AutoJev otomasyonlarında kullanılamaz.
OpenCode kendi context sıkıştırmasını yönetir; AutoJev context eşikleri ve
yerel metin konuşma dökümü şu anda Claude/Codex içindir. OpenCode konuşması
agent terminalinde görüntülenir.

Yerel model taklidiyle gerçek CLI/MCP testi: `pnpm engine:build && node scripts/smoke-opencode.mjs`.
