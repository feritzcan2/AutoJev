# Public yayın kontrol listesi

Hedef: GitHub deposunu ve indirilebilir JobLoop uygulamasını birlikte yayımlamak.
Durum: 28 Eylül 2026, ilk public sürüm hazırlığı.

## Tamamlanan uygulama işleri

- [x] Portal üyelik şifresinin yeni iş sitesi hesapları için kullanıldığı açıklanıyor;
  her adayın kaydı ayrı. Adaylar arası save/update/delete izolasyonu test edildi.
- [x] Yerel ağdaki telefon/web istemcisi, HTTP sunucusu ve QR eşleştirmesi kaldırıldı.
  Uzaktan bildirim ve sorular Telegram üzerinden yönetiliyor.
- [x] TermLoop kaynakları ve terminal paketleri sabit commit, checksum manifesti ve
  lisanslarıyla vendor edildi. Komşu TermLoop deposuna build bağımlılığı kaldırıldı.
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
- [ ] Son commit’in Windows/Linux/macOS native CI’ını tamamla ve kanıt bağlantısını kaydet.
- [ ] JobLoop repo/environment’ına macOS sertifika ve notarization secret’larını tanımla.
- [ ] İmzalı macOS, Windows ve Linux build’lerini aynı release altında yayımla.
- [ ] Repo görünürlüğünü public yap ve anonim indirme/kurulum bağlantılarını doğrula.

## Son doğrulamalar

- [x] Yerelde 489 Node testi geçti; üretim bağımlılık audit’inde bilinen açık yok.
- [x] Git geçmişinde Gitleaks v8.30.1 ile gerçek secret eşleşmesi bulunmadı.
- [ ] Son kaynak snapshot’ı ve paket içeriğini tekrar tara; yalnız checksum false-positive
  istisnasını kullan. `.env.jev`, gerçek aday verileri ve runtime dosyaları yayımlanmaz.
- [ ] Her işletim sisteminde temiz kullanıcı hesabıyla gerçek CLI/Chrome oturumunu doğrula.
- [ ] Küçük harici beta grubuyla ilk profil, arama/başvuru yetkisi, durdurma/devam,
  Telegram ve sürüm yükseltme akışlarını doğrula. Otomatik testler bu adımı tamamlamaz.

## Kararlar ve sınırlar

JobLoop lisansı TermLoop’un GPL-3.0-or-later + ticari lisans modeliyle hazırlandı.
Üçüncü taraf lisansları ayrıca korunur. Apple imzalama hesabı/sertifikası seçimi ve
secret kurulumu henüz tamamlanmadı. Windows sertifikası verilmezse EXE imzasızdır.
Gerçek aday adına bu hazırlık sırasında harici başvuru yapılmadı.
