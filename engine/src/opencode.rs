use std::path::Path;
use termloop_agents::ProviderHookSettings;

pub fn prepare(settings: &mut ProviderHookSettings, config_path: &Path) -> Result<(), String> {
    let script = settings.companion_script.as_ref().ok_or("Missing OpenCode plugin")?;
    let plugin = config_path.with_file_name("opencode-observation.js");
    termloop_platform::write_private_file(&plugin, script.as_bytes()).map_err(|e| e.to_string())?;
    let mut config: serde_json::Value = serde_json::from_str(&settings.content).map_err(|e| e.to_string())?;
    config["plugin"] = serde_json::json!([file_url(&plugin)]);
    settings.content = config.to_string();
    termloop_platform::write_private_file(config_path, settings.content.as_bytes()).map_err(|e| e.to_string())
}

fn file_url(path: &Path) -> String {
    // Match TermLoop's file URL encoding, including spaces and Windows drives.
    let path = path.to_string_lossy().replace('\\', "/");
    let mut url = String::from("file://");
    if !path.starts_with('/') { url.push('/'); }
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~' | b':') {
            url.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(url, "%{byte:02X}");
        }
    }
    url
}

// Server/model settings must go to OPENCODE_CONFIG_CONTENT, not the separate
// TUI observation config. Preserve the launch package's MCP and prompt config.
pub fn spawn(terminal: &termloop_terminal::TerminalService, id: &str, cwd: &str, launch: &termloop_launch::LaunchPayload, compaction: Option<&serde_json::Value>, document_directory: Option<&Path>) -> Result<(), String> {
    let original=launch.environment().entries().find(|(key,_)| *key=="OPENCODE_CONFIG_CONTENT").ok_or("Missing OpenCode launch config")?.1;
    let mut config:serde_json::Value=serde_json::from_str(&original.to_string_lossy()).map_err(|e|e.to_string())?;
    if let Some(compaction)=compaction {apply_compaction(&mut config,compaction)?;}
    if let Some(directory)=document_directory {
        let plugin=directory.join("opencode-documents.mjs");
        termloop_platform::write_private_file(&plugin,include_bytes!("../../app/opencode-documents-plugin.mjs")).map_err(|e|e.to_string())?;
        add_document_plugin(&mut config,&plugin)?;
    }
    terminal.spawn(termloop_terminal::PtySpawnSpec {
        session_id:id.into(),runtime_epoch:1,program:launch.program().into(),args:launch.args().to_vec(),cwd:cwd.into(),
        environment:launch.environment().clone().with_explicit("OPENCODE_CONFIG_CONTENT",config.to_string()),recent_output_replay:true,
    }).map_err(|e|e.to_string())
}

fn add_document_plugin(config: &mut serde_json::Value, plugin: &Path) -> Result<(), String> {
    if config.get("plugin").is_none() {config["plugin"]=serde_json::json!([]);}
    let plugins=config["plugin"].as_array_mut().ok_or("Invalid OpenCode plugins")?;
    let url=serde_json::Value::String(file_url(plugin));
    if !plugins.contains(&url) {plugins.push(url);}
    Ok(())
}

