// Adapted from modules/invocation/src/personal_agent.rs at the pinned upstream revision.
// Loop supplies its own MCP protocol; TermLoop interactive-session tools are not available here.
use termloop_domain::PersonalAgent;
use crate::{InvocationError, PromptTemplate};
pub const PERSONAL_AGENT_TEMPLATE: PromptTemplate = PromptTemplate {
    id: "builtin.agent.personal", version: 1,
    authored_body: include_str!("../../../resources/prompts/builtin.agent.personal.md"),
};
pub fn personal_agent_provider_instructions(profile: &PersonalAgent) -> Result<String, InvocationError> {
    if !profile.is_valid() { return Err(InvocationError::InvalidDeveloperInstructions); }
    crate::validate_agent_configuration(&profile.agent_id, &profile.selection.model, &profile.selection.permission, &profile.selection.reasoning)?;
    let instructions = crate::bind_ordered(PERSONAL_AGENT_TEMPLATE.authored_body, &[
        ("profileRef", profile.id.as_str()),
        ("profileVersion", profile.version.to_string().as_str()),
        ("instructions", profile.instructions.as_str()),
    ])?;
    if instructions.len() > 64 * 1024 { return Err(InvocationError::InvalidDeveloperInstructions); }
    Ok(instructions)
}
