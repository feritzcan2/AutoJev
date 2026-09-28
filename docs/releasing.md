# Release akışı

JobLoop, TermLoop’un exact commit doğrulaması ve üç yerel işletim sistemi build’i
üzerinden yayımlanır. Dağıtım adresi
[GitHub Releases](https://github.com/feritzcan2/jobmaster/releases) sayfasıdır.

## İş akışları

1. `ci.yml`, `main` ve `release/**` push’larında veya elle çalışır. Kaynak/vendor
   kontrolü, secret taraması, JavaScript testleri ve build’i doğrular. Ana uygulama
   üretim bağımlılıkları, altı kaynak aracının Bun lockfile’ları ve Rust engine
   bağımlılıkları ayrıca güvenlik taramasından geçer. Üç platform
   işi Rust testlerini, native paketlemeyi ve paketli uygulamanın açılışını test eder.
   Hatalı bir platform diğerlerinin sonucunu saklamaz (`fail-fast: false`).
2. Fork PR kontrolü GitHub’ın geçici runner’larında, salt okunur yetkiyle çalışır.
   Secret ve özel runner verilmez.
3. `v*` tag’i veya `release.yml` içindeki `tag` girdisi release’i başlatır.
   Tag’in sürümü `package.json` ile uyuşmalı, commit `main` geçmişinde olmalı ve
   **aynı SHA için üç platformun tamamında başarılı CI** bulunmalıdır.
4. macOS universal, Windows x64, Linux x64 paketleri yeniden üretilir. macOS’ta
   Developer ID imzası, notarization, stapler ve universal mimari kontrolleri
   zorunludur. Son paketler yeniden açılarak test edilir.
5. Üç iş de geçince tag ve CI kanıtı tekrar doğrulanır. Tam kaynak arşivi, paketler,
   güncelleme manifestleri ve SHA256SUMS bir GitHub Release’e birlikte yüklenir.
   Yayımlanmış bir sürümün üzerine yazılmaz; düzeltme yeni sürüm gerektirir.

CI’ın imzasız paketleri kısa ömürlü doğrulama artifact’larıdır. Public release
macOS imzası tamamlanmadan yayımlanmaz.

## Runner’lar

Varsayılanlar GitHub hosted `macos-15`, `windows-2025`, `ubuntu-24.04` makineleridir.
Özel runner kurulduğunda repository variable’larına JSON label dizileri gir:

| Variable | Örnek |
| --- | --- |
| `JOBLOOP_MACOS_RUNNER` | `["self-hosted","macOS","ARM64","jobloop-macos"]` |
| `JOBLOOP_WINDOWS_RUNNER` | `["self-hosted","Windows","X64","jobloop-windows"]` |
| `JOBLOOP_LINUX_RUNNER` | `["self-hosted","Linux","X64","jobloop-linux"]` |

Runner’lar **bu repoya** kayıtlı olmalı. TermLoop repository runner’ları otomatik
olarak JobLoop işlerini alamaz. Özel runner’ları güvenilmeyen PR koduna açma.
Linux kurulum adımı `apt-get` için sudo ister; özel makineleri buna göre hazırla.

## İmzalama ayarları

`production` GitHub environment’ı veya repository secret’ları:

| Secret | İçerik |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | Developer ID Application sertifikası ve özel anahtarının P12 export’u, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | P12 parolası |
| `MACOS_SIGNING_IDENTITY` | Tam Developer ID Application kimliği |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple notarization hesabı |
| `MACOS_API_KEY_BASE64`, `MACOS_API_KEY_ID`, `MACOS_API_ISSUER` | Apple ID yerine kullanılabilen App Store Connect API anahtarı |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | İsteğe bağlı Windows imzalama sertifikası ve parolası |

TermLoop’taki `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD` ve
`APPLE_SIGNING_IDENTITY` değerleri kullanılıyorsa JobLoop’ta yukarıdaki `MACOS_*`
adlarına eşlenmelidir. Secret değerlerini issue, log veya kaynak dosyasına yazma.
Sertifika geçici ve yalnızca bu işe ait keychain’e alınır; adım sonunda temizlenir.
Windows sertifikası sağlanmazsa EXE imzasızdır; release notunda bunu belirt.

## İlk yayın / sonraki sürüm

1. `package.json` ve `engine/Cargo.toml` sürümlerini eşleştir; lockfile’ı güncelle.
   Veritabanı sözleşmesi değiştiyse schema sürümünü de artır.
2. [Public kontrol listesini](public-release-checklist.md) ve gizlilik metnini
   gözden geçir. Commit’i `main` üzerine gönder.
3. O commit’in CI’ının üç platformda başarılı bitmesini bekle. Başka commit’in
   sonucu veya yalnızca yerel testler release kapısını geçirmez.
4. Onaylanan SHA’yı `v0.1.0` gibi sabit bir tag ile işaretleyip gönder:

   ```sh
   git tag -a v0.1.0 <onaylanan-sha> -m 'JobLoop 0.1.0'
   git push origin v0.1.0
   ```

5. `release.yml` sonucunu, tam artifact listesini, checksum’ları ve sürümler
   sayfasındaki indirme bağlantılarını kontrol et. Tag’i başka commit’e taşıma.

## Yerel doğrulama

```sh
pnpm bootstrap
pnpm check
pnpm test
node scripts/audit-dependencies.mjs
pnpm package:ci
pnpm test:packaged
```

Linux’ta son komutu `xvfb-run -a pnpm test:packaged` ile çalıştır. Yerel imzasız
paketleme Apple hesabı gerektirmez. Release paketleri imzalı workflow’dan üretilir.
Kaynak araçları paketlenirken güvenlik taraması, altı CLI’ın yardım/hata sözleşmeleri
ve ağ kullanmayan arama/ilan detayı fixture’ları yeniden çalışır.
Native smoke; ayrı çalışma dizininden açılışı, paketli Rust engine/skills/MCP
yardımcısını ve yeniden açılışta verinin korunmasını kontrol eder. Gerçek sağlayıcı
hesabı veya iş başvurusu kullanmaz.

Uygulama içi güncelleme yalnızca kullanıcı isteğiyle kontrol edilir ve indirilir.
Kurulumdan önce çalışan görevler durdurulmuş olmalı; aynı kurulum için kurtarma
yedeği alınır. Yeni sürüm ilk açılışta veri/schema sürümünü kontrol eder; daha yeni
schema’yı eski uygulamayla açmayı reddeder.

## Beta kabulü

CI tamamlandıktan sonra temiz kullanıcı hesabıyla her sistemde: CLI oturumu,
Chrome izinleri, ilk aday/CV, ilan arama, hazırlık, durdurma/devam, Telegram eşleşme,
yedekleme/geri yükleme ve önceki sürümden güncelleme doğrulanmalıdır. Gerçek
başvuru yalnızca adayın açık yetkisiyle yapılır. Harici kullanıcı beta sonucunu
otomasyon sonucu olarak işaretleme.
