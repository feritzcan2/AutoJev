# Amsterdam ev arama: kısa istekle canlı test

Tarih: 29 Eylül 2026

## Test edilen akış

Boş uygulama profili ve **Ev arama** template'i kullanıldı. Sağlayıcı gerçek
Codex, tarayıcı otomasyona ayrılmış gerçek Chrome'du. Kaynak URL'si, bütçe veya
kişisel bilgi verilmedi. Başlangıç mesajı:

> Amsterdam’da bana uygun kiralık ev bul. Birden fazla siteyi araştır, uygun ilanlara başvur. Gerekirse üye ol ve Gmail’den doğrula.

İlk denemede Codex klasör güveni sorusunda takıldı. Uygulamanın oluşturduğu
otomasyon klasörüne başlatma süresince güven tanımlandı; sağlayıcının izin modu
ve kullanıcının genel ayarları değişmedi. Sonraki gerçek oturum başladı.

İlk araştırmada Pararius ve Kamernet bulundu. Ayrı bir kontrol mesajıyla iki
gerçek ilan detayı ve görünen giriş gereksinimleri okundu. Agent'ın örnekleri
tabloya kaydetme isteği kurulum aşamasında uygulama tarafından reddedildi.

Bu engel düzeltildikten sonra yeni, boş bir çalışma alanında aynı başlangıç
mesajı tekrar gönderildi. Bu kez ek yönlendirme olmadan:

- Pararius ve Funda'nın Amsterdam kiralık sonuç sayfaları bulundu ve kaydedildi.
- Her kaynaktan bir ilan detayı okundu; toplam 8 tarayıcı adımı kullanıldı.
- Eski **Başvurular** tablosuna konum, kira, oda, m², müsaitlik, süre ve gider
  sütunları eklendi; 2 ilan **Araştırma örneği** olarak kaydedildi.
- Agent bütçe, semt, taşınma, ev şartları ve başvuru tanıtımı için soru sordu.
- Başvuru, üyelik, e-posta okuma veya düzenli takip başlatılmadı.

## Doğruluk kontrolü

Tabloya yazılmış olması ilanın uygunluğunun doğrulandığı anlamına gelmez.
Funda kaydı kaynakla ayrıca karşılaştırıldığında öğrenci şartının atlandığı
ve çelişkili sözleşme bilgisinin tek bir kesin değere indirildiği görüldü.

