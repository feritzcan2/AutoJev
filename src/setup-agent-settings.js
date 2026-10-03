import {defaultPermission} from '../app/agent-settings.mjs';
import './setup-agent-settings.css';

export function setupAgentSettingsPanel({api,getCatalog,refresh}){
 const root=document.createElement('form');root.id='setup-agent-settings';root.className='setup-agent-settings';root.setAttribute('aria-label','Kurulum agenti ayarları');
 root.innerHTML='<div class="setup-agent-settings-row"><label>Sağlayıcı<select name="provider" aria-label="Kurulum sağlayıcısı"></select></label><label class="setup-agent-model">Model<select name="model" aria-label="Kurulum modeli"></select></label><label>Düşünme düzeyi<select name="reasoning" aria-label="Kurulum düşünme düzeyi"></select></label><button type="submit" class="primary" data-save disabled>Kaydet</button><button type="button" class="quiet" data-restart title="Yalnızca kurulum sohbetini yeni bir oturumla başlat">Yeniden başlat</button></div><details><summary>Diğer agent ayarları</summary><div class="setup-agent-settings-row"><label>İzin modu<select name="permission" aria-label="Kurulum izin modu"></select></label><label>Ağ erişimi<select name="network"><option value="inherit">Sağlayıcı varsayılanı</option><option value="true">Açık</option><option value="false">Kapalı</option></select></label></div></details><p data-hint>Mesajlarda ve uygulamayı yeniden açtığında aynı sohbetten devam eder. Agent ayarlarını değiştirmek veya Yeniden başlat yeni oturum açar.</p><p data-status role="status" hidden></p>';
 const fields=root.elements,save=root.querySelector('[data-save]'),restart=root.querySelector('[data-restart]'),status=root.querySelector('[data-status]');
 let owner=null,settings={},baseline='',signature='',dirty=false,busy=false;
 const providers=()=>getCatalog().filter(p=>p.supported&&['codex','claude','opencode'].includes(p.id));
 function options(saved={}){
  const provider=providers().find(p=>p.id===fields.provider.value);
  for(const name of ['model','reasoning','permission']){
   const values=provider?.[name==='model'?'models':name==='permission'?'permissions':'reasoning']??['default'];
   fields[name].replaceChildren(...values.map(value=>new Option(value,value)));
   // Preserve saved/custom values when the catalog is temporarily unavailable.
   if(saved[name]&&!values.includes(saved[name]))fields[name].add(new Option(saved[name],saved[name]));
   fields[name].value=saved[name]??(name==='permission'?defaultPermission(fields.provider.value):values.includes('default')?'default':values[0]);
  }
  fields.network.disabled=fields.provider.value!=='codex';fields.network.value=saved.network==null?'inherit':String(saved.network);
 }
 function read(){return {...settings,provider:fields.provider.value,model:fields.model.value,reasoning:fields.reasoning.value,permission:fields.permission.value,network:fields.provider.value!=='codex'||fields.network.value==='inherit'?null:fields.network.value==='true',contextRestartTokens:0};}
 function mark(){dirty=JSON.stringify(read())!==baseline;save.disabled=busy||!dirty;restart.disabled=busy||dirty;status.hidden=false;status.textContent=dirty?'Kaydettiğinde kurulum agenti bu ayarlarla yeni bir sohbet oturumu açar.':'Değişiklik yok.';}
 fields.provider.onchange=()=>{options();mark();};root.onchange=mark;
 async function apply(reset){
  if(busy||!owner)return;const id=owner;busy=true;root.inert=true;status.hidden=false;status.textContent=reset?'Yeni sohbet açılıyor…':'Ayarlar kaydediliyor…';
  try{
   if(reset)await api.setupAgentRestart(id);else await api.setupAgentSettings(id,read());
   if(owner===id){dirty=false;signature='';await refresh();status.textContent=reset?'Yeni sohbet oturumu açıldı.':'Kurulum agenti ayarları kaydedildi.';}
  }catch(error){if(owner===id)status.textContent=error.message;}
  finally{busy=false;root.inert=false;save.disabled=!dirty;restart.disabled=dirty;}
 }
 root.onsubmit=event=>{event.preventDefault();if(dirty)void apply(false);};restart.onclick=()=>void apply(true);
 return {element:root,update(id,snapshot){
  const next=snapshot?.setupAgent?.settings??snapshot?.automation?.setupAgentSettings??snapshot?.automation?.agentSettings??{};
  if(owner!==id){owner=id;dirty=false;signature='';status.hidden=true;}
  if(dirty)return;const key=JSON.stringify([id,next,getCatalog()]);if(key===signature)return;signature=key;
  settings={...next,contextRestartTokens:0};fields.provider.replaceChildren(...providers().map(p=>new Option(p.label,p.id)));
  if(![...fields.provider.options].some(p=>p.value===settings.provider))fields.provider.add(new Option(settings.provider,settings.provider));
  fields.provider.value=settings.provider;options(settings);baseline=JSON.stringify(read());save.disabled=true;restart.disabled=busy;
 }};
}
