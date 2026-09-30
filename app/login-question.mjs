// A sign-in link is not an authentication barrier. Check rendered content,
// excluding hidden controls and URLs, before asking the user to log in.
export function asksForLogin(question){
 if(question.accessCheck?.kind==='login')return true;
 const text=[question.text,...(question.fields??[]).flatMap(f=>[f.label,f.help])].filter(Boolean).join(' ');
 return /giriş\s+yap|oturum(?:u|unuz|unuzu|unuzun)?\s+(?:aç|yok|olma|gerek)|hesab(?:ınıza|ına)\s+gir|\blog\s*in\b|\bsign\s*in\b|\banmeld(?:en|ung)\b/iu.test(text);
}
function rendered(page){
 const raw=page.text.replace(/^Page URL: [^\n]+\n/,'');
 try{
  const value=JSON.parse(raw);
  if(typeof value.text==='string')return value.text;
 }catch{}
 // Playwright snapshots contain accessible text and links on separate lines.
 return raw.replace(/^.*\blink\s+"[^\n]*$/gm,'');
}
export function validateLoginQuestion(page,proof){
 if(page.readiness?.loading)throw Error('Sayfa hâlâ yükleniyor. Giriş engeli varsayma; browser_read ile güncel sayfayı kontrol et.');
 if(!proof||proof.snapshotId!==page.id)throw Error('Giriş sorusu için son snapshot.id ve görünür giriş engelinden kısa bir alıntı içeren accessCheck gerekli. /signup bağlantısı veya önceki rapor kanıt değildir.');
 const text=rendered(page).replace(/^Link:.*$/gm,'').replace(/https?:\/\/\S+/g,''),normalize=s=>s.replace(/\s+/g,' ').trim().toLocaleLowerCase('tr');
 const quote=typeof proof.evidence==='string'?proof.evidence.trim():'';
 if(quote.length<12||quote.length>600||!normalize(text).includes(normalize(quote)))throw Error('Giriş engeli alıntısı güncel görünür sayfada bulunamadı. Sayfayı yeniden kontrol et; eski veya gizli metni kullanma.');
 const field=/(?:password|passwort|parola|şifre|e-?mail|e-posta|email address|verification code|doğrulama kodu)/iu.test(text);
 const form=/(?:log\s*in|sign\s*in|sign\s*up|create (?:a |your )?(?:new )?account|anmeld|giriş yap|oturum aç|hesap oluştur)/iu.test(text);
 const gate=/(?:must|need to|please|required to)\s+(?:log\s*in|sign\s*in)|(?:log\s*in|sign\s*in)\s+to\s+(?:continue|apply|access)|(?:giriş yapmanız|oturum açmanız)\s+gerekiyor|(?:devam etmek|başvurmak)\s+için\s+(?:giriş|oturum)|bitte\s+(?:einloggen|anmelden)|(?:scan|scanne).{0,40}qr.{0,40}(?:log\s*in|sign\s*in|anmeld)/iu.test(text);
 if(!gate&&!(field&&form))throw Error('Güncel sayfada giriş formu veya açık bir giriş zorunluluğu görülmüyor. Giriş/kayıt bağlantısı tek başına engel değildir. İlanın gerçek başvuru düğmesini takip et ve ulaşılan sayfayı browser_read ile doğrula.');
 return {kind:'login',url:page.url,evidence:quote,snapshotId:page.id};
}
