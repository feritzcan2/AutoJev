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

Veri biçimi değişiyorsa `app/data-management-schema.mjs` sürümünü artır;
eski verinin yedeklenmesi, yükseltilmesi ve geri yüklenmesi için test ekle.
Kaynak depo bağlantılarını ve vendor lisanslarını koru; `vendor/termloop` dosyalarını
elle değiştirip checksum doğrulamasını atlama.

CI üç işletim sisteminde exact commit’i doğrular. Public release için aynı commit’in
başarılı CI kanıtı gerekir. Fork PR’ları özel runner veya release secret’larına erişmez.
