use std::path::Path;
use termloop_launch::LaunchPayload;
use termloop_terminal::{PtySpawnSpec, TerminalService};

pub fn spawn(
    terminal: &TerminalService,
    id: &str,
    cwd: &str,
    launch: &LaunchPayload,
    runtime_directory: &Path,
) -> Result<(), String> {
    if !cfg!(windows) {
        return termloop_agent_runtime::spawn_agent_terminal(terminal, id, 1, cwd, launch)
            .map_err(|error| error.to_string());
    }
    // npm installations launch through cmd.exe, whose command line is limited
    // to 8191 characters. Native Windows executables also have an argv limit.
    // Keep the full instructions and hooks in this run's private runtime files.
    let args = file_arguments(launch.args(), runtime_directory)?;
    let (program, args) = command(launch.program(), args, launch.environment())?;
    terminal
        .spawn(PtySpawnSpec {
            session_id: id.into(),
            runtime_epoch: 1,
            program,
            args,
            cwd: cwd.into(),
            environment: launch.environment().clone(),
            recent_output_replay: true,
        })
        .map_err(|error| error.to_string())
}

fn command(
    program: &str,
    args: Vec<String>,
    environment: &termloop_platform::LaunchEnvironment,
) -> Result<(String, Vec<String>), String> {
    #[cfg(windows)]
    if Path::new(program)
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
        && args.len() >= 4
        && args[..3] == ["/d", "/s", "/c"]
    {
        // The PTY quotes argv for native programs, but cmd /s /c strips the
        // leading quote of a batch path containing spaces. PowerShell's call
        // operator handles the resolved shim and its short, literal arguments.
        let root = environment
            .entries()
            .find(|(key, _)| key.eq_ignore_ascii_case("SYSTEMROOT"))
            .map(|(_, value)| value)
            .ok_or("Missing Windows system directory for Claude launch")?;
        let powershell = Path::new(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let arguments: Vec<&str> = args[4..].iter().map(String::as_str).collect();
        let script =
            termloop_platform::powershell_or_posix_hook_command(Path::new(&args[3]), &arguments);
        return Ok((
            powershell.to_string_lossy().into_owned(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                format!("{script}; exit $LASTEXITCODE"),
            ],
        ));
    }
    let _ = environment;
    Ok((program.into(), args))
}

fn file_arguments(args: &[String], directory: &Path) -> Result<Vec<String>, String> {
    let mut result = Vec::with_capacity(args.len());
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, name) = match arg.as_str() {
            "--settings" => ("--settings", "claude-settings.json"),
            "--append-system-prompt" => ("--append-system-prompt-file", "claude-system-prompt.txt"),
            _ => {
                result.push(arg.clone());
                continue;
            }
        };
        let content = args
            .next()
            .ok_or_else(|| format!("Missing Claude launch argument for {arg}"))?;
        let file = directory.join(name);
        let path = file.to_str().ok_or("Invalid Claude runtime file path")?;
        termloop_platform::write_private_file(&file, content.as_bytes())
            .map_err(|error| format!("Could not prepare Claude launch file: {error}"))?;
        result.extend([flag.into(), path.into()]);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "auto jev-claude-{}-{}-{}",
                std::process::id(),
                super::super::now(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn long_instructions_and_settings_are_preserved_in_run_scoped_files() {
        let fixture = Fixture::new();
        let instructions =
            "Keep \"quotes\", newlines,\n%PATH%, !value!, & | < > ^ and Unicode: café.\n"
                .repeat(700);
        let settings = json!({
            "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x".repeat(9000)}]}]},
            "env": {"FORCE_PROMPT_CACHING_5M": "1"},
            "allowedMcpServers": [{"serverName": "jobloop"}]
        })
        .to_string();
        let args = vec![
            "/d".into(),
            "/s".into(),
            "/c".into(),
            "C:\\CLI folder\\claude.cmd".into(),
            "--resume".into(),
            "saved-session".into(),
            "--settings".into(),
            settings.clone(),
            "--append-system-prompt".into(),
            instructions.clone(),
            "--model".into(),
            "sonnet".into(),
            "--allowedTools".into(),
            "mcp__jobloop__get_automation_context".into(),
        ];
        let first = fixture.0.join("first run");
        let result = file_arguments(&args, &first).unwrap();
        assert!(result.iter().map(|arg| arg.len() + 3).sum::<usize>() < 8191);
        assert_eq!(&result[..6], &args[..6]);
        assert_eq!(&result[10..], &args[10..]);
        assert_eq!(result[6], "--settings");
        assert_eq!(result[8], "--append-system-prompt-file");
        assert_eq!(std::fs::read_to_string(&result[7]).unwrap(), settings);
        assert_eq!(std::fs::read_to_string(&result[9]).unwrap(), instructions);

        let second = fixture.0.join("second run");
        file_arguments(
            &["--append-system-prompt".into(), "Other worker".into()],
            &second,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&result[9]).unwrap(), instructions);
    }

    #[test]
    fn preparation_failure_is_returned_before_starting_the_terminal() {
        let fixture = Fixture::new();
        let blocked = fixture.0.join("not-a-directory");
        std::fs::write(&blocked, "fixture").unwrap();
        let error = file_arguments(&["--settings".into(), "{}".into()], &blocked).unwrap_err();
        assert!(error.starts_with("Could not prepare Claude launch file:"));
        assert!(file_arguments(&["--append-system-prompt".into()], &fixture.0).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_cmd_launch_reads_long_content_for_fresh_and_resumed_sessions() {
        use termloop_launch::{
            AgentObservationLaunch, AgentObservationLaunchTransport, ConversationHandle,
            LaunchRequest, McpConnection, PERSONAL_AGENT_TEMPLATE,
        };
        let fixture = Fixture::new();
        let powershell = PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        std::fs::write(
            fixture.0.join("claude.cmd"),
            format!(
                "@echo off\r\n\"{}\" -NoProfile -NonInteractive -File \"%~dp0capture.ps1\" %*\r\n",
                powershell.display()
            ),
        )
        .unwrap();
        std::fs::write(fixture.0.join("capture.ps1"), r#"
$values = @($args)
$settingsIndex = [Array]::IndexOf($values, '--settings')
$promptIndex = [Array]::IndexOf($values, '--append-system-prompt-file')
$settingsFile = $values[$settingsIndex + 1]
$promptFile = $values[$promptIndex + 1]
$result = @{
    arguments = $values
    settings = [IO.File]::ReadAllText($settingsFile)
    instructions = [IO.File]::ReadAllText($promptFile)
}
[IO.File]::WriteAllText((Join-Path (Split-Path $settingsFile) 'captured.json'), ($result | ConvertTo-Json -Depth 8))
"#).unwrap();
        let instructions =
            "Follow all instructions.\n\"quotes\" %PATH% !value! & | < > ^ café.\n".repeat(700);
        let settings = json!({"hooks":{"Stop":[]},"fixture":"x".repeat(12000)}).to_string();
        let conversation = ConversationHandle::from_native(
            "claude",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
        )
        .unwrap();
        for resume in [false, true] {
            let directory = fixture
                .0
                .join(if resume { "resumed run" } else { "fresh run" });
            std::fs::create_dir_all(&directory).unwrap();
            let cwd = fixture.0.to_str().unwrap();
            let mcp_path = directory.join("mcp.json");
            let mut request = LaunchRequest::interactive("claude", cwd, &PERSONAL_AGENT_TEMPLATE);
            request.executable_directory = Some(&fixture.0);
            request.prompt = Some("Read the synthetic CV.");
            request.provider_instructions_source = Some(&PERSONAL_AGENT_TEMPLATE);
            request.provider_instructions = Some(&instructions);
            request.observation = Some(AgentObservationLaunch {
                session_id: "fixture",
                endpoint: "http://127.0.0.1:1/observation",
                token: "synthetic-hook-token",
                transport: AgentObservationLaunchTransport::InlineSettings {
                    content: &settings,
                    inspectable_content: &settings,
                },
            });
            request.mcp = Some(McpConnection {
                endpoint: "http://127.0.0.1:1/mcp",
                token: "synthetic-mcp-token",
                claude_config_path: mcp_path.to_str().unwrap(),
                server_name: "jobloop",
                instructions: None,
            });
            if resume {
                request.conversation = conversation.resume();
            }
            let launch = termloop_launch::resolve(request).unwrap().into_payload();
            assert!(launch.args().iter().map(String::len).sum::<usize>() > 32767);
            assert_eq!(launch.initial_input(), Some("Read the synthetic CV.\r"));
            let terminal = TerminalService::with_process_registry(directory.join("processes"));
            spawn(&terminal, "fixture", cwd, &launch, &directory).unwrap();
            let mut subscription = terminal.subscribe("fixture", 1).unwrap();
            let mut cursor = crate::startup_cursor::StartupCursor::new().observer();
            let mut output = Vec::new();
            let captured = directory.join("captured.json");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let result = loop {
                if let Ok(bytes) = std::fs::read(&captured) {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        break Some(value);
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break None;
                }
                if let Ok(Ok(termloop_terminal::TerminalEvent::Output(bytes))) =
                    tokio::time::timeout(std::time::Duration::from_millis(25), subscription.recv())
                        .await
                {
                    // Without the engine's startup answer, conhost holds cmd.exe.
                    cursor.output(&terminal, "fixture", &bytes);
                    output.extend(bytes);
                }
            };
            let _ = terminal.terminate("fixture");
            let result = result.unwrap_or_else(|| {
                panic!(
                    "The Windows shim must receive and read the launch files: {}",
                    String::from_utf8_lossy(&output)
                )
            });
            assert_eq!(result["instructions"], instructions);
            assert_eq!(result["settings"], settings);
            let arguments = result["arguments"].as_array().unwrap();
            assert_eq!(arguments.iter().any(|arg| arg == "--resume"), resume);
            assert!(arguments.iter().any(|arg| arg == "--mcp-config"));
            assert!(
                arguments
                    .iter()
                    .any(|arg| arg == mcp_path.to_str().unwrap())
            );
        }
    }
}
