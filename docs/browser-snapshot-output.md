# Büyük tarayıcı çıktıları

Immowelt denemesinde Playwright yaklaşık 156 bin karakterlik tek araç yanıtı verdi. Claude yanıtı token sınırı nedeniyle dosyaya kaldırdı. Otomasyon araçları bu dosyayı okuyamadığından aynı sayfayı yeniden açmak ilerleme sağlamadı.

`browser-snapshot.mjs`, her otomasyon oturumunun son sayfa metnini bellekte tutar. Küçük yanıtlar mevcut biçimleriyle döner. Büyük yanıtların ilk parçası ve devam konumu döner; metnin geri kalanı kesilmez. JSON kodlaması ve Unicode dahil, parça yanıtı 16.000 bayt ile sınırlanır.

- `browser_read_part(snapshotId, offset, limit?)`: aynı gözlemin devamını okur. `snapshot.nextOffset` sonraki konumdur.
- `browser_search(snapshotId, query, offset?, limit?)`: metinde harfi harfine, büyük/küçük harf duyarsız arama yapar. Eşleşmeler, çevre metni ve devam konumu döner.
- Bu iki araç yeni tarayıcı adımı veya güncel işlem kanıtı oluşturmaz.
- Yeni gözlem, gezinme veya denenen etkileşim önceki gözlem kimliğini geçersiz kılar. Kimlik başka oturumda kullanılamaz.
- Kaynak ve işlem yetkisi kontrolleri mevcut otomasyon araçlarında kalır. Agent'ın dosya veya shell erişimi genişletilmez.
- Playwright'ın doğrulanmış yerel snapshot dosyaları, bu okuyucuyu kullanan çağrılarda mevcut dosya boyutu sınırı içinde tam okunur. Diğer tarayıcı çağrılarının mevcut sınırı korunur.

## Doğrulama

```sh
node --test tests/browser-snapshot.test.mjs
node scripts/smoke-browser-snapshot.mjs
node scripts/smoke-automation-jev.mjs
```

İkinci komut ayrı bir Chrome profili ve yerel ilan sayfası açar; uzun sayfanın son ilanını MCP üzerinden arayıp okur ve deneme sonucu olarak kaydeder. Kendi test tarayıcısını kapatır. Gerçek bir sağlayıcının kaydettiği büyük araç yanıtını da tekrar oynatmak için dosya yolu ilk argüman olarak verilebilir; gerçek sayfa verisi depoya eklenmez.

Bu değişiklik uygulamanın ana sürecindedir. Açık uygulamaya geçmesi için uygulamanın yeniden başlatılması gerekir; yalnızca ekranı yenilemek yeterli değildir.

## Jev: ekranın altındaki içerik

Jev otomasyonlarının `browser_open` ve `browser_read` yanıtları artık `scope=document` gözlemi kullanır. `jev-document.mjs`, ekranda görünmese de yüklenmiş DOM metinlerini ve gerçek HTTP(S) bağlantılarını okur; açık shadow root içeriklerini de kapsar. Gizli içerik, form değerleri ve iframe içerikleri dahil edilmez. Bu kapsam `reading` alanında belirtilir. Mevcut etkileşim hedefleri ve kimlik kontrolleri korunur; diğer Jev çağrılarının varsayılan kapsamı değişmez.

Henüz yüklenmemiş veya sanallaştırılmış listeler için `browser_jev_scroll(controlId, direction)` otomasyon aracına eklendi. Güncel `scrollTargets` listesindeki kapsayıcı kullanılır. Görüşme, deneme ve gözlem sırasında çalışabilir; kaynak, oturum ve adım sınırları uygulanır. Tıklama, form doldurma ve gönderim için gereken işlem rezervasyonunu vermez. Kaydırma sonrası yeni gözlem alınır; önceki sayfa parçaları geçersiz olur.

`node scripts/smoke-jev-reading.mjs`, gerçek Chrome/Jev üzerinde uzun sayfanın son ilanını, adresini ve bağlantısını; gizli içeriklerin dışlanmasını; kaydırmayla yüklenen ilanı ve gerçek detay bağlantısını doğrular. Yerel testte dış işlem gönderilmez. `tests/jev-reading.test.mjs` kaynak ve araç yetkisi kontrollerini ayrıca sınar.
