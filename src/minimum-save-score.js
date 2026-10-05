export function minimumSaveScoreSettings({save}){
 const element=document.createElement('form');element.className='automation-save-score-settings';
 element.innerHTML='<label>Minimum kayıt puanı<input id="automation-save-score-minimum" type="number" min="0" max="100" step="1" placeholder="Kapalı" aria-describedby="automation-save-score-hint"></label><button id="automation-save-score" type="submit" class="quiet">Kaydet</button><small id="automation-save-score-hint">Yeni sonuçlar bu puanın altındaysa kaydedilmez. Değişiklik sonraki kayıttan itibaren uygulanır; boş bırakırsan eleme yapılmaz.</small><span class="minimum-save-score-status" role="status"></span>';
 const input=element.querySelector('input'),button=element.querySelector('button'),status=element.querySelector('[role=status]');
 let owner=null,baseline='',dirty=false,saving=false,busy=false;
 const render=()=>{input.disabled=saving||busy;button.disabled=saving||busy||!dirty;button.textContent=saving?'Kaydediliyor…':'Kaydet';};
 input.oninput=()=>{dirty=input.value!==baseline;status.textContent='';render();};
 element.onsubmit=async event=>{
  event.preventDefault();if(saving||busy||!dirty||!element.reportValidity())return;
  const id=owner,value=input.value; saving=true;status.textContent='';render();
  try{
   const saved=await save(id,value,{expectedValue:baseline});
   if(owner===id){baseline=String(saved.criteria.save_score_threshold??'');input.value=baseline;dirty=false;status.textContent='Kaydedildi.';}
  }catch(error){if(owner===id)status.textContent=error.message;}
  finally{saving=false;render();}
 };
 return {element,update(a,locked=false){
  if(owner!==a.id){owner=a.id;dirty=false;status.textContent='';}
  if(!dirty&&!saving){baseline=String(a.criteria.save_score_threshold??'');input.value=baseline;}
  busy=locked;render();
 }};
}
