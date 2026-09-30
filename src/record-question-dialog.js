import {questionForm} from './question-form.js';
import {automationAttention} from '../app/automation-attention.mjs';
import {attentionTabs} from './automation-attention.js';
import './record-question-dialog.css';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const button=(text,click,cls='quiet')=>{const node=el('button',text,cls);node.type='button';node.onclick=click;return node;};

export function recordQuestionDialog(api,{refresh}){
 let snapshot=null,current=null;
 const dialog=el('dialog',null,'record-question-dialog');dialog.setAttribute('aria-labelledby','record-question-title');document.body.append(dialog);
 dialog.addEventListener('close',()=>{current=null;});
 function open(id){
  const issue=automationAttention(snapshot).find(q=>q.kind==='question'&&q.recordId&&q.id===id);if(!issue)return;
  if(dialog.open&&current?.id===id)return;
  const workspace=snapshot.automation.id,record=snapshot.results.find(r=>r.id===issue.recordId),session={id,workspace};current=session;
  dialog.replaceChildren();dialog.dataset.questionId=id;
  const head=el('header',null,'record-question-head'),heading=el('div'),title=el('h2',record?.title??'Kayıt için soru');title.id='record-question-title';
  heading.append(el('span','YANIT BEKLİYOR','record-question-eyebrow'),title);
  if(record?.url){const source=el('p',new URL(record.url).hostname.replace(/^www\./,''),'record-question-source');heading.append(source);}
  const close=button('×',()=>dialog.close(),'record-question-close');close.setAttribute('aria-label','Kapat');head.append(heading,close);
  const body=el('div',null,'record-question-body'),message=el('p',issue.message,'record-question-message');message.id='record-question-message';dialog.setAttribute('aria-describedby',message.id);
  const form=questionForm(workspace,{id,question:issue.message,fields:issue.fields},async value=>{
   await api.workspaceAnswer(workspace,id,value);
   if(current===session)dialog.close();
   await refresh();
  });
  body.append(message,form);
  const footer=el('footer',null,'record-question-footer'),tools=el('div',null,'record-question-tools'),feedback=el('p',null,'record-question-feedback'),choices=el('div',null,'record-question-tabs');feedback.setAttribute('role','status');
  const tab=button('Sekmeye git ↗',async()=>{tab.disabled=true;feedback.textContent='';try{
   const tabs=attentionTabs(issue,await api.workspaceTabs(workspace),snapshot?.sources??[]);if(current!==session)return;
   if(!tabs.length)throw Error('Bu kayda ait açık sekme bulunamadı.');
   if(tabs.length===1){await api.focusWorkspaceTab(workspace,tabs[0].tabId);return;}
   choices.replaceChildren(el('p','Açık sekmeyi seç:'));
   for(const item of tabs)choices.append(button(item.url,async()=>{try{await api.focusWorkspaceTab(workspace,item.tabId);choices.replaceChildren();}catch(error){feedback.textContent=error.message;}}));
  }catch(error){feedback.textContent=error.message;}finally{tab.disabled=false;}});
  const attach=button('Belge ekle',async()=>{attach.disabled=true;feedback.textContent='';try{const added=await api.pickDocument(workspace);if(added&&current===session){feedback.textContent='Belge eklendi. Yanıtını gönderdiğinde agent inceleyecek.';await refresh();}}catch(error){feedback.textContent=error.message;}finally{attach.disabled=false;}});
  tools.append(tab,attach);
  if(issue.canDismissRecord){const dismiss=button('Atla',async()=>{
   const controls=[...dialog.querySelectorAll('button,input,textarea,select')],disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);feedback.textContent='';
   try{await api.automationDismiss(workspace,issue.recordId);if(current===session)dialog.close();await refresh();}catch(error){feedback.textContent=error.message;}finally{controls.forEach((c,n)=>c.disabled=disabled[n]);}
  },'quiet record-question-dismiss');dismiss.dataset.recordDismiss=issue.recordId;dismiss.title='Bu kaydı atla ve bu kayda ait bekleyen soruları kapat';tools.append(dismiss);}
  footer.append(tools,choices,feedback);dialog.append(head,body,footer);
  if(!dialog.open)dialog.showModal();
  form.querySelector('input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled)')?.focus({preventScroll:true});
 }
 return {open,update(value){
  snapshot=value;
  if(current&&(!value||value.automation.id!==current.workspace||!value.automation.questions.some(q=>q.id===current.id&&q.answer==null)))dialog.close();
 }};
}
