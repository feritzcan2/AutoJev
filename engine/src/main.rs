mod opencode;
mod personal_agent;
mod hooks;
mod history;
mod context_status;
mod compact;
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

struct Engine {profile:bool, provider:String, compact:Option<compact::Delivery>, manual_draft:bool, compact_input_uncertain:bool, terminal:TerminalService, observed:Option<ObservedSession>, id:String, output:Option<tokio::task::JoinHandle<()>>}
impl Engine {
    fn stop(&mut self)->Result<(),String>{
        if !self.id.is_empty(){self.terminal.terminate(&self.id).map_err(|e|e.to_string())?;}
        if let Some(mut runtime)=self.observed.take(){runtime.close().map_err(|e|e.to_string())?;}
        if let Some(task)=self.output.take(){task.abort();}
        self.profile=false;self.id.clear();self.compact=None;self.manual_draft=false;self.compact_input_uncertain=false;Ok(())
    }
    fn command(&mut self,v:&Value)->Result<Value,String>{
        match field(v,"op")? {
            "repair-history"=>{if self.observed.is_some()||!self.id.is_empty(){return Err("Stop the writer before history repair".into());}history::repair(v)}
            "validate-profile"=>personal_agent::validate(v),
            "catalog"=>Ok(json!(termloop_agents::agent_catalog().iter().map(|a|json!({"id":a.id,"label":a.label,"models":a.models,"permissions":a.permissions,"reasoning":a.reasoning,"supported":a.id!="gemini"})).collect::<Vec<_>>())),
            "validate"=>{termloop_launch::validate_agent_configuration(field(v,"provider")?,field(v,"model")?,field(v,"permission")?,field(v,"reasoning")?).map_err(|e|e.to_string())?;Ok(json!({}))}
            "hook"=>{let runtime=self.observed.as_mut().ok_or("No agent")?;if v["observation"]["sessionId"]!=self.id{return Err("Wrong session".into());}let token=field(v,"token")?;let accepted=runtime.hook(token,hooks::input(&v["observation"]),now());runtime.release_hook_response(token);Ok(json!({"accepted":accepted}))}

            "start"=>{
                if self.observed.is_some(){return Err("An agent is already running".into());}
                let provider=field(v,"provider")?;if !matches!(provider,"codex"|"claude"|"opencode"){return Err("This provider does not yet support JobLoop MCP".into());}
                if provider=="opencode" {
                    let capability=termloop_agents::discover_capabilities(provider);
                    if capability.available && capability.observation!=termloop_agents::ObservationCapability::LaunchScopedHook {
                        return Err("OpenCode 1.18.33 veya daha yeni bir sürüm gerekli. Terminalde opencode upgrade ile güncelle.".into());
                    }
                }
                let id=field(v,"sessionId")?;let cwd=field(v,"cwd")?;let directory=field(v,"runtimeDirectory")?;
                let config_path=Path::new(directory).join("mcp.json");
                if provider=="claude"{std::fs::write(&config_path,json!({"mcpServers":{"jobloop":{"type":"http","url":field(v,"endpoint")?,"headers":{"Authorization":format!("Bearer {}",field(v,"token")?)}}}}).to_string()).map_err(|e|e.to_string())?;}
                let mcp=McpConnection{endpoint:field(v,"endpoint")?,token:field(v,"token")?,claude_config_path:config_path.to_str().ok_or("Invalid config path")?,server_name:"jobloop",instructions:None};
                let mut runtime=ObservedSession::new(id.into(),1,provider.into(),self.terminal.clone());
                let conversation=v["resumeId"].as_str().map(|identity|ConversationHandle::from_native(provider,identity.into())).transpose().map_err(|e|e.to_string())?;
                let profile=personal_agent::for_launch(v)?;
                let instructions=profile.as_ref().map(termloop_launch::personal_agent_provider_instructions).transpose().map_err(|e|e.to_string())?;
                let mut request=LaunchRequest::interactive(provider,cwd,if profile.is_some() { &termloop_launch::PERSONAL_AGENT_TEMPLATE } else if v["taskType"]=="background" { &BACKGROUND_TEMPLATE } else { &TEMPLATE });
                if let Some(ref instructions)=instructions {request.provider_instructions_source=Some(&termloop_launch::PERSONAL_AGENT_TEMPLATE);request.provider_instructions=Some(instructions);}
                let project_trust=workspace_trust(v);request.codex_project_trust=project_trust;
                if let Some(ref conversation)=conversation{request.conversation=conversation.resume();}
                request.prompt=Some(v["prompt"].as_str().unwrap_or(TEMPLATE.authored_body));request.mcp=Some(mcp);
                let approved_tools:Vec<&str>=match v.get("approvedTools") {
                    None=>Vec::new(),
                    Some(Value::Array(tools)) if tools.len()<=64=>tools.iter().map(|tool|tool.as_str().ok_or_else(||"Invalid approved tool".to_string())).collect::<Result<_,_>>()?,
                    _=>return Err("Invalid approved tools".into()),
                };
                request.approved_tools=&approved_tools;
                request.model=field(v,"model")?;request.permission=field(v,"permission")?;request.reasoning=field(v,"reasoning")?;request.explicit_configuration=true;request.workspace_network=v["network"].as_bool();
                let executable=std::env::current_exe().map_err(|e|e.to_string())?;
                let mut settings=termloop_agents::provider_hook_settings(provider,&executable).map_err(|e|e.to_string())?;
                if provider=="claude"&&v["taskType"]!="background" {
                    if let Some(ref mut settings)=settings {
                        let output=Path::new(directory).join(format!("context-{id}.jsonl"));
                        settings.content=context_status::settings(&settings.content,&executable,&output)?;
                        settings.inspectable_content=context_status::settings(&settings.inspectable_content,Path::new("jobloop-engine"),Path::new("<session-context>"))?;
                    }
                }
                let observation_path=Path::new(directory).join("opencode-tui.json");
                if provider=="opencode" {
                    opencode::prepare(settings.as_mut().ok_or("Missing OpenCode observation settings")?, &observation_path)?;
                }
                let observation_path=observation_path.to_str().ok_or("Invalid observation path")?;
                let hook_endpoint=format!("{}/agent-observation",field(v,"endpoint")?.trim_end_matches("/mcp"));
                request.observation=Some(AgentObservationLaunch{session_id:id,endpoint:&hook_endpoint,token:runtime.token(),transport:if let Some(ref settings)=settings{match settings.delivery {termloop_agents::ProviderHookSettingsDelivery::InlineSettings=>AgentObservationLaunchTransport::InlineSettings{content:&settings.content,inspectable_content:&settings.inspectable_content},termloop_agents::ProviderHookSettingsDelivery::EnvironmentSettingsPath{variable}=>AgentObservationLaunchTransport::EnvironmentSettingsPath{variable,path:observation_path,content:&settings.content,inspectable_content:&settings.inspectable_content}}}else{AgentObservationLaunchTransport::DaemonOwnedBridge{endpoint:termloop_launch::CODEX_APP_SERVER_RUNTIME_PLACEHOLDER}}});
                let mut launch=termloop_launch::resolve(request).map_err(|e|e.to_string())?.into_payload();
                if provider=="codex"{runtime.start_codex_with_project_trust(cwd,Path::new(directory),Some(mcp),&mut launch,None,project_trust).map_err(|e|e.to_string())?;}
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
                self.profile=profile.is_some();self.provider=provider.into();self.id=id.into();self.observed=Some(runtime);Ok(json!({"started":true,"providerInstructions":instructions}))
            }
            "compact"=>{
                if field(v,"sessionId")?!=self.id{return Err("Wrong session".into());}
                let runtime=self.observed.as_mut().ok_or("No agent")?;runtime.poll(now());
                if v["nativeId"].as_str().is_some_and(|id|runtime.native_identity()!=Some(id)){return Err("Native session changed".into());}
                let state=runtime.observation().map(|o|o.state);
                let ready=self.terminal.input_readiness_snapshot(&self.id,1).map_err(|e|e.to_string())?.facts();
                if self.compact.is_some()||runtime.delivery_state().is_some()||self.manual_draft
                    ||state.and_then(|s|compact::submit_key(&self.provider,s)).is_none()||!ready.bracketed_paste_enabled{
                    return Ok(json!({"deferred":true,"reason":"Terminal komut almaya hazır değil veya kullanıcı girdisi var."}));
                }
                // begin only fails before a paste was enqueued. Those cases
                // can safely wait; later transport failures are never retried.
                match compact::Delivery::begin(&self.terminal,&self.id){
                    Ok(delivery)=>self.compact=Some(delivery),
                    Err(reason)=>return Ok(json!({"deferred":true,"reason":reason})),
                }
                Ok(json!({"accepted":true}))
            }
            "input"=>{
                let bytes=field(v,"text")?.as_bytes();
                let before=self.terminal.user_input_activity(&self.id,1).map_err(|e|e.to_string())?;
                self.terminal.input_user(&self.id,1,bytes).map_err(|e|e.to_string())?;
                let after=self.terminal.user_input_activity(&self.id,1).map_err(|e|e.to_string())?;
                if after.mutation_sequence>before.mutation_sequence{self.manual_draft=true;}
                else if bytes==b"\r"{self.manual_draft=false;self.compact_input_uncertain=false;}
                Ok(json!({}))
            }
            "resize"=>{let rows=v["rows"].as_u64().filter(|n|*n>=4&&*n<=1024).ok_or("Invalid rows")?;let cols=v["cols"].as_u64().filter(|n|*n>=20&&*n<=4096).ok_or("Invalid cols")?;self.terminal.resize(&self.id,rows as u16,cols as u16).map_err(|e|e.to_string())?;Ok(json!({}))}
            "message"=>{if self.compact.is_some(){return Err("Compact delivery is in progress".into());}if self.compact_input_uncertain{return Err("Compact input needs review before another automatic message".into());}let submission=termloop_launch::generated_submission(if self.profile { &termloop_launch::PERSONAL_AGENT_TEMPLATE } else { &TEMPLATE },field(v,"text")?).map_err(|e|e.to_string())?;let runtime=self.observed.as_mut().ok_or("No agent")?;if !runtime.enqueue(submission){return Err("Message queue full".into());}Ok(json!({"queued":true}))}
            "stop"=>{self.stop()?;Ok(json!({"stopped":true}))}
            _=>Err("Unknown command".into()),
        }
    }
}
#[tokio::main]
async fn main(){
    let directory=std::env::args().nth(1).expect("process registry directory required");
    if directory=="hook"{let _=termloop_agent_runtime::hook_forwarder::run_hook_client(hooks::Protocol).await;return;}
    if directory=="context-status"{if let Some(output)=std::env::args().nth(2){let _=context_status::run(Path::new(&output));}return;}
    let mut engine=Engine{profile:false,provider:String::new(),compact:None,manual_draft:false,compact_input_uncertain:false,terminal:TerminalService::with_process_registry(directory.into()),observed:None,id:String::new(),output:None};
    let mut lines=BufReader::new(tokio::io::stdin()).lines();let mut tick=tokio::time::interval(std::time::Duration::from_millis(100));let mut previous=String::new();let mut previous_identity=String::new();let mut previous_delivery=String::new();
    loop{tokio::select!{
        line=lines.next_line()=>{let Ok(Some(line))=line else{break};if line.len()>16*1024*1024{continue;}match serde_json::from_str::<Value>(&line){Ok(v)=>{let id=v["id"].clone();if line.len()>262144 && v["op"]!="validate-profile" {emit(json!({"id":id,"error":"Command too large"}));continue;}match tokio::task::block_in_place(||engine.command(&v)){Ok(result)=>emit(json!({"id":id,"result":result})),Err(error)=>emit(json!({"id":id,"error":error}))}},Err(e)=>emit(json!({"event":"error","error":e.to_string()}))}}
        _=tick.tick()=>{if let Some(runtime)=engine.observed.as_mut(){runtime.poll(now());if let Some(result)=engine.compact.as_ref().and_then(|delivery|delivery.poll(&engine.terminal,&engine.id,&engine.provider,runtime.observation().map(|o|o.state))){engine.compact=None;match result{Ok(())=>emit(json!({"event":"compaction","sessionId":engine.id,"state":"submitted"})),Err(error)=>{engine.manual_draft=true;engine.compact_input_uncertain=true;emit(json!({"event":"compaction","sessionId":engine.id,"state":"failed","error":error}));}}}let delivery=format!("{:?}",runtime.delivery_state());let delivery_key=format!("{}:{delivery}",engine.id);if delivery_key!=previous_delivery{emit(json!({"event":"delivery","sessionId":engine.id,"state":delivery}));previous_delivery=delivery_key;}if let Some(identity)=runtime.native_identity(){let key=format!("{}:{identity}",engine.id);if key!=previous_identity{emit(json!({"event":"identity","sessionId":engine.id,"nativeId":identity}));previous_identity=key;}}let state=format!("{:?}",runtime.observation().map(|o|o.state));let observation_key=format!("{}:{state}",engine.id);if observation_key!=previous{emit(json!({"event":"state","sessionId":engine.id,"state":state}));previous=observation_key;}}}
    }}
    let _=engine.stop();
}


// Only workspaces generated by the app get a per-launch trust override.
// Provider permission settings and the user's global trust file stay unchanged.
fn workspace_trust(input: &Value) -> CodexProjectTrust {
    match input["taskType"].as_str() {
        Some("background" | "automation") => CodexProjectTrust::ManagedWorkspace,
        _ => CodexProjectTrust::Inherit,
    }
}

#[cfg(test)]
mod workspace_trust_tests {
    use super::*;
    #[test]
    fn only_managed_tasks_override_folder_trust() {
        for task_type in ["background", "automation"] {
            assert_eq!(workspace_trust(&json!({"taskType":task_type})), CodexProjectTrust::ManagedWorkspace);
        }
        for value in [json!({}), json!({"taskType":"application"}), json!({"taskType":"unknown"})] {
            assert_eq!(workspace_trust(&value), CodexProjectTrust::Inherit);
        }
    }
}
