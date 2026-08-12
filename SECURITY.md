# Security Policy

CodexPro exposes a local workspace to an MCP client. Treat it like a developer tool with access to your source tree, not like a hosted SaaS app.

## Supported Version

Security fixes target the latest published version only until the project reaches `1.0.0`.

Feature-specific notes follow GitHub `main`; npm users should check the published version before relying on a new command.

## Reporting

Please report security issues privately before opening a public issue. If the repository has GitHub private vulnerability reporting enabled, use that. Otherwise contact the maintainer listed by the project owner.

Do not include secrets, private repository contents, tunnel tokens, or `.env` values in reports.

## Terms Boundary

CodexPro is not designed to bypass, avoid, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. Do not market, deploy, or configure it that way.

Each user should connect their own ChatGPT account, use only product surfaces available to that account, and follow the limits, safety rules, and terms for ChatGPT, Codex, OpenAI, and any third-party model provider they connect.

## Threat Model

CodexPro can expose:

- file metadata and selected file contents from allowed workspaces
- git status and diffs
- `.ai-bridge` planning files
- optional shell command execution through the `bash` tool, hidden when bash mode is off
- optional durable shell execution through `start_background_job`, governed by the same bash mode and stored under a private local CodexPro state directory
- optional CodingTask worktrees with exclusive direct/Codex mutation ownership and private state outside allowed projects
- optional supervised Goal orchestration on supported POSIX hosts, with fingerprint-bound approval, parallel isolated CodingTasks, a private integration worktree, and separately confirmed source application
- optional write/edit/apply_patch capability depending on `CODEXPRO_WRITE_MODE`, advertised only in workspace write mode
- optional local handoff execution through `codexpro execute-handoff`, run from the user's terminal only
- optional local execute/review looping through `codexpro loop-handoff`, run from the user's terminal only with a user-provided reviewer command and iteration limit

## Failure Model

Review changes against these failure modes before release:

