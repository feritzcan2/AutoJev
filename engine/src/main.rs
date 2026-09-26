mod hooks;
mod history;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use termloop_agent_runtime::{ObservedSession, spawn_agent_terminal};
use termloop_launch::{AgentObservationLaunch, AgentObservationLaunchTransport, LaunchRequest, CodexProjectTrust, ConversationHandle, McpConnection, PromptTemplate};
use termloop_terminal::{TerminalEvent, TerminalService, TerminalGrid, TerminalGridMemory};
use tokio::io::{AsyncBufReadExt, BufReader};

const TEMPLATE: PromptTemplate = PromptTemplate { id: "jobloop.application-assistant", version: 1, authored_body: "You are JobLoop's job application assistant. Read AGENTS.md and the referenced skills. Read the candidate profile and application history through JobLoop MCP. Work only within the recorded authorization. Report actual work through MCP; never invent submission confirmation." };
const BACKGROUND_TEMPLATE: PromptTemplate = PromptTemplate { id: "jobloop.background-skill", version: 1, authored_body: "You are a temporary JobLoop background worker. Read AGENTS.md and execute only the assigned skill through its scoped MCP tools. Record the result and finish." };
fn emit(value:Value){let mut out=io::stdout().lock();let _=writeln!(out,"{value}");let _=out.flush();}
fn field<'a>(value:&'a Value,key:&str)->Result<&'a str,String>{value[key].as_str().filter(|s|!s.is_empty()).ok_or_else(||format!("Missing {key}"))}
fn now()->u64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}

