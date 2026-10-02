import {boundedText,webUrl} from '../app/automation-templates.mjs';

// An interview can start with an incomplete plan. Source requests are conversation
// context; only actual web addresses become runnable automation sources.
export function prepareAutomationChat(message,draft){
 const text=boundedText(message,'Mesaj',12000);
 if(!draft)return {message:text,draft:null};
 if(!Object.hasOwn(draft,'sources'))return {message:text,draft};
 const sources=[],notes=[];
 for(const source of draft.sources){
  try{new URL(source);}catch{notes.push(source);continue;}
  sources.push(webUrl(source));
 }
 const context=notes.length?'\n\nKaynak isteğim (henüz doğrulanmış web adresi değil):\n'+notes.join('\n'):'';
 return {message:boundedText(text+context,'Mesaj ve kaynak notları',12000),draft:{...draft,sources}};
}
