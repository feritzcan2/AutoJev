# Almanya’da ev bulma: canlı test

Tarih: 29 Eylül 2026

## Sonuç

Boş uygulama profili, gerçek Codex sağlayıcısı ve otomasyona ayrılmış Chrome ile
**Berlin kiralık daire takibi — test** oluşturuldu. Kaynak araştırması, kurulum
kartı, okuma denemesi ve ilk normal tarama başarıyla tamamlandı. Sağlayıcı yanıtları
ve web sayfaları taklit edilmedi. Mevcut uygulama pencereleri açık bırakıldı.

İlk normal turda 7 liste sayfası ve 53 adayın detay sayfası okundu:

| Kaynak | Listelenen ilan | Kaydedilen aday |
| --- | ---: | ---: |
| [Gewobag](https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/) | 86 | 48 |
| [GESOBAU](https://www.gesobau.de/mieten/wohnungssuche/) | 11 | 5 |
| Toplam | 97 | 53 |

44 ilan oda veya ilan edilen kira sınırından elendi. 24 adayda özel kişisel
uygunluk şartı görülmedi; 29 aday WBS, gelir, hane büyüklüğü veya yaş şartına bağlı.
Kullanıcının kişisel uygunluğu doğrulanmadı. Elektrik, internet ve bazı sıcak su,
mutfak devri veya tadilat giderleri bilinmediğinden bütün masraflar dahil kesin
bütçe uyumu iddia edilmedi. Kamuya açık ilan, kiralama veya müsaitlik garantisi değildir.

## Test varsayımları ve çalışma

- Konum: Berlin, bütün semtler. Almanya genelindeki başka şehirler bu turda taranmadı.
- En az 2 oda; bağımsız kiralık daire; en fazla 1.500 € ilan edilen Warmmiete.
- Taşınma tarihi esnek. WG, takas ve satın alma ilanları kapsam dışında.
- Şehir, bütçe ve oda sınırı test varsayımlarıdır; kullanıcı henüz kişiselleştirmedi.
- Yetki: **Bul ve bildir**. Hesap açma, form gönderme, başvuru ve ev sahibine mesaj yok.
- 30 dakikalık yerel takip etkin. İlk tur 60 tarayıcı adımıyla yaklaşık 8 dakikada bitti.
- Tur sonunda durum `enabled`, çalışma `completed`; sonraki kontrol 29.09.2026
  13:51 Europe/Istanbul olarak kaydedildi. Uygulama açık ve bilgisayar uyanık olmalı.

Bu zamanlar testin bitimindeki durumu gösterir; daha sonraki turların başarısını
veya ilanların halen erişilebilir olduğunu garanti etmez.

## Doğrulananlar

1. **Ev arama** template’i boş profilden seçildi. Kaynak adresi verilmeden sohbetten
   amaç gönderildi; agent gerçek siteleri araştırıp kartı doldurdu.
2. Kart kaydedildi. Ayrı okuma denemesi iki kaynağı ve birer aday detayını doğruladı.
3. Düzenli çalıştırma düğmesiyle ilk normal tur başlatıldı; bütün liste sayfaları
   ve 53 adayın detayları okundu, kaynak bağlantıları sonuçlara kaydedildi.
4. 53 normal sonuçta URL benzersizliği, kaynak kapsamı, boş işlem taslağı,
   sıfır işlem girişimi ve başlıklardaki oda/kira sınırları ayrıca kontrol edildi.
5. Denemedeki iki aday aynı kayıt kimlikleriyle güncellendi. Bir elenmiş deneme
   örneği deneme etiketiyle kaldı; normal sonuç sayısına dahil edilmedi.
6. Sonuçlar ekranı görsel olarak incelendi. Kurulumda ve çalışma sonunda hata yoktu.

## Tekrar kullanım

Uygulamada **Almanya · Ev bul** kişisel template’i kaydedildi. Taşınabilir örnek:
[germany-housing.loop-template.json](examples/germany-housing.loop-template.json).
Dosya uygulamanın template içe aktarma şemasıyla doğrulandı. Yeni kurulumlar boş
kriterler ve kaynaklarla başlar; kendi şehirleri için araştırma ve deneme gerekir.

Test otomasyonu kullanıcıya açık bırakıldı; kriterler **Çalışma alanı profili**
sayfasından değiştirilebilir. Profil kaydedilince önceki deneme sonucu korunur. Takip
üstteki **Durdur** düğmesiyle durdurulabilir.

## Eski arayüzle tablo düzenleme testi

Eski iş arama düzeni geri getirildikten sonra aynı veriler ayrı bir önizleme
profiline kopyalandı. Önceki test penceresi kapatılmadı; çift tarama olmaması için
onun zamanlaması duraklatıldı.

Gerçek agent’a mevcut kayıtları okuması ve sütunları düzenlemesi sohbetten söylendi.
Agent, 53 normal kaydın tam özetlerini okuyup **Kaynak, İlan, Konum, Kira (€), Oda,
m², Koşul** sütunlarını hazırladı. Belirsiz bir oda sayısını boş bıraktı. Kira
Warmmiete olarak dolduruldu. Tablo düzenlerken web taraması yapılmadı, yeni satır
oluşturulmadı, eski deneme kaydı ve mevcut plan/deneme korundu.

Canlı pencerede ortak çalışma alanı seçimi, Başvurular sayfası, 10 satırlık
sayfalama, adres araması, sayısal kira sıralaması, yıldızlama, tam detay ve
Kaynaklar/Dosyalar/Profil geçişleri doğrulandı. İş arama için mevcut Electron
arayüz testi de geçti. Genel otomasyon testi, gerçek IPC/SQLite/MCP ve yerel test
formuyla ayrı çalıştırıldı; 543 birim ve entegrasyon testi başarılı.

Agent sayfasında eski etkinlik paneli, terminal, worker düğmeleri ve ayarlar geri
getirildi. Electron testinde boş terminale yazıp Enter ile konuşma başlatma, çalışan
terminale doğrudan tuş iletme ve Jev seçiminin yeniden yüklemede korunması doğrulandı.
Jev'in okuma, alan doldurma, seçenek seçme ve onaylı gönderimi ayrı yerel Chrome
testinde denendi; karar modeli bu testte kontrollü yanıtlar verdi. Canlı ev takibi
Jev seçildikten sonra duraklatıldı ve bu motorla yeni bir deneme bekliyor.

## Ortak çekirdeğe geçiş

Agent ekranının ikinci kopyası kaldırıldı. Aynı terminal ve ayar formu iş arama, ev,
randevu ve özel template’lerde kullanılıyor. Sağlayıcı oturumları, tarayıcı havuzu,
araç sunucusu ve uygulama zamanlayıcısı ortak hizmetlere taşındı. Tablo düzenleme
araçları iş aramada da çalışıyor. Eski verilerin şema 4 geçişi ve yetkilerin
korunması otomatik testlerle doğrulandı.

Canlı verilerin ayrı önizleme kopyasında 53 ev kaydı ve 1 deneme kaydı birebir
korundu. Kriterler, işlem yetkisi, deneme durumu, tablo sütunları, Claude ayarı ve
Jev seçimi kaynak verilerle karşılaştırıldı. Önceki pencereler açık bırakıldı.
