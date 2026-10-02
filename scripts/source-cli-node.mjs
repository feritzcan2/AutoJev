// The upstream commands only use these three Bunli APIs. Keep their handlers,
// schemas and parsers unchanged while running the CLI on Electron's Node runtime.
export const defineCommand=command=>command;
export const option=(schema,metadata={})=>({...metadata,schema});
export async function createCLI(info){
 const commands=[];
 return {command:command=>commands.push(command),async run(){
  const [name,...argv]=process.argv.slice(2),command=commands.find(c=>c.name===name);
  if(['--version','-v'].includes(name)){console.log(info.version);return;}
  if(!name||['--help','-h','help'].includes(name)){
   console.log(`${info.name}: ${info.description}\n`+commands.map(c=>`  ${c.name}  ${c.description}`).join('\n'));return;
  }
  if(!command){console.error(JSON.stringify({code:'UNKNOWN_COMMAND',error:`Unknown command: ${name}`}));process.exitCode=1;return;}
  if(argv.includes('--help')||argv.includes('-h')){
   console.log(`${command.name}: ${command.description}\n`+Object.entries(command.options??{}).map(([key,value])=>`  --${key}${value.short?` (-${value.short})`:''}: ${value.description??''}`).join('\n'));return;
  }
  try{
   const raw={},positional=[],options=command.options??{};
   for(let i=0;i<argv.length;i++){
    const token=argv[i];
    if(token==='--'){positional.push(...argv.slice(i+1));break;}
    if(!token.startsWith('-')){positional.push(token);continue;}
    const equals=token.indexOf('='),flag=token.slice(token.startsWith('--')?2:1,equals<0?undefined:equals);
    const key=token.startsWith('--')?flag:Object.keys(options).find(key=>options[key].short===flag);
    if(!key||!options[key])throw Error(`Unknown flag: ${token}`);
    const value=equals<0?argv[++i]:token.slice(equals+1);
    if(value===undefined||equals<0&&value.startsWith('-'))throw Error(`Missing value for ${token}`);
    raw[key]=raw[key]===undefined?value:[...(Array.isArray(raw[key])?raw[key]:[raw[key]]),value];
   }
   const flags=Object.fromEntries(Object.entries(options).map(([key,option])=>[key,option.schema.parse(raw[key])]));
   await command.handler({flags,positional,signal:new AbortController().signal});
  }catch(error){console.error(JSON.stringify({code:'INVALID_ARGUMENT',error:error.message}));process.exitCode=1;}
 }};
}
