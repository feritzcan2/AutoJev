// A hidden native file input is usable only through a rendered associated UI.
export function uploadDetails(e){
 const rendered=n=>n?.isConnected&&!n.closest('[inert],[aria-hidden="true"]')&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&n.getBoundingClientRect().width>1&&n.getBoundingClientRect().height>1;
 if(!e.isConnected||e.disabled)return null;
 for(let p=e.parentElement;p;p=p.parentElement)if(p.hidden||p.matches('[inert],[aria-hidden="true"]')||getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden'||getComputedStyle(p).opacity==='0')return null;
 const root=e.getRootNode();
 for(let h=root.host;h;h=h.getRootNode().host)if(!rendered(h))return null;
 const labels=[...(e.labels??[])];
 const refs=(e.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>root.getElementById?.(id)).filter(Boolean);
 const linked=e.id?[...root.querySelectorAll('[aria-controls]')].filter(n=>n.getAttribute('aria-controls').split(/\s+/).includes(e.id)):[];
 let localTrigger=false;
 for(let p=e.parentElement,depth=0;p&&depth<2&&!p.matches('form,body');p=p.parentElement,depth++){
  if(p.querySelectorAll('input[type=file]').length!==1)break;
  localTrigger||=[...p.querySelectorAll('button,[role=button]')].some(n=>rendered(n)&&/upload|attach|browse|resume|cv|hochladen|anhängen|anfügen|datei auswählen|yükle|add file|datei hinzufügen|dosya ekle/i.test(n.textContent||n.getAttribute('aria-label')||''));
 }
 if(!rendered(e)&&![...labels,...refs,...linked].some(rendered)&&!localTrigger)return null;
 const explicit=e.getAttribute('aria-label')||refs.map(n=>n.textContent.trim()).join(' ')||labels.map(l=>l.innerText).join(' ')||e.name||'File upload';
 let context='';
 for(let p=e.parentElement,depth=0;p&&depth<4&&!p.matches('form,body');p=p.parentElement,depth++){
  const text=(p.innerText||'').replace(/\s+/g,' ').trim();
  if(text.length>200)continue;
  const cv=/\b(?:resume|résumé|curriculum vitae|cv)\b/i.test(text),letter=/cover\s*letter|anschreiben|ön\s*yazı/i.test(text);
  if(cv!==letter){context=cv?'Resume/CV':'Cover Letter';break;}
 }
 return {label:context&&!/\b(?:resume|résumé|curriculum vitae|cv)\b|cover\s*letter|anschreiben|ön\s*yazı/i.test(explicit)?`${context} — ${explicit}`:explicit,accept:e.accept,multiple:e.multiple};
}

export function validateUploadPurpose(label,filename){
 const name=filename.replace(/\.[^.]+$/,'');
 if(/cover\s*letter|anschreiben|ön\s*yazı/i.test(label)&&/^(?:cv|resume|résumé)(?:[\s._-]|$)/i.test(name))throw Error('CV dosyası ön yazı alanına yüklenemez; doğru ön yazı belgesini seç.');
 if(/\b(?:resume|résumé|curriculum vitae|cv)\b/i.test(label)&&/^(?:cover[\s._-]*letter|anschreiben|ön[\s._-]*yazı)(?:[\s._-]|$)/i.test(name))throw Error('Ön yazı dosyası CV alanına yüklenemez; doğru CV belgesini seç.');
}
