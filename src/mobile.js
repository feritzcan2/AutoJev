// Mobile entry: install the HTTP bridge, run the desktop renderer unchanged, then adapt a few touch-only details.
import './mobile/web-api.js';
import './renderer.js';
import './mobile/mobile.css';

const $=id=>document.getElementById(id);
const api=window.jobloop;

// A phone keyboard cannot drive a full-screen terminal comfortably; a message box sends the same keystrokes.
const composer=document.createElement('form');
composer.id='mobile-composer';composer.className='mobile-composer';
composer.innerHTML='<label for="mobile-composer-text">Agent’a yaz</label><textarea id="mobile-composer-text" rows="3" placeholder="Agent çalışırken yazdığın mesaj doğrudan terminaline gider"></textarea><div class="mobile-composer-foot"><small id="mobile-composer-note"></small><button class="primary" type="submit">Gönder</button></div>';
$('agent').insertBefore(composer,$('agent').querySelector('.terminal-section'));
const text=$('mobile-composer-text'),note=$('mobile-composer-note');
composer.onsubmit=async event=>{
  event.preventDefault();
  const candidate=$('candidates').value,message=text.value.trim();
  if(!candidate){note.textContent='Önce bir aday seç.';return;}
  if(!message)return;
  const button=composer.querySelector('button');button.disabled=true;note.textContent='Gönderiliyor…';
  try{await api.input(candidate,message);await api.input(candidate,'\r');text.value='';note.textContent='Gönderildi.';}
  catch(error){note.textContent=error.message;}
  finally{button.disabled=false;}
};
$('now-write').onclick=()=>{composer.scrollIntoView({behavior:'smooth',block:'center'});text.focus();};

// Keep the selected tab visible in the scrolling bottom bar.
for(const button of document.querySelectorAll('aside nav button[data-view]'))button.addEventListener('click',()=>button.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'}));

// Notices: tap to dismiss, and clear on their own so they never cover the page for long.
const box=$('notice');let noticeTimer;
box.addEventListener('click',()=>{box.hidden=true;});
new MutationObserver(()=>{clearTimeout(noticeTimer);if(!box.hidden)noticeTimer=setTimeout(()=>{box.hidden=true;},6000);}).observe(box,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['hidden']});
