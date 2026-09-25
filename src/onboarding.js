import {questionForm} from './question-form.js';
import './onboarding.css';
export function onboarding(api,{select,refresh,cancel}){
 const $=id=>document.getElementById(id),root=$('onboarding'),terminal=$('terminal'),terminalHome=terminal.parentElement;let snapshot=null,catalog=[],started=false,busy=false,celebrate=false,questionKey='',profileKey='';
 const error=e=>{$('setup-error').textContent=e.message??String(e);};
 const run=fn=>async(...args)=>{args[0]?.preventDefault?.();if(busy)return;busy=true;$('setup-error').textContent='';render();try{await fn(...args);}catch(e){error(e);}finally{busy=false;render();}};
 function settings(){return{provider:$('setup-provider').value,model:$('setup-model').value,permission:$('setup-permission').value,reasoning:$('setup-reasoning').value,network:$('setup-network').value==='inherit'?null:$('setup-network').value==='true'};}
 function options(){const c=catalog.find(c=>c.id===$('setup-provider').value);if(!c)return;for(const key of ['model','permission','reasoning']){$('setup-'+key).replaceChildren(...c[key==='model'?'models':key==='permission'?'permissions':'reasoning'].map(v=>new Option(v,v)));$('setup-'+key).value='default';}}
 async function ensure(){if(snapshot?.setup&&snapshot.setup.status!=='complete')return snapshot.profile.id;const p=await api.createSetup(settings());await select(p.id);return p.id;}
 async function cv(file){const id=await ensure();const picked=file?await api.importSetupCv(id,file):await api.pickCv(id);await refresh();if(picked)await api.beginSetup(id);await refresh();}
 $('setup-begin').onclick=()=>{started=true;render();};
 $('setup-cv').onclick=run(()=>cv());
 $('setup-link-form').onsubmit=run(async e=>{e.preventDefault();const source=$('setup-link').value.trim();if(!source)throw Error('LinkedIn profil bağlantısını gir');const id=await ensure();await api.beginSetup(id,source);await refresh();});
 // Keep native navigation disabled while accepting an OS file drop through preload.
 $('setup-drop').ondragover=e=>{e.preventDefault();$('setup-drop').classList.add('dragging');};
 $('setup-drop').ondragleave=()=>{$('setup-drop').classList.remove('dragging');};
 $('setup-drop').ondrop=e=>{e.preventDefault();$('setup-drop').classList.remove('dragging');const file=e.dataTransfer.files[0];if(file)run(()=>cv(file))();};
 $('setup-provider').onchange=options;
 $('setup-retry').onclick=run(async()=>{await api.beginSetup(snapshot.profile.id);await refresh();});
 $('setup-review').onsubmit=run(async e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.target));await api.completeSetup(snapshot.profile.id,fields);celebrate=true;await refresh();});
 $('setup-enter').onclick=()=>{celebrate=false;render();};
 $('setup-back').onclick=()=>{started=false;cancel();};
 function text(tag,value){const el=document.createElement(tag);el.textContent=value;return el;}
 function render(){
  const setup=snapshot?.setup,needed=!snapshot||setup&&setup.status!=='complete';root.hidden=!needed&&!celebrate;document.body.classList.toggle('onboarding-active',!root.hidden);if(root.hidden){if(terminal.parentElement!==terminalHome)terminalHome.append(terminal);return;}
  const stage=celebrate?'done':setup?.status==='review'?'review':setup?.status==='running'?'working':started||setup?'intake':'welcome';
  for(const node of root.querySelectorAll('[data-setup-stage]'))node.hidden=node.dataset.setupStage!==stage;
  const order=['intake','working','review'],at=stage==='done'?3:order.indexOf(stage);$('setup-progress').hidden=stage==='welcome';for(const [i,node]of [...$('setup-progress').children].entries())node.dataset.state=i<at?'done':i===at?'current':'pending';
  if(stage==='working'&&terminal.parentElement!==$('setup-terminal'))$('setup-terminal').append(terminal);
  if(snapshot?.active?.state==='AwaitingInput')$('setup-console').open=true;
  $('setup-back').hidden=stage==='working'||stage==='review'||stage==='done';
  for(const button of root.querySelectorAll('button'))button.disabled=busy;
  $('setup-retry').hidden=Boolean(snapshot?.active)||stage!=='working'||(snapshot?.questions??[]).some(q=>q.answer===null);
  $('setup-source-label').textContent=snapshot?.profile.cvPath?.split('/').pop()??'PDF, Word veya TXT';
  $('setup-settings').hidden=Boolean(setup);
  $('setup-status').textContent=setup?.error??setup?.message??(snapshot?.active?.state==='Working'?'Agent setup görevini yürütüyor.':snapshot?.active?.state==='AwaitingInput'?'Agent bir izin veya giriş bekliyor. Aşağıdaki agent ekranını kontrol et.':snapshot?.active?'Agent bağlantısı hazır; setup görevinin başlaması bekleniyor.':'Agent hazırlanıyor…');
  const steps=['reading','preferences','review'],index=steps.indexOf(setup?.stage);
  for(const [i,node]of [...$('setup-steps').children].entries()){node.dataset.state=i<index?'done':i===index?'current':'pending';}
  $('setup-card-name').textContent=snapshot?.profile.name==='Yeni aday'?'Profilin şekilleniyor':snapshot?.profile.name??'Profilin şekilleniyor';
  $('setup-card-facts').textContent=snapshot?.profile.facts||'Deneyimlerin ve yetkinliklerin belgelere göre burada oluşacak.';
  $('setup-card-preferences').textContent=snapshot?.profile.preferences==='Setup sırasında belirlenecek'?'İş tercihlerin sıradaki adımda netleşecek.':snapshot?.profile.preferences??'';
  const questions=(snapshot?.questions??[]).slice().reverse(),key=JSON.stringify(questions);
  if(key!==questionKey){questionKey=key;$('setup-questions').replaceChildren();for(const q of questions){const card=text('div','');card.className='setup-question';card.append(text('p',q.question));if(q.answer!==null){card.append(text('blockquote',q.answer));}else{const owner=snapshot.profile.id;card.append(questionForm(owner,q,async values=>{await api.answer(owner,q.id,values);await refresh();}));}$('setup-questions').append(card);}}
  if(stage==='review'){const key=JSON.stringify([snapshot.profile.name,snapshot.profile.preferences,snapshot.profile.facts]);if(key!==profileKey){profileKey=key;for(const field of ['name','preferences','facts'])$('setup-review').elements[field].value=snapshot.profile[field];}}
  $('setup-ready-name').textContent=`Profilin hazır, ${snapshot?.profile.name.split(' ')[0]??''}.`;
 }
 return {update(value,providers){snapshot=value;if(!catalog.length&&providers.length){catalog=providers;$('setup-provider').replaceChildren(...catalog.filter(c=>c.supported).map(c=>new Option(c.label,c.id)));options();}render();},reset(){snapshot=null;started=false;celebrate=false;profileKey='';questionKey='';$('setup-error').textContent='';render();}};
}
