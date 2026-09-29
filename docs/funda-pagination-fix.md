# Funda sayfalama incelemesi

29 Eylül 2026 tarihli `dc3735a6-e203-48da-9e8f-6da9c95607a0`
çalışmasının gerçek Claude araç çağrıları incelendi. Agent, 780 sonuç başlığını
ve ilk sayfadaki 17 kartı okumuş; 8 tarayıcı adımında, 104 saniyede `blocked`
bildirmişti. Erişim engeli kanıtı yoktu.

Araç yanıtlarında sayfanın yüksekliği 6138, görünür alan 735 piksel olarak
kayıtlıydı. İlk iki kaydırmada konum 0 → 560 → 1120 oldu. Üçüncü kaydırma da
başarılıydı. Agent, kalan kaydırma alanını tüketmeden sayfalama olmadığına karar
vermişti. Sayfalama/kaydırma alanları 35–38 bin karakterlik JSON çıktısının
sonundaydı; her yanıtın ilk 8000 karakteri görünüyordu. Bazı aramalarda gerçek
metinde bulunmayan JSON kaçış karakterleri de kullanılmıştı.

## Değişiklik

- Jev gözleminin kaydırma konumu, kalan mesafesi ve sayfalama bilgisi artık
  `pageNavigation` alanında, parçalı metnin dışında döner.
- Görünen DOM'daki sayfalama bölgeleri, gerçek bağlantılar, düğme etiketleri,
  etkin sayfa ve devre dışı kontroller okunur. URL üretilmez; filtreler korunur.
- Tıklama kimliği yalnız güncel gözlemde tek bir eşleşme varsa verilir.
- Özet boyutu sınırlıdır; tam belge önbellekte kalır.
- Agent talimatı, sayfa sonuna ulaşmadan “sayfalama yok” sonucuna varılmamasını
  ve gerçek erişim engellerinin ayrıca değerlendirilmesini açıklar.

## Doğrulama

`node scripts/smoke-pagination.mjs`, gerçek Chrome/Jev ile yerel uzun bir listeyi
ve alt kısma gelince oluşturulan sayfalama düğmesini sınar. İlk üç kaydırmada
henüz düğme yoktur. Onuncu kaydırmada düğme bulunur ve tek sekmede,
`selected_area=amsterdam` korunarak ikinci sayfaya geçilir. İkinci sayfadaki
kapalı “Volgende” düğmesi doğru raporlanır. Birim testleri ayrıca uzun/parçalı
çıktıda özetin kaybolmamasını, güncel hedef eşleşmesini ve çıktı boyutunu sınar.

Canlı mevcut Chrome profili kontrolü bağlantı onayında bekledi. Ayrı boş Chrome
profilindeki bir kontrol ise Funda'nın insan doğrulama sayfasına geldi; orada
ilerlenmedi. Bu nedenle canlı Funda'da ikinci sayfaya geçiş bu kontrolle henüz
kanıtlanmış değildir. Yerel senaryo, eski kayıttaki erken durma biçimini yeniden
üretip düzeltmeyi doğrular.
