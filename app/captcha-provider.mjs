// These are CAPTCHA provider protocols, never rules for the website being read.
export function captchaProvider(url){
 try{
  const u=new URL(url);if(u.protocol!=='https:')return null;
  if(['www.google.com','google.com','www.recaptcha.net','recaptcha.net','recaptcha.google.com'].includes(u.hostname)&&/^\/recaptcha\/(api2|enterprise)\/(anchor|bframe)$/.test(u.pathname))return {provider:'recaptcha',part:u.pathname.endsWith('/bframe')?'challenge':'anchor',sitekey:u.searchParams.get('k'),invisible:u.searchParams.get('size')==='invisible',enterprise:u.pathname.includes('/enterprise/')};
  if((u.hostname==='hcaptcha.com'||u.hostname.endsWith('.hcaptcha.com'))&&/checkbox|challenge|frame=/i.test(u.href))return {provider:'hcaptcha',part:/challenge/i.test(u.href)?'challenge':'anchor'};
  if(u.hostname==='challenges.cloudflare.com'&&u.pathname.includes('/challenge-platform/'))return {provider:'turnstile',part:'widget'};
 }catch{}return null;
}