| Failure mode | Expected control |
| --- | --- |
| Public tunnel reachable without a secret | Public/non-loopback HTTP fails closed unless a CodexPro token is configured. |
| Raw CodexPro or Cloudflare token appears in UI, logs, docs, or package output | Tokens are redacted in profile/status output and tunnel tokens use local files for persistence. |
| ChatGPT can edit outside the intended repo | Allowed roots are explicit; path resolution rejects escapes, blocked globs, and symlink traversal. |
| ChatGPT can run arbitrary shell by default | Bash defaults to safe mode, can be disabled, and full mode is a trusted-local-only choice. Safe mode can still run repo package scripts, so use `--no-bash` for untrusted repos. |
| Handoff mode still exposes generic writes | Handoff/pro modes do not advertise generic `write`/`edit`/`apply_patch`; bounded handoff tools write `.ai-bridge` files only. |
| Local Codex history is treated as ChatGPT memory | Codex session access is opt-in metadata/read mode and never attaches to a live Codex app session. |
| Browser admin mutates live runtime unexpectedly | Admin profile changes apply on restart; active runtime policy stays stable for the current session. |
| Repeated public token guesses consume unlimited attempts | HTTP authentication rejects tokens shorter than 24 bytes and rate-limits failed attempts per client address. |
| URL-token credentials persist in browser history or referrers | Browser onboarding removes token parameters from the visible URL after capture and sends no-store/no-referrer response headers. Prefer an Authorization header when the MCP client supports one. |
| Timed-out bash commands leave descendant processes running | POSIX commands run in a dedicated process group and Windows termination uses `taskkill /t`; timeout and output-limit termination target the process tree. |
| A dropped MCP request loses or duplicates a long command | Durable jobs run in a detached local runner, persist atomic state and bounded logs, and require an idempotent `job_key`; reconnecting with the same contract returns the existing job. |
| A background job silently retries or advances a multi-phase workflow | CodexPro launches exactly once per `job_key`, never retries, and exposes separate read/wait/cancel operations. Phase gates remain the caller's responsibility. |
| CodingTask execution is exposed under the safe shell allowlist | Creation, run, follow-up, and Direct → Codex require both `writeMode=workspace` and `bashMode=full`. Status, list, review, cancel, and Codex → Direct remain reachable for recovery. |
| Direct coding and Codex write the same task concurrently | CodingTask transfers one exclusive mutation owner under revision/lease checks; conflicting or stale transitions fail closed. |
| Codex requests broader authority during collaboration | CodingTask starts Codex with network disabled and approval policy `never`; approval and interactive-input requests fail closed. |
| A task lifecycle mutates repository history or destroys review evidence | CodingTask does not commit, merge, push, open a PR, or delete its retained worktree automatically. Those actions require a separate explicit user decision. |
| Goal orchestration runs on Windows without the required lock primitive | This release hides every Goal tool on Windows and rejects proposal before storing state. `server_config.goalOrchestration.supported=false` explains the platform boundary; Direct coding and standalone CodingTasks remain available. |
| A Goal proposal or approval unexpectedly executes work | Proposal is inert and fingerprinted; approval only records authority. Worker launch is a separate execution-gated action with an idempotent key. |
| A worker expands the Goal or overwrites another worker | Goal-owned CodingTasks have immutable membership and file scopes; only Pro can publish decisions or integrate a reviewed worker patch. Out-of-scope or blocked-path content is rejected. |
| A Live Goal writes unreviewed integration state | Workers and Pro integration remain isolated. `project_goal` is a separate confirmed source effect bound to `review_goal`'s exact integration HEAD and deterministic review fingerprint. |
| A Goal overwrites unrelated dirty, staged, or untracked work | Source effects operate only on reviewed changed paths under exact HEAD/file/index CAS and preserve unrelated source state. Same-path index drift or content edits fail closed. |
| Two Goals or retries race in the same repository | Source effects share a per-repository lock and durable immutable artifacts/journal. Stable keys bind retries to one exact contract and partial application is reconciled by authoritative path readback. |
| Cancellation is mistaken for rollback | `cancel_goal` never reverts source. Revert requires its own confirmation and stable key, and only the latest applied projection can be reverted first (LIFO). |
| A revert overwrites a user's later edit | External same-path edits are never overwritten. Apply or revert records `recovery_required` and requires user recovery instead of guessing. |
| Final Live application writes the same checkpoint twice | When the completed integration checkpoint exactly matches the latest applied projection, `apply_goal` adopts and seals it with zero source writes. |
| A projection crosses a symlink or submodule boundary | Live source effects accept only regular files/executable regular files with safe parent topology and stage-0 regular-file index entries; symlinks, submodules, conflicts, and non-regular files fail closed. |
| Unsupported autonomous settings silently degrade to supervised execution | The current slice rejects persistent, multi-turn, and automatic-retry contracts. Those modes remain roadmap work. |
| A Goal `commands` list is mistaken for an OS command sandbox | Goal execution requires trusted full-bash authority. The list is the approved verification protocol; network and writable paths are separately constrained, but arbitrary local command execution is possible inside the isolated worker workspace. |
| Automatic `cloudflared` install trusts a mutable download | The installer uses a pinned release URL and verifies the platform asset SHA-256 before writing or extracting it. |
| A handoff plan silently becomes agent execution | `handoff_to_agent` remains planning-only. Explicit full-bash/background commands are separate trusted command surfaces and must receive normal MCP write-action approval. |
| Autonomous loop drives ChatGPT Web or bypasses approvals | `loop-handoff` only runs local terminal commands over `.ai-bridge` files; it does not resume browser sessions, approve prompts, or expose a remote MCP executor. |
| Reviewer masks a failed external command | `loop-handoff` requires explicit reviewer verdict assignments and rejects reviewer `PASS` after failed executor, test, or reviewer commands unless the user opts into the supported executor/test override behavior. |

The main risks are:

