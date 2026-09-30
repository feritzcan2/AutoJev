import {personalAgent} from '../../agent-profiles.mjs';
export const JOB_AGENTS=[
 ['setup','Kurulum','Profil ve CV kurulumunu tamamlar.','Kurulum sohbeti veya profil iyileştirme başlatıldığında seçilir.','setup-profile'],
 ['search','Arama','Atanmış kaynaktaki ilanları tarar.','Bir kaynağın tarama görevi başladığında seçilir.','find-jobs'],
 ['rank','Puanlama','Atanmış ilanı kayıtlı profile göre değerlendirir.','Kuyruktaki puanlama görevi başladığında seçilir.','rank-jobs'],
 ['preparation','Hazırlık','Atanmış ilan için başvuru paketi hazırlar.','Başvuru hazırlama görevi başladığında seçilir.','prepare-application'],
 ['application','Başvuru','Atanmış başvuruyu kayıtlı yetki kapsamında yürütür.','Başvuru görevi başladığında seçilir.','apply-to-jobs'],
 ['verify','Doğrulama','Belirsiz başvurunun gerçek sonucunu kontrol eder.','Sonucu belirsiz bir başvuru kontrol edilirken seçilir.','apply-to-jobs'],
 ['conversation','Sohbet','Kayıtlı profil hakkında kullanıcının sorusunu yanıtlar.','Çalışma alanında doğrudan mesaj gönderildiğinde seçilir.','candidate-profile'],
].map(([kind,name,description,when,skill])=>({role:'job-'+kind,name,description,when,skill,category:'İş arama',instructions:`Your assigned role is ${kind}. Read .agents/skills/${skill}/SKILL.md for this role. ${kind==='setup'?'Use the saved setup context and user answers. Complete only this setup or profile improvement turn.':'Read the saved profile and current task through MCP. Do not perform onboarding or replay the setup interview. Complete only the assigned task; the scheduler selects the next task and agent.'} Follow saved user authorization and preserve observed evidence. Write user-facing messages in Turkish.`}));
export const JOB_AGENT_ROLES=JOB_AGENTS.map(a=>a.role);
export function jobAgentRole(store,id,worker){return store.setup(id)?.status==='running'?'job-setup':'job-'+(store.forWorker(worker).campaign(id)?.task?.kind??'conversation');}
export function jobAgentProfile(role,settings){const definition=JOB_AGENTS.find(a=>a.role===role);if(!definition)throw Error('Bilinmeyen iş agent görevi: '+role);return personalAgent(definition,settings);}