[Lijnbaansgracht 163-2](https://www.funda.nl/detail/huur/amsterdam/appartement-lijnbaansgracht-163-2/80977846/)
ilanının açıklaması yalnız öğrencilere, en fazla iki paylaşan kişiye ve en fazla
bir yıllık sözleşmeye işaret ederken özellikler bölümünde süresiz sözleşme yazıyor.
Kaynakta kira €3.000, alan 179 m², toplam oda sayısı 4 ve yatak odası sayısı 3.

Agent talimatına açıklama ve özellikleri birlikte okuma, kiracı şartlarını
kaydetme ve çelişkili değerleri kesin bilgiye dönüştürmeme kuralı eklendi.
Eksik kişisel uygunluk veya çelişkili kesin şartlar çözülmeden başvuru taslağı
hazırlanmaması istendi. Aynı iki kayıt ayrıca gerçek agent ile yeniden kontrol
edildi; bu kontrol başlangıçtaki tek mesaj testinden ayrı tutulur.

Yeniden kontrolde agent Funda kaydına öğrenci ve kişi sınırını ekledi, toplam oda
sayısını 4 olarak tamamladı ve sözleşme hücresini çelişkili olarak düzeltti.
Pararius kaydındaki depozito ve kiracı kısıtları da kaydedildi. Tabloya kiracı
kısıtları sütunu eklendi; bilinmeyen toplam giderler kesin bir fiyata dönüştürülmedi.
Bu sonuç, iki kaydın düzeltildiğini gösterir; başka ilanlarda aynı hatanın
tekrarlanmayacağına veya gönderim akışının hazır olduğuna kanıt değildir.

## Kod değişiklikleri ve kontroller

- Uygulamanın oluşturduğu otomasyon klasörleri için Codex başlangıç düzeltmesi.
- Kurulumda yalnız o turda detay sayfası gözlemlenen kayıtların örnek olarak
  saklanması. Kaynak kapsamı korunur; işlem taslağı kabul edilmez.
- Araştırma örnekleri işlem kuyruğuna girmez, onaylanamaz ve normal kayıtların
  geçmişini/onayını değiştiremez. Normal tarama aynı kaydı yeniden değerlendirir.
- Tabloda ve filtrede araştırma örneklerinin açıkça gösterilmesi.
- 574 Node testi, 5 Rust testi, JavaScript kontrolü ve uygulama build'i geçti.
- Canlı uygulamada 2 ayrı kaynak, 2 araştırma kaydı, boş işlem taslakları,
  sıfır işlem girişimi ve kapalı takip ayrıca kontrol edildi. Tablo görsel olarak
  incelendi; kaynaklar ve düzeltilmiş hücreler yeniden yüklemeden sonra korundu.

## Henüz tamamlanmayanlar

Gerçek uygunluk değerlendirmesi ve başvuru için kullanıcının bütçesi, ev şartları,
taşınma tarihi, hane bilgileri ve başvuruda kullanılacak kimlik/e-posta eksik.
Bu bilgiler tahmin edilmedi.

Codex'in Gmail bağlantısı salt okunur bağlantı kontrolünde `missing` döndü.
Genel otomasyon araçlarında üyelik için şifre kasası, güvenli şifre doldurma ve
doğrulama e-postası adımı henüz yok; iş arama akışındaki araçlar bu akışa
aktarılmamış. Gmail bağlantısını kurmak tek başına bu eksikliği çözmez.
Uçtan uca üyelik, Gmail doğrulaması ve ev sahibine mesaj gönderimi bu testte
başarılı kabul edilmedi.

Bot bu worktree'nin ayrı uygulama profilinde açık bırakıldı. Diğer uygulama
pencereleri kapatılmadı. Kriterler gelene kadar durum bilgi bekliyor, düzenli
takip kapalı ve gönderilen başvuru sayısı sıfırdır.

## Geniş tarama ve Jev testi

Aynı gün kullanıcı örnek kriterlerle daha geniş bir test istedi. Amsterdam,
aylık toplam en fazla €3.500, bağımsız konut, en az 2 toplam oda ve 40 m²,
öğrenci olmayan tek yetişkin kriterleri yalnız arama testi için kullanıldı.
İşlem modu gözlem olarak bırakıldı; kişisel başvuru bilgisi uydurulmadı.

İlk tarama ayrı Chrome ile başladı; kullanıcı Codex'i durdurup Claude/sonnet'e
geçti. Sonraki isteğiyle Jev ve mevcut **Your Chrome / Default** profili
kullanıldı. İki kaynak üzerinde gerçek Jev denemesi geçti. Ardından iki worker
aynı anda ayrı kaynak görevlerine başladı; ilk worker'ın başlayamaması tekrar
gözlenmedi.

### Gözlenen sonuç

- 32 kayıt saklandı: 30 normal kayıt ve 2 deneme örneği. Normal kayıtların
  URL'leri birbirinden farklı; 30 URL'nin tamamı gerçek gezinme geçmişinde var.
  Bu kontrol, farklı sitelerde aynı evin bulunmadığını veya tüm alanların
  doğru değerlendirildiğini tek başına kanıtlamaz.
- Jev ile son Pararius turunda ikinci sonuç sayfası ve 14 ilan detayı açıldı.
  Agent 3–26. sayfaların ve ikinci sayfadaki yaklaşık 11 adayın detaylarının
  kalmasına rağmen turu `completed` olarak bitirdi. Özetinde kısmi olduğunu
  söyledi; uygulamanın tamamlanma durumu kapsamı doğrulamıyor.
- Jev ile Funda turu ilk sayfada kaldı. Agent 781 sonuç bildirildiğini, 17 kart
  yüklendiğini ve çerez penceresinin açık olduğunu raporladı. Gözlem modunda
  tıklama yapamadı; sonraki sayfa bağlantısı veya kaydırma hedefi bulamadı.
  Tur `blocked` bitti.
- Önceki, kullanıcı tarafından durdurulan Codex turunda Pararius'un 26 sonuç
  sayfasının URL'leri açılmıştı. Aday detayları bitmediği için bu da tam tarama
  sayılmaz. Funda'da denenmiş bir sonraki sayfa URL'si Amsterdam filtresini
  kaybetmişti; bu ziyaret Amsterdam kapsamına dahil edilmez.
- Başvuru taslağı ve işlem girişimi sayısı sıfır. Üyelik, Gmail doğrulaması ve
  mesaj gönderimi bu testte denenmedi. Son durumda Amsterdam `blocked`, sonraki
  çalışma zamanı boş; düzenli tekrar çalışmıyor. Berlin çalışma alanı korunuyor.

### Testte bulunan ve düzeltilen hatalar

- Hazır bir otomasyonda ilk worker'ın Başlat düğmesi genel kurulum akışına
  yönleniyordu. Artık worker başlatma API'sine gidiyor. Durdurulmuş worker için
  genel otomasyonun “Çalışıyor” durumu gösterilmiyor. Bu arayüz düzeltmesi
  açık uygulamaya yüklendi; Jev turunda iki worker da gerçekten başladı.
- Son 20 sayfa metni yerine bütün gezinme URL'leri ayrıca saklanıyor. Böylece
  eski ziyaretler kapsam denetiminde kaybolmuyor.
- Yeni deneme örneklerinin mevcut normal kayıtları örneğe dönüştürmesi ve
  onaylarını değiştirmesi engellendi. Agent bağlamında eski sayfa metinleri
  tekrar gönderilmiyor; son üç gözlemin URL ve zamanı tutuluyor. Tam denetim
  kayıtları veritabanında korunuyor.
- Son iki backend düzeltmesi kaynak kodda hazır; kullanıcının açık Berlin
  çalışmasını kesmemek için uygulama yeniden başlatılmadı. 36 ilgili test,
  JavaScript kontrolü, build ve diff kontrolü geçti. Önceki gezinme/worker
  değişikliklerinde 575 Node testi geçmişti.

### Kalan engeller

**Tam tarama henüz doğrulanmadı.** Gözlem için gerekli çerez kapatma ve sonuç
sayfası gezinme işlemleri, mesaj/başvuru gibi dış işlemlerden ayrı ele alınmalı.
Erken biten tarama için kalan adaylar ve sayfa konumu kalıcı olarak tutulmalı;
uygulama eksik kapsamı `completed` kabul etmemeli. Şu an agent'ın özet yazması
bu devam mekanizmasının yerini tutmuyor.

Yerel denetim çıktısı: `/tmp/loop-amsterdam-jev-audit.json`.