- connecting an untrusted MCP client
- exposing the server through a public tunnel without auth
- running with `CODEXPRO_BASH_MODE=full`
- approving an untrusted `start_background_job` command or using a misleading/reused job key
- giving an untrusted Codex task prompt write access to a task worktree
- running with `CODEXPRO_WRITE_MODE=workspace` on an important repo
- executing an untrusted `.ai-bridge/current-plan.md` or custom `execute-handoff --command`
- running `loop-handoff` with an untrusted reviewer command or without a small `--max-iters`
- adding overly broad allowed roots
- leaking a `codexpro_token` or Cloudflare tunnel token
- trusting a downloaded `cloudflared` binary without understanding where it came from

## Safer Defaults

Default daily mode:

```bash
codexpro start \
  --root /path/to/repo \
  --bash safe \
  --tunnel cloudflare
```

Safer planning-only mode:

```bash
codexpro start \
  --root /path/to/repo \
  --mode handoff \
  --bash safe \
  --tunnel cloudflare
```

Trusted CodingTask collaboration mode (explicitly broader authority):

```bash
codexpro start \
  --root /path/to/repo \
  --write workspace \
  --bash full \
  --tunnel cloudflare
```

Do not use this mode for an untrusted repository or prompt. Codex App Server may run project commands outside the safe-shell allowlist.

For stable public hostnames, keep the CodexPro auth token stable but private:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token

codexpro start \
  --root /path/to/repo \
  --tunnel cloudflare-named \
  --hostname codexpro.example.com \
  --tunnel-name codexpro \
  --token-file ~/.codexpro/http-token \
  --bash safe
