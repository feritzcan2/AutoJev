const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};

// All web workspaces, including a blank one, start on the same tracking board.
export function automationOverview(root,{button,navigate,performAction}){
 let signature='';
 return {update(data,progress,{busy=false}={}){
  const a=data.automation,sources=data.sources??[],key=JSON.stringify([a.title,a.goal,a.mode,progress,sources.map(s=>[s.name,s.enabled,s.blocked]),busy]);
  if(key===signature)return;signature=key;
  root.replaceChildren();root.className='workspace-overview';root.setAttribute('aria-label','Çalışma alanı özeti');
  const head=el('div',null,'workspace-overview-head'),copy=el('div');
  copy.append(el('span','ÇALIŞMA ALANI','workspace-overview-eyebrow'),el('h2',progress.fresh?'Ne takip etmek istiyorsun?':a.goal||'Çalışma alanını hazırlayalım'),el('p',progress.fresh?'İhtiyacını anlat. Agent kaynakları araştırsın, kriterlerini ve takip tablonu birlikte hazırlayın.':'Kaynakların, kayıtların ve agent’ın yaptığı işlemler bu çalışma alanında toplanır.'));
  const actions=el('div',null,'actions');
  if(progress.primary&&progress.primary.id!=='results'){
   const primary=button(progress.fresh?'Agent ile kur':progress.primary.label,()=>performAction(progress.primary.id),'primary');primary.dataset.overviewAction=progress.primary.id;primary.disabled=busy;actions.append(primary);
  }
  const agent=button('Agent’ı aç',()=>navigate('agent'));agent.dataset.overviewAction='agent';
  if(progress.primary?.id!=='message')actions.append(agent);
  head.append(copy,actions);root.append(head);
  const sections=el('div',null,'workspace-overview-sections');
  for(const [view,title,detail,ready] of [
   ['profile','Profil ve kriterler',progress.reviewed?'Profil onaylandı':a.goal?'Taslağı incele ve tercihlerini kaydet':'Amacını ve tercihlerini birlikte belirleyelim',progress.reviewed],
   ['sources','Kaynaklar',sources.length?`${sources.filter(s=>s.enabled).length} etkin kaynak · ${sources.length} toplam`:'Agent uygun siteleri bulup önersin',sources.length>0],
   ['agent','Agent ve takip',progress.passed?progress.label:progress.reviewed?'Kaynakları denemeye hazır':'Kurulumdan sonra kaynakları dene',progress.passed],
  ]){
   const item=button('',()=>navigate(view),'workspace-overview-section');item.dataset.overviewView=view;
   const icon=el('span',ready?'✓':view==='profile'?'1':view==='sources'?'2':'3','workspace-overview-icon'),text=el('span');icon.dataset.ready=String(ready);icon.setAttribute('aria-hidden','true');
   text.append(el('b',title),el('small',detail));item.append(icon,text,el('span','↗','workspace-overview-arrow'));sections.append(item);
  }
  root.append(sections);
 }};
}
