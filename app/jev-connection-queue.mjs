// All regular Chrome profiles share one permission endpoint and foreground
// window. Hold this turn from profile activation through connection setup;
// another workspace must not activate its profile while approval is pending.
const waiting=[];
let active=false;
function advance(){if(!active&&waiting.length){active=true;waiting.shift().start();}}

export function acquireChromeConnection({signal,timeout=30000}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const fail=error=>{
      const index=waiting.indexOf(entry);if(index<0)return;
      waiting.splice(index,1);cleanup();reject(error);
    };
    const abort=()=>fail(signal.reason);
    const timer=setTimeout(()=>fail(Error('Başka bir Chrome bağlantısı izin bekliyor. Bu profil sırayla bağlanacak.')),timeout);
    const entry={start(){
      cleanup();let released=false;
      resolve(()=>{if(released)return;released=true;active=false;advance();});
    }};
    waiting.push(entry);signal?.addEventListener('abort',abort,{once:true});advance();
  });
}
