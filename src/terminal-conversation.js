// Line editing while the provider session is closed. Active sessions receive raw input.
export function terminalConversation({write,submit,columns=()=>100}){
 let chars=[],cursor=0,pasting=false,pending=false;
 const draw=()=>{const width=Math.max(12,columns()-4),start=Math.max(0,cursor-width),visible=chars.slice(start,start+width).join('').replace(/\n/g,'↵'),back=Math.max(0,Math.min(chars.length,start+width)-cursor);write('\r\x1b[2K› '+visible+(back?'\x1b['+back+'D':''));};
 const insert=text=>{const values=Array.from(text);if(chars.length+values.length>12000)return;chars.splice(cursor,0,...values);cursor+=values.length;};
 async function send(){const text=chars.join('').trim();if(!text){draw();return;}pending=true;write('\r\n');try{await submit(text);chars=[];cursor=0;}catch(error){write('\r\n'+error.message+'\r\n');draw();}finally{pending=false;}}
 return {prompt(){write('\x1b[?2004h\r\n');draw();},input(text){
  if(pending)return;
  for(const part of text.match(/\x1b\[(?:200~|201~|[ABCDHF])|\x1b[^\x1b]*|[^\x1b]/gu)??[]){
   if(part==='\x1b[200~'){pasting=true;continue;}if(part==='\x1b[201~'){pasting=false;continue;}
   if(pasting){insert(part.replace(/\r\n?/g,'\n'));continue;}
   if(part==='\r'||part==='\n'){void send();break;}
   if(part==='\x7f'||part==='\b'){if(cursor){chars.splice(--cursor,1);}continue;}
   if(part==='\x03'||part==='\x15'){chars=[];cursor=0;continue;}
   if(part==='\x1b[D'){cursor=Math.max(0,cursor-1);continue;}if(part==='\x1b[C'){cursor=Math.min(chars.length,cursor+1);continue;}
   if(part==='\x1b[H'){cursor=0;continue;}if(part==='\x1b[F'){cursor=chars.length;continue;}
   if(!/[\x00-\x1f\x7f]/.test(part))insert(part);
  }
  if(!pending)draw();
 },get text(){return chars.join('');}};
}
