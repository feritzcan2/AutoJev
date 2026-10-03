import {eligibilityLabels,assessmentEligibility,oldScoringMethod} from './scoring-state.js';
import {recordTable,recordCell,recordState,recordActions} from './record-table.js';
import {recordOperationStatus,recordActivityAt,recordIsWorking,recordNeedsAnswer} from './record-operation-status.js';
import {recordTabs} from './workspace-tabs.js';
import {scoreBreakdown} from './score-breakdown.js';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const collator=new Intl.Collator('tr',{numeric:true,sensitivity:'base'});
const source=result=>{try{return new URL(result.url).hostname.replace(/^www\./,'');}catch{return 'Kaynak';}};
const tabIdentity=tabs=>JSON.stringify(tabs.map(({tabId,recordId,runId})=>[tabId,recordId,runId]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
const menuControlKey=control=>{
 for(const key of ['recordMenuAction','recordOperation','recordDirect','recordDismiss','recordAction'])if(control?.dataset[key])return key+':'+control.dataset[key];
};
const positionMenu=(panel,toggle)=>{
 const trigger=toggle.getBoundingClientRect(),width=panel.offsetWidth,height=panel.offsetHeight;
 panel.style.left=Math.max(8,Math.min(trigger.right-width,innerWidth-width-8))+'px';
 panel.style.top=(trigger.bottom+height+8<=innerHeight?trigger.bottom+4:Math.max(8,trigger.top-height-4))+'px';
};

export function automationResultsTable(root,{button,badge,time,api,refresh,statusNames,onQuestion=()=>{}}){
 let data,busy=false,page=1,sort='updatedAt',direction=-1,scrollLeft=0,disposeTable=()=>{};
 let batchSubmitting=false,selectionOwner=null;
 let tabOwner=null,liveTabs=[],liveTabIdentity='[]',tabVersion=0;
 const selectedIds=new Set(),expanded=new Set(),requests=new Set(),visibleTabButtons=new Map(),pageSize=10;
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
 const selection=el('div',null,'record-selection-toolbar'),selectionCount=el('span'),selectionError=el('span',null,'record-selection-error');
 selectionCount.setAttribute('role','status');selectionError.setAttribute('role','alert');
 const eligible=result=>Boolean(result.recordAction?.scoreOperation&&!result.recordAction.scoreOperation.disabled&&!requests.has(data.automation.id+':'+result.id));
 const clearSelection=button('Seçimi temizle',()=>{selectedIds.clear();selectionError.textContent='';render();});
 const scoreSelected=button('Seçilenleri puanla',async()=>{
  if(batchSubmitting||busy||!selectedIds.size||selectedIds.size>100)return;
  const workspace=data.automation.id,ids=[...selectedIds];batchSubmitting=true;selectionError.textContent='';
  for(const id of ids)requests.add(workspace+':'+id);render();
  try{
   await api.automationRecordsScore(workspace,ids);
   if(selectionOwner===workspace)for(const id of ids)selectedIds.delete(id);
   await refresh();
  }catch(error){if(selectionOwner===workspace)selectionError.textContent=error.message;}
  finally{for(const id of ids)requests.delete(workspace+':'+id);batchSubmitting=false;render();}
 },'primary');scoreSelected.dataset.recordsScore='';
 selection.append(selectionCount,scoreSelected,clearSelection,selectionError);root.insertBefore(selection,pagination);


 function syncTabButtons(){
  for(const {result,control,actions,open} of visibleTabButtons.values()){
   if(recordTabs(result,liveTabs,data).length){if(!control.isConnected)actions.insertBefore(control,open);}
   else control.remove();
  }
 }
 async function refreshTabs(){
  if(!tabOwner)return;
  const id=tabOwner,version=++tabVersion;
  const next=await api.workspaceTabs(id).catch(()=>[]);
  if(tabOwner!==id||version!==tabVersion)return;
  const identity=tabIdentity(next),changed=identity!==liveTabIdentity;liveTabs=next;liveTabIdentity=identity;
  if(changed)render();else syncTabButtons();
 }
 const tabTimer=setInterval(()=>{if(root.isConnected&&root.getClientRects().length)void refreshTabs();},1000);
 function positionOpenMenu(){
  const panel=content.querySelector('.record-row-actions:popover-open');
  if(panel)positionMenu(panel,panel.closest('[data-result-id]').querySelector('.record-row-menu'));
 }

 function render(){
  if(!data)return;
  const openMenu=content.querySelector('.record-row-actions:popover-open'),openRow=openMenu?.closest('[data-result-id]'),focused=document.activeElement;
  const focusedAction=openMenu?.contains(focused)?menuControlKey(focused):null,focusedToggle=openRow?.querySelector('.record-row-menu')===focused,menuScroll=openMenu?.scrollTop;
  const previousTable=content.firstElementChild;
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
  const selectable=Boolean(data.definition.recordOperations?.score),visibleEligible=visible.filter(eligible);
  selection.hidden=!selectable||!selectedIds.size;
  selectionCount.textContent=selectedIds.size+' kayıt seçildi';
  scoreSelected.textContent=batchSubmitting?'Sıraya ekleniyor…':`Seçilenleri puanla (${selectedIds.size})`;
  scoreSelected.disabled=busy||batchSubmitting||!selectedIds.size||selectedIds.size>100;
  scoreSelected.title=selectedIds.size>100?'Bir seferde en fazla 100 kayıt puanlanabilir.':'';clearSelection.disabled=batchSubmitting;
  const selectCheckbox=(label,checked,change)=>{const input=el('input');input.type='checkbox';input.checked=checked;input.setAttribute('aria-label',label);input.disabled=busy||batchSubmitting;input.onchange=change;return input;};

  pagination.replaceChildren(el('span',results.length?`${start+1}–${start+visible.length} / ${results.length} kayıt`:'0 kayıt','pagination-count'));
  if(pages>1){const previous=button('Önceki',()=>{page--;render();}),next=button('Sonraki',()=>{page++;render();});previous.disabled=page===1;next.disabled=page===pages;pagination.append(previous,el('span',`${page} / ${pages}`),next);}
  disposeTable();visibleTabButtons.clear();
  const {element,table,body,dispose}=recordTable([...(selectable?[{key:'selection',label:'Seç'}]:[]),{key:'updatedAt',label:'Son aktivite'},...columns,{key:'status',label:'Durum'}],{className:'jobs-table automation-results-table',scrollLeft,onScroll:value=>{scrollLeft=value;},onLayout:positionOpenMenu,header:(th,{key,label})=>{
   if(key==='selection'){
    const count=visibleEligible.filter(result=>selectedIds.has(result.id)).length;
    const selectPage=selectCheckbox('Bu sayfadaki puanlanabilir kayıtları seç',visibleEligible.length>0&&count===visibleEligible.length,()=>{for(const result of visibleEligible)selectPage.checked?selectedIds.add(result.id):selectedIds.delete(result.id);selectionError.textContent='';render();});
    selectPage.indeterminate=count>0&&count<visibleEligible.length;selectPage.disabled||=!visibleEligible.length;selectPage.dataset.recordsSelectPage='';th.replaceChildren(selectPage);
   }else if(key){th.setAttribute('aria-sort',sort===key?(direction===1?'ascending':'descending'):'none');const control=button(label+(sort===key?(direction===1?' ↑':' ↓'):''),()=>{direction=sort===key?-direction:key==='updatedAt'?-1:1;sort=key;page=1;render();},'sort-button');control.dataset.resultSort=key;th.replaceChildren(control);}
  }});
  disposeTable=dispose;table.setAttribute('aria-label','Takip kayıtları ve sonuçlar');table.style.minWidth=(columns.length>5?820+(columns.length-5)*110:columns.length>2?720:560)+'px';content.append(element);
  if(!visible.length){const row=el('tr'),cell=el('td',null,'empty');cell.colSpan=columns.length+2+Number(selectable);cell.append(el('strong',data.results.length?'Bu arama veya filtreye uyan sonuç yok.':'Henüz kayıt yok'),el('p',data.results.length?'Farklı bir arama veya filtre deneyebilirsin.':'Agent’ın bulduğu kayıtlar, hazırladığı taslaklar ve işlem sonuçları burada görünecek.'));row.append(cell);body.append(row);}
  for(const result of visible){
   const progress=recordOperationStatus(result),requesting=requests.has(data.automation.id+':'+result.id);
   const keepMenu=openRow?.dataset.resultId===result.id;
   const row=el('tr'),state=el('td'),updated=el('td',null,'automation-result-time'),actionsPanel=keepMenu?openMenu:el('div',null,'record-row-actions'),actions=el('div',null,'table-actions'),actionsToggle=keepMenu?openRow.querySelector('.record-row-menu'):button('⋯',()=>{
    if(actionsPanel.matches(':popover-open')){actionsPanel.hidePopover();return;}
    actionsPanel.showPopover();positionMenu(actionsPanel,actionsToggle);
   },'record-row-menu');row.dataset.resultId=result.id;row.dataset.needsAnswer=String(recordNeedsAnswer(result));row.dataset.working=String(recordIsWorking(result));row.dataset.openTab=String(openIds.has(result.id));row.dataset.outcome=!progress&&!requesting?result.status:'';actionsPanel.popover='auto';actionsPanel.id='record-row-actions-'+result.id;actionsToggle.setAttribute('aria-controls',actionsPanel.id);actionsToggle.setAttribute('aria-expanded',String(keepMenu));actionsToggle.setAttribute('aria-label',result.title+' · İşlemler');actionsToggle.title='İşlemler';actionsPanel.ontoggle=()=>actionsToggle.setAttribute('aria-expanded',String(actionsPanel.matches(':popover-open')));
   row.dataset.selected=String(selectedIds.has(result.id));
   if(selectable){
    const cell=el('td');cell.dataset.column='selection';
    const checkbox=selectCheckbox(result.title+' · Seç',selectedIds.has(result.id),()=>{checkbox.checked?selectedIds.add(result.id):selectedIds.delete(result.id);selectionError.textContent='';render();root.querySelector(`[data-record-select="${result.id}"]`)?.focus();});
    checkbox.dataset.recordSelect=result.id;checkbox.disabled||=!eligible(result);checkbox.title=result.recordAction?.scoreOperation?.reason??(!eligible(result)?'Bu kayıt şu anda puanlanamaz':'');cell.append(checkbox);row.append(cell);
   }
   row.append(updated);
   for(const column of columns){const cell=el('td');cell.dataset.column=column.key;
    if(column.key==='source'){cell.className='company-cell';const heading=el('div',null,'company-heading'),star=button(result.starred?'★':'☆',async()=>{await api.automationStar(data.automation.id,result.id,!result.starred);await refresh();},'job-star');star.setAttribute('aria-label',result.starred?'Yıldızı kaldır':'Yıldızla');star.setAttribute('aria-pressed',String(Boolean(result.starred)));const name=el('span',source(result));name.title=source(result);heading.append(star,name);cell.append(heading);}
    else if(column.key==='title'){cell.className='role-cell';const heading=el('strong',result.title);heading.title=result.title;cell.append(heading);
     if(recordIsWorking(result)){const worker=data.workers?.find(w=>w.id===result.recordAction.task.workerId),mark=el('span','Agent çalışıyor'+(worker?.name?' · '+worker.name:''),'record-working-badge');cell.prepend(mark);}
     if(recordNeedsAnswer(result)){
      const question=result.recordAction.question,mark=el('span','Yanıt bekliyor','record-question-badge'),preview=el('span',question.text,'record-question-preview'),reply=button('Soruyu yanıtla',()=>onQuestion(question.id),'record-question-link');
      preview.title=question.text;reply.dataset.recordQuestion=question.id;reply.setAttribute('aria-label',result.title+' · Soruyu yanıtla');cell.append(mark,preview,reply);
     }}
    else if(column.key==='score'&&result.assessment){const assessment=result.assessment,score=button(assessment.score===null?'Değerlendirilemedi':`${assessment.score}/100`,()=>{expanded.has(result.id)?expanded.delete(result.id):expanded.add(result.id);render();},'sort-button');score.title=assessment.summary;score.setAttribute('aria-expanded',String(expanded.has(result.id)));score.setAttribute('aria-label',result.title+' · Puanlama gerekçesi');score.dataset.recordScore=result.id;cell.append(score,el('small',eligibilityLabels[assessmentEligibility(assessment)],'record-score-eligibility'));if(oldScoringMethod(assessment))cell.append(el('small','Eski yöntem · yeniden puanla','record-score-stale'));if(assessment.revision!==data.automation.revision)cell.append(el('small','Eski değerlendirme','record-score-stale'));}
    else{row.append(recordCell(column,result.cells?.[column.key],{openLink:url=>api.openLink(url)}));continue;}
    row.append(cell);
   }
   state.dataset.column='status';updated.dataset.column='updatedAt';state.append(el('span',requesting?'Sıraya ekleniyor':progress?.label??recordState(result,data.definition).label,'automation-badge '+(requesting?'queued':progress?.tone??result.status)));if(progress?.detail){const detail=el('span',progress.detail,'record-operation-detail');detail.title=progress.detail;state.append(detail);}if(result.workflowState&&result.workflowState!==result.status)state.append(badge(result.status));if(result.trial)state.append(el('span',result.sampleKind==='interview'?'Araştırma örneği':'Deneme örneği','automation-trial-label'));
   const activityDate=new Date(recordActivityAt(result)),date=el('time');date.dateTime=activityDate.toISOString();date.title=time(recordActivityAt(result));date.append(el('span',activityDate.toLocaleDateString('tr-TR')),el('span',activityDate.toLocaleTimeString('tr-TR'),'automation-result-clock'));updated.append(date);
   const detailsId='automation-result-detail-'+result.id,detail=button(expanded.has(result.id)?'Kapat':'Detay',()=>{expanded.has(result.id)?expanded.delete(result.id):expanded.add(result.id);render();root.querySelector(`[data-result-detail="${result.id}"]`)?.focus();});detail.dataset.resultDetail=result.id;detail.dataset.recordMenuAction='detail';detail.setAttribute('aria-expanded',String(expanded.has(result.id)));detail.setAttribute('aria-controls',detailsId);
   const open=button('Aç ↗',()=>{if(actionsPanel.matches(':popover-open'))actionsPanel.hidePopover();api.openLink(result.url);});open.dataset.recordMenuAction='open';open.setAttribute('aria-label',result.title+' · Kaynağı aç');
   const tabWorkspace=data.automation.id,tabFeedback=keepMenu?actionsPanel.querySelector('.record-tab-feedback'):el('span',null,'record-tab-feedback'),tabChoices=keepMenu?actionsPanel.querySelector('.record-tab-choices'):el('div',null,'record-tab-choices');tabFeedback.setAttribute('role','status');
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
   });goToTab.dataset.recordTab=result.id;goToTab.dataset.recordMenuAction='tab';actions.append(open,detail);visibleTabButtons.set(result.id,{result,control:goToTab,actions,open});
   if(openIds.has(result.id))actions.insertBefore(goToTab,open);
   recordActions(actions,result,data.definition,async action=>{try{await api.workspaceTransition(data.automation.id,result.id,action);await refresh();}catch(error){window.alert(error.message);}});
   const recordAction=result.recordAction;
   if(recordAction?.scoreOperation){
    const op=recordAction.scoreOperation,score=button(requesting?'Sıraya ekleniyor…':recordAction.task?.kind==='score'?progress.label:op.label,async()=>{try{await sendOperation(result,'score');}catch(error){window.alert(error.message);}});
    score.dataset.recordOperation='score';score.disabled=busy||requesting||op.disabled;score.title=op.reason??'İlanı kayıtlı puanlama kriterlerine, profile ve CV’ye göre değerlendir.';actions.append(score);
   }
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
   if(!keepMenu)state.append(actionsToggle);row.append(state);body.append(row);
   if(keepMenu){
    // Keep the connected native popover in the top layer while rebuilding the table.
    state.moveBefore(actionsToggle,null);state.moveBefore(actionsPanel,null);actionsPanel.querySelector('.table-actions').replaceWith(actions);
    if(focusedAction){const control=[...actions.children].find(control=>menuControlKey(control)===focusedAction&&!control.disabled);(control??actionsToggle).focus({preventScroll:true});}
    else if(focusedToggle)actionsToggle.focus({preventScroll:true});
    actionsPanel.scrollTop=menuScroll;
   }else{actionsPanel.append(actions,tabChoices,tabFeedback);state.append(actionsPanel);}
   const detailRow=el('tr',null,'automation-result-detail'),cell=el('td');detailRow.id=detailsId;detailRow.hidden=!expanded.has(result.id);cell.colSpan=columns.length+2+Number(selectable);cell.append(el('p',result.summary));
   if(result.assessment){
    const assessment=result.assessment;cell.append(el('h3',assessment.score===null?'Puanlama · Değerlendirilemedi':`Uygunluk puanı · ${assessment.score}/100`),scoreBreakdown(assessment),el('p',assessment.summary));
    if(oldScoringMethod(assessment))cell.append(el('p','Bu puan önceki yöntemle kaydedildi; sabit tavan uygulanmış olabilir. Güncel uyum puanı için yeniden puanla.','record-score-stale'));
    if(assessment.revision!==data.automation.revision)cell.append(el('p','Profil veya kriterler değişti. Bu değerlendirme eski bilgilere dayanıyor.','record-score-stale'));
    for(const [key,label] of [['strengths','Eşleşmeler'],['gaps','Eksikler'],['uncertainties','Belirsizlikler']])if(assessment[key]?.length){const list=el('ul');for(const note of assessment[key])list.append(el('li',note));cell.append(el('h4',label),list);}
    if(assessment.rubric)cell.append(el('h4','Kullanılan puanlama kriterleri'),el('p',assessment.rubric));
    cell.append(el('blockquote',assessment.evidence),button('Değerlendirilen ilan ↗',()=>api.openLink(assessment.evidenceUrl)),el('small',`Değerlendirme: ${time(assessment.scoredAt)} · Başarı olasılığı değildir.`));
   }
   if(result.proposal)cell.append(el('h3','İşlem taslağı'),el('pre',result.proposal));
   if(recordAction?.lastTask?.summary)cell.append(el('h3','Son kayıt işlemi'),el('p',recordAction.lastTask.summary));
   if(result.evidence)cell.append(el('h3','Sonuç kanıtı'),el('blockquote',result.evidence));
   detailRow.append(cell);body.append(detailRow);
  }
  previousTable?.remove();
  if(openMenu?.isConnected){element.querySelector('.jobs-table-wrap').scrollLeft=scrollLeft;positionOpenMenu();}
 }
 return {showQuestions(){search.value='';filter.value='waiting';page=1;render();root.scrollIntoView({block:'start',behavior:'smooth'});},dispose:()=>{content.querySelector('.record-row-actions:popover-open')?.hidePopover();clearInterval(tabTimer);tabOwner=null;tabVersion++;disposeTable();},update(snapshot,isBusy){if(data?.automation.id!==snapshot.automation.id){content.querySelector('.record-row-actions:popover-open')?.hidePopover();review.close();reviewed=null;scrollLeft=0;page=1;selectedIds.clear();selectionError.textContent='';}if(tabOwner!==snapshot.automation.id){liveTabs=[];liveTabIdentity='[]';tabVersion++;}tabOwner=snapshot.automation.id;data=snapshot;busy=isBusy;selectionOwner=snapshot.automation.id;const currentIds=new Set(data.results.filter(eligible).map(result=>result.id));for(const id of selectedIds)if(!currentIds.has(id)&&!requests.has(selectionOwner+':'+id))selectedIds.delete(id);const selected=filter.value;filter.replaceChildren(new Option('Tüm kayıtlar','all'),new Option('★ Yıldızlılar','starred'),new Option('İşlemdeki kayıtlar','active'),new Option('Yanıt bekleyenler','waiting'),...(data.definition?.records.states??[]).map(s=>new Option(s.label,s.id)),new Option('Araştırma ve deneme örnekleri','trial'));if([...filter.options].some(o=>o.value===selected))filter.value=selected;render();void refreshTabs();}};
}
