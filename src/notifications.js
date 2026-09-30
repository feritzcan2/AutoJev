import {telegramPanel} from './telegram.js';

export function notificationsPage(api,{notice}){
 const root=document.createElement('section');root.id='notifications';root.hidden=true;root.setAttribute('aria-labelledby','notifications-title');
 root.innerHTML=`<div class="notifications-head"><h2 id="notifications-title">Bildirim ayarları</h2><p>Seçili çalışma alanının Telegram bağlantısını ve hangi bildirimleri alacağını yönet.</p></div><div id="notifications-telegram"></div>`;
 document.getElementById('config').before(root);
 const nav=document.createElement('button');nav.type='button';nav.dataset.view='notifications';
 nav.innerHTML='<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span>Bildirimler</span>';
 document.querySelector('aside nav button[data-view="config"]').before(nav);
 const panel=api.telegramStatus?telegramPanel(api,root.querySelector('#notifications-telegram'),{notice}):null;
 if(!panel)root.querySelector('#notifications-telegram').textContent='Bu sürümde Telegram bildirimleri kullanılamıyor.';
 return {select(id){panel?.select(id);},show(id){panel?.select(id);}};
}
