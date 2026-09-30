import {recordTable,recordCell,recordState,recordActions} from './record-table.js';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const collator=new Intl.Collator('tr',{numeric:true,sensitivity:'base'});
const source=result=>{try{return new URL(result.url).hostname.replace(/^www\./,'');}catch{return 'Kaynak';}};

export function automationResultsTable(root,{button,badge,time,api,refresh,statusNames}){
 let data,busy=false,page=1,sort='updatedAt',direction=-1;
 const expanded=new Set(),pageSize=10;
 const toolbar=el('div',null,'automation-results-toolbar'),search=el('input'),filter=el('select'),pagination=el('div',null,'jobs-pagination'),content=el('div');
 search.type='search';search.id='automation-result-search';search.placeholder='Sonuçlarda ara…';search.setAttribute('aria-label','Sonuçlarda ara');
 filter.id='automation-result-filter';filter.setAttribute('aria-label','Sonuç durumunu filtrele');
 for(const [value,label] of [['all','Tüm kayıtlar'],['starred','★ Yıldızlılar'],['found','Bulunanlar'],['prepared','İşlem taslakları'],['completed','Tamamlananlar'],['uncertain','Doğrulama bekleyenler'],['dismissed','Atlananlar'],['trial','Araştırma ve deneme örnekleri']])filter.add(new Option(label,value));
 toolbar.append(search,filter);root.previousElementSibling.append(toolbar);root.replaceChildren(pagination,content);
 search.oninput=filter.onchange=()=>{page=1;render();};

 function render(){
  if(!data)return;
  const query=search.value.trim().toLocaleLowerCase('tr-TR').split(/\s+/).filter(Boolean);
  const results=data.results.filter(r=>(filter.value==='all'||(filter.value==='trial'?r.trial:filter.value==='starred'?r.starred:!r.trial&&recordState(r,data.definition).id===filter.value))&&query.every(q=>[r.title,r.summary,r.url,...Object.values(r.cells??{}),recordState(r,data.definition).label].join(' ').toLocaleLowerCase('tr-TR').includes(q)));
  const columns=data.automation.table?.columns??[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Kayıt',type:'text'}];
  if(!['status','updatedAt',...columns.map(c=>c.key)].includes(sort)){sort='updatedAt';direction=-1;}
  const value=r=>sort==='source'?source(r):sort==='status'?recordState(r,data.definition).label??r.status:sort==='title'||sort==='updatedAt'?r[sort]:r.cells?.[sort]??'';
  const numeric=sort==='updatedAt'||['number','money'].includes(columns.find(c=>c.key===sort)?.type);
  results.sort((a,b)=>{const av=value(a),bv=value(b);if(av===''||bv==='')return av===bv?0:av===''?1:-1;return direction*(numeric?Number(av)-Number(bv):collator.compare(av,bv))||collator.compare(a.id,b.id);});
  const pages=Math.max(1,Math.ceil(results.length/pageSize));page=Math.min(page,pages);
  const start=(page-1)*pageSize,visible=results.slice(start,start+pageSize);
  pagination.replaceChildren(el('span',results.length?`${start+1}–${start+visible.length} / ${results.length} kayıt`:'0 kayıt','pagination-count'));
  if(pages>1){const previous=button('Önceki',()=>{page--;render();}),next=button('Sonraki',()=>{page++;render();});previous.disabled=page===1;next.disabled=page===pages;pagination.append(previous,el('span',`${page} / ${pages}`),next);}
  content.replaceChildren();
  const {wrap,table,body}=recordTable([...columns,{key:'status',label:'Durum'},{key:'updatedAt',label:'Son aktivite'},{key:null,label:'İşlemler'}],{className:'jobs-table automation-results-table',header:(th,{key,label})=>{
   if(key){th.setAttribute('aria-sort',sort===key?(direction===1?'ascending':'descending'):'none');const control=button(label+(sort===key?(direction===1?' ↑':' ↓'):''),()=>{direction=sort===key?-direction:key==='updatedAt'?-1:1;sort=key;page=1;render();},'sort-button');control.dataset.resultSort=key;th.replaceChildren(control);}
  }});
  table.setAttribute('aria-label','Takip kayıtları ve sonuçlar');table.style.minWidth=(columns.length>5?1000+(columns.length-5)*110:columns.length>2?900:620)+'px';content.append(wrap);
  if(!visible.length){const row=el('tr'),cell=el('td',null,'empty');cell.colSpan=columns.length+3;cell.append(el('strong',data.results.length?'Bu arama veya filtreye uyan sonuç yok.':'Henüz kayıt yok'),el('p',data.results.length?'Farklı bir arama veya filtre deneyebilirsin.':'Agent’ın bulduğu kayıtlar, hazırladığı taslaklar ve işlem sonuçları burada görünecek.'));row.append(cell);body.append(row);}
  for(const result of visible){
   const row=el('tr'),state=el('td'),updated=el('td',null,'automation-result-time'),actionsCell=el('td'),actions=el('div',null,'table-actions');row.dataset.resultId=result.id;
   for(const column of columns){const cell=el('td');cell.dataset.column=column.key;
    if(column.key==='source'){cell.className='company-cell';const heading=el('div',null,'company-heading'),star=button(result.starred?'★':'☆',async()=>{await api.automationStar(data.automation.id,result.id,!result.starred);await refresh();},'job-star');star.setAttribute('aria-label',result.starred?'Yıldızı kaldır':'Yıldızla');star.setAttribute('aria-pressed',String(Boolean(result.starred)));heading.append(star,el('span',source(result)));cell.append(heading);}
    else if(column.key==='title'){cell.className='role-cell';const heading=el('strong',result.title);heading.title=result.title;cell.append(heading);}
    else{row.append(recordCell(column,result.cells?.[column.key],{openLink:url=>api.openLink(url)}));continue;}
    row.append(cell);
   }
   state.dataset.column='status';updated.dataset.column='updatedAt';actionsCell.dataset.column='actions';state.append(el('span',recordState(result,data.definition).label,'automation-badge '+result.status));if(result.workflowState&&result.workflowState!==result.status)state.append(badge(result.status));if(result.trial)state.append(el('span',result.sampleKind==='interview'?'Araştırma örneği':'Deneme örneği','automation-trial-label'));
   const date=el('time',time(result.updatedAt));date.dateTime=new Date(result.updatedAt).toISOString();updated.append(date);
   const detailsId='automation-result-detail-'+result.id,detail=button(expanded.has(result.id)?'Kapat':'Detay',()=>{expanded.has(result.id)?expanded.delete(result.id):expanded.add(result.id);render();root.querySelector(`[data-result-detail="${result.id}"]`)?.focus();});detail.dataset.resultDetail=result.id;detail.setAttribute('aria-expanded',String(expanded.has(result.id)));detail.setAttribute('aria-controls',detailsId);
   const open=button('Aç ↗',()=>api.openLink(result.url));open.setAttribute('aria-label',result.title+' · Kaynağı aç');actions.append(open,detail);
   recordActions(actions,result,data.definition,async action=>{try{await api.workspaceTransition(data.automation.id,result.id,action);await refresh();}catch(error){window.alert(error.message);}});
   if(result.status==='prepared'&&!result.trial){
    if(result.approvedDigest===result.digest)state.append(el('span','Onaylandı · Sonraki çalışmada uygulanabilir','automation-approved'));
    else if(data.automation.mode==='prepare'){const approve=button('Bu işlemi onayla',async()=>{await api.automationApprove(data.automation.id,result.id);await refresh();},'primary');approve.dataset.idle='';approve.dataset.approveResult=result.id;actions.append(approve);}
   }
   if(['found','prepared'].includes(result.status)){const dismiss=button('Atla',async()=>{await api.automationDismiss(data.automation.id,result.id);await refresh();});dismiss.dataset.idle='';actions.append(dismiss);}
   for(const control of actions.querySelectorAll('[data-idle]'))control.disabled=busy||Boolean(data.activeRun);
   actionsCell.append(actions);row.append(state,updated,actionsCell);body.append(row);
   const detailRow=el('tr',null,'automation-result-detail'),cell=el('td');detailRow.id=detailsId;detailRow.hidden=!expanded.has(result.id);cell.colSpan=columns.length+3;cell.append(el('p',result.summary));
   if(result.proposal)cell.append(el('h3','İşlem taslağı'),el('pre',result.proposal));
   if(result.evidence)cell.append(el('h3','Sonuç kanıtı'),el('blockquote',result.evidence));
   detailRow.append(cell);body.append(detailRow);
  }
 }
 return {update(snapshot,isBusy){data=snapshot;busy=isBusy;const selected=filter.value;filter.replaceChildren(new Option('Tüm kayıtlar','all'),new Option('★ Yıldızlılar','starred'),...(data.definition?.records.states??[]).map(s=>new Option(s.label,s.id)),new Option('Araştırma ve deneme örnekleri','trial'));if([...filter.options].some(o=>o.value===selected))filter.value=selected;render();}};
}
