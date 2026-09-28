# Otomatik context yönetimi

## Compaction — varsayılan %80

Agent → Agent ayarları → **Otomatik compaction eşiği (%)**. Varsayılan **80**; `0` kapatır. Ayarı bulunmayan eski profiller de %80 kullanır. Eşik değişikliği çalışan aday agent'ında bir sonraki ölçümde uygulanır. Claude ve Codex desteklenir; aday setup oturumları da izlenir. Background Jobs kapsam dışındadır.

Güncel kullanım eşiğe ulaşınca `/compact` bir kez gönderilir. Görev sonucu beklenmez. Codex çalışan turda komutu Tab ile, Claude Enter ile kendi kuyruğuna alır; komutun çalışmaya başlama zamanını sağlayıcı belirler. Uygulama turu zorla kesmez. İzin ekranı, kullanıcı taslağı veya devam eden mesaj teslimi varsa terminal hazır olana kadar bekler. Kısmen teslim edilmiş ya da sonucu belirsiz bir komut otomatik tekrarlanmaz.

Gönderildi, sıkıştırılıyor ve yeni kullanım ölçümü durumları ayrı izlenir. Komut gönderilmesi başarı sayılmaz. Yeni bir ölçüm eşik altına inmeden aynı yüksek kullanım için ikinci komut gönderilmez. Compaction sırasında sonraki kampanya/setup görevi gönderilmez; mevcut işin kayıtları ve konuşma kimliği korunur.

Compaction güncel kullanım yüzdesini izler. Aşağıdaki restart ayarı ise oturumda görülen en yüksek yüzdeyi hatırlar. İkisi bağımsızdır: compaction context'i küçültse bile daha önce aşılmış restart eşiği geçerli görev sonunda oturumu yenileyebilir.

Sağlayıcı komut davranışı: [Codex slash commands](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands), [Claude queued commands](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works).

## Görev sonunda temiz oturum

Agent → Agent ayarları → **Otomatik context yenileme eşiği (%)** alanında bir eşik belirle. `16`, context kapasitesinin %16'sı kullanıldığında yeniler; kalan context yüzdesini ifade etmez. `0` özelliği kapatır. Varsayılan kapalıdır. Değişiklik çalışan kampanyaya da uygulanır.

Son isteğin girdi token sayısı sağlayıcının bildirdiği context kapasitesine bölünür. Claude'un cache okuma/yazma tokenları toplama dahildir; Codex bunları zaten girdi sayısına dahil eder. Claude için oturuma özel status line, Codex için kullanım kaydı okunur. Model kapasitesi tahmin edilmez; 1M veya başka kapasiteyi sağlayıcı bildirir. Henüz geçerli ölçüm yoksa yenileme kararı verilmez. Eski token ayarları yüzdeye çevrilmez; yeni yüzde seçilmelidir.

Eşik aşılırsa mevcut kampanya görevinin geçerli sonuç kaydı ve sağlayıcının `Idle` bildirimi beklenir. Kesinti, hata, Chrome bekleyişi veya sonuçsuz biten tur görevin tamamlandığı anlamına gelmez. Sağlayıcı context'i sıkıştırsa bile gözlenen eşik aşımı görev sonuna kadar hatırlanır.

Görev bitince eski oturum kapanır. Sonraki görev yeni konuşmada açılır. Aday bilgileri, başvuru kayıtları, yanıtlar, belgeler, kaynak tarama takvimi ve tarayıcı sekmeleri korunur. Oturum kapatılamazsa kampanya duraklatılır. Background Jobs zaten ayrı, geçici oturumlar kullanır; bu ayar ana kampanya agent'ına uygulanır.

Kullanım kayıtları yalnızca etkin sağlayıcı konuşmasının kimliği ve aday çalışma alanı eşleşince okunur. Codex için `CODEX_HOME` desteklenir. Claude status line sadece JobLoop'un açtığı ana oturuma eklenir ve terminalde `ctx 16.0%` biçiminde gösterilir; genel Claude ayarlarına yazılmaz. Kayıt biçimi desteklenmezse terminal metninden yüzde tahmini yapılmaz.

Doğrulama: `node --test tests/context-{restart,compaction}.test.mjs`, `cargo test --manifest-path engine/Cargo.toml`, `pnpm check`, `pnpm build`, `pnpm engine:build`, `node scripts/smoke-context-settings.mjs`. İsteğe bağlı gerçek sağlayıcı testi: `node scripts/smoke-context-compact.mjs` (geçici çalışma alanları, sentetik bekleme görevi, başvuru yapılmaz).
