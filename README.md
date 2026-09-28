# JobLoop

JobLoop, aday profillerini ve iş başvurularını Codex veya Claude Code ile yöneten
bir masaüstü uygulamasıdır. İlan arama, puanlama, başvuru hazırlığı ve başvurular
aynı adayın worker’ları arasında paylaşılır. Bekleyen sorular ve bildirimler
isteğe bağlı Telegram botları üzerinden yönetilir. Arayüz Türkçedir.

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
2. Chrome tabanlı tarayıcı modları için Google Chrome kur. Jev kullanırken mevcut
   Chrome’da `chrome://inspect/#remote-debugging` bağlantısını aç ve bağlantı
   isteğine izin ver. Agent’ın kendi tarayıcı modunda araçları agent içinde etkinleştir.
3. Jev kullanacaksan **Yapılandırma → Jev** bölümünden TypeSafe API anahtarını
   kaydet ve bağlantıyı test et. Hazır kaynakların CLI araç modu ayrıca **Bun** ister;
   web ve tarayıcı aramaları için Bun gerekmez.
4. **Kurulum kontrolü** bölümünü aç, aday profilini ve CV’yi ekle. Başvuru
   yetkisini, tercihleri ve aday bilgilerini kontrol et.

Portal üyelik şifresi, o aday adına **yeni iş sitesi hesapları oluşturmak** için
saklanır. Her adayın kaydı ayrıdır. Mevcut bir hesabın şifresi olduğunu varsaymaz.
Telegram kurulumu için [Telegram rehberine](docs/telegram.md) bak.

## Veriler ve güncellemeler

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
```

Paketleme, native CI ve yayın adımları: [release rehberi](docs/releasing.md).
Katkılar: [CONTRIBUTING](CONTRIBUTING.md).

## Destek ve lisans

Hata bildirimlerini [Issues](https://github.com/feritzcan2/jobmaster/issues)
üzerinden ilet. CV, aday bilgisi, bot token’ı veya ham terminal kaydı paylaşma.
Güvenlik açıkları için [SECURITY](SECURITY.md) içindeki özel kanalı kullan.

JobLoop GPL-3.0-or-later ve ticari lisans seçenekleriyle sunulur; [LICENSE](LICENSE).
Üçüncü taraf bileşenler kendi lisanslarına tabidir: [bildirimler](THIRD_PARTY_NOTICES.md).
