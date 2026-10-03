// A sign-in link is not an authentication barrier. Check rendered content,
// excluding hidden controls and URLs, before asking the user to log in.
import {browserRenderedText} from './browser-rendered-text.mjs';
export const LOGGED_IN_FIELD={id:'loggedIn',type:'boolean',label:'Açık sekmede giriş yaptınız mı?',required:true,help:'Giriş yaptıktan sonra Evet yanıtını gönderin. Şifre veya doğrulama kodu paylaşmayın.'};
// Matches a request to log in, not a statement that the user is logged in
// ("giriş yapmış", "oturum açık").
export function asksForLogin(question){
 if(question.accessCheck?.kind==='login')return true;
 const text=[question.text??question.question,...(question.fields??[]).flatMap(f=>[f.label,f.help])].filter(Boolean).join(' ');
 return /giriş\s+yap(?:ın|manız|malı|ılmalı|tınız|ması|abilir)|oturum\s+aç(?:ın|manız|malı|ılmalı|tınız|ması|abilir)|oturum(?:u|unuz|unuzu|unuzun)?\s+(?:yok|olma|gerek)|hesab(?:ınıza|ına)\s+gir|\blog\s*in\b|\bsign\s*in\b|\banmeld(?:en|ung)\b/iu.test(text);
}
function credentialField(page,text){
 let value;try{value=JSON.parse(page.text.replace(/^Page URL: [^\n]+\n/,''));}catch{}
 const password=/(?:\bpassword\b|\bpasswort\b|parola|şifre)/iu,code=/(?:verification code|one[- ]time (?:code|password)|doğrulama kodu)/iu;
 const visible=field=>field.visible!==false;
 // Email also appears in public forms and newsletters. Prefer actual input
 // metadata when available, so prose and hidden controls cannot imply login.
 const hasPassword=Array.isArray(value?.passwordFields)?value.passwordFields.some(visible):Array.isArray(value?.controls)?value.controls.some(c=>visible(c)&&c.role==='textbox'&&password.test(c.label??'')):password.test(text);
 const hasCode=Array.isArray(value?.controls)?value.controls.some(c=>visible(c)&&c.role==='textbox'&&code.test(c.label??'')):code.test(text);
 return hasPassword||hasCode;
}
export function validateLoginQuestion(page,proof){
 if(page.readiness?.loading)throw Error('Sayfa hâlâ yükleniyor. Giriş engeli varsayma; browser_read ile güncel sayfayı kontrol et.');
 if(!proof||proof.snapshotId!==page.id)throw Error('Giriş sorusu için son snapshot.id içeren accessCheck gerekli. /signup bağlantısı veya önceki rapor kanıt değildir.');
 const text=browserRenderedText(page).replace(/^.*\blink\s+"[^\n]*$/gm,'').replace(/^Link:.*$/gm,'').replace(/https?:\/\/\S+/g,'');
 const quote=typeof proof.evidence==='string'?proof.evidence.trim().slice(0,600):'Güncel sayfada giriş gerekli.';
 const field=credentialField(page,text);
 // Word boundaries: "designing" is not "sign in".
 const form=/\b(?:log\s*in|sign\s*in|sign\s*up)\b|create (?:a |your )?(?:new )?account|\banmeld|giriş yap|oturum aç|hesap oluştur/iu.test(text);
 const gate=/(?:must|need to|please|required to)\s+(?:log\s*in|sign\s*in)\b|\b(?:log\s*in|sign\s*in)\s+to\s+(?:continue|apply|access)|(?:giriş yapmanız|oturum açmanız)\s+gerekiyor|(?:devam etmek|başvurmak)\s+için\s+(?:giriş|oturum)|bitte\s+(?:einloggen|anmelden)|(?:scan|scanne).{0,40}qr.{0,40}(?:log\s*in|sign\s*in|anmeld)/iu.test(text);
 if(!gate&&!(field&&form))throw Error('Güncel sayfada giriş formu veya açık bir giriş zorunluluğu görülmüyor. Giriş/kayıt bağlantısı tek başına engel değildir. İlanın gerçek başvuru düğmesini takip et ve ulaşılan sayfayı browser_read ile doğrula.');
 return {kind:'login',url:page.url,evidence:quote,snapshotId:page.id};
}