fn apply_compaction(config: &mut serde_json::Value, value: &serde_json::Value) -> Result<(), String> {
    let provider=value["providerID"].as_str().filter(|s| !s.is_empty()).ok_or("Missing provider")?;
    let model=value["modelID"].as_str().filter(|s| !s.is_empty()).ok_or("Missing model")?;
    let input=value["inputLimit"].as_u64().ok_or("Invalid input limit")?;
    let reserved=value["reserved"].as_u64().ok_or("Invalid compaction reserve")?;
    let context=value["contextWindow"].as_u64().ok_or("Invalid context capacity")?;
    let output=value["outputLimit"].as_u64().ok_or("Invalid output limit")?;
    if input<=reserved || input>context {return Err("Invalid compaction budget".into());}
    config["compaction"]=serde_json::json!({"auto":true,"prune":true,"reserved":reserved});
    config["provider"][provider]["models"][model]["limit"]["input"]=input.into();
    config["provider"][provider]["models"][model]["limit"]["context"]=context.into();
    config["provider"][provider]["models"][model]["limit"]["output"]=output.into();
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn document_guard_keeps_mcp_permissions_prompt_and_existing_plugins_without_compaction() {
        let mut config=serde_json::json!({"mcp":{"jobloop":{"url":"http://localhost/mcp"}},"permission":{"jobloop_read_scoring_profile":"allow"},"agent":{"build":{"prompt":"Saved instructions"}},"plugin":["existing-plugin"]});
        let before=config.clone();
        let plugin=std::path::Path::new("/worker with spaces/opencode-documents.mjs");
        super::add_document_plugin(&mut config,plugin).unwrap();
        super::add_document_plugin(&mut config,plugin).unwrap();
        assert_eq!(config["plugin"],serde_json::json!(["existing-plugin","file:///worker%20with%20spaces/opencode-documents.mjs"]));
        for field in ["mcp","permission","agent"] {assert_eq!(config[field],before[field]);}
        assert!(config.get("compaction").is_none());
    }
    #[test]
    fn compaction_budget_is_native_and_does_not_change_context_or_output_capacity() {
        let mut config=serde_json::json!({"provider":{"example":{"models":{"large":{"limit":{"context":1000000,"output":100000}}}}}});
        super::apply_compaction(&mut config,&serde_json::json!({"providerID":"example","modelID":"large","inputLimit":120000,"reserved":20000,"contextWindow":1000000,"outputLimit":100000})).unwrap();
        assert_eq!(config["compaction"]["auto"],true);
        assert_eq!(config["compaction"]["prune"],true);
        assert_eq!(config["provider"]["example"]["models"]["large"]["limit"]["input"],120000);
        assert_eq!(config["provider"]["example"]["models"]["large"]["limit"]["context"],1000000);
        assert_eq!(config["provider"]["example"]["models"]["large"]["limit"]["output"],100000);
    }
    use termloop_launch::{ConversationHandle, LaunchRequest, McpConnection, PERSONAL_AGENT_TEMPLATE};

    #[test]
    fn native_configuration_and_prompt_delivery_cover_fresh_and_resumed_sessions() {
        let conversation=ConversationHandle::from_native("opencode", "ses_fixture".into()).unwrap();
        for resume in [false,true] {
            let mut request=LaunchRequest::interactive("opencode", "/tmp", &PERSONAL_AGENT_TEMPLATE);
            request.prompt=Some("Fixture prompt");
            request.provider_instructions_source=Some(&PERSONAL_AGENT_TEMPLATE);
            request.provider_instructions=Some("Fixture instructions");
            request.approved_tools=&["ask_candidate"];
            request.mcp=Some(McpConnection{endpoint:"http://127.0.0.1:1234/mcp",token:"private-token",claude_config_path:"unused",server_name:"jobloop",instructions:None});
            if resume { request.conversation=conversation.resume(); }
            let manifest=termloop_launch::resolve(request).unwrap();
            let inspection=serde_json::to_string(manifest.inspectable_manifest()).unwrap();
            assert!(!inspection.contains("private-token"));
            let payload=manifest.into_payload();
            assert_eq!(payload.args().iter().any(|arg| arg.starts_with("--prompt=")),!resume);
            assert_eq!(payload.initial_input_submission().is_some(),resume);
            let config=payload.environment().entries().find(|(key,_)| *key=="OPENCODE_CONFIG_CONTENT").unwrap().1;
            let config:serde_json::Value=serde_json::from_str(&config.to_string_lossy()).unwrap();
            assert_eq!(config["mcp"]["jobloop"]["oauth"],false);
            assert_eq!(config["mcp"]["jobloop"]["headers"]["Authorization"],"Bearer {env:TERMLOOP_MCP_TOKEN}");
            assert_eq!(config["permission"]["jobloop_ask_candidate"],"allow");
            assert!(config["permission"].get("*").is_none());
            assert_eq!(config["agent"]["build"]["prompt"],"Fixture instructions");
            assert_eq!(config["agent"]["plan"]["prompt"],"Fixture instructions");
        }
    }
}
