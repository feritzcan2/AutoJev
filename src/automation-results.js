import {recordTable,recordCell,recordState,recordActions} from './record-table.js';
import {recordOperationStatus,recordActivityAt,recordIsWorking,recordNeedsAnswer} from './record-operation-status.js';
import {recordTabs} from './workspace-tabs.js';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const collator=new Intl.Collator('tr',{numeric:true,sensitivity:'base'});
const source=result=>{try{return new URL(result.url).hostname.replace(/^www\./,'');}catch{return 'Kaynak';}};
const tabIdentity=tabs=>JSON.stringify(tabs.map(({tabId,recordId,runId})=>[tabId,recordId,runId]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));

export function automationResultsTable(root,{button,badge,time,api,refresh,statusNames,onQuestion=()=>{}}){
 let data,busy=false,page=1,sort='updatedAt',direction=-1,scrollLeft=0,disposeTable=()=>{};
 let tabOwner=null,liveTabs=[],liveTabIdentity='[]',tabVersion=0;
 const expanded=new Set(),requests=new Set(),visibleTabButtons=new Map(),pageSize=10;
 const review=el('dialog',null,'automation-record-review'),reviewTitle=el('h2'),reviewSummary=el('p'),proposal=el('pre'),reviewError=el('p'),reviewActions=el('div',null,'actions');
 const cancel=button('Vazgeç',()=>review.close()),confirm=button('Onayla ve uygula',()=>{},'primary');
 reviewError.setAttribute('role','alert');reviewActions.append(cancel,confirm);review.append(reviewTitle,reviewSummary,proposal,reviewError,reviewActions);root.append(review);
 let reviewed=null,submitting=false;
 const sendOperation=async(result,kind,input={})=>{const workspace=data.automation.id,key=workspace+':'+result.id;if(requests.has(key))return;requests.add(key);render();try{await api.automationRecordRun(workspace,result.id,kind,input);await refresh();}finally{requests.delete(key);render();}};
 confirm.onclick=async()=>{
  if(!reviewed||submitting)return;submitting=true;confirm.disabled=true;reviewError.textContent='';
  try{await api.automationRecordRun(reviewed.workspace,reviewed.id,'execute',{digest:reviewed.digest});review.close();await refresh();}
  catch(error){reviewError.textContent=error.message;}finally{submitting=false;confirm.disabled=false;}
 };
 const showReview=result=>{
  reviewed={workspace:data.automation.id,id:result.id,digest:result.digest};reviewTitle.textContent=result.title;proposal.textContent=result.proposal;
  reviewSummary.textContent='Bu içerik yalnızca seçtiğin kayıt için uygulanacak. Hedefi, yanıtları ve kullanılacak belgeleri kontrol et.';
  confirm.textContent=data.definition.recordOperations.execute.reviewLabel;reviewError.textContent='';review.showModal();
 };
 const toolbar=el('div',null,'automation-results-toolbar'),search=el('input'),filter=el('select'),pagination=el('div',null,'jobs-pagination'),content=el('div'),activity=el('div',null,'record-activity-summary');activity.setAttribute('role','status');
 search.type='search';search.id='automation-result-search';search.placeholder='Sonuçlarda ara…';search.setAttribute('aria-label','Sonuçlarda ara');
 filter.id='automation-result-filter';filter.setAttribute('aria-label','Sonuç durumunu filtrele');
 for(const [value,label] of [['all','Tüm kayıtlar'],['starred','★ Yıldızlılar'],['found','Bulunanlar'],['prepared','İşlem taslakları'],['completed','Tamamlananlar'],['uncertain','Doğrulama bekleyenler'],['dismissed','Atlananlar'],['trial','Araştırma ve deneme örnekleri']])filter.add(new Option(label,value));
 toolbar.append(search,filter);root.previousElementSibling.append(toolbar);root.replaceChildren(activity,pagination,content,review);
 search.oninput=filter.onchange=()=>{page=1;render();};

 function syncTabButtons(){
  for(const {result,control,actions,open} of visibleTabButtons.values()){
   if(recordTabs(result,liveTabs,data).length){if(!control.isConnected)actions.insertBefore(control,open);}
   else control.remove();
  }
 }
 async function refreshTabs(){
  if(!tabOwner||data?.automation.browserMode!=='jev')return;
  const id=tabOwner,version=++tabVersion;
  const next=await api.workspaceTabs(id).catch(()=>[]);
  if(tabOwner!==id||version!==tabVersion)return;
  const identity=tabIdentity(next),changed=identity!==liveTabIdentity;liveTabs=next;liveTabIdentity=identity;
  if(changed)render();else syncTabButtons();
 }
 const tabTimer=setInterval(()=>{if(root.isConnected&&root.getClientRects().length)void refreshTabs();},1000);

 function render(){
  if(!data)return;
  const active=data.results.filter(r=>recordOperationStatus(r)?.active),queued=active.filter(r=>r.recordAction?.task?.state==='pending').length,waiting=data.results.filter(recordNeedsAnswer).length;
  activity.replaceChildren();activity.hidden=!active.length;if(active.length){activity.append(el('span',`${active.length} kayıt işlemde · ${queued} sırada${waiting?` · ${waiting} yanıt bekliyor`:""}`),button(filter.value==='active'?'Tüm kayıtları göster':'İşlemdeki kayıtları göster',()=>{filter.value=filter.value==='active'?'all':'active';page=1;render();}));}
  const query=search.value.trim().toLocaleLowerCase('tr-TR').split(/\s+/).filter(Boolean);
  const results=data.results.filter(r=>(filter.value==='all'||(filter.value==='waiting'?recordNeedsAnswer(r):filter.value==='active'?recordOperationStatus(r)?.active:filter.value==='trial'?r.trial:filter.value==='starred'?r.starred:!r.trial&&recordState(r,data.definition).id===filter.value))&&query.every(q=>[r.title,r.summary,r.url,...Object.values(r.cells??{}),recordState(r,data.definition).label,recordOperationStatus(r)?.label??''].join(' ').toLocaleLowerCase('tr-TR').includes(q)));
  const openIds=new Set(liveTabs.length?results.filter(result=>recordTabs(result,liveTabs,data).length).map(result=>result.id):[]);
  const columns=data.automation.table?.columns??[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Kayıt',type:'text'}];
  if(!['status','updatedAt',...columns.map(c=>c.key)].includes(sort)){sort='updatedAt';direction=-1;}
  const value=r=>sort==='source'?source(r):sort==='status'?recordOperationStatus(r)?.label??recordState(r,data.definition).label??r.status:sort==='updatedAt'?recordActivityAt(r):sort==='title'?r[sort]:r.cells?.[sort]??'';
  const numeric=sort==='updatedAt'||['number','money'].includes(columns.find(c=>c.key===sort)?.type);
  const priority=result=>recordNeedsAnswer(result)?0:openIds.has(result.id)?1:recordIsWorking(result)?2:3;
  results.sort((a,b)=>{const rank=priority(a)-priority(b);if(rank)return rank;const av=value(a),bv=value(b);if(av===''||bv==='')return av===bv?0:av===''?1:-1;return direction*(numeric?Number(av)-Number(bv):collator.compare(av,bv))||collator.compare(a.id,b.id);});
  const pages=Math.max(1,Math.ceil(results.length/pageSize));page=Math.min(page,pages);
  const start=(page-1)*pageSize,visible=results.slice(start,start+pageSize);
  pagination.replaceChildren(el('span',results.length?`${start+1}–${start+visible.length} / ${results.length} kayıt`:'0 kayıt','pagination-count'));
  if(pages>1){const previous=button('Önceki',()=>{page--;render();}),next=button('Sonraki',()=>{page++;render();});previous.disabled=page===1;next.disabled=page===pages;pagination.append(previous,el('span',`${page} / ${pages}`),next);}
  disposeTable();visibleTabButtons.clear();content.replaceChildren();
  const {element,table,body,dispose}=recordTable([{key:'updatedAt',label:'Son aktivite'},...columns,{key:'status',label:'Durum'}],{className:'jobs-table automation-results-table',scrollLeft,onScroll:value=>{scrollLeft=value;},header:(th,{key,label})=>{
   if(key){th.setAttribute('aria-sort',sort===key?(direction===1?'ascending':'descending'):'none');const control=button(label+(sort===key?(direction===1?' ↑':' ↓'):''),()=>{direction=sort===key?-direction:key==='updatedAt'?-1:1;sort=key;page=1;render();},'sort-button');control.dataset.resultSort=key;th.replaceChildren(control);}
  }});
  disposeTable=dispose;table.setAttribute('aria-label','Takip kayıtları ve sonuçlar');table.style.minWidth=(columns.length>5?820+(columns.length-5)*110:columns.length>2?720:560)+'px';content.append(element);
  if(!visible.length){const row=el('tr'),cell=el('td',null,'empty');cell.colSpan=columns.length+2;cell.append(el('strong',data.results.length?'Bu arama veya filtreye uyan sonuç yok.':'Henüz kayıt yok'),el('p',data.results.length?'Farklı bir arama veya filtre deneyebilirsin.':'Agent’ın bulduğu kayıtlar, hazırladığı taslaklar ve işlem sonuçları burada görünecek.'));row.append(cell);body.append(row);}
  for(const result of visible){
   const progress=recordOperationStatus(result),requesting=requests.has(data.automation.id+':'+result.id);
   const row=el('tr'),state=el('td'),updated=el('td',null,'automation-result-time'),actionsPanel=el('div',null,'record-row-actions'),actions=el('div',null,'table-actions'),actionsToggle=button('⋯',()=>{
    if(actionsPanel.matches(':popover-open')){actionsPanel.hidePopover();return;}
    actionsPanel.showPopover();const trigger=actionsToggle.getBoundingClientRect(),width=actionsPanel.offsetWidth,height=actionsPanel.offsetHeight;
    actionsPanel.style.left=Math.max(8,Math.min(trigger.right-width,innerWidth-width-8))+'px';
    actionsPanel.style.top=(trigger.bottom+height+8<=innerHeight?trigger.bottom+4:Math.max(8,trigger.top-height-4))+'px';
   },'record-row-menu');row.dataset.resultId=result.id;row.dataset.needsAnswer=String(recordNeedsAnswer(result));row.dataset.working=String(recordIsWorking(result));row.dataset.openTab=String(openIds.has(result.id));row.dataset.outcome=!progress&&!requesting?result.status:'';actionsPanel.popover='auto';actionsPanel.id='record-row-actions-'+result.id;actionsToggle.setAttribute('aria-controls',actionsPanel.id);actionsToggle.setAttribute('aria-expanded','false');actionsToggle.setAttribute('aria-label',result.title+' · İşlemler');actionsToggle.title='İşlemler';actionsPanel.addEventListener('toggle',()=>actionsToggle.setAttribute('aria-expanded',String(actionsPanel.matches(':popover-open'))));
   row.append(updated);
   for(const column of columns){const cell=el('td');cell.dataset.column=column.key;
    if(column.key==='source'){cell.className='company-cell';const heading=el('div',null,'company-heading'),star=button(result.starred?'★':'☆',async()=>{await api.automationStar(data.automation.id,result.id,!result.starred);await refresh();},'job-star');star.setAttribute('aria-label',result.starred?'Yıldızı kaldır':'Yıldızla');star.setAttribute('aria-pressed',String(Boolean(result.starred)));const name=el('span',source(result));name.title=source(result);heading.append(star,name);cell.append(heading);}
    else if(column.key==='title'){cell.className='role-cell';const heading=el('strong',result.title);heading.title=result.title;cell.append(heading);
     if(recordIsWorking(result)){const worker=data.workers?.find(w=>w.id===result.recordAction.task.workerId),mark=el('span','Agent çalışıyor'+(worker?.name?' · '+worker.name:''),'record-working-badge');cell.prepend(mark);}
     if(recordNeedsAnswer(result)){
      const question=result.recordAction.question,mark=el('span','Yanıt bekliyor','record-question-badge'),preview=el('span',question.text,'record-question-preview'),reply=button('Soruyu yanıtla',()=>onQuestion(question.id),'record-question-link');
      preview.title=question.text;reply.dataset.recordQuestion=question.id;reply.setAttribute('aria-label',result.title+' · Soruyu yanıtla');cell.append(mark,preview,reply);
     }}
    else{row.append(recordCell(column,result.cells?.[column.key],{openLink:url=>api.openLink(url)}));continue;}
    row.append(cell);
   }
   state.dataset.column='status';updated.dataset.column='updatedAt';state.append(el('span',requesting?'Sıraya ekleniyor':progress?.label??recordState(result,data.definition).label,'automation-badge '+(requesting?'queued':progress?.tone??result.status)));if(progress?.detail){const detail=el('span',progress.detail,'record-operation-detail');detail.title=progress.detail;state.append(detail);}if(result.workflowState&&result.workflowState!==result.status)state.append(badge(result.status));if(result.trial)state.append(el('span',result.sampleKind==='interview'?'Araştırma örneği':'Deneme örneği','automation-trial-label'));
   const activityDate=new Date(recordActivityAt(result)),date=el('time');date.dateTime=activityDate.toISOString();date.title=time(recordActivityAt(result));date.append(el('span',activityDate.toLocaleDateString('tr-TR')),el('span',activityDate.toLocaleTimeString('tr-TR'),'automation-result-clock'));updated.append(date);
   const detailsId='automation-result-detail-'+result.id,detail=button(expanded.has(result.id)?'Kapat':'Detay',()=>{expanded.has(result.id)?expanded.delete(result.id):expanded.add(result.id);render();root.querySelector(`[data-result-detail="${result.id}"]`)?.focus();});detail.dataset.resultDetail=result.id;detail.setAttribute('aria-expanded',String(expanded.has(result.id)));detail.setAttribute('aria-controls',detailsId);
   const open=button('Aç ↗',()=>{if(actionsPanel.matches(':popover-open'))actionsPanel.hidePopover();api.openLink(result.url);});open.setAttribute('aria-label',result.title+' · Kaynağı aç');
   const tabWorkspace=data.automation.id,tabFeedback=el('span',null,'record-tab-feedback'),tabChoices=el('div',null,'record-tab-choices');tabFeedback.setAttribute('role','status');
   const focusTab=async tab=>{try{await api.focusWorkspaceTab(tabWorkspace,tab.tabId);tabChoices.replaceChildren();tabFeedback.textContent='';if(actionsPanel.matches(':popover-open'))actionsPanel.hidePopover();}catch(error){tabFeedback.textContent=error.message;void refreshTabs();}};
   const goToTab=button('Sekmeye git',async()=>{
    tabFeedback.textContent='';tabChoices.replaceChildren();
    try{const version=++tabVersion,openTabs=await api.workspaceTabs(tabWorkspace);
     if(tabOwner!==tabWorkspace)return;
     if(version===tabVersion){const identity=tabIdentity(openTabs),changed=identity!==liveTabIdentity;liveTabs=openTabs;liveTabIdentity=identity;if(changed)render();else syncTabButtons();}
     const current=data.results.find(item=>item.id===result.id),tabs=current?recordTabs(current,openTabs,data):[];
     if(!tabs.length){tabFeedback.textContent='Bu kaydın açık sekmesi bulunamadı.';return;}
     if(tabs.length===1){await focusTab(tabs[0]);return;}
     tabFeedback.textContent='Açık sekmeyi seç:';for(const tab of tabs)tabChoices.append(button(tab.url,()=>focusTab(tab)));
    }catch(error){tabFeedback.textContent=error.message;void refreshTabs();}
   });goToTab.dataset.recordTab=result.id;actions.append(open,detail);visibleTabButtons.set(result.id,{result,control:goToTab,actions,open});
   if(openIds.has(result.id))actions.insertBefore(goToTab,open);
   recordActions(actions,result,data.definition,async action=>{try{await api.workspaceTransition(data.automation.id,result.id,action);await refresh();}catch(error){window.alert(error.message);}});
   const recordAction=result.recordAction;
   if(recordAction?.retryOperation){
    const op=recordAction.retryOperation,retry=button(requesting?'Sıraya ekleniyor…':'Tekrar dene',async()=>{
     if(op.review){showReview(result);return;}
     try{await sendOperation(result,op.kind,op.direct?{direct:true}:{});}catch(error){window.alert(error.message);}
    },'record-retry');
    retry.dataset.recordRetry=result.id;retry.disabled=busy||requesting||op.disabled;
    retry.title=op.reason??(op.kind==='verify'?'Yeniden göndermeden önce işlemin sonucunu doğrula.':'Son yarım kalan işlemi yeniden dene.');state.append(retry);
   }
   if(recordAction?.directOperation&&!recordAction.task){
    const op=recordAction.directOperation,apply=button(requesting?'Sıraya ekleniyor…':op.label,async()=>{try{await sendOperation(result,'execute',{direct:true});}catch(error){window.alert(error.message);}},'primary');
    apply.dataset.recordDirect='execute';apply.disabled=busy||requesting||op.disabled;
    apply.title=op.reason??'Agent gerekli bilgileri kontrol edip bu kayıt için işlemi tamamlar. Eksik bilgi varsa sana sorar.';actions.append(apply);
   }
   if(recordAction?.operation){
    const op=recordAction.operation,action=button(requesting?'Sıraya ekleniyor…':recordAction.task?progress.label:op.kind==='execute'?'İncele ve '+op.label.toLocaleLowerCase('tr'):op.label,async()=>{
     if(op.kind==='execute'){if(actionsPanel.matches(':popover-open'))actionsPanel.hidePopover();showReview(result);return;}
     try{await sendOperation(result,op.kind);}catch(error){window.alert(error.message);}
    },recordAction.directOperation&&!recordAction.task?'':'primary');
    action.dataset.recordOperation=op.kind;action.disabled=busy||requesting||op.disabled;action.title=op.reason??'';actions.append(action);
    if(op.kind==='execute'&&data.definition.recordOperations.prepare){const again=button('Taslağı yeniden hazırla',async()=>{try{await sendOperation(result,'prepare');}catch(error){window.alert(error.message);}});again.disabled=busy||requesting||Boolean(recordAction.task);again.dataset.recordOperation='prepare';actions.append(again);}
   }
   if(['found','prepared'].includes(result.status)){const dismiss=button('Atla',async()=>{await api.automationDismiss(data.automation.id,result.id);await refresh();});dismiss.dataset.recordDismiss=result.id;dismiss.disabled=busy||requesting;dismiss.title='Bu kaydı atla ve bu kayda ait bekleyen soruları kapat';actions.append(dismiss);}
   for(const control of actions.querySelectorAll('[data-idle]'))control.disabled=busy||requesting||Boolean(recordAction?.task);
   actionsPanel.append(actions,tabChoices,tabFeedback);state.append(actionsToggle,actionsPanel);row.append(state);body.append(row);
   const detailRow=el('tr',null,'automation-result-detail'),cell=el('td');detailRow.id=detailsId;detailRow.hidden=!expanded.has(result.id);cell.colSpan=columns.length+2;cell.append(el('p',result.summary));
   if(result.proposal)cell.append(el('h3','İşlem taslağı'),el('pre',result.proposal));
   if(recordAction?.lastTask?.summary)cell.append(el('h3','Son kayıt işlemi'),el('p',recordAction.lastTask.summary));
   if(result.evidence)cell.append(el('h3','Sonuç kanıtı'),el('blockquote',result.evidence));
   detailRow.append(cell);body.append(detailRow);
  }

 }
 return {showQuestions(){search.value='';filter.value='waiting';page=1;render();root.scrollIntoView({block:'start',behavior:'smooth'});},dispose:()=>{clearInterval(tabTimer);tabOwner=null;tabVersion++;disposeTable();},update(snapshot,isBusy){if(data?.automation.id!==snapshot.automation.id){review.close();reviewed=null;scrollLeft=0;}if(tabOwner!==snapshot.automation.id||snapshot.automation.browserMode!=='jev'){liveTabs=[];liveTabIdentity='[]';tabVersion++;}tabOwner=snapshot.automation.id;data=snapshot;busy=isBusy;const selected=filter.value;filter.replaceChildren(new Option('Tüm kayıtlar','all'),new Option('★ Yıldızlılar','starred'),new Option('İşlemdeki kayıtlar','active'),new Option('Yanıt bekleyenler','waiting'),...(data.definition?.records.states??[]).map(s=>new Option(s.label,s.id)),new Option('Araştırma ve deneme örnekleri','trial'));if([...filter.options].some(o=>o.value===selected))filter.value=selected;render();void refreshTabs();}};
}
