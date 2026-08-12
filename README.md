<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  Local coding tools for ChatGPT, scoped to explicitly allowed projects.
</p>

<p align="center">
  <strong>Direction:</strong> ChatGPT Pro orchestrates; Codex workers implement locally; Pro integrates and reviews.
  See <a href="PRODUCT_DIRECTION.md">the accepted product contract</a> for implemented versus planned capabilities.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/"><img alt="Website" src="https://img.shields.io/badge/site-GitHub%20Pages-67e8f9?style=flat-square"></a>
</p>

## Install

Requirements:

- Node.js 20+
- A ChatGPT account with Apps / Developer Mode access
- One HTTPS route to your local machine when connecting ChatGPT from the web

Install the CLI:

```bash
npm install -g codexpro
```

Run setup inside the repo you want ChatGPT to work on:

```bash
cd /path/to/your/repo
codexpro setup
```

CodexPro prints and copies the Server URL. In ChatGPT, open:

```text
Settings -> Security and login -> Developer mode: on
Settings -> Plugins -> Plugins tab -> + (beside Search plugins)
```

This opens **New Plugin**. Give it a name such as `CodexPro`, paste the Server URL in the **Server URL** connection option, then choose `Authentication: No Authentication / None`. The form may initially show OAuth; change it before creating the plugin. CodexPro uses its own URL token.

### Current Plugins UI

| Open Plugins and click `+` | Complete the New Plugin form |
| --- | --- |
| ![Open Plugins and click the plus button](docs/images/chatgpt-plugins-add.png) | ![Complete the New Plugin form](docs/images/chatgpt-plugin-details.png) |

Daily use from the same repo:

```bash
codexpro start
```

## What It Does

CodexPro starts a local MCP server for the current workspace. ChatGPT can then:

- read files and inspect the repo
- search code
- make scoped edits with `write`, `edit`, or guarded `apply_patch`
- run safe verification commands through `bash`
- run durable commands through `start_background_job` when work may exceed 180 seconds or must survive reconnects
- keep one CodingTask worktree/context while switching between direct ChatGPT coding and supervised Codex collaboration
- propose and supervise a durable Goal whose independent Codex workers run concurrently, report through a Blackboard, and are integrated in an isolated Goal worktree
- review changed files with `show_changes`
- write handoff plans under `.ai-bridge`
- export a selected context bundle for model surfaces that cannot call tools

CodexPro is not a hosted service, model proxy, quota bypass, account pool, or OS sandbox.
It connects your own ChatGPT session to your own local repo through the official Developer Mode / MCP app path.

## Multiple Projects

Keep one launch project and explicitly allow additional projects:

```bash
codexpro settings set --project ~/code/web --project ~/code/api
codexpro start
```

`open_workspace` selects an allowed project for the current MCP session. After that, tools can omit `workspace_id` and operate on the selected project. `open_current_workspace` returns the session to the launch project.

Selections are session-local, so one MCP session switching projects does not change another session. Whether separate ChatGPT conversations receive separate MCP sessions is controlled by the client. Keep using separate CodexPro processes when you need guaranteed process isolation, different permissions, or different public endpoints.

Only the launch project and projects explicitly added with `--project` can be opened. Remove saved additional projects with:

```bash
codexpro settings set --clear-projects
```

## Relaunch Coding Experience

- `view_image` sends PNG, JPEG, GIF, and WebP files as native MCP image content, so ChatGPT can inspect screenshots and visual assets without a separate upload.
- `read` returns a SHA-256. Pass it as `expected_sha256` to `write` or `edit` when multiple sessions may touch the same file. A stale edit fails instead of silently overwriting newer work.
- New files use same-directory atomic replacement. Existing files are updated in place so ownership, ACLs, extended attributes, and hard links remain attached; a machine or process crash during that write can leave partial content.
- `codexpro start --headless` runs without prompts, clipboard access, browser opening, or terminal controls. It prints one `CODEXPRO_READY` line, publishes the supervised runtime PID in local status, cleans up on signals, and exits nonzero if the HTTP runtime dies unexpectedly.

## Repository Analysis

CodexPro builds a bounded repository map from local manifests, source declarations, imports, tests, and Git state. It provides:

