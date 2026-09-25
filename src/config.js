import './config.css';
const KINDS={start:'Oturum başlangıcı',message:'Görev mesajı',input:'Senin yazdığın'};
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const size=text=>text.length>=1000?`${(text.length/1000).toFixed(1).replace('.0','')}k karakter`:`${text.length} karakter`;
// Text with {{placeholders}} rendered as marks, never as HTML.
function richText(text){const pre=node('pre');const parts=text.split(/(\{\{[^}]+\}\})/);for(const part of parts){if(/^\{\{[^}]+\}\}$/.test(part))pre.append(node('mark','',part.slice(2,-2)));else if(part)pre.append(document.createTextNode(part));}return pre;}
function body(text){const wrap=node('div','prompt-body');const copy=node('button','quiet copy','Kopyala');copy.type='button';copy.onclick=async()=>{try{await navigator.clipboard.writeText(text);copy.dataset.done='';copy.textContent='Kopyalandı';setTimeout(()=>{delete copy.dataset.done;copy.textContent='Kopyala';},1500);}catch{}};const head=node('div','prompt-body-head');head.append(copy);wrap.append(head,richText(text));return wrap;}
function card({title,when,path,text,open=false}){const details=node('details','prompt-card');details.open=open;details.dataset.search=(title+' '+(when??'')+' '+text).toLowerCase();const summary=node('summary');const main=node('span');main.append(node('span','prompt-title',title));if(when)main.append(node('span','prompt-when',when));if(path)main.append(node('code','prompt-path',path));summary.append(main,node('span','prompt-size',size(text)));details.append(summary,body(text));return details;}
export function configPage(api,{notice,relativeTime}){
 const root=document.getElementById('config');
 root.innerHTML=`<div class="config-head"><div><h2>Yapılandırma</h2><p>Agent’a giden her metin burada: çalışma alanı talimatları, görev promptları, beceriler, MCP araçları ve seçili adaya gerçekten gönderilenler. Salt okunur.</p></div><label class="config-search"><input id="config-search" type="search" placeholder="Metinlerde ara" aria-label="Metinlerde ara"><small id="config-search-note"></small></label></div>
<div class="config-body"><nav class="config-nav" aria-label="Bölümler"><a href="#config-sent">Gönderilenler<b></b></a><a href="#config-instructions">Talimatlar<b></b></a><a href="#config-tasks">Görev promptları<b></b></a><a href="#config-skills">Beceriler<b></b></a><a href="#config-tools">MCP araçları<b></b></a></nav>
<div class="config-sections">
<section id="config-sent" class="config-section"><h3>Seçili adaya gönderilenler</h3><p>Bu adayın agent oturumlarına giden gerçek metinler, en yeni üstte. Oturum başlangıcı, kampanya görev mesajları ve terminalden senin yazdıkların.</p><div id="config-sent-list"></div></section>
<section id="config-instructions" class="config-section"><h3>Talimatlar</h3><p>Her oturumda agent’ın önüne konan sabit metinler.</p><div id="config-instructions-list"></div></section>
<section id="config-tasks" class="config-section"><h3>Görev promptları</h3><p>Kampanya her görevi bu şablonlardan biriyle gönderir. Mavi alanlar o anda gerçek değerle dolar.</p><div id="config-tasks-list"></div></section>
<section id="config-skills" class="config-section"><h3>Beceriler</h3><p>Aday çalışma alanına kopyalanan SKILL.md dosyaları. Agent çalışmaya başlamadan bunları okur.</p><div id="config-skills-list"></div></section>
<section id="config-tools" class="config-section"><h3>MCP araçları</h3><p>Agent’ın profil ve başvuru verisine ulaştığı araçlar ve parametreleri. Tarayıcı araçları ayarlara göre ayrıca eklenir. Çerçeveli parametreler zorunlu.</p><div id="config-tools-list" class="tool-list"></div></section>
</div></div>`;
 const $=id=>root.querySelector('#'+id);
 let catalog=null,candidate=null,dirty=true,loading=false;
 const lists={sent:$('config-sent-list'),instructions:$('config-instructions-list'),tasks:$('config-tasks-list'),skills:$('config-skills-list'),tools:$('config-tools-list')};
 for(const a of root.querySelectorAll('.config-nav a'))a.onclick=e=>{e.preventDefault();$(a.getAttribute('href').slice(1)).scrollIntoView({behavior:'smooth',block:'start'});};
 const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){for(const a of root.querySelectorAll('.config-nav a'))a.classList.toggle('active',a.getAttribute('href')==='#'+entry.target.id);}},{rootMargin:'-20% 0px -70% 0px'});
 for(const section of root.querySelectorAll('.config-section'))observer.observe(section);
 function counts(){const query=$('config-search').value.trim().toLowerCase();let shown=0,total=0;for(const [key,list]of Object.entries(lists)){const items=[...list.querySelectorAll('[data-search]')];let visible=0;for(const item of items){const hit=!query||item.dataset.search.includes(query);item.hidden=!hit;if(hit)visible++;}shown+=visible;total+=items.length;const badge=root.querySelector(`.config-nav a[href="#config-${key}"] b`);badge.textContent=query?`${visible}/${items.length}`:String(items.length);list.querySelector('.config-nomatch')?.remove();if(query&&items.length&&!visible){list.append(node('p','config-empty config-nomatch','Bu bölümde eşleşme yok.'));}}$('config-search-note').textContent=query?`${shown} / ${total} eşleşme`:'';}
 $('config-search').oninput=counts;
 function renderCatalog(){
  lists.instructions.replaceChildren(...catalog.instructions.map(p=>card({title:p.title,when:`${p.where} · ${p.when}`,text:p.text,open:p.id==='agents-md'})));
  lists.tasks.replaceChildren(...catalog.tasks.map(p=>card({title:p.title,when:p.when,text:p.text,open:p.id==='search-source'})));
  lists.skills.replaceChildren(...catalog.skills.map(s=>card({title:s.title,when:`${s.usedBy} · ${s.description}`,path:s.path,text:s.text})));
  lists.tools.replaceChildren(...catalog.tools.map(t=>{const el=node('div','tool-card');el.dataset.search=(t.name+' '+t.description+' '+t.params.map(p=>p.name).join(' ')).toLowerCase();el.append(node('code','',t.name),node('p','',t.description));const params=node('div','tool-params');for(const p of t.params){const chip=node('span');chip.dataset.required=String(p.required);chip.append(p.name,node('i','',': '+p.type));params.append(chip);}if(t.params.length)el.append(params);return el;}));
 }
 function renderSent(prompts){
  if(!candidate){lists.sent.replaceChildren(Object.assign(node('div','config-empty'),{innerHTML:'<strong>Önce bir aday seç</strong>Gönderilen promptlar adaya göre tutulur.'}));return;}
  if(!prompts.length){lists.sent.replaceChildren(Object.assign(node('div','config-empty'),{innerHTML:'<strong>Bu adaya henüz prompt kaydedilmedi</strong>Agent’ı başlattığında ilk oturum promptu burada görünür. Daha önceki oturumlar kaydedilmedi.'}));return;}
  lists.sent.replaceChildren(...prompts.map(p=>{const details=node('details','prompt-card sent');details.dataset.search=(KINDS[p.kind]+' '+p.text).toLowerCase();const summary=node('summary');const time=node('time','',relativeTime(p.at,{past:true}));time.dateTime=p.at;time.title=new Date(p.at).toLocaleString('tr-TR');const kind=node('span','prompt-kind',KINDS[p.kind]??p.kind);kind.dataset.kind=p.kind;summary.append(time,kind,node('span','prompt-preview',p.text.replace(/\s+/g,' ').slice(0,160)));details.append(summary,body(p.text));return details;}));
 }
 async function load(){if(root.hidden||loading)return;loading=true;try{if(!catalog){catalog=await api.promptCatalog();renderCatalog();}renderSent(candidate?await api.prompts(candidate):[]);dirty=false;counts();}catch(e){notice(e.message);}finally{loading=false;}}
 return {select(id){if(id!==candidate){candidate=id;dirty=true;}load();},refresh(){dirty=true;load();},show(){if(dirty||!catalog)load();}};
}
