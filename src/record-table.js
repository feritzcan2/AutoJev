// Shared table structure and typed values. Templates supply record-specific cells
// and actions, so existing application controls keep their behavior.
export function recordTable(columns,{className='jobs-table',header}={}){
 const wrap=document.createElement('div');wrap.className='jobs-table-wrap';
 const table=document.createElement('table');table.className=className;
 const head=document.createElement('thead'),row=document.createElement('tr'),body=document.createElement('tbody');
 for(const column of columns){const th=document.createElement('th');th.scope='col';th.dataset.column=column.key??'actions';th.textContent=column.label;header?.(th,column);row.append(th);}
 head.append(row);table.append(head,body);wrap.append(table);return {wrap,table,body};
}
export function recordCell(column,value,{openLink}){
 const cell=document.createElement('td');cell.dataset.column=column.key;
 if(value==null||value===''){cell.textContent='—';return cell;}
 if(column.type==='url'){const link=document.createElement('button');link.type='button';link.className='quiet';link.textContent='Aç ↗';link.onclick=()=>openLink(value);cell.append(link);}
 else if(['number','money'].includes(column.type)&&Number.isFinite(Number(value))){cell.textContent=Number(value).toLocaleString('tr-TR',{minimumFractionDigits:column.type==='money'?2:0,maximumFractionDigits:2});cell.className='automation-number-cell';}
 else{const text=document.createElement('span');text.className='automation-cell-text';text.textContent=String(value);text.title=String(value);cell.append(text);}
 return cell;
}
export const recordState=(record,definition)=>{const id=record.workflowState??record.status;return {id,label:definition?.records?.states.find(s=>s.id===id)?.label??id};};
export function recordActions(container,record,definition,onAction){for(const action of definition?.records?.actions??[]){if(!action.from.includes(record.workflowState??record.status))continue;const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=action.label;button.dataset.recordAction=action.id;button.onclick=async()=>{button.disabled=true;try{await onAction(action.id);}finally{button.disabled=false;}};container.append(button);}}
