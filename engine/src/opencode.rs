use std::path::Path;
use termloop_agents::ProviderHookSettings;

pub fn prepare(settings: &mut ProviderHookSettings, config_path: &Path) -> Result<(), String> {
    let script = settings.companion_script.as_ref().ok_or("Missing OpenCode plugin")?;
    let plugin = config_path.with_file_name("opencode-observation.js");
    termloop_platform::write_private_file(&plugin, script.as_bytes()).map_err(|e| e.to_string())?;
    // Match TermLoop's file URL encoding, including spaces and Windows drives.
    let path = plugin.to_string_lossy().replace('\\', "/");
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
    let mut config: serde_json::Value = serde_json::from_str(&settings.content).map_err(|e| e.to_string())?;
    config["plugin"] = serde_json::json!([url]);
    settings.content = config.to_string();
    termloop_platform::write_private_file(config_path, settings.content.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
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
