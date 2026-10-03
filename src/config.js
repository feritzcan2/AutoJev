import './config.css';
import {jevSettingsPanel,dataDisclosure} from './jev-settings.js';
import {captchaSettingsPanel} from './captcha-settings.js';
import {readinessPanel} from './readiness.js';
import {createDataManagement} from './data-management.js';
import {updatesPanel} from './updates.js';
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const size=text=>text.length>=1000?`${(text.length/1000).toFixed(1).replace('.0','')}k karakter`:`${text.length} karakter`;
// Text with {{placeholders}} rendered as marks, never as HTML.
function richText(text){const pre=node('pre');const parts=text.split(/(\{\{[^}]+\}\})/);for(const part of parts){if(/^\{\{[^}]+\}\}$/.test(part))pre.append(node('mark','',part.slice(2,-2)));else if(part)pre.append(document.createTextNode(part));}return pre;}
function body(text){const wrap=node('div','prompt-body');const copy=node('button','quiet copy','Kopyala');copy.type='button';copy.onclick=async()=>{try{await navigator.clipboard.writeText(text);copy.dataset.done='';copy.textContent='Kopyalandı';setTimeout(()=>{delete copy.dataset.done;copy.textContent='Kopyala';},1500);}catch{}};const head=node('div','prompt-body-head');head.append(copy);wrap.append(head,richText(text));return wrap;}
function card({title,when,path,text,open=false}){const details=node('details','prompt-card');details.open=open;details.dataset.search=(title+' '+(when??'')+' '+text).toLowerCase();const summary=node('summary');const main=node('span');main.append(node('span','prompt-title',title));if(when)main.append(node('span','prompt-when',when));if(path)main.append(node('code','prompt-path',path));summary.append(main,node('span','prompt-size',size(text)));details.append(summary,body(text));return details;}
export function configPage(api,{notice,relativeTime,openNotifications}){
 const root=document.getElementById('config');
 root.innerHTML=`<div class="config-head"><div><h2>Yapılandırma</h2><p>Kurulum, yedekler, güncellemeler, bildirimler ve agent’a giden metinler: talimatlar, görev promptları, beceriler ve MCP araçları.</p></div><label class="config-search"><input id="config-search" type="search" placeholder="Metinlerde ara" aria-label="Metinlerde ara"><small id="config-search-note"></small></label></div>
<div class="config-body"><nav class="config-nav" aria-label="Bölümler"><a href="#config-telegram">Bildirimler<b></b></a><a href="#config-readiness">Kurulum kontrolü<b></b></a><a href="#config-jev">Jev<b></b></a><a href="#config-captcha">CAPTCHA<b></b></a><a href="#config-data">Veriler ve yedekler<b></b></a><a href="#config-updates">Güncellemeler<b></b></a><a href="#config-privacy">Veri paylaşımı<b></b></a><a href="#config-instructions">Talimatlar<b></b></a><a href="#config-tasks">Görev promptları<b></b></a><a href="#config-skills">Beceriler<b></b></a><a href="#config-tools">MCP araçları<b></b></a></nav>
<div class="config-sections">
<section id="config-telegram" class="config-section"><h3>Bildirimler</h3><p>Telegram bot bağlantısı ve adaya özel bildirim tercihleri Bildirimler sayfasında.</p><button id="open-notifications" class="primary" type="button">Bildirim ayarlarını aç</button></section>
<section id="config-readiness" class="config-section"><h3>Kurulum kontrolü</h3><div id="config-readiness-panel"></div></section>
<section id="config-captcha" class="config-section"><h3>CAPTCHA</h3><div id="config-captcha-panel"></div></section>
<section id="config-jev" class="config-section"><h3>Jev</h3><div id="config-jev-panel"></div></section>
<section id="config-updates" class="config-section"><div id="config-updates-panel"></div></section>
<section id="config-privacy" class="config-section"><h3>Veri paylaşımı</h3><div id="config-privacy-panel"></div></section>
<section id="config-instructions" class="config-section"><h3>Talimatlar</h3><p>Seçilen çalışma alanının güncel talimatları, kaynaklarına göre bölümler halinde.</p><div id="config-instructions-list"></div></section>
<section id="config-tasks" class="config-section"><h3>Görev promptları</h3><p>Agent görevleri bu şablonlarla başlatılır. Mavi alanlar o anda gerçek değerle dolar.</p><div id="config-tasks-list"></div></section>
<section id="config-skills" class="config-section"><h3>Beceriler</h3><p>Bu çalışma alanı için tanımlı beceri dosyaları. Agent ilgili görevde ihtiyaç duyduğu beceriyi okur.</p><div id="config-skills-list"></div></section>
<section id="config-tools" class="config-section"><h3>MCP araçları</h3><p>Bu çalışma alanındaki görevlerde kullanılan araçlar ve parametreleri. Oturuma sunulan araçlar göreve ve tarayıcı ayarlarına göre daralabilir. Çerçeveli parametreler zorunlu.</p><div id="config-tools-list" class="tool-list"></div></section>
</div></div>`;
 const $=id=>root.querySelector('#'+id);
 let catalog=null,candidate=null,version=0;
 const lists={instructions:$('config-instructions-list'),tasks:$('config-tasks-list'),skills:$('config-skills-list'),tools:$('config-tools-list')};
 // One section at a time; a search query overrides that and shows every section with a hit.
 const tabKey='jobloop-config-tab';let active='telegram';try{active=localStorage.getItem(tabKey)||'telegram';}catch{}
 function layout(){const query=$('config-search').value.trim().toLowerCase();if(![...root.querySelectorAll('.config-nav a:not([hidden])')].some(tab=>tab.getAttribute('href')===`#config-${active}`))active=openNotifications?'telegram':'instructions';for(const section of root.querySelectorAll('.config-section')){const key=section.id.slice(7),tab=root.querySelector(`.config-nav a[href="#config-${key}"]`);if(tab.hidden){section.hidden=true;continue;}const hits=section.querySelectorAll('[data-search]:not([hidden])').length;section.hidden=query?!hits:key!==active;tab.classList.toggle('active',!query&&key===active);tab.classList.toggle('hit',Boolean(query&&hits));tab.setAttribute('aria-current',!query&&key===active?'page':'false');}root.dataset.searching=String(Boolean(query));}
 function open(key){active=key;try{localStorage.setItem(tabKey,key);}catch{}if($('config-search').value){$('config-search').value='';counts();}else layout();if(window.scrollY)window.scrollTo({top:0});}
 for(const a of root.querySelectorAll('.config-nav a'))a.onclick=e=>{e.preventDefault();open(a.getAttribute('href').slice(8));};
 function counts(){const query=$('config-search').value.trim().toLowerCase();let shown=0,total=0;for(const [key,list]of Object.entries(lists)){const items=[...list.querySelectorAll('[data-search]')];let visible=0;for(const item of items){const hit=!query||item.dataset.search.includes(query);item.hidden=!hit;if(hit)visible++;}shown+=visible;total+=items.length;const badge=root.querySelector(`.config-nav a[href="#config-${key}"] b`);badge.textContent=query?`${visible}/${items.length}`:String(items.length);for(const group of list.querySelectorAll('.config-group'))group.hidden=![...group.querySelectorAll('[data-search]')].some(item=>!item.hidden);}$('config-search-note').textContent=query?(shown?`${shown} / ${total} eşleşme`:'Eşleşme yok'):'';layout();}
 $('config-search').oninput=counts;
 function renderCatalog(){
  lists.instructions.replaceChildren();
  const groups=[['system','Sistem talimatları'],['template','Template kuralları'],['workspace','Çalışma alanı bilgileri'],['user','Kullanıcı mesajları'],['tool','Araç bağlamı']];
  for(const [source,label]of groups){
   const parts=catalog.instructions.filter(p=>p.source===source);if(!parts.length)continue;
   const group=node('div','config-group');group.append(node('h4','',label));
   group.append(...parts.map(p=>card({title:p.title,when:p.when,text:p.text})));lists.instructions.append(group);
  }
  lists.tasks.replaceChildren(...catalog.tasks.map(p=>card({title:p.title,when:p.when,text:p.text,open:p.id==='search-source'})));
  lists.skills.replaceChildren(...catalog.skills.map(s=>card({title:s.title,when:`${s.usedBy} · ${s.description}`,path:s.path,text:s.text})));
  lists.tools.replaceChildren(...catalog.tools.map(t=>{const el=node('details','tool-card');el.dataset.search=(t.name+' '+t.description+' '+t.params.map(p=>p.name).join(' ')).toLowerCase();const summary=node('summary'),head=node('span');head.append(node('code','',t.name),node('span','tool-brief',t.description));const required=t.params.filter(p=>p.required).length;summary.append(head,node('span','tool-count',t.params.length?`${t.params.length} parametre${required?`, ${required} zorunlu`:''}`:'parametresiz'));el.append(summary);const body=node('div','tool-body');body.append(node('p','',t.description));if(t.params.length){const params=node('div','tool-params');for(const p of t.params){const chip=node('span');chip.dataset.required=String(p.required);chip.append(p.name,node('i','',': '+p.type));params.append(chip);}body.append(params);}el.append(body);return el;}));
  for(const [key,list]of Object.entries(lists))if(!list.children.length)list.append(node('p','config-empty',key==='skills'?'Bu çalışma alanı için ayrı bir beceri dosyası tanımlı değil.':'Bu çalışma alanında bu bölüm için içerik tanımlı değil.'));
 }
 const captcha=captchaSettingsPanel(api,$('config-captcha-panel'),{notice});
 const jev=jevSettingsPanel(api,$('config-jev-panel'),{notice});
 const readiness=readinessPanel(api,$('config-readiness-panel'),{getSettings:async()=>{if(!candidate)return {};const snapshot=await api.workspaceSnapshot(candidate),profile=snapshot.workspace;return {provider:profile.agentSettings.provider,chromeProfile:profile.chromeProfile};}});
 const dataPanel=api.dataStatus?createDataManagement(api,{notice}):null;
 if(dataPanel)root.querySelector('.config-sections').append(dataPanel.element);else root.querySelector('a[href="#config-data"]').hidden=true;
 const updates=api.updateStatus?updatesPanel(api,$('config-updates-panel'),{notice}):null;
 if(!updates){$('config-updates').hidden=true;root.querySelector('a[href="#config-updates"]').hidden=true;}
 dataDisclosure($('config-privacy-panel'));
 function loadSettings(){captcha.load();jev.load();readiness.load();dataPanel?.load();updates?.load();}
 $('open-notifications').onclick=openNotifications;
 if(!openNotifications){$('config-telegram').hidden=true;root.querySelector('a[href="#config-telegram"]').hidden=true;}
 function clearCatalog(message='İçerikler yükleniyor…'){
  catalog=null;for(const list of Object.values(lists))list.replaceChildren(node('p','config-empty',message));counts();
 }
 async function load(){
  if(root.hidden)return;const request=++version;loadSettings();
  try{
   if(!candidate){clearCatalog('İçerikleri görmek için bir çalışma alanı seç.');return;}
   const next=await api.configurationCatalog(candidate);if(request!==version)return;
   catalog=next;renderCatalog();counts();
  }catch(e){if(request!==version)return;clearCatalog('İçerikler yüklenemedi.');notice(e.message);}
 }
 layout();
 return {open,select(id){if(id===candidate)return;candidate=id;version++;clearCatalog();readiness.invalidate();void load();},refresh(){version++;clearCatalog();void load();},show(){layout();void load();}};
}
