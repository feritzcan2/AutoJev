import './readiness.css';

const node=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
export function readinessPanel(api,root,{getSettings=()=>({})}={}){
 let result=null,key='',version=0,settingsVersion=0,busy=false;
 if(!api.readiness){root.hidden=true;return {load:async()=>null,ensure:async()=>null,invalidate(){}};}
 root.classList.add('readiness-card');
 const heading=node('div'),title=node('h4','Başlamadan önce'),button=node('button','Tekrar kontrol et'),summary=node('p','Agent ve tarayıcı kurulumu kontrol edilecek.'),list=node('ul');
 heading.className='readiness-heading';button.type='button';button.className='quiet';summary.setAttribute('role','status');heading.append(title,button);root.append(heading,summary,list);
 function render(){
  button.disabled=busy;button.textContent=busy?'Kontrol ediliyor…':'Tekrar kontrol et';
  summary.textContent=busy?'Agent ve tarayıcı kurulumu kontrol ediliyor…':result?result.ready?'Kurulum kontrolü tamamlandı. Aşağıdaki bağlantı notlarını gözden geçir.':'Başlamak için aşağıdaki eksikleri tamamla.':'Agent ve tarayıcı kurulumu kontrol edilecek.';
  list.replaceChildren(...(result?.checks??[]).map(check=>{const row=node('li'),label=node('b',check.label),detail=node('span',check.detail);row.dataset.state=check.state;label.prepend(node('span',check.state==='ready'?'✓ ':check.state==='error'?'! ':'• '));row.append(label,detail);return row;}));
 }
 async function check(settings){
  const request=++version;busy=true;render();
  try{settings??=await getSettings();if(request!==version)return null;key=JSON.stringify(settings);const next=await api.readiness(settings);if(request!==version)return null;result=next;render();return next;}
  catch(error){if(request===version){result={ready:false,checks:[{id:'failed',label:'Kurulum kontrolü',state:'error',detail:error.message??'Kontrol tamamlanamadı. Tekrar dene.'}]};render();}return result;}
  finally{if(request===version){busy=false;render();}}
 }
 button.onclick=()=>check();
 return {
  async load(){const request=++settingsVersion;try{const settings=await getSettings();if(request!==settingsVersion)return null;return JSON.stringify(settings)!==key?check(settings):result;}catch(error){if(request!==settingsVersion)return null;version++;busy=false;result={ready:false,checks:[{id:'failed',label:'Kurulum kontrolü',state:'error',detail:error.message??'Ayarlar okunamadı.'}]};render();return result;}},
  async ensure(){const next=await check();if(!next?.ready)throw Error(next?.checks.find(check=>check.state==='error')?.detail??'Kurulum kontrolünü tamamla.');return next;},
  invalidate(){version++;settingsVersion++;key='';result=null;busy=false;render();}
 };
}
