# Public yayın kontrol listesi

Hedef: GitHub deposunu ve indirilebilir JobLoop uygulamasını birlikte yayımlamak.
Durum: 28 Eylül 2026, [v0.1.0 public yayında](https://github.com/feritzcan2/jobmaster/releases/tag/v0.1.0).

## Tamamlanan uygulama işleri

- [x] Portal üyelik şifresinin yeni iş sitesi hesapları için kullanıldığı açıklanıyor;
  her adayın kaydı ayrı. Adaylar arası save/update/delete izolasyonu test edildi.
- [x] Yerel ağdaki telefon/web istemcisi, HTTP sunucusu ve QR eşleştirmesi kaldırıldı.
  Uzaktan bildirim ve sorular Telegram üzerinden yönetiliyor.
- [x] TermLoop kaynakları ve terminal paketleri sabit commit, checksum manifesti ve
  lisanslarıyla vendor edildi. Komşu TermLoop deposuna build bağımlılığı kaldırıldı; ayrı temiz checkout’ta bootstrap geçti.
- [x] Paketli Rust engine, kaynak CLI araçları ve Playwright yardımcı yolları eklendi.
- [x] Agent kurulumu/oturumu, Chrome ve isteğe bağlı Bun/Jev ön kontrolleri eklendi.
- [x] Jev anahtarı sistem anahtarlığıyla saklanıyor; açıkça başlatılan bağlantı testi var.
- [x] AI sağlayıcısı, TypeSafe/Jev, Telegram ve iş sitelerine veri aktarımı açıklanıyor.
- [x] Taşınabilir aday/CV/belge yedeği, doğrulamalı geri yükleme, sürümlü veri sözleşmesi,
  yükseltme öncesi otomatik yedek ve prompt/terminal saklama sınırları eklendi.
- [x] Görevler ve diğer veri yazımları sürerken geri yükleme/güncelleme engelleniyor.
- [x] README, katkı ve güvenlik kanalı, gizlilik, lisans, üçüncü taraf ve release belgeleri yazıldı.
- [x] Eski UI smoke metni güncellendi; ana UI, Telegram, puanlama, tarayıcı başlatma,
  onboarding ve yeni ayar ekranları yerel Electron testlerinden geçti.

## Release altyapısı

- [x] Windows x64, Linux x64 ve macOS universal native CI işleri.
- [x] Exact SHA için üç platform CI kanıtı, sabit tag ve main geçmişi kontrolü.
- [x] Zorunlu macOS Developer ID imzası/notarization ve tam artifact kümesi kontrolü.
- [x] GitHub Releases manifestleri ve kullanıcı tarafından başlatılan güncelleme akışı.
- [x] Public PR işleri hosted runner’da; özel runner ve release sırlarına erişmiyor.
- [x] Windows/Linux/macOS native CI geçti: [b4e9fb6 koşusu](https://github.com/feritzcan2/jobmaster/actions/runs/36443400316).
  Her yeni yayın adayının kendi SHA kontrolü release workflow’unda ayrıca zorunlu.
- [x] JobLoop repository secret’larına macOS sertifika ve notarization bilgileri tanımlandı.
- [x] Developer ID imzalı/notarize macOS, Windows EXE ve Linux paketleri aynı release altında yayımlandı.
  [Release workflow’u](https://github.com/feritzcan2/jobmaster/actions/runs/36446383950) üç platformda geçti.
- [x] Repo public açıldı; 13 release dosyasının anonim indirme bağlantısı doğrulandı.
  Paket/source/manifest checksum’ları GitHub asset digest’leriyle eşleşiyor; üç update feed’i yayımlanmış paketlere işaret ediyor.
- [x] Public macOS ZIP indirilip checksum, codesign, stapler ve Gatekeeper kontrollerinden geçirildi.

## Son doğrulamalar

- [x] Yerelde 498 Node testi ve kaynak araçlarının 312 offline testi geçti.
- [x] Ana uygulama üretim bağımlılıkları, altı Bun lockfile’ı ve Rust engine lockfile’ı
  tarandı; bilinen açık bulunmadı. OpenTUI güncellemesi gömülü eski diff kodunu ve
  Jimp/file-type zincirini kaldırdı. CI ve paketleme akışı bu taramaları tekrarlıyor.
- [x] Git geçmişinde Gitleaks v8.30.1 ile gerçek secret eşleşmesi bulunmadı.
- [x] Kaynak snapshot’ı, Git geçmişi ve çıkarılmış macOS paketinde Gitleaks taraması temiz.
  Dar istisnalar yalnız vendor checksum’ları ve sır içermeyen bir boolean ifadesidir.
  Pakette `.env.jev`, gerçek aday verileri ve runtime dosyaları bulunmuyor.
- [ ] Her işletim sisteminde temiz kullanıcı hesabıyla gerçek CLI/Chrome oturumunu doğrula.
- [ ] Küçük harici beta grubuyla ilk profil, arama/başvuru yetkisi, durdurma/devam,
  Telegram ve sürüm yükseltme akışlarını doğrula. Otomatik testler bu adımı tamamlamaz.

## Kararlar ve sınırlar

JobLoop lisansı TermLoop’un GPL-3.0-or-later + ticari lisans modeliyle hazırlandı.
Üçüncü taraf lisansları ayrıca korunur. TermLoop’un mevcut Apple imzalama ve
notarization bilgileri, JobLoop repository anahtarıyla şifrelenerek altı secret olarak
tanımlandı; aktarım dosyası ve geçici dal temizlendi. Windows EXE bu sürümde imzasızdır.
Gerçek aday adına bu hazırlık sırasında harici başvuru yapılmadı.
