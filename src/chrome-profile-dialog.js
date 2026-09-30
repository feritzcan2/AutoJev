export function createChromeProfileDialog({loadProfiles,save}){
 const dialog=document.createElement('dialog');dialog.className='chrome-profile-dialog';
 dialog.setAttribute('aria-labelledby','chrome-profile-title');
 dialog.innerHTML='<form><h2 id="chrome-profile-title">Chrome profilini değiştir</h2><p>Bu çalışma alanının kullanacağı Chrome profilini seç. Çalışan işler duraklatılır; bağlantı kurulduktan sonra yeniden başlatabilirsin.</p><label>Chrome profili<select name="profile" aria-describedby="chrome-profile-message"></select></label><p id="chrome-profile-message" role="status"></p><div class="chrome-profile-actions"><button type="button" class="quiet" data-cancel>Vazgeç</button><button type="submit" class="primary">Seç ve bağlan</button></div></form>';
 const select=dialog.querySelector('select'),message=dialog.querySelector('[role=status]'),submit=dialog.querySelector('[type=submit]'),cancel=dialog.querySelector('[data-cancel]');
 let owner=null,profiles=[],pending=false,request=0;
 cancel.onclick=()=>dialog.close();
 dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
 dialog.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(pending||submit.disabled)return;
  pending=true;select.disabled=submit.disabled=cancel.disabled=true;message.textContent='Profil kaydediliyor ve bağlantı yenileniyor…';
  try{await save(owner,profiles.find(profile=>profile.directory===select.value)??null);dialog.close();}
  catch(error){message.textContent=error.message;}
  finally{pending=false;select.disabled=submit.disabled=cancel.disabled=false;}
 };
 return {element:dialog,async show(workspace){
  if(dialog.open)return;owner=workspace;const token=++request;
  select.replaceChildren(new Option('Profiller yükleniyor…',''));select.disabled=submit.disabled=true;message.textContent='';dialog.showModal();
  try{
   profiles=await loadProfiles();if(token!==request||!dialog.open)return;
   select.replaceChildren(new Option('Son kullanılan Chrome profili',''),...profiles.map(profile=>new Option(`${profile.name} — ${profile.directory}`,profile.directory)));
   const selected=workspace.chromeProfile;
   if(selected&&!profiles.some(profile=>profile.directory===selected.directory)){
    const missing=new Option(`${selected.name} — ${selected.directory} (bulunamadı)`,selected.directory);missing.disabled=true;select.add(missing);
    message.textContent='Kayıtlı profil bulunamadı. Başka bir profil seç.';
   }else if(!profiles.length)message.textContent='Chrome profili bulunamadı. Chrome’da bir profil oluşturup tekrar dene.';
   select.value=selected?.directory??'';select.disabled=false;
   const validate=()=>{submit.disabled=!profiles.length||Boolean(select.selectedOptions[0]?.disabled);};select.onchange=validate;validate();select.focus();
  }catch(error){if(token===request&&dialog.open)message.textContent=error.message;}
 }};
}
