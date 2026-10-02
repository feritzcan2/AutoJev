# AutoJev kaynak listesi

[sources.json](sources.json), paylaşılabilir site tanımlarını içerir. Bu dizin
ayrı bir public Git deposunda da kullanılabilir; uygulama düz JSON listesini okur.
Kaynak katkısı için JSON'a bir kayıt ekleyip pull request aç.

## Kullanım

**Kaynaklar → Listeden ekle** uygulamayla gelen altı kaynağı gösterir. Başka bir
liste için ham JSON adresini gir veya **Dosyadan aç** seçeneğini kullan. GitHub
üzerindeki bir liste için dosyanın **Raw** adresi gerekir. Seçilen kaynaklar yerel
kopya olarak eklenir; kaynak, talimat ve skill metni kütüphaneden bağımsız saklanır.
Kütüphane güncellemeleri bu kopyayı değiştirmez.

Yeni kaynaklar seçildiğinde etkin eklenir. Mevcut bir kaynağın talimatı, skilli ve aracı
boşsa bu alanlar kopyalanır; adı, sorgusu, zamanlaması ve etkinlik durumu
korunur. Kullanıcı tarafından düzenlenmiş yöntem yeniden import edilince ezilmez.
**Kaynaklar** kartındaki **Skill** bağlantısından yerel rehberi görüntüleyip
düzenleyebilirsin. **Kaynağı sil**, kaynağı ve yerel skillini kaldırır; bulunmuş
kayıtları korur. Çalışan kaynağın yöntemi değiştirilemez veya kaynak silinemez. **Dışa aktar**, kaynak tanımlarını
JSON'a yazar; çalışma alanı kriterlerini, kaynak sorgularını ve geçmişini içermez.
Çalışma talimatına veya skille elle yazdığın bilgiler ise paylaşılacak metnin parçasıdır.

## Biçim

```json
[
  {
    "name": "İlan sitesi",
    "url": "https://example.org/jobs/",
    "instructions": "Arama, filtreler, sayfalama ve detay okuma yöntemi.",
    "skill": "Bu kaynağa ait düzenlenebilir kullanım rehberi.",
    "tool": "",
    "intervalMinutes": 30,
    "enabled": true
  }
]
```

`instructions` en fazla 6000, `skill` en fazla 60000 karakterdir. Skill içermeyen
eski bir tanım import edilirken, bilinen aracın rehberi bir kez kopyalanır.
Kullanıcının sildiği veya değiştirdiği skill tekrar doldurulmaz. `tool` boşsa agent yönetilen tarayıcıyı
kullanır. Desteklenen araçlar `freehire-search`, `linkedin-search`,
`jobindex-search`, `jobnet-search`, `jobdanmark-search` ve `jobbank-search`.
Tanımlanmayan araçlar listede gösterilir; o araç uygulamaya eklenene kadar import
edilemez. Liste en fazla 200 kayıt ve 1 MB olabilir; bir çalışma alanında en fazla
20 kaynak bulunur. Kaynak URL'leri benzersiz HTTP(S) adresleri olmalıdır.

## Araçların çalışması

Agent'ın `assignedSource.cli` bağlamı tam terminal komutunu ve kullanım rehberinin
dosya yolunu verir. Agent komuta `search`, `detail` veya sitenin yardımcı
komutlarını ekleyerek bu CLI’ı kullanır. CLI bulunmayan kaynaklar tarayıcıyla
çalışır; onların başlangıç mesajında CLI’dan söz edilmez.
Aramaya özel bir MCP çalıştırma aracı yoktur. Sağlayıcının terminal izinleri
geçerlidir; uygulama bu izinleri değiştirmez.

Altı CLI sabit upstream commit'ten alınır. `pnpm build`, TypeScript kodunu
bağımlılıklarıyla paketler; dört CLI'ın Bunli girişini küçük Node uyarlamasıyla
değiştirir. Arama ve ayrıştırma kodu korunur. Paketli uygulamada CLI'lar Electron'ın
Node ortamında çalışır; sistemde Node/Bun bulunması gerekmez. Yardım metnindeki
`SOURCE_TOOL`, bağlamda verilen tam komutun yer tutucusudur.

Yeni araç katkıları uygulama koduna PR ile gelir. Bu JSON dosyası kod indirmez,
paket kurmaz veya komut çalıştırmaz. Kullanım rehberleri ve kaynak kodu için
[upstream bildirimi](../vendor/ai-job-search/UPSTREAM.json) ve
[MIT lisansı](../vendor/ai-job-search/LICENSE) geçerlidir.

## Tarama ve sınırlar

CLI çıktısını okuyan agent, mevcut `save_scan_progress`, `complete_scan_search`
veya `finish_automation_run` araçlarına `sourceRead: {url, command, summary}`
bildirir. Hata yanıtlarında `error: true` kullanılır. Bu kayıt bir agent raporudur;
uygulamanın gözlemlediği tarayıcı kanıtı veya gönderim onayı sayılmaz. Kayıtlar,
puanlama, kalan işler, zamanlama ve başvuru yetkisi mevcut AutoJev akışındadır.

Sayfa/çıktı limiti tam tarama anlamına gelmez. Özellikle Jobbank RSS en fazla
100 ilan döndürür; agent kalan kapsam için alt sorgular veya tarayıcı kullanır.
Yöntem metni ya da araç değişirse o kaynağın denemesi ve tarama kapsamı yenilenir;
kayıtlı ilanlar ve diğer kaynaklar korunur.
