# İzmir → Yunanistan vize randevusu: canlı test

Tarih: 29 Eylül 2026

## Sonuç

Temiz bir uygulama profiliyle, gerçek Codex sağlayıcısı ve Chrome kullanılarak
otomasyon oluşturuldu. Agent kaynakları kendisi araştırdı, kurulum kartını doldurdu
ve gerçek kaynaklarda deneme yapıldı. **Randevu takvimine erişim doğrulanamadı:**
Kosmos, HTTP 403 ve Cloudflare “Sorry, you have been blocked” sayfası gösterdi.

Bu nedenle doğrulanmış boş randevu sayısı **0**, müsaitlik durumu **bilinmiyor**.
Deneme `blocked`, kayıtlı deneme sonucu `failed`. Düzenli takip etkinleştirilmedi;
hem “Şimdi çalıştır” hem “Düzenli çalıştır” düğmelerinin kapalı olduğu doğrulandı.
Bu kayıt, randevuların dolu olduğunu veya çalışan bir randevu izleyicisi kurulduğunu
göstermiyor. Rezervasyon, ödeme, başvuru formu gönderimi ve hesap oluşturma yapılmadı.

## Test senaryosu

- Test varsayımı: 1 kişi, turistik Schengen vizesi, yalnızca İzmir merkezi.
- Seyahat tarihi belirtilmedi; gözlenebilen tüm gelecek randevu tarihleri hedeflendi.
- Yetki: bul ve bildir. Planlanan kontrol aralığı: 30 dakika.
- Gerçek kimlik, pasaport, ikamet ve hesap bilgileri girilmedi.
- Otomasyon adı: **İzmir Yunanistan turistik vize randevu takibi**.
- Mevcut uygulamalar ve kullanıcı agent’ları açık bırakıldı; test ayrı veri dizininde yapıldı.

## Gerçek akış

1. Boş profilde **Randevu takibi** template’i seçildi.
2. Sohbete hedef ve test kriterleri yazıldı; kaynak adresi verilmedi.
3. Agent, yönetilen tarayıcıyla arama yaptı ve yedi araştırma adımı yürüttü.
4. [İzmir Başkonsolosluğunun vize sayfasında](https://www.mfa.gr/turkey/tr/visas.html?mission=smy)
   Kosmos yönlendirmesini gözlemledi. [Kosmos](https://kosmosvize.com.tr/) erişimi engellendi.
5. Agent amaç, kriter, kaynak ve işleyişi kaydetti; engeli kullanıcı mesajında açıkladı.
6. Kurulum kartı test kapsamında kaydedildi; **Deneme çalıştır** seçildi.
7. İki kaynak yeniden okundu. Konsolosluk sayfası erişilebilirdi; Kosmos yine HTTP 403 verdi.
8. Agent iki deneme gözlemi kaydetti, takvim müsaitliğini bilinmiyor olarak bıraktı ve
   denemeyi engellenmiş olarak bitirdi. Uygulama düzenli çalışmaya izin vermedi.

Gerçek sağlayıcı çalıştırmasında model yanıtları, MCP yanıtları ve sayfalar taklit edilmedi.
O tarihteki yerel form testi, daha sonra kaldırılan `scripts/smoke-automations.mjs` ile çalıştırıldı;
o testte yalnızca sağlayıcı çağrıları kontrollü girdiler kullanır.

## Bu test sırasında düzeltilenler

- Kurulum görüşmesine, en fazla 12 adımlık kaynak araştırması eklendi. Araştırma sadece
  gezinme ve okuma yapar; form etkileşimi ve otomatik etkinleştirme yetkisi vermez.
- Provider oturumunda yalnızca uygulamanın adını açıkça verdiği MCP araçları onaylanır.
  Uygulamanın kaynak, işlem izni, deneme, günlük limit ve tekrar gönderim kontrolleri
  her çağrıda uygulanır. Global provider ayarları değiştirilmez. Codex için kullanılan
  araç bazındaki ayar [resmî yapılandırma referansında](https://developers.openai.com/codex/config-reference)
  açıklanır; mevcut TermLoop başlatma desteği kullanıldı.
- Plan aracının kriter anahtarları template alanlarıyla sınırlandı. Ortak şema
  nesnesinin URL ve mesaj alanlarını yanlışlıkla kısıtlaması düzeltildi ve test edildi.

## Doğrulama

- JavaScript test paketi: 530 test başarılı.
- Rust engine: 4 test başarılı; derleme başarılı.
- Electron + Chrome yerel otomasyon testi: başarılı.
- Kod kontrolü ve `git diff --check`: başarılı.
- Canlı test: kurulum başarılı, takvim erişimi engellenmiş. Bulunan randevu yokluğu
  veya randevu alma yeteneği hakkında başarı iddiası yok.

## Kaydedilen çıktı ve devam koşulu

Uygulamada otomasyon, görüşmeler, deneme gözlemleri ve aynı amaç için kişisel bir
template kayıtlı bırakıldı. Taşınabilir başlangıç template’i:
[izmir-greece-visa.loop-template.json](examples/izmir-greece-visa.loop-template.json).
Bu dosya kaynaklara erişim veya başarılı deneme vermez; yeni kurulumlar yeniden
inceleme ve deneme gerektirir.

Devam edebilmek için resmi Kosmos sitesine normal şekilde erişim sağlanmalı ve
randevu sonuç sayfasının erişilebilir adresi belirlenmeli. Giriş gerekiyorsa kullanıcı
görünür tarayıcıda yapmalı. Sonrasında gerçek takvim için yeni bir deneme yapılmalı;
başarılı olmadan düzenli takip etkinleştirilmemeli. Bir sonraki aşama, takvimin hangi
arama alanlarını ve bilgileri gerektirdiğine bağlıdır; mevcut gözlem denemesi form
doldurma veya düğme tıklama gerektiren takvimleri henüz doğrulamış değildir.
