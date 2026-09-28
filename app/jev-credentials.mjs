// Report validation metadata only: never expose values or page-generated error text.
function passwordValidation(e){
 const visible=n=>n?.isConnected&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const root=e.getRootNode(),ids=[e.getAttribute('aria-describedby'),e.getAttribute('aria-errormessage')].filter(Boolean).join(' ').split(/\s+/);
 const related=ids.map(id=>root.getElementById?.(id)).filter(visible);
 const box=e.closest('[class*=field],[class*=Field]')||e.parentElement;
 const errorNodes=[...related,...(box?.querySelectorAll('[role=alert],[class*=error],[class*=invalid]')||[])].filter(visible);
 const siteRejected=e.getAttribute('aria-invalid')==='true'||errorNodes.some(n=>/(?:password|şifre|passwort).{0,100}(?:invalid|incorrect|not meet|doesn't meet|too short|rejected|geçersiz|ungültig)|security requirements|(?:invalid|incorrect).{0,30}password/i.test(n.textContent||''));
 return {invalid:!e.validity.valid||siteRejected,siteRejected,minLength:e.minLength>0?e.minLength:undefined};
}
import {randomUUID} from 'node:crypto';
export async function capturePasswordFields(slot,owner){
 for(const f of slot.passwordFields?.values()??[])await f.handle.dispose().catch(()=>{});
 slot.passwordFields=new Map();
 const handles=await slot.page.locator('input[type="password"]').elementHandles(),fields=[];
 for(const handle of handles){
  const meta=await handle.evaluate(e=>{
   if(!e.isConnected||e.disabled||e.readOnly||!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return null;
   return {label:e.getAttribute('aria-label')||[...(e.labels||[])].map(l=>l.textContent.trim()).join(' ')||e.name||'Password',autocomplete:e.autocomplete};
  });
  if(!meta){await handle.dispose();continue;}
  meta.validation=await handle.evaluate(passwordValidation);
  const fieldId=randomUUID();slot.passwordFields.set(fieldId,{handle,owner,url:slot.page.url(),meta});fields.push({fieldId,...meta});
 }
 return fields;
}
export async function fillAccountPassword(slot,args,owner,{vault,jobId}){
 if(new Set(args.fieldIds).size!==args.fieldIds.length)throw Error('Aynı şifre alanını bir kez belirt.');
 const fields=args.fieldIds.map(id=>slot.passwordFields?.get(id));
 if(fields.some(f=>!f||f.owner!==owner||f.url!==slot.page.url()))throw Error('Güncel passwordFields kimlikleri gerekli.');
 const origin=new URL(slot.page.url()).origin;
 if(!origin.startsWith('https://')||/(^|\.)google\.com$/.test(new URL(origin).hostname))throw Error('Yalnızca HTTPS aday portalı şifre alanları desteklenir.');
 const status=vault.status();
 if(!status.configured){vault.request({jobId,origin});return {status:'credential_required',executed:false,message:'Aday profiline güvenli şifre giriş isteği açıldı. Sohbette şifre isteme. Bu teknik beklemeyi raporla; kullanıcı profil kartından kaydedip yeniden sıraya alabilir.'};}
 if(args.email.trim().toLowerCase()!==status.email)throw Error('Portal e-postası kayıtlı aday hesabıyla eşleşmiyor.');
 // Verify the account on the form, not merely the agent-provided argument.
 const accountMatch=await fields[0].handle.evaluate((password,email)=>{
  const root=password.form||password.getRootNode();
  const inputs=[...root.querySelectorAll('input')].filter(e=>e.type!=='password'&&e.type!=='hidden'&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  return inputs.some(e=>{
   const labelled=(e.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>e.getRootNode().getElementById?.(id)?.textContent||'').join(' ');
   const label=[e.getAttribute('aria-label'),labelled,...[...(e.labels||[])].map(l=>l.textContent),e.name,e.id,e.placeholder].filter(Boolean).join(' ');
   const accountField=e.type==='email'||e.autocomplete.split(/\s+/).some(t=>t==='username'||t==='email')||(/^(text|search)$/.test(e.type)&&/e[-_ ]?mail|username|user[-_ ]?name|benutzername/i.test(label));
   return accountField&&e.value.trim().toLowerCase()===email;
  });
 },status.email);
 if(!accountMatch)return {status:'account_email_unverified',executed:false,retryable:false,message:'Formdaki hesap e-postası doğrulanamadı; şifre aktarılmadı. Bu teknik alan-eşleştirme hatasıdır, hesabın var olduğunu veya e-postanın yanlış olduğunu göstermez. Formdaki e-posta boş/yanlışsa düzelt; zaten doğruysa aynı çağrıyı tekrar etme ve adaya hesap oluşturduğunu varsayan soru sorma. Teknik engel olarak raporla.'};
 for(const f of fields){
  const valid=await f.handle.evaluate((e,meta)=>e.isConnected&&e.type==='password'&&!e.disabled&&!e.readOnly&&e.autocomplete===meta.autocomplete&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),f.meta);
  if(!valid)throw Error('Şifre alanı değişti; güncel gözlemi kullan.');
 }
 let secret=vault.secret();
 try{
  for(const f of fields){
   if(slot.page.url()!==f.url)throw Error('Page changed');
   await f.handle.fill(secret,{timeout:3000});
   if(!await f.handle.evaluate((e,value)=>e.type==='password'&&e.value===value,secret))throw Error('Unverified');
  }
  const validation=[];
  for(const f of fields){await f.handle.evaluate(e=>e.blur());validation.push(await f.handle.evaluate(passwordValidation));}
  if(validation.some(v=>v.invalid)){
   vault.request({jobId,origin,reason:'password_validation_failed'});
   return {status:'credential_invalid',executed:true,passwordFilled:true,passwordAccepted:false,validation,retryable:false,message:'Şifre aktarıldı fakat form doğrulaması şifreyi reddediyor. Diğer alanlar tamam veya yalnızca CAPTCHA kaldı deme. Aynı şifreyi yeniden deneme. Aday güvenli profil kartından site koşullarına uygun şifre kaydetmeli; sohbette şifre isteme.'};
  }
  vault.clearRequest();
  return {status:'ready',executed:true,passwordFilled:true,passwordAccepted:null,message:'Kayıtlı şifre doğrulanan aday portalına aktarıldı. Şifreyi okuma veya sohbete yazma. Hesap oluşturulması ayrıca site sonucuyla doğrulanmalı.'};
 }catch{return {status:'uncertain',executed:'unknown',message:'Şifre aktarımı tamamlanamadı; alanları yeniden gözlemle. Şifre veya hata ayrıntısı loglanmadı.'};}
 finally{secret=null;}
}
