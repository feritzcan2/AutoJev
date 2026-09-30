const compact=value=>value.replace(/\s+/g,' ').trim();
const clock=value=>value.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi,(_,hour,minute,period)=>`${String(Number(hour)%12+(period.toLowerCase()==='pm'?12:0)).padStart(2,'0')}:${minute??'00'}`);

// Read the current rendered provider UI, not raw PTY chunks or scrollback.
// Require a provider banner plus reset/continuation UI, so quoted tool output
// mentioning a limit is not treated as an account status.
export function providerLimit(screen,provider){
 if(provider!=='claude')return null;
 const lines=String(screen??'').split('\n').map(line=>line.trim()),text=lines.join('\n');
 const banners=lines.flatMap((line,index)=>/^[⚠\uFE0F!●•⏺⎿└│─\s]*(?:You['’]ve hit your (?:(?:session|weekly|usage) )?limit|Usage limit reached)(?:\b|[·.])/i.test(line)?[index]:[]),banner=banners[0];
 if(banner===undefined)return null;
 const last=banners.at(-1);
 if(lines.slice(last+1).some(line=>/^(?:⏺|●)\s*(?!Usage limit|Continuing automatically)\S/i.test(line)||/^Calling \S+.*(?:times|tools)/i.test(line)))return null;
 const tail=compact(lines.slice(banner).join(' '));
 const automaticResume=/\bcontinuing automatically (?:at|in)\b/i.test(tail)&&/\besc to cancel\b/i.test(tail);
 const reset=tail.match(/\b(?:limit resets|resets)\s+(.+?)(?=\s+(?:Use your|claude\.ai\/|Continuing automatically|esc to cancel|ctx\b|auto mode|[●•⏺❯⚠])|$)/i);
 if(!automaticResume&&!(reset&&/(?:claude\.ai|clau\.de)\/(?:reset|upgrade)|\/extra-usage/i.test(text)))return null;
 const resetLabel=reset?clock(reset[1].replace(/[·.\s]+$/,'')):null;
 return {kind:'usage_limit',provider,resetLabel:resetLabel?.slice(0,160)??null,automaticResume};
}

export function providerLimitAttention(limit){
 if(!limit)return null;
 const provider=limit.provider==='claude'?'Claude':limit.provider==='codex'?'Codex':'Sağlayıcı';
 return {kind:'usage_limit',title:`${provider} kullanım limitine ulaştı`,detail:[limit.resetLabel?`Limitin yenilenmesi: ${limit.resetLabel}.`:'Yenilenme saati henüz bildirilmedi.',limit.automaticResume?'Sağlayıcı bu oturumda otomatik devam edeceğini bildiriyor.':'Devam etmek için sağlayıcının terminaldeki açıklamasını kontrol et.'].join(' ')};
}
