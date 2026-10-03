export function browserWaitView(snapshot){
 const {profile,browserStatus:status,campaign,setup,active}=snapshot??{};
 if(!profile||status?.ready||!(campaign?.status==='running'&&campaign.browserWait||setup?.status==='running'&&setup.browserWait))return null;
 const starting=!active,connecting=status?.state==='connecting';
 return {
  starting,
  title:connecting?'Chrome izni bekleniyor':'Chrome bağlantısı bekleniyor',
  detail:starting?'Agent henüz başlatılmadı. Chrome bağlantısı hazır olana kadar bekleyecek.':'İşin kaydedildi. Chrome bağlantısı hazır olduğunda aynı görev sürdürülecek.',
  instruction:'Chrome’daki “Allow remote debugging?” penceresinde Allow / İzin ver düğmesine bas. Bağlantı kurulunca otomatik devam edilecek.',
  error:status?.state==='waiting'?status.message??'':'',
  canRetry:!connecting
 };
}

export function createBrowserWaitDialog({reconnect,cancel}){
 const dialog=document.createElement('dialog');dialog.className='chrome-approval';
 dialog.setAttribute('aria-labelledby','chrome-approval-title');dialog.setAttribute('aria-describedby','chrome-approval-instruction');
 const reminder=document.createElement('div');reminder.className='chrome-approval-reminder';reminder.hidden=true;
 reminder.innerHTML='<span class="chrome-wait-dot" aria-hidden="true"></span><div><b>Chrome izni bekleniyor</b><small>Bağlantı hazır olunca otomatik devam edilecek.</small></div><button type="button" class="quiet">İzin adımlarını göster</button>';
 dialog.innerHTML=`
  <button class="chrome-approval-close" type="button" aria-label="İzin penceresini küçült" title="Arka planda beklemeye devam et">×</button>
  <div class="chrome-approval-body">
   <div class="chrome-approval-connection" aria-hidden="true"><span class="chrome-approval-jobloop">j.</span><span class="chrome-approval-dots"><i></i><i></i><i></i></span><span class="chrome-approval-chrome"></span></div>
   <p class="chrome-approval-eyebrow">SON BİR ADIM</p>
   <h2 id="chrome-approval-title" tabindex="-1"></h2>
   <p id="chrome-approval-instruction">Chrome’a geç ve açılan izin penceresinde <strong>Allow / İzin ver</strong> düğmesine bas.</p>
   <div class="chrome-approval-steps">
    <div><span class="chrome-step-number">1</span><b>Chrome’a geç</b><kbd class="chrome-switch-shortcut"></kbd></div>
    <div><span class="chrome-step-number">2</span><b>Allow düğmesine bas</b></div>
   </div>
   <figure class="chrome-prompt-example">
    <figcaption>CHROME’DA GÖRECEĞİN PENCERE <span>Örnek</span></figcaption>
    <div class="chrome-prompt-window" aria-hidden="true">
     <b>Allow remote debugging?</b>
     <p>An external app wants full control over this Chrome session to debug it.</p>
     <div class="chrome-prompt-actions"><span class="chrome-prompt-cancel">Cancel</span><span class="chrome-prompt-allow">Allow <svg viewBox="0 0 20 20" fill="none"><path d="m5 10 3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>
    </div>
    <p>İzni Chrome’un kendi penceresinde ver.</p>
   </figure>
   <div class="chrome-approval-progress" role="status"><span class="chrome-wait-dot" aria-hidden="true"></span><span>Onayını bekliyoruz</span><small>Otomatik devam edecek</small></div>
   <p class="chrome-approval-detail"></p>
   <p class="chrome-approval-error" role="alert" hidden></p>
  </div>
  <div class="chrome-approval-footer"><button class="chrome-approval-cancel" type="button">Başlatmayı iptal et</button><div><button class="quiet chrome-approval-retry" type="button" hidden>Yeniden bağlan</button><button class="chrome-approval-dismiss" type="button">Arka planda bekle <span aria-hidden="true">↘</span></button></div></div>`;
 const title=dialog.querySelector('h2'),detail=dialog.querySelector('.chrome-approval-detail'),error=dialog.querySelector('.chrome-approval-error');
 const retryButton=dialog.querySelector('.chrome-approval-retry'),cancelButton=dialog.querySelector('.chrome-approval-cancel');
 const shortcut=dialog.querySelector('kbd');shortcut.textContent=/Mac/i.test(navigator.platform)?'⌘ Tab':'Alt Tab';
 let current=null,owner=null,episode=null,dismissed=false,pending=false,externalBusy=false;
 const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
 const buttons=()=>{retryButton.disabled=cancelButton.disabled=externalBusy||pending;};
 const show=()=>{if(!current)return;dismissed=false;reminder.hidden=true;if(!dialog.open){dialog.showModal();title.focus({preventScroll:true});}};
 const dismiss=()=>{dismissed=true;dialog.close();reminder.hidden=!current;};
 const perform=async action=>{if(pending)return;pending=true;buttons();error.hidden=true;try{await action();}catch(e){text(error,e.message);error.hidden=false;}finally{pending=false;buttons();}};
 dialog.querySelector('.chrome-approval-close').onclick=dismiss;
 dialog.querySelector('.chrome-approval-dismiss').onclick=dismiss;
 dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
 reminder.querySelector('button').onclick=show;
 retryButton.onclick=()=>perform(()=>reconnect(owner));
 cancelButton.onclick=()=>perform(()=>cancel(owner));
 return {element:dialog,reminder,show,update(snapshot,busy=false){
  current=browserWaitView(snapshot);owner=snapshot?.profile?.id;externalBusy=busy;buttons();
  if(!current){episode=null;dismissed=false;dialog.close();reminder.hidden=true;return;}
  const scope=snapshot?.setup?.status==='running'?'setup':'campaign',key=`${owner}:${scope}`;
  if(episode!==key){episode=key;dismissed=false;}
  text(title,current.title);text(detail,current.detail);text(reminder.querySelector('b'),current.title);
  text(dialog.querySelector('.chrome-approval-progress > span:last-of-type'),current.canRetry?'Bağlantı bekleniyor':'Onayını bekliyoruz');
  text(error,current.error);error.hidden=!current.error;
  retryButton.hidden=!current.canRetry;
  cancelButton.hidden=scope==='setup'&&snapshot.setup.mode!=='improve';
  text(cancelButton,scope==='setup'?'Profile dön':current.starting?'Başlatmayı iptal et':'Çalışmayı durdur');
  if(dismissed)reminder.hidden=false;else show();
 }};
}
