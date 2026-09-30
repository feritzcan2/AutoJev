export function missingAgentMessage(provider){
 const label=provider==='opencode'?'OpenCode':provider==='codex'?'Codex CLI':'Claude Code';
 const login=provider==='opencode'?'opencode auth login':provider==='codex'?'codex login':'claude auth login';
 return `AutoJev ${label} komutunu bulamadı. Terminalde ${provider} --version ile kontrol et. Komut çalışıyorsa AutoJev’i tamamen kapatıp aynı terminalden aç. AutoJev bu aracı içermez; kurulu değilse ayrıca kur ve ${login} ile oturum aç. Ardından kuruluma devam et. Kayıtlı bilgilerin korunur.`;
}

export function engineErrorMessage(message){
 const missing=/^agent CLI for (codex|claude|opencode) was not found on the launch PATH$/.exec(message);
 return missing?missingAgentMessage(missing[1]):message;
}
