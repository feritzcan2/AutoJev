fn configure_opencode_launch(
    target: &termloop_platform::ResolvedLaunchTarget,
    arguments: &mut Vec<ResolvedArgument>,
    environment: &mut termloop_platform::LaunchEnvironment,
    model: &str,
    permission: &str,
) -> Result<(), InvocationError> {
    if !termloop_agents::opencode_uses_server_configuration(target, environment) {
        return Ok(());
    }
    // AutoJev already carries MCP, tool approvals and agent instructions here.
    // Extend that configuration instead of replacing it with the selection.
    let mut config = environment.entries()
        .find(|(key, _)| *key == "OPENCODE_CONFIG_CONTENT")
        .map(|(_, value)| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&value.to_string_lossy()))
        .transpose()
        .map_err(|_| InvocationError::InvalidPromptBinding)?
        .unwrap_or_default();
    if model != "default" {
        config.insert("model".into(), model.into());
        arguments.retain(|argument| argument.purpose != "model selection");
    }
    if permission == "plan" {
        config.insert("default_agent".into(), "plan".into());
        arguments.retain(|argument| argument.purpose != "permission selection");
    }
    if config.is_empty() {
        return Ok(());
    }
    // The shared v2 server has its own environment. A private server is needed
    // for this launch's selection to apply without changing other Sessions.
    arguments.push(ResolvedArgument::exact(
        "--standalone",
        "launch-scoped OpenCode configuration",
    ));
    *environment = environment.clone().with_explicit(
        "OPENCODE_CONFIG_CONTENT",
        serde_json::Value::Object(config).to_string(),
    );
    Ok(())
}
