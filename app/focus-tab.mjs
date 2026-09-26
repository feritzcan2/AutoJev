import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
// Arguments are data, never interpolated into executable AppleScript.
const script=`ObjC.import('stdlib');
function run(args) {
 const chrome=Application('Google Chrome');
 if(!chrome.running())return 'missing';
 const matches=[],wins=chrome.windows();
 for(let w=0;w<wins.length;w++){const tabs=wins[w].tabs();for(let t=0;t<tabs.length;t++){
  const url=tabs[t].url();if(url===args[1])matches.push({window:wins[w],index:t+1,id:String(tabs[t].id())});
 }}
 const exact=matches.filter(x=>x.id===args[0]);
 const chosen=exact.length===1?exact[0]:matches.length===1?matches[0]:null;
 if(!chosen)return matches.length?'ambiguous':'missing';
 chosen.window.activeTabIndex=chosen.index;chosen.window.index=1;chrome.activate();return 'focused';
}`;
export async function focusApplicationTab(context,{platform=process.platform,exec=execute}={}){
 if(!context?.url)throw Error('Bu başvuru için kayıtlı sekme yok. İlan bağlantısını açabilirsin.');
 const url=new URL(context.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz sekme bağlantısı');
 if(platform!=='darwin'||!/(chrome|chromium)/i.test(context.browser??''))throw Error('Bu tarayıcı için sekmeyi öne getirme desteklenmiyor. İlan bağlantısını kullanabilirsin.');
 let output;try{output=await exec('/usr/bin/osascript',['-l','JavaScript','-e',script,String(context.tabId??''),url.toString()],{timeout:15000,maxBuffer:4000});}catch{throw Error('Chrome sekmesine erişilemedi. macOS otomasyon iznini kontrol et.');}
 const status=output.stdout.trim();if(status==='missing')throw Error('Kayıtlı sekme bulunamadı; kapanmış veya adresi değişmiş olabilir. Yeni form açılmadı.');if(status==='ambiguous')throw Error('Aynı adresle birden fazla sekme var; yanlış sekmeyi açmamak için seçim yapılmadı.');if(status!=='focused')throw Error('Sekme öne getirilemedi');return{focused:true};
}