struct Engine {terminal:TerminalService, observed:Option<ObservedSession>, id:String, output:Option<tokio::task::JoinHandle<()>>}
impl Engine {
    fn stop(&mut self)->Result<(),String>{
        if !self.id.is_empty(){self.terminal.terminate(&self.id).map_err(|e|e.to_string())?;}
        if let Some(mut runtime)=self.observed.take(){runtime.close().map_err(|e|e.to_string())?;}
        if let Some(task)=self.output.take(){task.abort();}
        self.id.clear();Ok(())
    }
    fn command(&mut self,v:&Value)->Result<Value,String>{
        match field(v,"op")? {
            "repair-history"=>{if self.observed.is_some()||!self.id.is_empty(){return Err("Stop the writer before history repair".into());}history::repair(v)}
            "catalog"=>Ok(json!(termloop_agents::agent_catalog().iter().map(|a|json!({"id":a.id,"label":a.label,"models":a.models,"permissions":a.permissions,"reasoning":a.reasoning,"supported":a.id!="gemini"})).collect::<Vec<_>>())),
            "validate"=>{termloop_launch::validate_agent_configuration(field(v,"provider")?,field(v,"model")?,field(v,"permission")?,field(v,"reasoning")?).map_err(|e|e.to_string())?;Ok(json!({}))}
            "hook"=>{let runtime=self.observed.as_mut().ok_or("No agent")?;if v["observation"]["sessionId"]!=self.id{return Err("Wrong session".into());}let token=field(v,"token")?;let accepted=runtime.hook(token,hooks::input(&v["observation"]),now());runtime.release_hook_response(token);Ok(json!({"accepted":accepted}))}

            "start"=>{
                if self.observed.is_some(){return Err("An agent is already running".into());}
                let provider=field(v,"provider")?;if provider!="codex"&&provider!="claude"{return Err("This provider does not yet support JobLoop MCP".into());}
                let id=field(v,"sessionId")?;let cwd=field(v,"cwd")?;let directory=field(v,"runtimeDirectory")?;
                let config_path=Path::new(directory).join("mcp.json");
                if provider=="claude"{std::fs::write(&config_path,json!({"mcpServers":{"jobloop":{"type":"http","url":field(v,"endpoint")?,"headers":{"Authorization":format!("Bearer {}",field(v,"token")?)}}}}).to_string()).map_err(|e|e.to_string())?;}
                let mcp=McpConnection{endpoint:field(v,"endpoint")?,token:field(v,"token")?,claude_config_path:config_path.to_str().ok_or("Invalid config path")?,server_name:"jobloop",instructions:None};
                let mut runtime=ObservedSession::new(id.into(),1,provider.into(),self.terminal.clone());
                let conversation=v["resumeId"].as_str().map(|identity|ConversationHandle::from_native(provider,identity.into())).transpose().map_err(|e|e.to_string())?;
                let mut request=LaunchRequest::interactive(provider,cwd,if v["taskType"]=="background" { &BACKGROUND_TEMPLATE } else { &TEMPLATE });
                if v["taskType"]=="background" { request.codex_project_trust=CodexProjectTrust::ManagedWorkspace; }
                if let Some(ref conversation)=conversation{request.conversation=conversation.resume();}
                request.prompt=Some(v["prompt"].as_str().unwrap_or(TEMPLATE.authored_body));request.mcp=Some(mcp);
                request.model=field(v,"model")?;request.permission=field(v,"permission")?;request.reasoning=field(v,"reasoning")?;request.explicit_configuration=true;request.workspace_network=v["network"].as_bool();
                let settings=termloop_agents::provider_hook_settings(provider,&std::env::current_exe().map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                let hook_endpoint=format!("{}/agent-observation",field(v,"endpoint")?.trim_end_matches("/mcp"));
                request.observation=Some(AgentObservationLaunch{session_id:id,endpoint:&hook_endpoint,token:runtime.token(),transport:if let Some(ref settings)=settings{AgentObservationLaunchTransport::InlineSettings{content:&settings.content,inspectable_content:&settings.inspectable_content}}else{AgentObservationLaunchTransport::DaemonOwnedBridge{endpoint:termloop_launch::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER}}});
                let mut launch=termloop_launch::resolve(request).map_err(|e|e.to_string())?.into_payload();
                if provider=="codex"{runtime.start_codex_with_project_trust(cwd,Path::new(directory),Some(mcp),&mut launch,None,if v["taskType"]=="background" { CodexProjectTrust::ManagedWorkspace } else { CodexProjectTrust::Inherit }).map_err(|e|e.to_string())?;}
                if let (Some(rows),Some(cols))=(v["rows"].as_u64(),v["cols"].as_u64()){
                    if rows<=1024 && cols<=4096 {
                        if let Some(grid)=TerminalGrid::new(rows as u16,cols as u16){self.terminal.seed_terminal_grids(TerminalGridMemory{latest:Some(grid),sessions:vec![(id.into(),grid)]});}
                    }
                }
                spawn_agent_terminal(&self.terminal,id,1,cwd,&launch).map_err(|e|e.to_string())?;
                if let Some(prompt)=launch.initial_input_submission(){runtime.enqueue(prompt);}
                let mut subscription=self.terminal.subscribe(id,1).map_err(|e|e.to_string())?;
                let output_session=id.to_owned();
                self.output=Some(tokio::spawn(async move{loop{match subscription.recv().await{
                    Ok(TerminalEvent::Output(bytes))=>emit(json!({"event":"output","sessionId":output_session,"bytes":bytes})),
                    Ok(TerminalEvent::Eof)=>{emit(json!({"event":"eof","sessionId":output_session}));break},
                    Ok(TerminalEvent::Gap(n))=>emit(json!({"event":"gap","sessionId":output_session,"count":n})),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n))=>emit(json!({"event":"gap","sessionId":output_session,"count":n})),
                    Err(_)=>break,
                }}}));
                self.id=id.into();self.observed=Some(runtime);Ok(json!({"started":true}))
            }
            "input"=>{self.terminal.input(&self.id,field(v,"text")?.as_bytes()).map_err(|e|e.to_string())?;Ok(json!({}))}
            "resize"=>{let rows=v["rows"].as_u64().filter(|n|*n>=4&&*n<=1024).ok_or("Invalid rows")?;let cols=v["cols"].as_u64().filter(|n|*n>=20&&*n<=4096).ok_or("Invalid cols")?;self.terminal.resize(&self.id,rows as u16,cols as u16).map_err(|e|e.to_string())?;Ok(json!({}))}
            "message"=>{let submission=termloop_launch::generated_submission(&TEMPLATE,field(v,"text")?).map_err(|e|e.to_string())?;let runtime=self.observed.as_mut().ok_or("No agent")?;if !runtime.enqueue(submission){return Err("Message queue full".into());}Ok(json!({"queued":true}))}
            "stop"=>{self.stop()?;Ok(json!({"stopped":true}))}
            _=>Err("Unknown command".into()),
        }
    }
}
#[tokio::main]
async fn main(){
    let directory=std::env::args().nth(1).expect("process registry directory required");
    if directory=="hook"{let _=termloop_agent_runtime::hook_forwarder::run_hook_client(hooks::Protocol).await;return;}
    let mut engine=Engine{terminal:TerminalService::with_process_registry(directory.into()),observed:None,id:String::new(),output:None};
    let mut lines=BufReader::new(tokio::io::stdin()).lines();let mut tick=tokio::time::interval(std::time::Duration::from_millis(100));let mut previous=String::new();let mut previous_identity=String::new();let mut previous_delivery=String::new();
    loop{tokio::select!{
        line=lines.next_line()=>{let Ok(Some(line))=line else{break};if line.len()>262144{continue;}match serde_json::from_str::<Value>(&line){Ok(v)=>{let id=v["id"].clone();match tokio::task::block_in_place(||engine.command(&v)){Ok(result)=>emit(json!({"id":id,"result":result})),Err(error)=>emit(json!({"id":id,"error":error}))}},Err(e)=>emit(json!({"event":"error","error":e.to_string()}))}}
        _=tick.tick()=>{if let Some(runtime)=engine.observed.as_mut(){runtime.poll(now());let delivery=format!("{:?}",runtime.delivery_state());let delivery_key=format!("{}:{delivery}",engine.id);if delivery_key!=previous_delivery{emit(json!({"event":"delivery","sessionId":engine.id,"state":delivery}));previous_delivery=delivery_key;}if let Some(identity)=runtime.native_identity(){let key=format!("{}:{identity}",engine.id);if key!=previous_identity{emit(json!({"event":"identity","sessionId":engine.id,"nativeId":identity}));previous_identity=key;}}let state=format!("{:?}",runtime.observation().map(|o|o.state));let observation_key=format!("{}:{state}",engine.id);if observation_key!=previous{emit(json!({"event":"state","sessionId":engine.id,"state":state}));previous=observation_key;}}}
    }}
    let _=engine.stop();
}
