export function conversationToolLabel(tool=''){
 const name=tool.replace(/^jobloop_/,'');
 if(/automation_context|context_part/.test(name))return 'Çalışma alanındaki bilgileri inceliyor';
 if(/workspace_history/.test(name))return 'İlgili geçmiş kaydını kontrol ediyor';
 if(/workspace_records|automation_result|scan_results/.test(name))return 'Kayıtlı sonuçları inceliyor';
 if(/save_automation_plan/.test(name))return 'Önerdiği değişiklikleri taslağa kaydediyor';
 if(/browser|research/.test(name))return 'Web’deki bilgileri kontrol ediyor';
 if(/ask_workspace_question/.test(name))return 'Sorularını hazırlıyor';
 if(/reply_to_user|finish_automation_run/.test(name))return 'Yanıtını tamamlıyor';
 if(/task/.test(name))return 'Sonuçları ayrıntılı inceliyor';
 if(/bash|read|grep/.test(name))return 'İlgili bilgileri kontrol ediyor';
 return 'Yanıt üzerinde çalışıyor';
}
