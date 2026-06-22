# CodexPro FAQ

## Which ChatGPT account should I use?

Use ChatGPT Plus or Pro with Apps / Developer Mode access.

Current testing shows free and Go accounts do not expose the app flow needed for CodexPro.

CodexPro does not unlock Developer Mode, unlock models, bypass account limits, or provide account access. It connects to the ChatGPT app surface your account already has.

Account access and model tool support are separate. A Plus or Pro account can have Apps / Developer Mode, while a specific model surface may still be unable to call connectors or MCP tools directly. Use the Pro context fallback for those sessions.

## How is CodexPro different from generic workspace bridges?

They can look similar at the transport layer because both use a local MCP-style bridge and a workspace root.

CodexPro is more focused: it is built around one clear product loop for ChatGPT users:

```text
install -> setup in one repo -> paste Server URL into ChatGPT -> inspect/edit/verify/review that repo
```

The main differences are:

- CodexPro is ChatGPT Developer Mode first, not a generic workspace bridge.
- Bash, write/edit, tool mode, Codex session reads, and handoff execution are separate safety controls.
- Durable context is repo-backed through `AGENTS.md` and `.ai-bridge/*`, so important project memory stays reviewable in files.
- The normal workflow emphasizes compact cards, diffs, `show_changes`, smoke tests, and handoff status files.
- CodexPro keeps a strict boundary: no model proxying, account pooling, third-party Pro site scraping, quota bypassing, or OS sandbox claims.

Short version: other tools may share the bridge idea; CodexPro is the cleaner ChatGPT-to-local-repo coding agent workflow with stricter defaults and clearer review surfaces.

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

## What do I enable in ChatGPT?

Open ChatGPT and go to:

```text
Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Enforce CSP in developer mode: on
-> Create app
```

In Create App:

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

Only if your ChatGPT account already exposes that exact model, or a similar stronger model, in the ChatGPT web product surface you are using, and that model surface can call Developer Mode apps.

Some stronger planning-model surfaces may not be able to call the CodexPro connector directly. CodexPro does not provide, proxy, resell, or unlock models. It gives compatible ChatGPT sessions local repo tools.

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
No public tunnel:       local-only mode, only for clients that can reach localhost
```

Cloudflare quick tunnel URLs change on restart. If you put a quick-mode URL into ChatGPT, you must edit the ChatGPT app Server URL every time you restart the tunnel.

For most users, the better path is a free ngrok dev domain. Create a free ngrok account, find your assigned dev domain under Universal Gateway -> Domains, and save that hostname during `codexpro setup`.

If you own a domain, use Cloudflare named tunnels and route DNS to a hostname like `codexpro.example.com`.

Official references:

- ngrok dev domains: https://ngrok.com/docs/universal-gateway/domains
- Cloudflare Tunnel routing: https://developers.cloudflare.com/tunnel/routing/
- Cloudflare Tunnel DNS records: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/

## Can I use the same ChatGPT app URL every day?

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

Use different local ports and different tunnel hostnames.

Example:

```text
repo A: port 8787, hostname A
repo B: port 8788, hostname B
```

Run `codexpro setup` in each repo and save a profile per workspace.

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

Workspace profiles are saved under:

```text
~/.codexpro/profiles/
```

Use:

```bash
codexpro settings
codexpro settings list
codexpro settings delete --yes
```

Saved tokens are redacted when profiles are displayed.