- `inspect_workspace` for languages, project types, entrypoints, areas, symbols, and relationships
- optional structured `search` intents: `text`, `symbol`, `references`, and `impact`
- affected-area, risk, related-test, and focused-command recommendations in `show_changes`
- matching read-only terminal views:

```bash
codexpro inspect --root /path/to/repo
codexpro review --root /path/to/repo
codexpro inspect --root /path/to/repo --json
```

The analysis is deterministic and local. It uses confidence labels instead of claiming compiler precision, stays within configured file/byte/symbol limits, and falls back to normal lexical search and Git review when analysis is incomplete.

Set `CODEXPRO_ANALYSIS=0` to disable repository analysis without changing the rest of the connector.

## Normal Commands

```bash
codexpro setup
codexpro start
codexpro start --root /path/to/repo
codexpro doctor
codexpro connection-test --root /path/to/repo
codexpro settings
codexpro inspect
codexpro review
```

Useful modes:

```bash
codexpro start --no-bash
codexpro start --tool-mode minimal
codexpro start --tool-mode full
codexpro start --mode handoff
codexpro start --mode pro
```

If ChatGPT cannot create the plugin, run `codexpro connection-test`. It keeps
the normal read, tree, search, and skill tools, disables writes, bash, and tool
cards, and logs whether a request reached the local MCP endpoint.

Tool cards are opt in:

```bash
CODEXPRO_TOOL_CARDS=1 codexpro start
```

The v11 cards cover selected workspace, analysis, change, Git, handoff,
CodingTask, Goal, and terminal results. Reads and searches stay in normal chat output. After updating
the connector, refresh its ChatGPT plugin connection once so it loads the new
widget resource.

## Public URL Options

ChatGPT web needs a public HTTPS Server URL. CodexPro supports:

- Fast demo URL: `codexpro start --tunnel cloudflare`
- Stable ngrok domain: `codexpro ngrok --hostname your-domain.ngrok-free.dev`
- Stable Cloudflare route: `codexpro stable --hostname codexpro.example.com --tunnel-name codexpro`
- Tailscale Funnel: `codexpro tailscale --hostname your-device.your-tailnet.ts.net`
- Local only: `codexpro start --tunnel none`

Cloudflare quick tunnels honor `HTTPS_PROXY`, `ALL_PROXY`, or `HTTP_PROXY` when those env vars are set.

Stable modes should use a stable CodexPro token:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token

codexpro tailscale \
  --hostname your-device.your-tailnet.ts.net \
  --token-file ~/.codexpro/http-token
