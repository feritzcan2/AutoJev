export function createJobFilters(select,onChange){
  const options=[...select.options].map(option=>({value:option.value,label:option.textContent}));
  let selected=new Set(['all']);
  try{
    const saved=JSON.parse(localStorage.getItem('job-filters'));
    if(Array.isArray(saved)){
      const valid=saved.map(value=>value==='already_submitted'?'submitted':value).filter(value=>options.some(option=>option.value===value));
      if(valid.length)selected=new Set(valid.includes('all')?['all']:valid);
    }
  }catch{}
  const root=document.createElement('details'),summary=document.createElement('summary'),panel=document.createElement('div'),hint=document.createElement('p');
  root.id=select.id;root.className='job-filters';
  panel.id='job-filter-options';panel.className='job-filter-options';
  panel.setAttribute('role','group');panel.setAttribute('aria-label','Başvuru filtreleri');
  summary.setAttribute('aria-controls',panel.id);
  hint.className='job-filter-hint';hint.textContent='Seçtiklerinden en az birine uyan ilanlar gösterilir.';
  panel.append(hint);
  const inputs=new Map();
  const addOption=({value,label})=>{
    const row=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');
    row.className='job-filter-option';input.type='checkbox';input.value=value;input.setAttribute('aria-controls','jobs');text.textContent=label;
    input.onchange=()=>{
      if(value==='all')selected=new Set(['all']);
      else{
        selected.delete('all');
        if(input.checked)selected.add(value);else selected.delete(value);
        if(!selected.size)selected.add('all');
      }
      update();
      try{localStorage.setItem('job-filters',JSON.stringify([...selected]));}catch{}
      onChange();
    };
    inputs.set(value,input);row.append(input,text);panel.append(row);
  }
  for(const option of options)addOption(option);
  function update(){
    for(const [value,input] of inputs)input.checked=selected.has(value);
    const labels=options.filter(option=>selected.has(option.value)).map(option=>option.label);
    summary.textContent=labels.length===1?labels[0]:`${labels.length} filtre seçili`;
    summary.title=labels.join(', ');summary.setAttribute('aria-label',`Başvuru filtreleri: ${labels.join(', ')}`);
  }
  root.append(summary,panel);select.replaceWith(root);update();
  root.addEventListener('toggle',()=>{
    if(!root.open)return;
    const rect=summary.getBoundingClientRect(),below=window.innerHeight-rect.bottom-12,above=rect.top-12,up=below<Math.min(420,above);
    root.dataset.side=up?'above':'below';panel.style.maxHeight=`${Math.max(120,Math.min(420,up?above:below))}px`;
  });
  root.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&root.open){event.preventDefault();root.open=false;summary.focus();}
  });
  document.addEventListener('pointerdown',event=>{if(!root.contains(event.target))root.open=false;});
  document.addEventListener('focusin',event=>{if(!root.contains(event.target))root.open=false;});
  let definitionKey='';
  return {setTemplate(definition){const states=definition?.personal?definition.records.states:[],key=JSON.stringify(states);if(key===definitionKey)return;definitionKey=key;for(const [value,input]of inputs)if(value.startsWith('state:')){input.closest('label').remove();inputs.delete(value);selected.delete(value);}for(let i=options.length-1;i>=0;i--)if(options[i].value.startsWith('state:'))options.splice(i,1);for(const state of states){const option={value:'state:'+state.id,label:state.label};options.push(option);addOption(option);}if(!selected.size)selected.add('all');update();},get values(){return [...selected];}};
}
