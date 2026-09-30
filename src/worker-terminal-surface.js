import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {terminalThemeForAppearance} from '@termloop/terminal-surface/xterm';
import {clipboardKeyDecision} from '@termloop/terminal-surface/clipboard';
import {sgrWheelReports,wheelToArrowLines} from '@termloop/terminal-surface/wheel';
import '@xterm/xterm/css/xterm.css';
import '@termloop/terminal-surface/styles';

const font='"JetBrains Mono", "SFMono-Regular", Menlo, monospace';
const fontsReady=Promise.all([400,600].flatMap(weight=>['','italic '].map(style=>document.fonts.load(`${style}${weight} 13px ${font}`)))).catch(()=>{});

// The worker must restore at the saved grid before fitting the current pane.
export class WorkerTerminalSurface {
 constructor(onInput,onResize,onImagePaste){
  this.host=document.createElement('div');this.host.className='terminal-surface';
  this.terminal=new Terminal({fontFamily:font,fontSize:13,fontWeight:400,fontWeightBold:600,lineHeight:1,scrollback:2000,cursorBlink:true,minimumContrastRatio:4.5,theme:terminalThemeForAppearance('dark')});
  this.fit=new FitAddon();this.terminal.loadAddon(this.fit);this.onResize=onResize;
  this.terminal.onData(text=>{if(!this.restoring)onInput(text);});
  this.terminal.onResize(({rows,cols})=>{if(!this.restoring)onResize(rows,cols);});
  this.terminal.attachCustomKeyEventHandler(event=>{
   const decision=clipboardKeyDecision(event,this.terminal.hasSelection());if(!decision.handled)return true;
   event.preventDefault();
   if(decision.action==='copy')void navigator.clipboard.writeText(this.terminal.getSelection()).catch(()=>{});
   else if(decision.action==='paste')void (async()=>{const text=await navigator.clipboard.readText().catch(()=>'');if(text){this.terminal.paste(text);return;}const items=await navigator.clipboard.read().catch(()=>[]);if(items.some(item=>item.types.some(type=>type.startsWith('image/'))))onImagePaste();})();
   return false;
  });
  this.host.addEventListener('paste',event=>{if(event.clipboardData?.getData('text/plain'))return;if([...(event.clipboardData?.items??[])].some(item=>item.kind==='file'&&item.type.startsWith('image/'))){event.preventDefault();event.stopPropagation();onImagePaste();}},true);
  this.host.addEventListener('mousedown',()=>this.terminal.focus());
  this.wheelRemainder=0;
  this.terminal.attachCustomWheelEventHandler(event=>{
   const t=this.terminal,tracking=t.modes.mouseTrackingMode;if(event.type!=='wheel'||t.buffer.active.type!=='alternate'||tracking==='x10')return true;
   const screen=this.host.querySelector('.xterm-screen'),rect=screen.getBoundingClientRect();
   const {lines,remainder}=wheelToArrowLines(event.deltaY,event.deltaMode,rect.height/t.rows||16,this.wheelRemainder);this.wheelRemainder=remainder;
   if(lines&&tracking!=='none')onInput(sgrWheelReports(lines,Math.max(1,Math.min(t.cols,Math.floor((event.clientX-rect.left)/(rect.width/t.cols))+1)),Math.max(1,Math.min(t.rows,Math.floor((event.clientY-rect.top)/(rect.height/t.rows))+1))));
   else if(lines)onInput(((t.modes.applicationCursorKeysMode?'\x1bO':'\x1b[')+(lines<0?'A':'B')).repeat(Math.abs(lines)));
   return false;
  });
 }
 async mount(container){
  container.append(this.host);await fontsReady;if(this.dead)return;
  this.terminal.open(this.host);this.opened=true;this.fitVisible();
  this.observer=new ResizeObserver(()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>this.fitVisible());});this.observer.observe(container);
 }
 fitVisible(){if(!this.dead&&this.opened&&!this.restoring&&this.host.clientWidth&&this.host.clientHeight){this.fit.fit();this.onResize(this.terminal.rows,this.terminal.cols);}}
 async restore(output){
  this.restoring=true;
  // Flush older queued writes before resetting parser modes, cursor and buffers.
  await new Promise(resolve=>this.terminal.write('',resolve));if(this.dead)return;
  this.terminal.reset();if(output.rows&&output.cols)this.terminal.resize(output.cols,output.rows);
  await new Promise(resolve=>this.terminal.write(new Uint8Array(output.bytes),resolve));
 }
 flush(){return new Promise(resolve=>this.terminal.write('',resolve));}
 finishRestore(){this.restoring=false;this.fitVisible();}
 write(bytes,callback){this.terminal.write(bytes,callback);}
 writeln(text){this.terminal.writeln(`\r\n${text}\r\n`);}
 probe(){const buffer=this.terminal.buffer.active,text=[];for(let i=Math.max(0,buffer.length-200);i<buffer.length;i++)text.push(buffer.getLine(i)?.translateToString(true)??'');return {text:text.join('\n'),lines:buffer.length,cursorX:buffer.cursorX,cursorY:buffer.cursorY};}
 dispose(){this.dead=true;cancelAnimationFrame(this.frame);this.observer?.disconnect();this.terminal.dispose();this.host.remove();}
}
