# Güvenlik bildirimi

Güvenlik açığını herkese açık issue’ya yazma. `feritzcan93@gmail.com` adresine
konusu `JobLoop security` olan bir e-posta gönder. Etkilenen sürümü, işletim
sistemini, beklenen/gerçek davranışı ve sentetik verilerle tekrar adımlarını ekle.
CV, aday profili, gerçek şifre, token, tarayıcı çerezi veya oturum kaydı gönderme.

Desteklenen düzeltme hedefi son yayımlanan sürümdür. Düzeltme ve açıklama zamanını
bildirimi yapan kişiyle birlikte planlarız; belirli bir yanıt süresi taahhüt edilmez.

JobLoop yalnızca yerel masaüstü arayüzünü açar. Agent MCP bağlantısı loopback
üzerinden oturuma özel bearer token ve aday/worker kapsamıyla çalışır.
Telegram erişimi adayın yapılandırdığı bot ve eşleşmiş sohbet üzerinden sağlanır.
Portal, Telegram ve Jev sırları işletim sistemi anahtarlığıyla şifrelenir;
anahtarlık kullanılamıyorsa yeni sır kaydedilmez.

Başvuru otomasyonu, agent sağlayıcısı ve sitelerle bağlantı gerçek kullanıcı
yetkileriyle çalışır. Adayın verdiği yetkiyi, doğru bilgileri ve hangi işlemlerin
gönderilebileceğini uygulamadaki görev/başvuru ayarlarında açıkça belirt.
