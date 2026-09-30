import {defaultPermission} from '../app/agent-settings.mjs';
import {questionForm} from './question-form.js';
import {browserWaitView} from './browser-status.js';
import {readinessPanel} from './readiness.js';
import './onboarding.css';
export function onboarding(api,{select,refresh,cancel,showProfile}){
 const $=id=>document.getElementById(id),root=$('onboarding');let enabled=!api.automationTemplates,snapshot=null,catalog=[],started=false,busy=false,celebrate=false,questionKey='',profileKey='',sessionKey='';
 const error=e=>{$('setup-error').textContent=e.message??String(e);};
 const run=fn=>async(...args)=>{args[0]?.preventDefault?.();if(busy)return;busy=true;$('setup-error').textContent='';render();try{await fn(...args);}catch(e){error(e);}finally{busy=false;render();}};
 function settings(){return{provider:$('setup-provider').value,model:$('setup-model').value,permission:$('setup-permission').value,reasoning:$('setup-reasoning').value,network:$('setup-network').value==='inherit'?null:$('setup-network').value==='true'};}
 const readiness=readinessPanel(api,$('setup-readiness'),{getSettings:()=>({provider:snapshot?.profile.agentSettings?.provider??$('setup-provider').value??'codex',browserMode:snapshot?.profile.browserMode??'jev',chromeProfile:snapshot?.profile.chromeProfile??null})});
 function options(){const c=catalog.find(c=>c.id===$('setup-provider').value);if(!c)return;for(const key of ['model','permission','reasoning']){$('setup-'+key).replaceChildren(...c[key==='model'?'models':key==='permission'?'permissions':'reasoning'].map(v=>new Option(v,v)));$('setup-'+key).value=key==='permission'?defaultPermission(c.id):'default';}}
 async function ensure(){if(snapshot?.setup&&snapshot.setup.status!=='complete')return snapshot.profile.id;const p=await api.workspaceCreate('job-search',{intake:true,agentSettings:settings()});await select(p.id);return p.id;}
 async function cv(file){await readiness.ensure();const id=await ensure();const picked=file?await api.importSetupCv(id,file):await api.pickDocument(id,{purpose:'cv'});await refresh();if(picked)await api.beginSetup(id);await refresh();}
 $('setup-begin').onclick=()=>{started=true;render();};
 $('setup-cv').onclick=run(()=>cv());
 $('setup-link-form').onsubmit=run(async e=>{e.preventDefault();const source=$('setup-link').value.trim();if(!source)throw Error('LinkedIn profil bağlantısını gir');await readiness.ensure();const id=await ensure();await api.beginSetup(id,source);await refresh();});
 // Keep native navigation disabled while accepting an OS file drop through preload.
 $('setup-drop').ondragover=e=>{e.preventDefault();$('setup-drop').classList.add('dragging');};
 $('setup-drop').ondragleave=()=>{$('setup-drop').classList.remove('dragging');};
 $('setup-drop').ondrop=e=>{e.preventDefault();$('setup-drop').classList.remove('dragging');const file=e.dataTransfer.files[0];if(file)run(()=>cv(file))();};
 $('setup-provider').onchange=()=>{options();readiness.load();};
 $('setup-retry').onclick=run(async()=>{await api.beginSetup(snapshot.profile.id);await refresh();});
 $('setup-review').onsubmit=run(async e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.target)),improving=snapshot.setup.mode==='improve';await api.completeSetup(snapshot.profile.id,fields);celebrate=!improving;await refresh();if(improving)showProfile();});
 $('setup-improve-continue').onclick=run(async()=>{const form=$('setup-review');if(!form.reportValidity())return;await api.saveProfile({...Object.fromEntries(new FormData(form)),id:snapshot.profile.id});await api.beginSetup(snapshot.profile.id);await refresh();});
 $('setup-enter').onclick=()=>{celebrate=false;render();};
 $('setup-back').onclick=run(async()=>{if(snapshot?.setup?.mode==='improve'&&snapshot.setup.status!=='complete'){await api.finishProfileImprovement(snapshot.profile.id);await refresh();showProfile();}else{started=false;await cancel();}});
 function text(tag,value){const el=document.createElement(tag);el.textContent=value;return el;}
 function render(){
  if(!enabled){root.hidden=true;document.body.classList.remove('onboarding-active');return;}
  const browserWait=browserWaitView(snapshot);
  const setup=snapshot?.setup,needed=!snapshot||setup&&setup.status!=='complete';root.hidden=!needed&&!celebrate;document.body.classList.toggle('onboarding-active',!root.hidden);if(root.hidden)return;
  const improving=setup?.mode==='improve',key=JSON.stringify([snapshot?.profile.id,setup?.startedAt]);
  if(key!==sessionKey){sessionKey=key;profileKey='';questionKey='';$('setup-console').open=improving;}
  const questions=(snapshot?.questions??[]).filter(q=>!improving||!q.jobId&&!(setup.excludedQuestionIds??[]).includes(q.id));
  root.querySelector('.setup-working h1').textContent=improving?'Profilini birlikte geliştirelim.':'Profilin hazırlanıyor.';
  root.querySelector('.setup-review > p').textContent=improving?'Güncellenen profilini kontrol et. İstersen agent ile konuşmaya devam edebilirsin.':'Agent’ın çıkardığı bilgileri düzelt, istediğini ekle. Başvuru yetkisi senin seçimin.';
  root.querySelector('.setup-after > p').textContent=improving?'Değişikliklerin profilinde kaydedilir. İş aramaya devam etmek için çalışma alanında Devam et düğmesini kullan.':'Her şeyi sonradan Aday profili sayfasından değiştirebilirsin.';
  root.querySelector('.setup-after ol').hidden=improving;
  $('setup-review').elements.facts.required=!improving;
  $('setup-review').querySelector('[type=submit]').textContent=improving?'Değişiklikleri kaydet':'Profilimi onayla';
  $('setup-improve-continue').hidden=!improving;
  $('setup-progress').firstElementChild.textContent=improving?'Profil':'CV';
  $('setup-steps').firstElementChild.textContent=improving?'Profilini inceleme':'Belgelerini okuma';
  $('setup-back').textContent=improving?'← Profile dön':'← Çalışma alanına dön';
  $('setup-back').title=improving?'Sohbeti kapatır; agent’ın kaydettiği profil değişiklikleri korunur.':'';
  $('setup-retry').textContent=improving?'Agent ile devam et':'Setup’a devam et';
  const stage=celebrate?'done':setup?.status==='review'?'review':setup?.status==='running'?'working':started||setup?'intake':'welcome';
  if(stage==='intake'&&catalog.length)readiness.load();
  for(const node of root.querySelectorAll('[data-setup-stage]'))node.hidden=node.dataset.setupStage!==stage;
  const order=['intake','working','review'],at=stage==='done'?3:order.indexOf(stage);$('setup-progress').hidden=stage==='welcome';for(const [i,node]of [...$('setup-progress').children].entries())node.dataset.state=i<at?'done':i===at?'current':'pending';
  if(snapshot?.active?.state==='AwaitingInput')$('setup-console').open=true;
  $('setup-back').hidden=!improving&&(stage==='working'||stage==='review'||stage==='done');
  for(const button of root.querySelectorAll('button'))button.disabled=busy;
  $('setup-retry').hidden=Boolean(snapshot?.active)||Boolean(browserWait)||stage!=='working'||questions.some(q=>q.answer===null);
  $('setup-source-label').textContent=snapshot?.profile.cvPath?.split('/').pop()??'PDF, Word veya TXT';
  $('setup-settings').hidden=Boolean(setup);
  $('setup-status').textContent=browserWait?.detail??setup?.error??setup?.message??(snapshot?.active?.state==='Working'?'Agent setup görevini yürütüyor.':snapshot?.active?.state==='AwaitingInput'?'Agent bir izin veya giriş bekliyor. Aşağıdaki agent ekranını kontrol et.':snapshot?.active?'Agent bağlantısı hazır; setup görevinin başlaması bekleniyor.':'Agent hazırlanıyor…');
  const steps=['reading','preferences','review'],index=steps.indexOf(setup?.stage);
  for(const [i,node]of [...$('setup-steps').children].entries()){node.dataset.state=i<index?'done':i===index?'current':'pending';}
  $('setup-card-name').textContent=snapshot?.profile.name==='Yeni aday'?'Profilin şekilleniyor':snapshot?.profile.name??'Profilin şekilleniyor';
  $('setup-card-facts').textContent=snapshot?.profile.facts||'Deneyimlerin ve yetkinliklerin belgelere göre burada oluşacak.';
  $('setup-card-preferences').textContent=snapshot?.profile.preferences==='Setup sırasında belirlenecek'?'İş tercihlerin sıradaki adımda netleşecek.':snapshot?.profile.preferences??'';
  const questionsKey=JSON.stringify(questions);
  if(questionsKey!==questionKey){questionKey=questionsKey;$('setup-questions').replaceChildren();for(const q of questions.slice().reverse()){const card=text('div','');card.className='setup-question';card.append(text('p',q.question));if(q.answer!==null){card.append(text('blockquote',q.answer));}else{const owner=snapshot.profile.id;card.append(questionForm(owner,q,async values=>{await api.answer(owner,q.id,values);await refresh();}));}$('setup-questions').append(card);}}
  if(stage==='review'){const key=JSON.stringify([snapshot.profile.id,snapshot.profile.name,snapshot.profile.preferences,snapshot.profile.facts,snapshot.profile.authorization]);if(key!==profileKey){profileKey=key;for(const field of ['name','preferences','facts','authorization'])$('setup-review').elements[field].value=snapshot.profile[field];}}
  $('setup-ready-name').textContent=`Profilin hazır, ${snapshot?.profile.name.split(' ')[0]??''}.`;
 }
 return {setEnabled(value){enabled=value;render();},update(value,providers){snapshot=value;if(!catalog.length&&providers.length){catalog=providers;$('setup-provider').replaceChildren(...catalog.filter(c=>c.supported).map(c=>new Option(c.label,c.id)));options();}render();},reset(){enabled=true;snapshot=null;started=false;celebrate=false;profileKey='';questionKey='';readiness.invalidate();$('setup-error').textContent='';render();}};
}
