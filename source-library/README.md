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

Yeni kaynaklar seçildiğinde etkin eklenir. Mevcut bir kaynağın talimatı boşsa veya
reçetesi yoksa bu alanlar kopyalanır; adı, sorgusu, zamanlaması ve etkinlik durumu
korunur. Kullanıcı tarafından düzenlenmiş yöntem veya reçete yeniden import edilince
ezilmez. **Kaynaklar** kartındaki reçete rozetinden yerel reçeteyi görüntüleyip
düzenleyebilirsin. **Kaynağı sil** (düzenleme formunda), kaynağı ve reçetesini kaldırır;
bulunmuş kayıtları korur. Çalışan kaynağın yöntemi değiştirilemez veya kaynak silinemez.
**Kaynak tanımlarını dışa aktar**, kaynak tanımlarını ve reçetelerini JSON'a yazar;
çalışma alanı kriterlerini, kaynak sorgularını ve geçmişini içermez.

## Arama reçetesi

Reçete, kaynağın mevcut sorgu için sonuç sayfasına nasıl ulaştığını ve nasıl
sayfalandığını tutar. Her kaynağın ilk deneme turunda agent siteyi bir kez çözer ve
reçeteyi `save_source_recipe` ile kaydeder; uygulama reçeteyi Jev ile açıp en az bir
ilan bulmadan kabul etmez. Sonraki taramalar reçeteyi uygular; agent sayfayı yeniden
keşfetmez. İki ardışık turda sonuç vermeyen reçete `stale` olur ve kaynak yeniden
deneme turuna girer. **Agent ayarları → Deneme turu modeli** ile keşif için daha güçlü
bir model seçilebilir.

- `entry.kind: "url_template"`: `{query}` yer tutuculu sonuç adresi. Diğer yer tutucular
  (`{location}` gibi) aynı adlı kriter alanından doldurulur; boş kalan parametre düşer.
  Yer tutucusuz sabit bir sonuç adresi de olabilir. Site yeniden eskiye sıralama
  sunuyorsa adres onu içermelidir; artımlı taramalar böylece bilinen ilanda durur.
- `terms`: kaynak sorgusu anahtar kelime değil de hedef tarifi ise en fazla 5 somut arama
  terimi. `{query}` (veya form alanı) her terimle ayrı ayrı doldurulur; tarama her
  aramayı sırayla yapar. Doğrulama ilk terimle yapılır.
- `entry.kind: "search_form"`: arama formu sayfası ve alanların görünen etiketleri
  (`query` zorunlu, `location` isteğe bağlı).
- `entry.kind: "discovery"`: kalıcı yöntem yok; agent her turda kendisi arar.
- `pagination`: `auto`, `url_param`, `next_link`, `next_click`, `load_more`,
  `infinite_scroll` veya `none`. Jev sayfalamayı kendisi bulur; bu alan ipucudur.
- `loginRequired` ve `notes` (en fazla 1000 karakter) isteğe bağlıdır.

## Biçim

```json
[
  {
    "name": "İlan sitesi",
    "url": "https://example.org/jobs/",
    "instructions": "Arama, filtreler, sayfalama ve detay okuma yöntemi.",
    "recipe": {
      "entry": {"kind": "url_template", "template": "https://example.org/jobs?q={query}&l={location}&sort=date"},
      "terms": ["Compliance", "AI Governance"],
      "pagination": "url_param",
      "notes": "sort=date yeniden eskiye sıralar."
    },
    "intervalMinutes": 30,
    "enabled": true
  }
]
```

`instructions` en fazla 6000 karakterdir; eski `skill` alanı (en fazla 60000 karakter)
kabul edilir ama arayüzde düzenlenmez. Agent her kaynağı
Jev ile yönetilen Chrome üzerinden tarar. Liste en fazla 200 kayıt ve 1 MB olabilir; bir
çalışma alanında en fazla 20 kaynak bulunur. Kaynak URL'leri benzersiz HTTP(S) adresleri olmalıdır.

## Tarama ve sınırlar

Agent her kaynağı Jev ile yönetilen Chrome üzerinden tarar; sayfa kuyruğunu ve
sayfa numarasını Jev tutar. Kayıtlar, puanlama, kalan işler, zamanlama ve başvuru
yetkisi mevcut AutoJev akışındadır. Yöntem metni değişirse o kaynağın denemesi ve
tarama kapsamı yenilenir; kayıtlı ilanlar ve diğer kaynaklar korunur.