```

## Hard Rules

- Do not run public tunnels with `--no-auth`.
- Public tunnel mode and non-loopback binds fail closed if `CODEXPRO_HTTP_TOKEN` is missing.
- HTTP tokens shorter than 24 bytes are rejected. Use a generated random token, not a memorable password.
- Do not commit printed connector URLs that include `codexpro_token`.
- Production integrations must use OAuth or `Authorization: Bearer <token>`. Query-string tokens are a personal connector compatibility mode, not a shared or multi-user production authentication design.
- Do not commit Cloudflare tunnel tokens.
- Do not paste raw Cloudflare tunnel tokens into browser pages or screenshots. Use `--cloudflare-token-file` or the local page's Cloudflare token file field instead.
- Use `--mode handoff` for planning workflows where ChatGPT should not edit source files. Handoff mode does not advertise generic `write`/`edit` tools.
- Preview local handoff execution with `codexpro execute-handoff --dry-run` before running an unfamiliar adapter or custom command.
- Preview autonomous local loops with `codexpro loop-handoff --dry-run`, keep `--max-iters` small, and prefer `--require-human-confirmation` until you trust the reviewer command.
- Keep `execute-handoff` local. Do not wrap it in a remote MCP tool unless you add a stronger approval and sandbox story.
- Keep `loop-handoff` local. Do not use it to automate ChatGPT Web, Codex approvals, account access, third-party Pro sites, quota limits, or product safety prompts.
- Use default agent mode only with trusted ChatGPT sessions and repo-specific roots.
- Use `--no-bash` when ChatGPT should never trigger shell commands in the workspace.
- Treat `start_background_job` like `bash`: inspect the exact command, workspace, cwd, timeout, and stable `job_key` before approval. It survives connector restarts by design.
- For benchmark/release jobs, require the full expected Git HEAD and a clean worktree. These guards prevent launch on the wrong candidate but do not freeze the repository after the process starts.
- Pin service-managed installations with `--codex-bin` or `CODEXPRO_CODEX_BIN`; do not assume launchd/systemd inherits the same `PATH` as an interactive terminal.
- Use `get_background_job` or `wait_for_background_job` after reconnecting. Do not invent a new key as an automatic retry, and cancel only with `cancel_background_job`.
- Keep `CODEXPRO_TASK_DIR` outside every allowed project. Treat its retained worktrees, task state, prompts, and bounded logs as private source data.
- Do not attempt to expose Goal tools manually on Windows. Goal orchestration requires the POSIX advisory-locking contract and is intentionally unavailable as a whole on that platform; use Direct coding or standalone CodingTasks instead.
- Treat Goal state, worker worktrees, the Goal integration worktree, prompts, Blackboard records, projection manifests, journals, and patches under `CODEXPRO_TASK_DIR` as private source data. Live never makes worker or integration worktrees public source workspaces.
- Review the exact Goal fingerprint before approval. Approval does not start workers, and Live projection still requires a separate explicit confirmation of `review_goal`'s exact integration HEAD and review fingerprint.
- Do not treat cancel as undo. Use `revert_goal_projection` only after inspecting the latest applied projection; reverts are explicit LIFO source effects and completed/adopted projections are sealed.
- If a projection reports `recovery_required`, stop source automation. Preserve the user's same-path edit and recover deliberately from the durable journal; do not invent a new key or overwrite the path.
- Keep the source repository on the approved committed HEAD for every Goal source effect. Unrelated dirty/staged/untracked paths may remain, but changed-path file bytes, modes, and index entries are CAS-protected.
- Fail closed on symlinks, submodules, conflicted index entries, renames/copies, and non-regular source topology. Do not broaden Live projection to cover them implicitly.
- `complete_goal` records Pro's judgment. `apply_goal` is still the final explicit boundary; for a matching already-projected Live checkpoint it performs a zero-write adoption/seal rather than writing source again.
- Enable CodingTask execution only by explicitly setting both `CODEXPRO_WRITE_MODE=workspace` and `CODEXPRO_BASH_MODE=full`. Setting only one must not weaken the gate.
- Keep status, list, review, cancel, and Codex → Direct available under safer modes so an operator can inspect, stop, and recover existing tasks.
- Review a CodingTask diff after every ownership return. Once explicitly enabled, Codex collaboration has workspace write and full command authority, but no network and no automatic approvals.
- Treat a custom `--codex-dir` as a Codex credential/configuration boundary: detached Codex receives it as `CODEX_HOME`.
- Do not start a general background job inside a CodingTask worktree; CodexPro rejects this initially because an untracked process could cross the exclusive-owner transition.
- Use `--bash-session <id> --require-bash-session` when bash should be enabled only for calls that explicitly target this local CodexPro terminal label.
- Keep Codex session history access off unless needed. `--codex-sessions metadata` only lists local Codex JSONL metadata; `--codex-sessions read` allows bounded transcript reads.
- Keep `CODEXPRO_CONTEXT_DIR` as a workspace-relative hidden directory such as `.ai-bridge`; CodexPro rejects source, build, dependency, credential, and absolute context directories.
- Use `--bash full` only for trusted local repos.
- Do not treat MCP session ids or bash session labels as Codex conversation ids. CodexPro does not execute inside a Codex app session.
- Prefer a repo-specific `--root` instead of `--allow-home`.
- Use `--no-install-cloudflared --cloudflared <path>` if your organization requires a managed Cloudflare Tunnel binary.

## Cloudflare Binary Install

For the one-command public tunnel flow, CodexPro can download the official Cloudflare `cloudflared` release into `~/.codexpro/bin` on supported macOS, Windows, and Linux systems. It does not install a system service, does not use sudo/admin rights, and does not modify shell startup files.

Resolution order:

```text
1. explicit --cloudflared path or CLOUDFLARED_BIN
2. cloudflared already available in PATH
3. ~/.codexpro/bin/cloudflared or cloudflared.exe
4. download the pinned official Cloudflare release unless --no-install-cloudflared is set
```

CodexPro currently pins `cloudflared` `2026.7.2` and verifies the selected asset
against its published SHA-256 before writing or extracting it. Updating the
version requires updating every supported platform digest in
`scripts/cloudflared-release.mjs` and passing `npm run test:settings`.

Use `--install-cloudflared` to reinstall the verified pinned binary. Use
`--no-install-cloudflared` to disable downloads.

## Built-In Guards

CodexPro blocks common sensitive paths by default:

- `.env` and `.env.*`
- `.git` internals
- `node_modules`
- common private key names
- build/cache folders such as `dist`, `build`, `.next`, `coverage`, `.cache`
- symlinks that resolve outside the workspace or into blocked paths

These guards reduce risk. They are not an OS sandbox.
