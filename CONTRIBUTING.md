# Katkı geliştirme

Kurulum için [README](README.md).

Değişikliğin davranışını ve ilgili doğrulamayı PR açıklamasına yaz. Testlerde
sentetik aday, iş ilanı ve anahtar kullan; gerçek sitelere başvuru gönderen testleri
CI’a bağlama. Eşzamanlı worker’ların görev, tarayıcı sekmesi ve aday kapsamını koru.

```sh
pnpm vendor:verify
pnpm check
pnpm test
pnpm build
cargo test --locked --manifest-path engine/Cargo.toml --target-dir engine/target
```

Arayüz değişikliğinde ilgili `scripts/smoke-*.mjs` senaryosunu çalıştır ve ekranı
kontrol et. Paketleme değişikliğinde kendi işletim sisteminde `pnpm package:ci`
ve `pnpm test:packaged` çalıştır. Linux’ta arayüz testleri için Xvfb gerekir.

## Kod düzeni

`app/main.mjs` uygulamayı kurar; diğer modüller sorumluluklarına göre klasörlerdedir:

| Klasör | İçerik |
| --- | --- |
| `workspaces/` | Çalışma alanları, depolama, zamanlayıcı, belgeler |
| `automation/` | Agent turları: worker, araç çağrıları, görev bağlamı, kurtarma |
| `sources/` | Kaynak tarama, reçeteler, toplayıcılar, deneme turları |
| `records/` | Kayıtlar, kimlik, kayıt işlemleri (hazırla/uygula) |
| `scoring/` | Puanlama politikası, eşikler, puan kaydı |
| `jev/` | Jev: sayfa okuma, kararlar, form doldurma, görev kuyruğu |
| `browser/` | Chrome bağlantısı, sekmeler, kanıt, site erişim bekleme |
| `captcha/` | Doğrulama sayfaları ve çözücüler |
| `agents/` | Claude/Codex/OpenCode oturumları, bağlam, araç sunucusu |
| `channels/` | Bildirim kanalları (Telegram) |
| `templates/` | Şablon sözleşmesi ve kataloğu; `job-search/` iş aramaya özgü her şey |
| `site-extensions/` | Siteye özgü okuyucular (yalnızca kullanıcı isteğiyle) |
| `system/` | Ayarlar, yedekleme, güncelleme, bakım |

İş aramaya özgü yeni metin ve kurallar çekirdek klasörlere değil
`templates/job-search/` altına eklenir. Biçim `pnpm format` ile korunur; başında
`// @ts-check` olan dosyalar `pnpm check` içinde tip denetiminden geçer.

Veri biçimi değişiyorsa `app/system/data-management-schema.mjs` sürümünü artır;
eski verinin yedeklenmesi, yükseltilmesi ve geri yüklenmesi için test ekle.
Kaynak depo bağlantılarını ve vendor lisanslarını koru; `vendor/termloop` dosyalarını
elle değiştirip checksum doğrulamasını atlama.

CI üç işletim sisteminde exact commit’i doğrular. Public release için aynı commit’in
başarılı CI kanıtı gerekir. Fork PR’ları özel runner veya release secret’larına erişmez.
