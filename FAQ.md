# CodexPro FAQ

## Which ChatGPT account should I use?

Use a ChatGPT account that can create custom MCP plugins. OpenAI's July 2026 documentation says full MCP, including write/modify actions, is available to Business and Enterprise/Edu. Pro can connect MCP apps with read/fetch permissions, but does not currently receive full MCP write support. Plus is not listed as a supported custom-MCP tier in that documentation.

CodexPro does not unlock Plugins, unlock models, bypass account limits, or provide account access. It connects to the ChatGPT plugin surface your account already has.

Plan access and model tool support are separate, and availability can change. If CodexPro actions are unavailable in that chat, use another tool-capable ChatGPT surface or the Pro context fallback for that session.

## How is CodexPro different from generic workspace bridges?

They can look similar at the transport layer because both use a local MCP-style bridge and a workspace root.

CodexPro is built around one product loop:

```text
install -> setup in a repo -> paste Server URL into ChatGPT Plugins -> inspect/edit/verify/review allowed projects
```

The main differences are:

- CodexPro is ChatGPT Plugins + MCP first, not a generic workspace bridge.
- Bash, write/edit, tool mode, Codex session reads, and handoff execution are separate safety controls.
- Durable context is repo-backed through `AGENTS.md` and `.ai-bridge/*`, so important project memory stays reviewable in files.
- The normal workflow emphasizes diffs, `show_changes`, smoke tests, and handoff status files.
- CodexPro keeps a strict boundary: no model proxying, account pooling, third-party Pro site scraping, quota bypassing, or OS sandbox claims.

CodexPro connects ChatGPT to a user-approved local repository over MCP. Repository access, command permissions, and change review remain explicit.

## What does Repository Analysis understand?

Repository Analysis builds a local repository map from bounded, inspectable evidence:

- project and package manifests
- source/test/config/documentation paths
- common declarations, imports, includes, and internal module relationships
- Git changes and existing project verification scripts

It supports TypeScript/JavaScript, Python, Go, Rust, Swift, Java, C#, C, and C++ declaration patterns. Unsupported languages still participate in safe inventory and lexical search.

Relationships are labeled `exact`, `strong`, or `inferred`. The repository map does not replace a compiler or language server. CodexPro does not require a language server, daemon, embedding service, or vector database.

Analysis is process-local and cached by a bounded workspace fingerprint. Direct CodexPro writes, edits, and patches invalidate that cache. If limits are reached, results say `partial` and retain normal tree/search/read/review fallback behavior.

Set `CODEXPRO_ANALYSIS=0` to disable this layer while keeping the standard file, search, Git, and review tools available.

Terminal users can inspect the same facts without ChatGPT:

```bash
codexpro inspect --json
codexpro review --json
```

## What is the `codexpro` supertool?

Note: this FAQ follows GitHub `main`. Check the npm badge/version before assuming a `main` feature is in `codexpro@latest`.

`codexpro` is a stable wrapper tool for advanced setups. It accepts:

```json
{ "action": "search", "args": { "query": "needle", "path": "src" } }
```

Call it with `action=list_actions` to see what the current server mode actually allows. It cannot call tools that are hidden by `--tool-mode`, `--no-bash`, or non-workspace write mode.

Use explicit tools such as `read`, `search`, `edit`, `bash`, and `show_changes` for normal work. Use the supertool when ChatGPT connector caching, custom workflows, or stable wrapper-style integrations matter more than separate visible tool descriptors.

## What is the recommended install path?

Install globally once:

```bash
npm install -g codexpro
```

Then run setup from the repo you want ChatGPT to work on:

```bash
codexpro setup
```

After setup, daily startup from that same repo is:

```bash
codexpro start
```

`npx codexpro@latest start` still works as a no-install fallback, but the global install is easier for normal users.

## How do I update CodexPro?

There is no `codexpro update` command. Reinstall the latest package and restart the connector:

```bash
npm install -g codexpro@latest
codexpro --version
```

Then stop the old process and run `codexpro start` again from the launch repo. Saved profiles under `~/.codexpro` stay in place.

