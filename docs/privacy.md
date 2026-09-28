# Veriler ve paylaşım

Bu metin JobLoop’un uyguladığı veri akışını açıklar. Son güncelleme: 28 Eylül 2026.

## Bu bilgisayarda

Aday profilleri, kaynaklar, ilanlar, sorular ve başvuru geçmişi yerel SQLite
veritabanındadır. CV’ler, aday belgeleri, JobLoop’un ayrı Chrome profilleri ve sınırlı işlem
kayıtları uygulama veri klasöründe saklanır. Bu veritabanı ve belge dosyaları
JobLoop tarafından bütünüyle şifrelenmez. Jev, Chrome’un bağımsız mevcut profilini
kullanır. İşletim sistemi hesabını ve diskini koru.

Portal üyelik şifreleri aday başına, Telegram token’ları aday bot ayarında ve Jev
API anahtarı uygulamadan kaydedildiğinde işletim sistemi anahtarlığıyla şifrelenir.
Geliştirme için kullanılan `TYPESAFE_API_KEY` ve `.env.jev` bu anahtarlık korumasının dışındadır.
Anahtarlık kilitliyse veya Linux’ta yalnızca düz metin deposu varsa yeni sır
kaydedilmez. Jev’deki portal şifresi aracı şifreyi doğrudan site alanına doldurur;
şifreyi sohbet yanıtı olarak geri döndürmez.

## Dış hizmetler

| Kullanılan özellik | Gönderilen bilgiler | Alıcı |
| --- | --- | --- |
| Codex / Claude Code agent görevi | Talimatlar, aday bilgileri, agent’ın okuduğu belgeler, tarayıcı gözlemleri ve araç sonuçları | Seçilen AI sağlayıcısı ve kullanıcının etkinleştirdiği araçlar |
| Jev tarayıcı kararı | Sayfa adresi ve başlığı, sayfa metni, elementler, form alanı değerleri, görev ve son işlemler | TypeSafe / Jev |
| Jev bağlantı testi | API anahtarıyla model listesi isteği | TypeSafe; aday veya tarayıcı içeriği gönderilmez |
| Telegram | Yapılandırılmış ilan, başvuru ve soru bildirimleri; yanıtlar, eşleşmiş sohbet kimliği | Telegram ve adayın botu |
| İş arama / başvuru | Arama sorguları, izin verilen form alanları, yüklenen CV ve belgeler | Ziyaret edilen iş sitesi / işveren |
| Güncelleme kontrolü / indirme | Standart ağ isteği, platforma uygun sürüm dosyası isteği | GitHub Releases ve dağıtım altyapısı |

Formlardaki kişisel bilgiler Jev gözlemlerine girebilir. Sağlayıcıların veri
saklama koşulları ve kullanıcının hesap ayarları ayrıca geçerlidir. JobLoop’a
merkezi analitik veya telemetri hizmeti eklenmemiştir. Özelliklerin kendi ağ
istekleri yukarıda belirtilmiştir.

## Saklama ve silme

Prompt kayıtları en fazla 30 gün, aday başına 2.000 ve toplam 10.000 kayıttır;
her kayıt en fazla 128.000 karakter içerir. Tamamlanmış arka plan terminal
kayıtları en fazla 30 gün ve 100 dosya saklanır; dosya başına 150.000 bayt sınırı
vardır. Etkin terminalin bellekteki çıktısı sınırlıdır. Başvuru geçmişi bu otomatik
temizliğe dahil değildir. Ayarlardan prompt ve terminal kayıtlarını temizleyebilirsin.

Çalışma alanını silmek o adayın yerel kayıtlarını, belgelerini ve uygulamanın
sakladığı bot/portal ayarlarını kaldırır. Önceden alınmış yedekler ayrıca silinmelidir.
Bu işlem sağlayıcının CLI geçmişini, işverenin başvuru kaydını, Telegram mesajlarını
ve bağımsız Chrome profilini dış hizmetlerden silmez.

## Yedekler

Taşınabilir yedekler profilleri, CV ve belgeleri, ilanları ve başvuru geçmişini
içerir. Kayıtlı portal şifreleri, bot/Jev sırları ve agent oturumları çıkarılır.
Belgelerde veya kullanıcı metinlerinde elle yazılmış kişisel bilgi ve sırlar
otomatik olarak ayıklanmaz. Yedek klasörü şifrelenmez; güvenli bir yerde sakla.

Otomatik güncelleme ve geri yükleme öncesi yedekler aynı kurulumda kurtarma için
şifrelenmiş sırları korur. Başka kuruluma taşındıklarında sırlar kaldırılır ve
yeniden girilir. Son beş yükseltme yedeği tutulur; manuel dışa aktarımlar kullanıcı
tarafından yönetilir. Geri yükleme mevcut verileri değiştirir ve görevleri
duraklatır. Eski yedekten devam etmeden son başvuruları kontrol et.

Gizlilik veya güvenlik soruları için `feritzcan93@gmail.com` adresine ulaş.
