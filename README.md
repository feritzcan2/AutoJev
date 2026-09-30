# AutoJev · Web otomasyonları

AutoJev, kişisel web işlerini template ve asistanla kurulan otomasyonlarla yöneten bir
masaüstü uygulamasıdır. İş arama arayüzündeki çalışma alanı seçimi, **Başvurular**
tablosu, Kaynaklar, Agent, Arka plan işleri ve Dosyalar sayfaları korunur. İş arama,
ev arama ve randevu takibi bu ortak düzeni kullanır. Agent ihtiyacını sorularla
öğrenir; profili ve tablo sütunlarını otomasyona göre düzenler. Bütün template’ler
aynı kayıt deposunu, görev kuyruğunu, 1–8 worker altyapısını, Agent terminalini ve tarayıcı yönetimini kullanır. Template soruları, sütunları, durumları ve işlem adımlarını tanımlar.
[Ortak çalışma alanı mimarisi](docs/workspace-architecture.md) geçişi ve template’e
ait kuralları açıklar.

İş arama template’i mevcut JobLoop aday profillerini, CV’leri, başvuruları ve Telegram
bağlantılarını kullanır. Diğer otomasyonlar kendi konuşmasına, kaynaklarına, tarayıcı
ayarlarına, yetkilerine ve sonuç geçmişine sahiptir. Tekrar kullanılabilir template’ler
kaydedilebilir ve JSON dosyasıyla paylaşılabilir. Arayüz Türkçedir.

**Başlangıç:** Yeni çalışma alanı → template seç → Agent ile konuş → profili kaydet → deneme
çalıştır → bir kez veya düzenli çalıştır. Zamanlama için uygulama ve bilgisayar açık
kalmalıdır. [Otomasyon rehberi](docs/automation-templates.md) çalışma modlarını,
denemenin kapsamını ve mevcut sınırları açıklar. Uygulamanın eski adı JobLoop’tur; dağıtım kimliği ve veri
klasörü mevcut JobLoop kurulumlarıyla uyumluluk için korunur.

## Kurulum

[Sürümler](https://github.com/feritzcan2/jobmaster/releases) sayfasındaki işletim
sistemine uygun paketi kullan:

| Sistem | Paket | Mimari |
| --- | --- | --- |
| macOS | DMG / ZIP | Universal: Apple Silicon ve Intel |
| Windows | NSIS kurulum EXE | x64 |
| Linux | AppImage / DEB | x64 |

Güncel sürüm [v0.1.1](https://github.com/feritzcan2/jobmaster/releases/tag/v0.1.1)
yayımlandı. İlk profil hazırlanırken görülen `skills not found` hatası giderildi.
macOS paketi Developer ID imzalı ve notarize edilmiştir; Windows EXE
bu sürümde kod imzası taşımaz. Platform kontrolleri ve kalan beta çalışmaları
[yayın kontrol listesinde](docs/public-release-checklist.md) izlenir.

0.1.0 sürümünde profil hazırlığında kaldıysan uygulamayı kapat, yeni paketi kur ve
yeniden aç. Kayıtlı profil ve CV korunur; hazırlık yeniden denenir.

### Başlamadan önce

1. [Codex CLI](https://github.com/openai/codex) veya
   [Claude Code](https://code.claude.com/docs/en/overview) kur ve kendi hesabınla
   terminalde oturum aç. Sağlayıcı kullanımı hesabının ücret ve veri koşullarına tabidir.
2. Genel web otomasyonları için Google Chrome kur. Agent ayarlarından ayrı tarayıcı
   veya Jev seçebilirsin. Ayrı tarayıcı her otomasyon için kendi profilini açar;
   **Tarayıcıyı aç** düğmesinden hesaplarına giriş yapabilirsin. Jev kullanırken mevcut
   Chrome’da `chrome://inspect/#remote-debugging` bağlantısını aç ve bağlantı
   isteğine izin ver. Agent’ın kendi tarayıcı modunda araçları agent içinde etkinleştir.
3. Jev kullanacaksan **Yapılandırma → Jev** bölümünden TypeSafe API anahtarını
   kaydet ve bağlantıyı test et. Hazır kaynakların CLI araç modu ayrıca **Bun** ister;
   web ve tarayıcı aramaları için Bun gerekmez.
4. **Template’ler** bölümünden başla ve çalışma alanı profilini kontrol et. İş arama
   template’inde aday profilini ve CV’yi ekle; başvuru yetkisini ve tercihleri seç.

Portal üyelik şifresi, o aday adına **yeni iş sitesi hesapları oluşturmak** için
saklanır. Her adayın kaydı ayrıdır. Mevcut bir hesabın şifresi olduğunu varsaymaz.
Telegram kurulumu için [Telegram rehberine](docs/telegram.md) bak.

## Veriler ve güncellemeler

- **Yapılandırma → Veriler ve yedekler → Mevcut veri klasörünü aç** ile
  `jobloop.sqlite` içeren bir AutoJev veri klasörünü seçebilirsin. Uygulama yeniden
  başlar ve sonraki açılışlarda da o klasördeki kayıtları kullanır. Dışa aktarılmış
  yedekler için **Yedekten geri yükle** seçeneğini kullan.
- Profiller, CV’ler ve başvuru geçmişi uygulamanın yerel veri klasöründedir.
  Agent, Jev ve Telegram kullanıldığında ilgili bilgiler dış hizmetlere gönderilir.
  Ayrıntılar: [veri paylaşımı](docs/privacy.md).
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
gerekir. Paket üretiminde Bun da kullanılır.

```sh
git clone https://github.com/feritzcan2/jobmaster.git
cd jobmaster
corepack enable
pnpm bootstrap
pnpm start
```

TermLoop’un gereken Rust modülleri ve terminal paketleri sabit commit ve
SHA-256 manifestiyle `vendor/termloop` içinde bulunur; komşu bir TermLoop deposu
gerekmez. Geliştirmede hazır kaynak CLI araçlarını kullanmak için Bun kurup
`pnpm sources:install` çalıştır. Jev anahtarı uygulamadan kaydedilebilir;
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

Paketleme, native CI ve yayın adımları: [release rehberi](docs/releasing.md).
Katkılar: [CONTRIBUTING](CONTRIBUTING.md).

## Destek ve lisans

Hata bildirimlerini [Issues](https://github.com/feritzcan2/jobmaster/issues)
üzerinden ilet. CV, aday bilgisi, bot token’ı veya ham terminal kaydı paylaşma.
Güvenlik açıkları için [SECURITY](SECURITY.md) içindeki özel kanalı kullan.

AutoJev GPL-3.0-or-later ve ticari lisans seçenekleriyle sunulur; [LICENSE](LICENSE).
Üçüncü taraf bileşenler kendi lisanslarına tabidir: [bildirimler](THIRD_PARTY_NOTICES.md).