If docs mention a feature that `codexpro --version` does not include yet, GitHub `main` is ahead of npm `latest`. Wait for the next release or install from the tagged GitHub release.

## How is CodexPro different from ChatGPT's built-in web Agent?

They solve different jobs.

ChatGPT's web Agent is for browsing, web research, and general web tasks. By default it cannot open a local Git repo on your machine, read `AGENTS.md`, inspect your current branch/`git diff`, run local verification commands, or keep edits inside an allowed workspace.

CodexPro is a local MCP bridge: your ChatGPT session talks to an approved folder on your computer through Plugins. Developer mode is only the ChatGPT settings toggle that lets you create custom plugins. It does not replace the web Agent, bypass account limits, or turn ChatGPT into a remote shell service.

Use the web Agent for web work. Use CodexPro when the source of truth is a local repository.

## How do I import a ChatGPT attachment into my repo?

In workspace write mode, CodexPro advertises `import_file`. ChatGPT must pass an Apps SDK file object:

```json
{
  "download_url": "https://...",
  "file_id": "file_...",
  "mime_type": "image/png",
  "file_name": "screenshot.png"
}
```

CodexPro marks that argument with `_meta["openai/fileParams"]`. It downloads only temporary HTTPS URLs from approved ChatGPT/OpenAI file hosts, enforces `CODEXPRO_MAX_IMPORT_BYTES`, rejects private/loopback redirect targets, and writes into the allowed workspace only. Overwrite defaults to false. Arbitrary user- or model-supplied download URLs are rejected.

Example destination:

```text
docs/evidence/screenshot.png
```

If the client does not provide `download_url` and `file_id`, the tool returns an unsupported-reference error and creates no files.

## What do I enable in ChatGPT?

Open ChatGPT and go to:

```text
Settings
-> Security and login
-> Developer mode: on
-> Enforce CSP in developer mode: on

Settings
-> Plugins
-> Create
```

When creating the plugin:

```text
Name: CodexPro
Description: Local workspace bridge for ChatGPT coding
Connection: Server URL
Server URL: paste the URL copied by CodexPro
Authentication: No Authentication / None
```

The copied Server URL already includes the private CodexPro token.

## Should CSP stay enabled?

Yes. Keep Enforce CSP in developer mode enabled.

CodexPro widgets are built for the CSP-enabled path. They do not need unrestricted network access, external fonts, remote scripts, iframes, or third-party images.

## Does CodexPro bypass rate limits?

No.

CodexPro does not bypass, avoid, increase, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. Every request still runs through the user's own ChatGPT session and whatever limits that account has.

The useful part is that Codex and ChatGPT are different product surfaces. If one workflow is unavailable and another product surface you already have access to is still available, CodexPro lets you work against the same local repo without changing either product's limits.

## Can CodexPro use GPT-5.5?

Only if your ChatGPT account already exposes that exact model, or a similar stronger model, in the ChatGPT web product surface you are using, and that model surface can call custom MCP plugins.

Some GPT-5.5 Pro or other model surfaces may not expose plugin actions in a given chat. If CodexPro actions are unavailable there, CodexPro cannot make that request reach the local server. CodexPro does not provide, proxy, resell, or unlock models. It gives compatible ChatGPT sessions local repo tools.

For models that cannot call tools, generate a repo context bundle instead:

```bash
codexpro pro-bundle --root /path/to/repo --copy
```

## What can ChatGPT see through CodexPro?

ChatGPT can see explicit workspace context exposed by tools:

- `AGENTS.md`
- `.ai-bridge` plans and status files
- git status
- git diff
- selected source files
- file tree and search results

It cannot read hidden Codex runtime memory or anything outside the allowed workspace unless you explicitly allow that root.

## What can ChatGPT edit?

In normal coding mode, ChatGPT can write and exact-edit files inside the configured workspace.

Safety defaults block common sensitive paths:

- `.env`
- private keys
- `.git`
- `node_modules`
- generated build/cache folders
- symlink escapes
- paths outside the workspace

Use handoff mode if you want ChatGPT to write a plan only and let Codex execute locally. In handoff mode, generic `write` and `edit` tools are not advertised to ChatGPT.

