use serde_json::{Value, json};
use termloop_domain::{AgentLibrary, PersonalAgent, SessionAgentProfile};

pub fn validate(input: &Value) -> Result<Value, String> {
    if let Some(library) = input.get("library") {
        let library: AgentLibrary = serde_json::from_value(library.clone()).map_err(|e| e.to_string())?;
        if !library.is_valid() { return Err("Invalid agent library".into()); }
        for profile in &library.agents { termloop_launch::personal_agent_provider_instructions(profile).map_err(|e|e.to_string())?; }
        return Ok(json!(library));
    }
    let profile: PersonalAgent = serde_json::from_value(input["profile"].clone()).map_err(|e|e.to_string())?;
    let instructions = termloop_launch::personal_agent_provider_instructions(&profile).map_err(|e|e.to_string())?;
    Ok(json!({"profile":profile,"instructions":instructions}))
}

pub fn for_launch(input: &Value) -> Result<Option<PersonalAgent>, String> {
    if input.get("agentProfile").is_none() { return Ok(None); }
    let profile: PersonalAgent = serde_json::from_value(input["agentProfile"].clone()).map_err(|e|e.to_string())?;
    termloop_launch::personal_agent_provider_instructions(&profile).map_err(|e|e.to_string())?;
    if input["provider"] != profile.agent_id || input["model"] != profile.selection.model
        || input["permission"] != profile.selection.permission || input["reasoning"] != profile.selection.reasoning {
        return Err("Agent profile selection differs from launch".into());
    }
    // Keep the same upstream snapshot shape used for logical sessions.
    let snapshot = SessionAgentProfile { session_id: super::field(input,"sessionId")?.into(), agent: profile };
    Ok(Some(snapshot.agent))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(provider: &str) -> Value {json!({"id":"builtin.agent-profile.loop-trial","version":1,"name":"Trial","description":"Inspect sources","category":"Web","instructions":"Only test sources. {{literal}}","agent_id":provider,"selection":{"model":"default","permission":"default","reasoning":"default"}})}
    #[test]
    fn profiles_use_upstream_binding_and_validation() {
        for provider in ["codex","claude"] {
            let result=validate(&json!({"profile":profile(provider)})).unwrap();
            assert!(result["instructions"].as_str().unwrap().contains("Saved agent: builtin.agent-profile.loop-trial · revision 1"));
            assert!(result["instructions"].as_str().unwrap().contains("{{literal}}"));
        }
        let mut invalid=profile("codex");invalid["id"]=json!("random");
        assert!(validate(&json!({"profile":invalid})).is_err());
    }
    #[test]
    fn launch_rejects_profile_setting_mismatch() {
        let mut input=json!({"agentProfile":profile("codex"),"sessionId":"s","provider":"codex","model":"default","permission":"default","reasoning":"default"});
        assert!(for_launch(&input).unwrap().is_some());
        input["provider"]=json!("claude");assert!(for_launch(&input).is_err());
    }
    #[test]
    fn instructions_use_native_provider_transport() {
        for provider in ["codex", "claude"] {
            let profile: PersonalAgent=serde_json::from_value(profile(provider)).unwrap();
            let instructions=termloop_launch::personal_agent_provider_instructions(&profile).unwrap();
            let mut request=termloop_launch::LaunchRequest::interactive(provider,"/tmp",&termloop_launch::PERSONAL_AGENT_TEMPLATE);
            request.prompt=Some("Execute the assigned task.");
            request.provider_instructions_source=Some(&termloop_launch::PERSONAL_AGENT_TEMPLATE);
            request.provider_instructions=Some(&instructions);
            let launch=termloop_launch::resolve(request).unwrap().into_payload();
            if provider=="codex" {assert_eq!(launch.codex_app_server_developer_instructions(),Some(instructions.as_str()));}
            else {let index=launch.args().iter().position(|a|a=="--append-system-prompt").unwrap();assert_eq!(launch.args()[index+1],instructions);}
        }
    }

}
