# Contributing

CodexPro is early. Good contributions make it safer, faster, and easier to explain.

## Local Setup

```bash
npm install
npm run build
npm run smoke
```

Run a local connector:

```bash
npm run connect:local -- --root /path/to/test/repo
```

Run through a Cloudflare quick tunnel:

```bash
npm run connect -- --root /path/to/test/repo --bash safe --write handoff
```

## Test and Runtime Isolation

- Do not build or run smoke tests from a checkout that is serving an active CodexPro plugin. A running server keeps its loaded modules, while newly spawned runners may read newly built files and create a mixed-version runtime.
- Run development checks from a detached worktree or disposable copy. Point the live launcher at a separate, immutable built release directory.
- Every test server must set dedicated temporary `CODEXPRO_TASK_DIR` and `CODEXPRO_JOB_DIR` values outside all allowed workspaces. Never let a test inherit the live `~/.codexpro/tasks` or `~/.codexpro/jobs` stores.
- Treat retained Goal and CodingTask state as user data. Validate exact test provenance and move confirmed fixtures to a recoverable quarantine before deleting anything.

## Useful Areas

- safer tool defaults
- better setup diagnostics
- stable tunnel setup helpers
- smaller/faster context bundles
- clearer ChatGPT tool prompts
- better Apps SDK widgets
- tests for path guards and auth boundaries
- docs that reduce user setup mistakes

## Pull Request Checklist

- Keep the change scoped.
- Do not include local tunnel URLs, auth tokens, `.env` values, or private paths.
- Run `npm run build`.
- Run `npm run smoke`.
- Update `README.md` or `CHANGELOG.md` when behavior changes.
- Explain security impact for changes touching auth, file access, shell execution, or tunnels.

## Docs Style

- Be concrete.
- Avoid hype.
- Name the exact command, mode, flag, and failure case.
- Make risk boundaries clear.
- Prefer examples that use `/path/to/repo` and `codexpro.example.com`, not local machine paths.