Use `CODEXPRO_WRITE_MODE=off` when you want direct `write` and `edit` tools removed from the advertised MCP tool list while still allowing bounded handoff/context files.

## Can CodexPro bind bash to a specific session id?

CodexPro cannot attach to, read, or execute inside a specific Codex app conversation or terminal session.

The MCP `bash` tool runs from the CodexPro server process you started for the configured workspace. MCP session ids are HTTP transport state between ChatGPT and CodexPro; they are not Codex conversation ids.

What CodexPro can do is require a matching local bash session label before it runs shell commands:

```bash
codexpro start --bash-session main --require-bash-session
```

Then `bash` calls must include `session_id: "main"`. This helps avoid accidental shell execution in the wrong CodexPro terminal, but it is not remote control of an existing Codex app chat.

CodexPro can list local Codex session ids and titles when you explicitly opt in:

```bash
codexpro start --codex-sessions metadata
```

This reads local Codex JSONL history under `~/.codex/sessions` and `~/.codex/archived_sessions` and returns metadata plus `codex resume <session-id>` commands. Use `--codex-sessions read` only if you also want bounded transcript reads. It does not attach to a live Codex app conversation.

If you do not want ChatGPT to trigger shell commands while you work in Codex, start CodexPro with bash disabled:

```bash
codexpro start --no-bash
```

This removes the `bash` MCP tool from the advertised tool list. ChatGPT can still use non-bash CodexPro tools such as workspace open, read, search, and show_changes. Direct `write`/`edit` are advertised only in workspace write mode.

If you only want ChatGPT to plan and leave execution to Codex or another local agent:

```bash
codexpro start --mode handoff --no-bash
```

## Which tunnel should I choose?

Use this rule:

```text
Fast demo:              Cloudflare quick tunnel
Recommended stable URL: ngrok free dev domain
Custom domain:          Cloudflare named tunnel
Tailnet users:           Tailscale Funnel
No public tunnel:       local-only mode, only for clients that can reach localhost
```

Cloudflare quick tunnel URLs change on restart. If you put a quick-mode URL into ChatGPT, you must edit the ChatGPT app Server URL every time you restart the tunnel.

For most users, the better path is a free ngrok dev domain. Create a free ngrok account, find your assigned dev domain under Universal Gateway -> Domains, and save that hostname during `codexpro setup`.

If you own a domain, use Cloudflare named tunnels and route DNS to a hostname like `codexpro.example.com`.

## Why does ChatGPT show “Something went wrong” when I create a connector?

Usually ChatGPT could not reach the public MCP URL. A generated `trycloudflare.com` URL is not proof that `cloudflared` stayed connected.

Run the connection test:

```bash
codexpro connection-test --root /path/to/repo
```

This keeps `read`, `tree`, `search`, and `load_skill`, but disables file writes,
bash, and tool cards. In ChatGPT, create the development plugin under
`Settings -> Plugins`, paste the complete Server URL, and choose
`No Authentication`.

The terminal output separates the failure boundary:

- No `POST /mcp received`: the request did not reach CodexPro. Check the ChatGPT
  Plugins page and the tunnel.
- `POST /mcp -> 401`: paste the complete URL, including `codexpro_token`.
- `POST /mcp -> 2xx`: ChatGPT reached CodexPro and the MCP endpoint responded.

The URL token is a personal-use compatibility fallback for connector forms
without custom headers. Shared or multi-user production deployments require
OAuth or `Authorization: Bearer <token>`. CodexPro
requires at least 24 token bytes, removes token parameters from the local
browser address after onboarding, and rate-limits failed authentication
attempts.

Keep CodexPro running while testing. A Cloudflare quick-tunnel URL changes on
every restart. If Cloudflare returns `530` / `Error 1033`, check DNS or
proxy-client DNS handling on the machine running `cloudflared`.

ChatGPT now manages custom MCP connections under Plugins. The browser error
`Failed to execute 'removeChild' on 'Node'` occurs in the ChatGPT page, before
CodexPro can handle an MCP request. Remove or recreate the stale plugin entry
from the Plugins page, then retry with the current URL. CodexPro cannot repair
that browser-side entry.

