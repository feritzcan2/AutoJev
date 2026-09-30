// Inspect the rendered terminal screen: interactive prompts are often redrawn
// in place and can be split across PTY output events.
export function terminalAttention(screen, state){
 const text=String(screen??'').replace(/\s+/g,' ').trim();
 const trust=/(?:quick safety check|do you trust (?:the files in )?this (?:folder|workspace|project))/i.test(text)
  && /(?:yes,? i trust this folder|trust this (?:folder|workspace|project))/i.test(text)
  && /(?:enter to confirm|press enter|esc to cancel)/i.test(text);
 if(trust)return {kind:'trust',title:'Çalışma alanı için güven onayı bekleniyor',detail:'Claude Code klasöre erişmek için onay istiyor. Terminaldeki yolu kontrol edip seçimini orada yap.'};
 const permission=/(?:do you want to (?:allow|proceed|approve)|allow .{1,120}\?|permission (?:required|requested)|needs (?:your )?permission)/i.test(text)
  && /\b(?:yes|allow|approve)\b/i.test(text)&&/\b(?:no|deny|cancel)\b/i.test(text)
  && /(?:enter to confirm|press enter|esc to cancel)/i.test(text);
 if(permission)return {kind:'permission',title:'Agent işlem için onay bekliyor',detail:'İstenen işlemi terminalde inceleyip karar ver.'};
 if(state==='AwaitingInput')return {kind:'input',title:'Agent giriş veya onay bekliyor',detail:'Devam etmek için terminaldeki isteği inceleyip yanıtla.'};
 return null;
}
