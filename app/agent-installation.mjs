export function missingAgentMessage(provider){
 const label=provider==='codex'?'Codex CLI':'Claude Code';
 const login=provider==='codex'?'codex login':'claude auth login';
 return `${label} komutu bu bilgisayarda bulunamadı. AutoJev bu aracı içermez; ayrıca kurman gerekir. Zaten kuruluysa terminalde ${provider} --version komutunun çalıştığını kontrol et. Ardından ${login} ile oturum aç, AutoJev’i tamamen kapatıp yeniden aç ve kuruluma devam et. Kayıtlı bilgilerin korunur.`;
}

export function engineErrorMessage(message){
 const missing=/^agent CLI for (codex|claude) was not found on the launch PATH$/.exec(message);
 return missing?missingAgentMessage(missing[1]):message;
}