```

Tailscale Funnel must already be allowed for your tailnet. It requires MagicDNS, HTTPS certificates, and Funnel policy support. CodexPro runs:

```bash
tailscale funnel http://127.0.0.1:8787
```

Then ChatGPT uses:

```text
https://your-device.your-tailnet.ts.net/mcp?codexpro_token=keep-this-token-stable
```

The URL token is a personal-use compatibility fallback for connector forms that cannot set
headers. Prefer `Authorization: Bearer <token>` when the MCP client supports
custom headers. Shared or multi-user production deployments require OAuth or
header authentication. CodexPro requires at least 24 token bytes, removes token
parameters from the local browser address after onboarding, and sends
no-store/no-referrer headers. Never share or commit the connector URL.

## Safety Defaults

- Public tunnel mode requires a CodexPro HTTP token.
- HTTP tokens shorter than 24 bytes are rejected and failed guesses are rate-limited per client address.
- Generic writes are hidden unless `CODEXPRO_WRITE_MODE=workspace`.
- Safe bash blocks broad shell patterns and secret/build/cache paths.
- Durable background jobs use the same bash policy, require an idempotent key, retain bounded logs outside the repo, and never retry automatically.
- `--codex-bin` / `CODEXPRO_CODEX_BIN` pins the Codex CLI used by foreground and durable jobs, avoiding service-shell `PATH` drift.
- `apply_patch` is workspace-scoped and rejects blocked paths, symlink patches, and secret-looking patch content.
- `show_changes` keeps a review checkpoint so repeated unchanged reviews collapse.
- Tool-card metadata is off unless `CODEXPRO_TOOL_CARDS=1`.

Read [SECURITY.md](SECURITY.md) before exposing CodexPro through any tunnel.

## RAM And ChatGPT Memory

CodexPro can reduce what it sends to ChatGPT. Current local fixes:

- binary-file checks scan with a reusable 64 KiB buffer instead of allocating the whole file
- ChatGPT tool-card structured payloads are compacted only for card output, not for normal tool data
- bash chat transcripts stay compact by default

That helps avoid oversized MCP/card payloads. It does not force Chrome, ChatGPT, or an old browser iframe to release memory that the client already holds. If the browser tab has already grown, reload the ChatGPT page or restart the browser.

## Repo Context

CodexPro uses explicit files, not hidden chat memory:

```text
AGENTS.md
.ai-bridge/current-plan.md
.ai-bridge/agent-status.md
.ai-bridge/decisions.md
.ai-bridge/open-questions.md
.ai-bridge/execution-log.jsonl
```

For non-tool model surfaces:

```bash
codexpro start --mode pro
```

Or from a local checkout:

```bash
codexpro pro-bundle --root /path/to/repo --copy
codexpro pro-apply --root /path/to/repo --file plan.md
```

## Handoff

ChatGPT can write a plan without executing a local agent:

```bash
codexpro start --mode handoff
```

Then you run execution locally:

```bash
codexpro execute-handoff --agent codex --yes
codexpro watch-handoff --agent codex --yes
```

`handoff_to_agent` remains a compatibility, planning-only flow over MCP. CodingTask is the implementation flow when you want ChatGPT and Codex to work on the same durable task.

## Direct Coding and Codex Collaboration

A CodingTask owns one persistent Git worktree and context. For a trusted repository, explicitly enable both required capabilities when starting the web connector:

```bash
codexpro start --root /path/to/repo --write workspace --bash full
```

The safer defaults do not change. Both `writeMode=workspace` and `bashMode=full` are required to create a CodingTask, run or follow up with Codex, and transfer Direct → Codex. Codex App Server may execute project commands beyond the safe-shell allowlist, so `safe` bash cannot honestly authorize this path. Task status, list, review, cancel, and Codex → Direct transfer remain available without full bash so recovery and inspection are never trapped behind the execution gate.

Start the task in direct mode, let ChatGPT use the normal read/search/write/edit/bash tools against the returned task workspace, then transfer ownership to Codex without copying a patch or opening another repository:

```text
create_coding_task (owner: direct)
  -> direct coding in the returned workspace_id
transition_coding_task (owner: codex)
  -> run_coding_task
  -> followup_coding_task as needed
transition_coding_task (owner: direct)
  -> review_coding_task / show_changes
```

Transitions are exclusive: Codex cannot start while a direct operation owns the task, and direct mutation is rejected while Codex owns or runs it. Read-only status and review remain available. A Codex follow-up resumes the same persisted task/thread and worktree; connector restarts recover task state from `~/.codexpro/tasks` by default.

The Codex collaboration default is `gpt-5.6-sol` with `high` reasoning. Configure it with `--codex-model`, `--codex-reasoning-effort`, and `--task-dir`, or save those options with `codexpro settings set`. If you set `--codex-dir`, that directory is forwarded to the detached Codex process as `CODEX_HOME`, so it uses the intended authentication, configuration, and session store. Codex runs with workspace write access, network disabled, and approval policy `never`; an approval or user-input request fails closed instead of being silently accepted.

CodingTask never commits, merges, pushes, opens a PR, or deletes its worktree automatically. Review the resulting diff and choose those repository actions explicitly. Task state, bounded logs, and worktrees are private local state outside allowed projects and are retained for recovery and review; this release has no automatic cleanup. General durable background jobs are initially rejected inside CodingTask worktrees so an untracked process cannot cross an ownership transition.

## Pro-Orchestrated Goals (Unreleased)

Use a Goal when Pro should decompose a larger request and supervise multiple isolated CodingTasks. The ordinary Chat flow is:

```text
propose_goal (inert plan + contract fingerprint)
  -> user reviews the Goal card
