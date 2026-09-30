import {validateSourceSearch} from './source-integrations.mjs';
import {boundedText,webUrl} from './automation-templates.mjs';

const modes=['observe','prepare','auto'];
export function sourceMode(automation,url){
 const requested=automation.sourceSettings?.[url]?.mode??automation.mode;
 return modes[Math.min(modes.indexOf(automation.mode),modes.indexOf(requested))]??'observe';
}
export function automationSources(a){return a.sources.map(url=>{
 const saved=a.sourceSettings?.[url]??{},state=a.sourceState?.[url]??{};
 return {...saved,id:url,url,name:saved.name??new URL(url).hostname.replace(/^www\./,''),query:saved.query??a.goal,enabled:saved.enabled!==false,intervalMinutes:saved.intervalMinutes??a.intervalMinutes,mode:sourceMode(a,url),...state};
});}
export function sourceInput(a,url,input){
 url=webUrl(url);if(!a.sources.includes(url))throw Error('Kaynak bu çalışma alanına ait değil');
 const saved=a.sourceSettings?.[url]??{},result={...saved,...validateSourceSearch(input,saved)};
 if(input.name!==undefined)result.name=boundedText(input.name,'Kaynak adı',120);
 if(input.query!==undefined)result.query=boundedText(input.query,'Arama kapsamı',2000);
 if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')throw Error('Geçersiz kaynak durumu');result.enabled=input.enabled;}
 if(input.intervalMinutes!==undefined){if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<1||input.intervalMinutes>10080)throw Error('Tarama aralığı: 1–10080 arasında tam sayı gerekli');result.intervalMinutes=input.intervalMinutes;}
 if(input.mode!==undefined){if(!modes.includes(input.mode)||modes.indexOf(input.mode)>modes.indexOf(a.mode))throw Error('Kaynak yetkisi profilin işlem yetkisini aşamaz');result.mode=input.mode;}
 return result;
}