Official references:

- OpenAI: connect an MCP server to ChatGPT: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- OpenAI: MCP server authentication: https://developers.openai.com/apps-sdk/build/auth
- ngrok dev domains: https://ngrok.com/docs/universal-gateway/domains
- Cloudflare Tunnel routing: https://developers.cloudflare.com/tunnel/routing/
- Cloudflare Tunnel DNS records: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/

## Can I use the same ChatGPT plugin URL every day?

Yes, if you use a stable hostname.

Recommended simple path:

```bash
codexpro setup
# choose ngrok
# enter your ngrok free dev domain
```

After that:

```bash
codexpro start
```

The same hostname and CodexPro token are reused for that workspace.

## What if I run CodexPro in two repos at once?

For convenient switching through one connector, save the additional projects on the launch workspace:

```bash
cd ~/code/app
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

Confirm `Projects` lists the extra roots, then restart the connector so the admin page Allowed Roots list refreshes. Ask ChatGPT to open an allowed project. `open_workspace` returns a `workspace_id` that stays valid for later tool calls on this CodexPro process, including a later MCP session. It also becomes the selected project for the current MCP session, so tools in that same session may omit `workspace_id`. `open_current_workspace` switches the session selection back to the launch project without invalidating other ids. Unknown `workspace_id` values fail closed and never fall back to the launch project.

`--clear-projects` removes the saved extra roots from that launch workspace profile:

```bash
codexpro settings set --clear-projects
```

Workspace selection is isolated between MCP sessions created by the client. Registered `workspace_id` values are process-wide, so an explicit id from `open_workspace` still resolves after the client opens a new session. A ChatGPT conversation is not guaranteed to map one-to-one to an MCP session, so pass `workspace_id` on later tool calls. Use separate CodexPro processes when you need separate allowlists or public endpoints.

For separate processes, two ChatGPT accounts, or two ngrok domains on one machine, run two CodexPro processes with different local ports and different public hostnames:

```text
repo A: port 8787, hostname A, ChatGPT plugin URL A
repo B: port 8788, hostname B, ChatGPT plugin URL B
```

Run `codexpro setup` in each repo and save a profile per workspace. Do not reuse one Server URL across both accounts.

## How do multiple ChatGPT sessions avoid overwriting each other?

Workspace selection is session-local. Explicit `workspace_id` values are not: they resolve from the process workspace registry and never fall back to another root. For shared files, read the file first and pass its returned SHA-256 as `expected_sha256` to `write` or `edit`. CodexPro rejects the operation if the file changed after that read. New files use atomic replacement; existing files are updated in place to retain inode-bound metadata and hard links.

This protects against stale file content. It does not turn CodexPro into a collaborative merge server, so separate worktrees remain the stronger choice for large overlapping changes.

For service managers and background launches, use `codexpro start --headless`. It avoids prompts, clipboard and browser actions, reports readiness with `CODEXPRO_READY`, and exits nonzero if its HTTP runtime stops unexpectedly.

## Why not use codexpro.github.io?

GitHub Pages gives `owner.github.io` only to the GitHub user or organization named `owner`.

The `codexpro` GitHub username already exists, so this repo cannot use `codexpro.github.io` from the `rebel0789` account.

The clean GitHub Pages URL for this project is:

```text
https://rebel0789.github.io/codexpro/
```

## Is CodexPro production safe?

CodexPro is a local developer bridge, not an OS sandbox.

Use it with repos you trust. Keep token auth enabled for public tunnels. Keep safe bash on unless you know why you need full bash. Read [SECURITY.md](SECURITY.md) before exposing it through a public tunnel.

## Where are saved settings stored?

CodexPro stores local state under `~/.codexpro` by default. On Windows that is usually `C:\Users\<you>\.codexpro`.

Workspace profiles are JSON files saved under:

```text
~/.codexpro/profiles/
```

Current runtime connection files are saved under:

```text
~/.codexpro/runtime/
```

Set `CODEXPRO_HOME` to move this directory.

Use:

```bash
codexpro settings
codexpro settings list
codexpro settings delete --yes
```

Saved tokens are redacted when profiles are displayed.
