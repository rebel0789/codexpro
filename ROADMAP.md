# CodexPro Roadmap

CodexPro aims to be the safest, most reliable bridge between ChatGPT and explicitly allowed local repositories. The roadmap favors measurable workflow improvements over adding broad machine control.

## Now: release and compatibility confidence

- Keep package metadata as the single source of truth for every runtime version report.
- Install each packed release into a clean temporary project and test all public command entrypoints.
- Run the full build, smoke, stress, package-install, and dependency-audit gates on Node.js 20 and 24 across Linux and Windows.
- Keep public package contents and release provenance easy to inspect.

## Next: deeper code navigation

- Add exact symbol lookup and context retrieval without expanding raw output volume.
- Improve references, call relationships, and change-impact confidence language by language.
- Publish repeatable accuracy, latency, memory, and token-volume benchmarks on representative repositories.
- Keep lexical fallback and explicit partial-coverage reporting for unsupported or oversized projects.

## Next: durable work sessions

- Add managed background commands with bounded, paginated output and explicit stop controls.
- Produce a redacted support report that users can attach to issues without exposing tokens, home paths, or repository contents.
- Improve reconnect and resume diagnostics for long-running ChatGPT sessions and tunnel changes.
- Keep command execution scoped to allowed workspaces and retain auditable receipts for handoffs.

## Later: optional user interface

- Explore a local dashboard for connection health, active workspaces, running jobs, diffs, and handoff status.
- Keep the command-line and MCP server fully usable without a desktop application.
- Treat computer control and broad operating-system automation as separate, opt-in capabilities with stronger foreground-app, executable-integrity, and permission checks.

## Non-goals

- Model or account proxying
- Quota or safety-system bypasses
- Unrestricted remote shell access
- Claims of compiler- or language-server-level certainty from heuristic analysis
- Silent access outside user-approved workspace roots

Roadmap items are priorities, not release-date promises. Open focused proposals through [GitHub Issues](https://github.com/rebel0789/codexpro/issues).
