# Security reporting

Do not write about a security vulnerability in a public issue. Send an email with
the subject `JobLoop security` to `feritzcan93@gmail.com`. Include the affected
version, operating system, expected/actual behaviour and reproduction steps using
synthetic data. Do not send CVs, candidate profiles, real passwords, tokens, browser
cookies or session logs.

The supported fix target is the latest released version. We plan the timing of the
fix and disclosure together with the reporter; no specific response time is
promised.

JobLoop only opens a local desktop interface. The agent MCP connection runs over
loopback with a session-specific bearer token and candidate/worker scope.
Telegram access goes through the bot configured by the candidate and the paired
chat. Portal, Telegram and Jev secrets are encrypted with the operating system
keychain; if the keychain is unavailable, no new secret is saved.

Application automation, the agent provider and connections to sites run with real
user permissions. State clearly in the app's task/application settings the
permission the candidate gives, the correct information, and which actions may be
submitted.
