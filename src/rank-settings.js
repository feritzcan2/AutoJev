import {rankCriteria,rankWeights,normalizeRankWeights} from '../app/rank-criteria.mjs';
import './rank-settings.css';

export function createRankSettings({save,notice}){
 const form=document.createElement('form');form.id='rank-settings';form.className='rank-settings';
 form.innerHTML=`<div class="rank-settings-head"><label>Başvuru puan eşiği <input name="threshold" type="number" min="0" max="100" step="1" value="50" required aria-label="Başvuru puan eşiği"></label><button class="quiet" type="submit">Kaydet</button></div>
  <small>Eşiğin üzerindekiler başvuruya alınır. Diğer ilanlar listede kalır.</small>
  <details class="rank-criteria"><summary>Puanlama kriterleri ve oranları</summary>
   <p>Puanlamada kullanılacak kriterleri seç ve toplamı %100 olacak şekilde oranlarını belirle.</p>
   <div class="rank-criteria-list">${Object.entries(rankCriteria).map(([key,{label,description}])=>`<div class="rank-criterion" data-criterion="${key}"><label class="rank-criterion-choice"><input name="${key}Enabled" type="checkbox"><span><b>${label}</b><small>${description}</small></span></label><label class="rank-criterion-weight"><input name="${key}" type="number" min="1" max="100" step="1" required aria-label="${label} oranı (%)"><span>%</span></label></div>`).join('')}</div>
   <div class="rank-criteria-foot"><output class="rank-weight-total" aria-live="polite"></output><button class="quiet" type="button" data-defaults>Varsayılan oranlar</button></div>
   <small>Kaydettiğinde mevcut ve yeni ilanların toplam puanı bu oranlarla hesaplanır. Kapatılan kriter toplam puanı etkilemez.</small>
  </details>`;
 const fields=form.elements,submit=form.querySelector('[type=submit]'),total=form.querySelector('output'),keys=Object.keys(rankCriteria);
 let owner=null,dirty=false,saving=false,revision=0,remembered={...rankWeights};
 const weights=()=>Object.fromEntries(keys.map(key=>[key,fields[`${key}Enabled`].checked?fields[key].valueAsNumber:0]));
 function validate(){
  const value=weights(),sum=Object.values(value).reduce((a,b)=>a+b,0);let valid=true;
  try{normalizeRankWeights(value);}catch{valid=false;}
  for(const key of keys){
   const enabled=fields[`${key}Enabled`].checked;
   fields[key].disabled=!owner||!enabled||saving;
   fields[`${key}Enabled`].disabled=!owner||saving;
   form.querySelector(`[data-criterion="${key}"]`).dataset.enabled=String(enabled);
   if(enabled&&(!Number.isInteger(value[key])||value[key]<1||value[key]>100))valid=false;
  }
  total.textContent=Number.isFinite(sum)?`Toplam %${sum}${valid?'':' · %100 olmalı'}`:'Her seçili kritere bir oran gir';
  total.dataset.valid=String(valid);
  fields.threshold.disabled=!owner||saving;
  form.querySelector('[data-defaults]').disabled=!owner||saving;
  submit.disabled=!owner||saving||!valid;
 }
 function fill(profile){
  const value=profile?.rankWeights??rankWeights;fields.threshold.value=profile?.rankThreshold??50;
  remembered={...rankWeights};
  for(const key of keys){fields[key].value=value[key];fields[`${key}Enabled`].checked=value[key]>0;if(value[key]>0)remembered[key]=value[key];}
  validate();
 }
 form.addEventListener('input',event=>{
  dirty=true;revision++;
  for(const key of keys)if(event.target===fields[`${key}Enabled`]){
   if(event.target.checked)fields[key].value=remembered[key];
   else{if(fields[key].valueAsNumber>0)remembered[key]=fields[key].valueAsNumber;fields[key].value=0;}
  }
  validate();
 });
 form.querySelector('[data-defaults]').onclick=()=>{fill({rankThreshold:fields.threshold.value,rankWeights});dirty=true;revision++;};
 form.onsubmit=async event=>{
  event.preventDefault();if(!owner||saving||submit.disabled||!form.reportValidity())return;
  const candidate=owner,version=revision;
  try{
   const input={threshold:fields.threshold.valueAsNumber,weights:normalizeRankWeights(weights())};saving=true;validate();
   const result=await save(candidate,input);
   if(owner===candidate&&revision===version){dirty=false;fill({rankThreshold:result.threshold,rankWeights:result.weights});notice('Puanlama ayarları kaydedildi.');}
  }catch(error){notice(error.message);}finally{saving=false;validate();}
 };
 return {element:form,update(candidate,profile){if(owner!==candidate){owner=candidate;dirty=false;revision++;}if(!dirty)fill(profile);else validate();}};
}