approve_goal (records approval; still starts nothing)
  -> start_goal (launches dependency-ready workers concurrently)
  -> get_goal / refresh_goal / publish_goal_blackboard
  -> integrate_goal_work for each Pro-reviewed worker result
  -> review_goal
  -> complete_goal (records Pro's evidence judgment; source still unchanged)
  -> apply_goal (separate explicit source effect)
```

Goal workers use the configured Codex model and reasoning effort, defaulting to `gpt-5.6-sol` and `high`. They always write isolated CodingTask worktrees. Pro controls work assignment and integration; worker Blackboard records can report discoveries, contracts, blockers, paths, and verification but cannot change the approved work graph or publish decisions.

The current vertical slice deliberately accepts only `execution_policy=supervised`, `workspace_policy=isolated`, one turn per worker, and zero automatic retries. Parallel detached workers and their CodingTasks survive Chat or connector disconnects, but Pro must explicitly refresh, review, integrate, and start newly unblocked dependency work. Persistent autonomous scheduling, automatic multi-turn/retry behavior, and incremental Live projection are roadmap capabilities, not aliases for the current flow.

`complete_goal` does not modify the source repository. `apply_goal` additionally requires source-apply permission in the approved contract and explicit confirmation. It checks the original committed HEAD, rejects overlap with pre-existing dirty paths, preserves unrelated dirty files, never stages or commits, and records authoritative before/after state. Commit, push, draft PR, worker network access, and automatic cleanup are not implemented. The `commands` field records the approved verification protocol; because Goal execution intentionally requires trusted `bashMode=full`, it is not an OS command allowlist.

## Durable Background Jobs

The foreground `bash` tool is intentionally bounded to 180 seconds. For a long test suite, benchmark, build, or other command that must continue when ChatGPT reconnects, use this MCP flow:

```text
start_background_job
  job_key: release-candidate-151cc47:benchmark-run
  command: python3 benchmarks/benchmark.py run ...
  timeout_ms: 21600000
  expected_git_head: 151cc47...full-40-character-sha...
  require_clean_worktree: true

wait_for_background_job
  job_key: release-candidate-151cc47:benchmark-run
  wait_ms: 60000
```

`start_background_job` returns quickly. A detached local runner writes atomic state and bounded stdout/stderr logs under `~/.codexpro/jobs` by default, so the command survives an MCP disconnect or CodexPro HTTP server restart. `get_background_job` and `list_background_jobs` recover state in a new session; `cancel_background_job` is the only cancellation path.

The `job_key` is required and idempotent. Calling start again with the same key and contract returns the existing job instead of launching a duplicate. Reusing the key with a changed command, cwd, timeout, log limit, or Git guard fails. For release or benchmark work, pass the full `expected_git_head` and set `require_clean_worktree: true`; CodexPro checks both before accepting the launch and again in the detached runner. A mismatch fails without starting the command. CodexPro never retries a failed job or advances a multi-phase workflow automatically.

The command still follows `CODEXPRO_BASH_MODE` and the optional bash session guard. Safe mode accepts only its existing allowlist; trusted long-running project commands that are outside that allowlist require full mode. Shell jobs use a deterministic non-login shell. Pin the intended CLI with `codexpro start --codex-bin /absolute/path/to/codex` (or `CODEXPRO_CODEX_BIN`) when CodexPro runs under launchd/systemd or another service environment. `server_config` and `/healthz` expose the resolved path without exposing credentials. Set `CODEXPRO_JOB_DIR`, `CODEXPRO_BACKGROUND_JOB_TIMEOUT_MS`, or `CODEXPRO_BACKGROUND_JOB_MAX_LOG_BYTES` only when the defaults do not fit your local setup.

## Troubleshooting

Run:

```bash
codexpro doctor
```

Common fixes:

- Quick tunnel URL changed: rerun `codexpro start` and update the ChatGPT app Server URL.
- Stable URL does not respond: check the tunnel provider first, then the CodexPro token.
- ChatGPT cannot call tools in one model/chat: switch to a ChatGPT surface that supports Developer Mode app actions.
- Local port is busy: start another repo with `--port 8788`.
- Tool list looks stale: create a new ChatGPT app entry or change the connector URL token.
- A job sees the wrong Codex version: pin it with `--codex-bin "$(command -v codex)"`, restart CodexPro, and confirm `codexBin` in `server_config` before starting work.

## Development

```bash
npm install
npm run build
npm run smoke
npm run stress
```

Useful release checks:

```bash
npm run release:check
git diff --check
```

Release only from the CodexPro project root. Do not use `npm --prefix` with
`npm pack` or `npm publish`: npm packs the current directory in that case.
The release scripts verify the root, package identity, canonical repository,
and tarball before publishing:

```bash
cd /path/to/codexpro
npm run release:publish
```

## Docs

- [Website](https://rebel0789.github.io/codexpro/)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
