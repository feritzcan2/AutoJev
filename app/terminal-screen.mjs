import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

// Keep terminal state, not a suffix of the byte stream: cursor commands depend
// on every preceding write and on the grid at the time each write happened.
export class TerminalScreen {
 constructor({rows=24,cols=80}={}){
  this.terminal=new headless.Terminal({rows,cols,scrollback:2000,allowProposedApi:true});
  this.serializer=new serialize.SerializeAddon();this.terminal.loadAddon(this.serializer);
  this.queue=Promise.resolve();this.sequence=0;
 }
 write(bytes,sequence){
  const data=Uint8Array.from(bytes);
  this.queue=this.queue.then(()=>new Promise(resolve=>this.terminal.write(data,()=>{this.sequence=sequence;resolve();})));
 }
 resize({rows,cols}){this.queue=this.queue.then(()=>this.terminal.resize(cols,rows));}
 snapshot(sessionId){
  const result=this.queue.then(()=>({bytes:[...Buffer.from(this.serializer.serialize())],rows:this.terminal.rows,cols:this.terminal.cols,sequence:this.sequence,sessionId}));
  this.queue=result.then(()=>{});return result;
 }
 dispose(){return this.queue.then(()=>this.terminal.dispose());}
}
