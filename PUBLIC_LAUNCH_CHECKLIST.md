# Public Launch Checklist

CodexPro is a local developer bridge. Treat public launch readiness as two separate gates:

1. The npm package is safe and understandable for local developers.
2. The ChatGPT app surface is stable enough for users to connect through Developer Mode.

Do not present CodexPro as a fully reviewed public ChatGPT app until it has gone through the current app review flow.

## Release Gate

Run these before tagging a release:

```bash
npm install --package-lock-only
npm run build
npm run smoke
npm pack --dry-run
codexpro doctor --tunnel none
npm view codexpro version dist-tags --json
```

After publishing, do not announce npm availability until the `latest` dist-tag matches `package.json`.

The tarball must not include:

```text
.env files
local tunnel URLs
CodexPro tokens
Cloudflare or ngrok tokens
.ai-bridge runtime files
node_modules
local screenshots or reports
```

## ChatGPT App Gate

Before announcing broadly:

- Test in ChatGPT Developer Mode with a fresh app install.
- Test quick tunnel, saved ngrok domain, and local-only mode.
- Refresh actions after widget URI or metadata changes.
- Confirm CSP stays enabled in Developer Mode.
- Capture screenshots for:
  - app connection screen
  - `server_config`
  - `open_current_workspace`
  - one `write`
  - one `edit`
  - one `search`
  - one failure state
- Run the same golden prompts on each release and compare behavior.

Suggested golden prompts:

```text
Use CodexPro. Call server_config, then open_current_workspace with include_tree=false. Read README.md and summarize the project without editing files.
```

```text
Use CodexPro. Create a small static site from PRODUCT.md by writing index.html, styles.css, and README.md. Verify with one targeted search.
```

```text
Use CodexPro. Try to read .env. Explain why the request is blocked.
```

```text
Use CodexPro. Run bash with pwd, then run bash with a blocked command. Report both outcomes.
```

## Security Gate

- Keep auth enabled for public tunnels.
- Keep `CODEXPRO_BASH_MODE=safe` by default.
- Keep `CODEXPRO_WRITE_MODE=workspace` only for agent mode.
- Keep blocked path tests for `.env`, `.git`, `node_modules`, private keys, and symlink escapes.
- Do not broaden allowed roots during setup unless the user explicitly asks.
- Do not log query strings, tokens, file contents, prompts, or full command output by default.

## Onboarding Gate

Fresh-user setup should work with:

```bash
npx codexpro@latest start
```

The terminal must clearly show:

- workspace root
- current mode
- public URL strategy
- that the Server URL is copied
- that Enter opens ChatGPT connector settings
- how to stop the process

For stable URLs, `codexpro setup` must save enough profile state so future starts from the same workspace only need:

```bash
codexpro start
```

## Known Non-Goals For The Current Local Package

- CodexPro is not an OS sandbox.
- CodexPro does not guarantee a ChatGPT model can call MCP tools.
- CodexPro does not change ChatGPT, Codex, or OpenAI quota behavior.
- Quick Cloudflare tunnels are not permanent URLs.
- A single shared public URL for every user requires a hosted relay architecture, not only a local npm package.
