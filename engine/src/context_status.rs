use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::Path;

fn shell_quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }

pub fn settings(content: &str, executable: &Path, output: &Path) -> Result<String, String> {
    let mut settings: Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let command = format!("{} context-status {}", shell_quote(&executable.to_string_lossy()), shell_quote(&output.to_string_lossy()));
    settings["statusLine"] = json!({"type":"command", "command":command});
    Ok(settings.to_string())
}

// Persist only main-session identity and context measurements, never the full
// status payload (which also contains costs, paths and account limits).
fn sample(input: &Value) -> Option<Value> {
    let id = input["session_id"].as_str()?;
    let cwd = input["workspace"]["project_dir"].as_str().or_else(|| input["cwd"].as_str())?;
    let window = input["context_window"]["context_window_size"].as_u64().filter(|n| *n > 0)?;
    let usage = &input["context_window"]["current_usage"];
    let tokens = usage["input_tokens"].as_u64().and_then(|input| {
        let cache = |key: &str| if usage.get(key).is_none() { Some(0) } else { usage[key].as_u64() };
        input.checked_add(cache("cache_read_input_tokens")?)?.checked_add(cache("cache_creation_input_tokens")?)
    });
    Some(json!({"type":"context_usage", "sessionId":id, "cwd":cwd, "tokens":tokens, "contextWindow":window}))
}

pub fn run(output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();std::io::stdin().take(262145).read_to_end(&mut bytes)?;
    if bytes.len() > 262144 { return Err("status input too large".into()); }
    let input: Value = serde_json::from_slice(&bytes)?;
    if let Some(value) = sample(&input) {
        let mut options = std::fs::OpenOptions::new();options.create(true).append(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt;options.mode(0o600); }
        // A single small append avoids partial replacements and preserves a
        // crossed threshold even if Claude compacts before the app polls.
        options.open(output)?.write_all(format!("{value}\n").as_bytes())?;
        if let (Some(tokens), Some(window)) = (value["tokens"].as_u64(), value["contextWindow"].as_u64()) {
            println!("ctx {:.1}%", (tokens as f64 * 100.0 / window as f64).min(100.0));
        } else { println!("ctx —"); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_comes_from_provider_and_cached_input_is_counted_once() {
        let input = json!({"session_id":"thread", "cwd":"/candidate", "cost":{"secret":"omit"}, "context_window":{"context_window_size":1000000,"current_usage":{"input_tokens":10000,"cache_read_input_tokens":140000,"cache_creation_input_tokens":10000,"output_tokens":9000}}});
        let value = sample(&input).unwrap();assert_eq!(value["tokens"],160000);assert_eq!(value["contextWindow"],1000000);assert!(value.get("cost").is_none());
        let mut changed=input;changed["context_window"]["context_window_size"]=json!(200000);assert_eq!(sample(&changed).unwrap()["contextWindow"],200000);
    }
    #[test]
    fn missing_usage_is_unknown_and_invalid_capacity_is_rejected() {
        let mut input=json!({"session_id":"thread", "cwd":"/candidate", "context_window":{"context_window_size":1000000,"current_usage":null}});
        assert!(sample(&input).unwrap()["tokens"].is_null());
        input["context_window"]["context_window_size"]=json!(0);assert!(sample(&input).is_none());
    }
    #[test]
    fn status_command_preserves_hooks_and_quotes_shell_paths() {
        let value:Value=serde_json::from_str(&settings(r#"{"hooks":{"Stop":[]}}"#,Path::new("/app's engine"),Path::new("/a b/context.jsonl")).unwrap()).unwrap();
        assert_eq!(value["hooks"],json!({"Stop":[]}));
        assert_eq!(value["statusLine"]["command"],"'/app'\"'\"'s engine' context-status '/a b/context.jsonl'");
    }
}
