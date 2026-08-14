# Changelog

## Unreleased

- Fixed `list_goals` and `list_coding_tasks` so allowed-source filtering occurs inside the bounded store scan before the caller's result limit is applied; newer state from unrelated repositories can no longer hide an allowed older item. General MCP smoke tests now force dedicated temporary task/job stores, and contributor guidance requires an immutable live release separate from development builds.
- Added the first supervised Goal orchestration vertical slice: inert fingerprinted proposals, explicit approval/start separation, parallel Goal-owned CodingTasks, a structured Pro-supervised Blackboard, dependency-ordered isolated integration, Goal cards, persisted completion evidence, pause/resume/cancel, and separately confirmed source application with drift and dirty-path overlap protection.
- Added the Phase 8 Persistent Goal scheduler as a separately fingerprinted Isolated-only contract: explicit propose/approve/start, dependency-ready parallel Codex workers, provenance- and path-policy-verified mechanical integration in the private Goal worktree, durable scheduler reservations/leases, passive reconnect reads, and a mandatory `waiting_review` / `semantic_review` stop for Pro. Persistent has an empty Goal `commands` list, network disabled, no source effects, one turn per worker, and zero fresh automatic retries.
- Added Phase 9 bounded Persistent continuations: each worker now has 1–4 total turns including its initial turn, with exactly `maxTurns - 1` ordered immutable approval-time `continuation_intents`. Continuations resume the same CodingTask, worktree, Codex thread, and session as distinct operations; intermediate successes remain private/non-integrable and cannot unlock dependents, while only the final authorized success can create one cumulative integration. This milestone intentionally kept the earlier no-fresh-retry boundary; the separate Phase 10 entry below supersedes it for approved Persistent contracts.
- Added a bounded public turn ledger and v16 Goal card rendering for authorized/completed/remaining turns, intent summaries and fingerprints, per-turn identity/status/stop reason, and the final-only integration gate. `list_goals` remains compact, and exact prompts, raw Goal state, full ledgers, and Blackboard evidence are not returned.
- Added Phase 10 bounded Persistent fresh retries: public `max_retries_per_worker` permits 0–2 total per work item across all semantic turns (default 0), with fingerprinted `infra-pre-turn-v1` authority and immutable `[1000,5000]` ms backoff. Only positively attested `app_server_startup / infrastructure / runner_start` or `app_server_initialize_transport / infrastructure / app_server_initialize` failures with known outcome, no returned attempt identity, no written thread-establish/turn-start request, and exact zero-change Git may retry; an earlier semantic turn's established thread/session remains bound. Supervised remains zero-retry.
- Retained every attempt under a deterministic operation identity. A fresh retry repeats the exact approved prompt/scope/task/worktree/model/effort, preserves an established thread/session, and does not consume a semantic turn; same-operation recovery consumes no retry. Timeout, semantic/model/tool/input/approval, policy/path/content/provenance/validation/identity conflict, cancellation, partial Git change, ambiguous response loss, and unknown outcome fail closed without retry.
- Added v17 Goal cards and bounded public projections that separate semantic turns from attempts/retries, show aggregate retry usage, backoff deadline, safe failure tuple, zero-turn-start/Git attestation, and final-only integration. Get/review remain bounded; list remains compact; raw prompts, errors, logs, private paths, and full Goal/Blackboard state remain private. v16 through v8 remain legacy resources.
- Made Persistent lifecycle control durable and explicit: pause prevents new launch/integration/dependency advancement after it takes effect, resume is idempotent against the same approved contract and does not rerun completed work, and cancel fences active workers without reverting source or deleting retained worktrees. The local machine and detached scheduler must remain running while work progresses; the CodexPro server is required to start, control, or reconnect. This is not ChatGPT Scheduled Tasks or offline Pro judgment.
- Limited the complete Goal orchestration surface to supported POSIX hosts for this release: all Goal tools are hidden on Windows, proposal fails before state creation, and `server_config.goalOrchestration.supported=false` reports the missing crash-safe GoalStore locking contract. Direct coding and standalone CodingTasks remain available on Windows.
- Added supervised Live source projection through separately confirmed `project_goal`: exact `review_goal` HEAD/fingerprint attestation, per-repository locking, changed-path file/index CAS, durable manifests/journals, same-key retry recovery, and preservation of unrelated tracked, staged, and untracked work while workers and Pro integration remain isolated.
- Added explicit latest-applied-first `revert_goal_projection`, fail-closed `recovery_required` handling for user same-path edits, unsupported symlink/submodule/non-regular topology rejection, and zero-write final `apply_goal` adoption when the completed checkpoint is already projected. Cancel never reverts source, and no Goal source effect stages, commits, merges, pushes, or opens a PR.
- Verified the complete supervised Live happy path in ordinary Chat through the installed private plugin and a real `gpt-5.6-sol`/`high` Codex App Server turn: exact integration review, separately approved projection, completion, zero-write final adoption, unchanged source HEAD, and no stage, commit, push, or PR.
- Verified Persistent through the intended ordinary-Chat flow with Goal `goal_cd1d3bf868c2bdade5b1c7af`: explicit propose/approve/start, navigation away, two real `gpt-5.6-sol`/`high` workers running in parallel followed by their summary dependency, private integration of exactly `a.md`, `b.md`, and `summary.md`, and reconnect review at revision 20. The scheduler stopped at `waiting_review` / `semantic_review`; source HEAD, index, refs, and the target source path remained unchanged.
- Verified the built HTTP/MCP Persistent path with an installed real Codex App Server, including disconnect/reconnect, pause/resume/cancel fencing, scheduler recovery/idempotency, authoritative three-file review counts, and clean termination of scheduler and worker processes. Native Windows execution was not run; all Goal tools remain intentionally hidden there.
- Verified Phase 9 through the built public HTTP/MCP entry point: an approval-time two-turn contract held the successful first turn private with zero integration commits or dependency unlocks, resumed the same task/base/thread/session for a distinct second operation that observed the first turn's exact bytes, and produced exactly one final cumulative integration. Client/HTTP disconnect and restart preserved detached progress; passive get/list/review caused no launch or mutation; terminal same-key start remained byte-idempotent; source HEAD/refs/index and staged, unstaged, and untracked state stayed exact.
- Verified the same two-turn contract with an installed real Codex App Server using Goal `goal_f18e1e62ec5797e868fd6421`, CodingTask `task_8eb28bf1e327e3cbb2ac2a92`, thread `019ff6ef-94b9-7bc3-adbb-ced648a29472`, two distinct turns, and one integration commit.
- Verified Phase 9 through the canonical ordinary-Chat/plugin flow: Goal `goal_d96c4d1de3d6382cc4ebcc86` reached revision 15 `waiting_review` / `semantic_review` under contract fingerprint `9851972a680218074a44e12e7830691c0353cf466b92752eb56ffba082ccb8a4`; CodingTask `task_f1c84e9b39654c8aaebb2e6b` kept thread/session `019ff70a-ea6f-7a83-94d6-f81fe92527a2` across operations `run:1` / `run:2` and turns `019ff70a-eb7c-7611-b700-539667ba8c4e` / `019ff70b-a812-7a13-a9cb-6936fc1ba359`. The captured intermediate state had integration HEAD equal to base `ce4421d…` and no integrated commit; final integration `124787d868b3d89a1191d394192831cd3fb5c46e` had exactly one commit and the exact two-line `phase9-chat/multi-turn.md`, attested by review fingerprint `e36aa461a0ca684d9fe85efd253e0e3431255baf1951e471266d3eedba663c8b`.
- Confirmed in that Chat flow that source path/status/diff/index remained byte-identical across start, disconnect, and reconnect. An unrelated external source commit `cd0f3e18…` occurred before Goal start while the approved Goal base remained `ce4421d…`; it was neither created nor absorbed by the Goal. Duplicate passive get/review calls were harmless and byte-identical. The final v16 get/review card rendered 2/2 turns, stable identities, and final-only integration.
- Corrected `start_goal`'s MCP destructive hint from `true` to `false`: Persistent start executes in private isolated worktrees and has no source effect, while source projection/application stay separately confirmed. After rebuild, server restart, and plugin refresh, the canonical ordinary-Chat `start_goal` call was discoverable and succeeded.
- Verified Phase 10 with the full deterministic npm smoke and built production HTTP/MCP flow: exact 1s/5s backoff, aggregate cross-turn budget and exhaustion, passive restart reads, free concurrency slots during backoff, pause/cancel dominance, non-retry semantic/dirty/ambiguous-response cases, one final private integration, and unchanged source all passed.
- Verified an installed real Codex HTTP retry with Goal `goal_b134f2acc8a910aedd6d31d5`: an injected initialize failure consumed attempt 0, attempt 1 ran real `gpt-5.6-sol`/`high` successfully, private integration produced exactly one commit, and source remained unchanged.
- Verified the canonical ordinary-Chat Phase 10 flow with Goal `goal_855e97294fe7d3a8f25a06fe` revision 14, contract fingerprint `273019c6d5f124f87d6240be9997b1571c9f73445839b941d449e6ffa3759578`, and task `task_5fe51f8b7cf5b5911361e416`. Attempt 0 recorded `app_server_initialize_transport / infrastructure / app_server_initialize`, known outcome, no turn, zero changed paths; after 1 second attempt 1 succeeded on thread/session `019ff759-a258-7480-9765-c075c6f867a3`, turn `019ff759-a318-7283-83d4-c0d2477a42eb`. Integration `b1fe3f18e44601ebbc7c9af42e144e95fa77c1f9` had one commit; source HEAD/ref, write-tree, file bytes, status, and diff stayed unchanged.
- Confirmed the final ordinary-Chat v17 get card rendered 1/1 semantic turn, two attempts, retries 1/1, and one changed file. The Chat host duplicated passive get/review calls, but state SHA-256 remained `5fd32c…` and no launch/write occurred. Initial approve/start cards had transient template fetch failures during the live endpoint swap; fresh resource/read/get v17 rendering passed.
- Verified the vertical slice through ordinary Chat and the installed private plugin with two concurrent real `gpt-5.6-sol`/`high` Codex workers, Pro-controlled integration/review/completion, persistent v11 cards, and no source application.
- Made `review_goal` the authoritative private-integration-worktree inspection surface, including an integrated `git diff --check`, and clarified that generic workspace denial for internal Goal worktrees is an expected isolation boundary rather than a verification failure.
- Added Goal HTTP/MCP and execution regressions covering parallel detached workers, reconnect recovery, passive reads, isolated integration, cancellation, idempotent source application, preservation of unrelated source dirt, same-thread bounded continuations, bounded infrastructure retries, intermediate integration/dependency gates, and final-only cumulative integration. Out-of-policy retries and invalid continuation/retry counts fail closed.
- Upgraded the opt-in Apps widget to v17 with Goal lifecycle, scheduler state, authoritative changed-file counts, approval, work graph, Blackboard, bounded continuation/turn and attempt/retry history, review, and next-action rendering. A stale v13 cache established the rule that renderer changes require a new resource URI; v14 carried the initial fix, counts moved to v15, turn history to v16, and retry history to current v17 while v16 through v8 remain compatible legacy resources.
- Added persistent CodingTask worktrees and exclusive bidirectional ownership transfer between direct ChatGPT coding and supervised Codex collaboration, including same-thread follow-ups, restart-safe status/review, and explicit transition guards.
- Added CodingTask launcher/profile/HTTP configuration for a private task directory, Codex model, and reasoning effort; defaults are `gpt-5.6-sol` and `high` with network disabled and approval requests rejected.
- Added durable MCP background jobs for long tests and benchmarks, with detached runners, atomic reconnect-safe state, bounded logs outside the workspace, idempotent job keys, explicit status/wait/list/cancel tools, process-group timeout/cancellation, and no automatic retry or phase advancement.
- Added exact Codex CLI pinning for service environments and optional full-SHA/clean-worktree launch guards that are rechecked by durable runners before execution.
- Refreshed patched transitive releases for brace expansion, URI parsing, HTTP middleware, and IP classification after the August 2026 advisories; `npm audit` is clean again.
- Fixed the ripgrep availability probe to honor the same `PATH` as the subsequent search process, so a login-shell profile cannot select an unavailable binary instead of the Node fallback.

## 0.30.0 (2026-08-08)

- Published the multi-project allowlist that was already on `main`: `codexpro settings set --project`, `--clear-projects`, session-local `open_workspace` selection, and matching FAQ guidance. npm `0.29.0` did not include those commits, which caused empty Allowed Roots reports after following current docs.
- Rejected invalid relative `HOME` values such as `=` in restricted bash child environments, prefer a usable absolute `USERPROFILE`/`HOME`, and forward Windows `APPDATA`/`LOCALAPPDATA` when valid so npm cache dirs are not created inside workspaces.
- Raised the bash `timeout_ms` hard cap from 180s to 10 minutes by default (max 15 minutes via `CODEXPRO_MAX_BASH_TIMEOUT_MS`). Per-command default remains 30s.
- Follow directory symlinks under configured skill roots during skill discovery so managers such as cc-switch can install skills as links. Thanks @yuczzzzz. Keep symlinked/junction skills tagged by their configured scan root and accept both realpathed and caller-supplied home spellings so Windows junctions keep `user` / `~/` identity.
- Added `import_file` for ChatGPT Apps SDK attachments (`openai/fileParams`), with HTTPS host allowlisting, redirect revalidation, streaming size limits, SHA-256 checks, MIME sniffing, and workspace write-mode gating.
- Documented update steps (`npm install -g codexpro@latest`), ChatGPT web Agent vs CodexPro, and dual-account / dual-tunnel process separation in the English and Chinese FAQs.
- Updated transitive dependencies so `npm audit --audit-level=high` reports zero known vulnerabilities.

- Added saved additional projects with `codexpro settings set --project <path>`, session-local workspace selection through the existing `open_workspace` tool, and `--clear-projects` for removing the saved allowlist.
- Isolated workspace selection between HTTP MCP sessions while preserving explicit workspace-id access for configured roots, with stdio, HTTP, profile, and regression coverage.
- Added native workspace image inspection for PNG, JPEG, GIF, and WebP files through `view_image`.
- Added optional SHA-256 preconditions and canonical-path write serialization for `write` and `edit`, preventing stale multi-session edits from silently replacing newer file content. New files use atomic replacement; existing files retain inode-bound metadata and hard-link identity through in-place updates.
- Added `codexpro start --headless` with non-interactive readiness output, supervised HTTP-runtime failure propagation, runtime PID status, and signal cleanup.
- Updated the MCP SDK and affected transitive HTTP, URI, and pattern-matching dependencies to patched releases; the release audit now reports zero known vulnerabilities.
- Hardened public HTTP authentication with a 24-byte minimum token, per-client failed-attempt throttling, no-store/no-referrer browser responses, and immediate removal of onboarding token parameters from the visible URL.
- Pinned automatic `cloudflared` installation to release `2026.7.2` and verify each supported platform asset against its published SHA-256 before writing or extracting it.
- Closed cross-session and concurrency gaps by isolating `show_changes` checkpoints per MCP session and making `apply_patch` share canonical per-file write locks with `write` and `edit`.
- Made bounded ripgrep truncation tolerate an interrupted final JSON record, rejected symlinked `.ai-bridge` handoff paths, and terminated timed-out bash process trees instead of only their direct shell process.
- Closed the follow-up security findings by rejecting symlinked handoff leaf files, bounding and force-terminating output-heavy bash trees, disabling unbounded regex in the Node search fallback, size-capping verified `cloudflared` downloads, removing `cmd.exe call` re-expansion, excluding internal plans from npm packages, and adding a protected `--token-file` path for stable launches.
- Added Windows CI coverage and made smoke, stress, tunnel-shim, and runtime-status checks portable across Windows and Unix hosts.
- Made skill inventory and name-only `load_skill` use one deterministic winner per skill name, with workspace skills taking precedence over user-global and plugin skills.
- Kept explicit `source` and `path` overrides available for diagnostics or intentionally loading a suppressed duplicate.

## 0.29.0 (2026-07-13)

- Replaced the heavy v9 Apps widget with a compact, host-theme-aware v10 card for selected user-visible results: workspace, analysis, changes, Git status, handoff, and terminal verification.
- Fixed cards that stayed on a loading placeholder after ChatGPT completed a tool call by accepting bounded nested result envelopes and showing a clear unavailable state instead of an infinite animation.
- Kept raw reads and searches in normal chat output, added local copy support only for bounded terminal results, and added widget bridge smoke coverage.
- Added guarded release scripts that reject wrong-folder and `npm --prefix` pack/publish attempts, verify the canonical CodexPro tarball, and require a full release check before publishing.

## 0.29.0-beta.1 (npm beta, 2026-07-11)

- Added bounded multi-language repository analysis, grouped search results, change-impact and test recommendations, `codexpro inspect` / `codexpro review` CLI commands, and compact opt-in tool cards.
- Added `codexpro connection-test`, a read-only connector profile with no bash or tool cards, plus request-arrival logging and current ChatGPT Plugins troubleshooting.
- Added Tailscale Funnel as a saved tunnel/profile option, including `codexpro tailscale --hostname ...`, launcher support, admin profile support, and settings smoke coverage.
- Added proxy-aware Cloudflare quick tunnels: when proxy env vars are set, CodexPro requests quick-tunnel credentials through `curl --proxy`, runs `cloudflared` with a temporary credentials file, ignores Cloudflare API URLs, and cleans the credentials file after shutdown.
- Hardened Codex handoff execution on Windows by resolving spawnable Codex shims, asking Codex to read the plan file instead of argv-passing the whole plan, and recording git status in handoff artifacts.
- Added concise connector-creation troubleshooting to the English and Chinese FAQs.
- Bounded browser-facing tool-card structured payloads and binary-file text checks so CodexPro emits less data without reducing normal tool-result or binary-detection quality.
- Allowed targeted line-range reads and search matches in text files slightly above `maxReadBytes`, while keeping full-file reads and very large scans bounded.
- Replaced the overlong README with a shorter install, tunnel, safety, RAM-boundary, and development guide.
- Added a guarded `apply_patch` MCP tool for unified-diff edits inside workspace write mode, with blocked-path and secret-content checks before patches are applied.
- Added last-shown review checkpoints to `show_changes`, so repeated unchanged reviews collapse while new workspace changes still produce a fresh diff.
- Fixed checkpoint-hit `show_changes` responses so repeated unchanged reviews report zero new diff stats instead of carrying stale addition/deletion counts.
- Scoped `apply_patch` result diffs to the applied patch, so unrelated dirty tracked files are not folded into the patch card.
- Hardened safe bash filtering, path canonicalization, binary-file checks, ripgrep truncation reporting, and supertool argument validation around edge-case bypasses found by stress testing.
- Redacted child tunnel process output before logging or surfacing startup failures so Cloudflare `TUNNEL_TOKEN` values cannot leak from failed named-tunnel launches.
- Kept `codex_sessions` metadata mode from returning transcript-tail summaries, skipped unreadable stale history files, and accepted source paths under symlink-resolved Codex history roots.
- Hardened search, context export, path blocking, skill loading, and change summaries around hidden files, colon-containing paths, `.env` descendants, large-file limits, user skills, and diff stats.
- Blocked raw newline and carriage-return command separators in safe bash mode before whitespace normalization, including through the stable `codexpro` supertool wrapper.
- Corrected docs to describe Developer Mode account eligibility as broader than Plus/Pro while keeping the model/tool-surface limitation explicit.

## 0.28.6 (main, pending npm latest)

- Added the stable `codexpro` supertool wrapper for advanced connector-cache/custom workflows, while preserving tool/write/bash mode gates.
- Hardened direct HTTP auth defaults, local `--no-auth`, token redaction, search parsing, selected-path Pro exports, and handoff polling state.
- Added `npm run stress` to cover full-mode MCP behavior, supertool dispatch, skill caps, card payloads, search edge cases, Pro export, and handoff polling.
- Fixed CLI env precedence so `CODEXPRO_HOST` / `CODEXPRO_PORT` override generic `HOST` / `PORT`, preventing ambient process env from widening a launcher-validated bind.
- Normalized stable public hostnames in CLI settings/setup/start flows and accepted common `--flag=value` syntax.

- Made ChatGPT tool-card descriptor metadata opt-in with `CODEXPRO_TOOL_CARDS=1`, so default `tools/list` responses stay plain MCP and avoid fragile widget metadata during tool discovery.
- Added `codexpro loop-handoff` for bounded local execute/review loops over `.ai-bridge/current-plan.md`, with a required local `--review-command`, `--max-iters`, dry-run preview, optional test command capture, and stop conditions for no diff, repeated diff, missing follow-up plans, reviewer errors, and human cancellation.
- Hardened `loop-handoff` external-command boundaries: commands are preflighted before execution, reviewer verdicts require explicit `CODEXPRO_REVIEW=...` assignment lines by default, and reviewer `PASS` no longer masks failed executor/test/reviewer commands unless the user opts into the supported override behavior.
- Fixed loop change detection so `--stop-if-no-files-changed` and `--stop-if-same-diff` compare each iteration against a pre-execution baseline and count unstaged diffs, staged diffs, and untracked file fingerprints outside `.ai-bridge`.
- Switched loop guard decisions to an uncapped git-state fingerprint instead of hashing or vetoing on the trimmed reviewer diff artifact.
- Kept handoff plan hashing on the handoff read-size budget instead of `--max-output-bytes`, so valid plans larger than captured output excerpts do not abort the loop after execution.
- Made loop change fingerprints content/status based instead of timestamp based, so repeated identical tracked-file writes stop as no new changes instead of looking different because of volatile mtimes.
- Normalized Git porcelain paths back to workspace-relative paths before loop clean-start filtering and change fingerprinting, with path-scoped status and untracked-file scans so nested workspaces inside larger Git repos are handled correctly.
- Bounded untracked file fingerprinting so symlinks are reported via `readlink` and regular files hash only a capped prefix instead of following arbitrary paths or reading entire generated artifacts.
- Tightened `--require-clean-git-start` so staged renames are treated as handoff-only only when both rename endpoints are inside `.ai-bridge`.
- Stopped reviewer `FAIL` and implicit review verdicts from continuing when the reviewer deletes, empties, or restores `.ai-bridge/current-plan.md` to the scaffold instead of writing a usable follow-up plan.
- Kept the autonomous handoff loop CLI-only and local-terminal-owned; it does not expose agent execution as a remote MCP tool, automate ChatGPT Web, approve product prompts, proxy models, or bypass limits.
- Extended handoff smoke coverage with a fake reviewer that fails once by writing a follow-up plan, then passes on the second local executor iteration, plus failed executor, failed reviewer, bare `PASS`, staged-only, untracked-file, bounded-untracked, dirty-baseline, repeated-identical-write, nested-workspace, nested-untracked-workspace, outside-untracked-nested-workspace, large-dirty-baseline, unavailable-diff-artifact, large-plan-over-output-cap, staged-rename, deleted-follow-up-plan, and implicit-deleted-plan cases.

## 0.28.5

- Added a compatibility alias for stale ChatGPT descriptors that still request `ui://widget/codexpro-tool-card-v8.html`, while keeping `ui://widget/codexpro-tool-card-v9.html` as the current advertised widget.
- Stopped advertising the `bash` MCP tool when `CODEXPRO_BASH_MODE=off` / `codexpro start --no-bash` is active, so ChatGPT has less opportunity to attempt a shell tool call in no-bash sessions.
- Stopped advertising direct `write` and `edit` tools unless `CODEXPRO_WRITE_MODE=workspace`; handoff/off modes keep handoff planning tools available for bounded `.ai-bridge` plan files without exposing generic source edit actions.
- Added smoke coverage that compares `codexpro_self_test` expected tools against the actually registered MCP tool set, so disabled tools cannot silently remain visible in ChatGPT's tool list.
- Tightened `CODEXPRO_CONTEXT_DIR` to workspace-relative hidden directories such as `.ai-bridge`, rejecting source/build/dependency/credential directories and absolute paths.
- Made saved profile handling stricter: non-agent modes cannot inherit `write=workspace`, relative tunnel config/token paths resolve from the workspace, and `settings set` refuses to persist raw Cloudflare tunnel tokens.
- Completed the local admin profile form for named Cloudflare/ngrok settings, including tunnel name, config paths, token-file path, and cloudflared auto-install preference.
- Fixed path-scoped `show_changes` so unrelated workspace status is not reported for a clean requested path.
- Kept duplicate `load_skill` matches ambiguous until the caller supplies the exact displayed skill path.
- Added `codexpro_self_test`, a local-only diagnostic that checks modes, expected tools, safe bash policy, selected-only Pro context, and an optional `.ai-bridge/codexpro-self-test.md` write/edit probe without touching source files.
- Upgraded ChatGPT cards to `ui://widget/codexpro-tool-card-v9.html` and attached compact card metadata to every CodexPro tool, with large git/tree/context/bash payloads folded or bounded instead of printed as a giant chat block.
- Added `include_important_files` and `include_changed_files` controls to `export_pro_context` plus CLI smoke coverage for exact selected-only bundles.
- Added a dedicated compact `server_config` renderer and accepted model-friendly aliases `workspace_snapshot.max_files` plus `git_diff.include_diff=false` to reduce avoidable retry/error loops in ChatGPT.
- Reconfirmed the compliance boundary in runtime diagnostics and docs: CodexPro is a local workspace MCP bridge, not a model provider, model proxy, quota bypass, resale layer, or remote executor.
- Added `codexpro start --no-bash` and documented that CodexPro does not bind MCP bash to a Codex app conversation id.
- Added an optional bash session guard with `--bash-session <id> --require-bash-session`; guarded `bash` calls must include the matching `session_id` before any shell command runs.
- Made bash chat transcripts compact by default, with `--bash-transcript full` for the old raw stdout/stderr chat output.
- Added opt-in local Codex session discovery with `--codex-sessions metadata|read`, including session ids, titles, cwd paths, source files, resume commands, and bounded transcript reads only in explicit `read` mode.
- Added a token-protected local profile editor at `/admin/profile` and the setup page so users can save tunnel, hostname, port, mode, bash, Codex session, write/tool mode, widget origin, and tunnel config defaults for the next `codexpro start` without exposing raw tokens in the browser.

## 0.28.4

- Made workspace cards compact by default, moving git details, discovered skills, and optional file tree output behind collapsible disclosure rows.
- Changed workspace open skill discovery to include workspace, user, and plugin skills by default while still exposing a focused `standard` tool surface.
- Added read-only `load_skill` so ChatGPT can load bounded `SKILL.md` instructions for discovered workspace, user, or plugin skills without exposing arbitrary path reads.
- Kept AGENTS detection in the workspace open result but stopped embedding the full AGENTS file in the open response; agents can read it explicitly when needed.
- Fixed setup propagation for `--widget-domain` and corrected workspace-card git status splitting for multi-file diffs.

## 0.28.3

- Added `CODEXPRO_WIDGET_DOMAIN` and the Apps SDK resource metadata keys `_meta.ui.domain` plus `_meta["openai/widgetDomain"]` so ChatGPT no longer reports that the widget domain is missing.
- Surfaced the widget domain in server config, HTTP status output, docs, env examples, and smoke tests.

## 0.28.2

- Moved ChatGPT visual cards from `bash` to the workspace open tools so the first call gives a compact project orientation instead of noisy terminal cards.
- Kept `bash` data-only for focused verification commands and strengthened server instructions to prefer `tree`, `search`, `read`, and `show_changes` for inspection/review.
- Upgraded the widget to v8 with a workspace summary renderer and a neutral waiting state instead of a stale-looking running card.

## 0.28.1

- Added `CODEXPRO_TOOL_MODE=minimal|standard|full`, with `standard` as the default focused ChatGPT tool surface and `full` preserving the previous advanced toolbox.
- Added `show_changes` as a review-oriented visual card for git status, diff stats, and optional diff while keeping raw `git_diff` data-only.
- Upgraded the ChatGPT widget to v7 with compact bash execution summaries, review cards, and cleaner handoff cards.
- Allowed `open_workspace` to accept `path` as an alias for `root` to reduce client argument mismatch failures.
- Allowed safe package scripts with colon suffixes such as `npm run build:clients` for build/test verification.
- Surfaced tool mode in server config, local status, workspace/context exports, launcher output, setup profiles, and docs.

## 0.28.0

- Added `codexpro execute-handoff` as an opt-in local executor for `.ai-bridge/current-plan.md`.
- Added `codexpro watch-handoff` as an opt-in local watcher that executes new handoff plans by content hash without exposing execution as a remote MCP tool.
- Added built-in local adapters for `opencode`, `pi`, and `codex`, plus a restricted `--command` template path for custom agents.
- Added `--dry-run`, `--yes`, timeout handling, stdout/stderr capture, `agent-status.md`, `implementation-diff.patch`, and `execution-log.jsonl` output.
- Kept `handoff_to_agent` planning-only; local execution is not exposed as a remote MCP tool.
- Fixed Windows release-gate coverage for symlink-escape smoke tests, Bash lookup, and custom executor paths containing spaces.
- Added smoke coverage for dry-run previews, custom command validation, execution status, diff collection, duplicate watch-plan skipping, and structured execution logging.
- Clarified that CodexPro is an official Developer Mode/MCP workflow, not a rate-limit bypass or model access provider.

## 0.27.2

- Added `handoff_to_agent` for file-based handoffs to Codex, OpenCode, Pi, or custom local implementation agents without executing local commands.
- Extended `.ai-bridge` with generic `agent-status.md`, `implementation-diff.patch`, and `execution-log.jsonl` files.
- Updated `read_handoff`, `codex_context`, Pro apply logging, docs, and smoke coverage for generic agent handoffs.
- Fixed secret detection so benign env-var references like `process.env.TOKEN` are not blocked or redacted as literal secrets.
- Shell-quoted generated agent command hints so model names cannot inject extra shell tokens.
- Bounded append-mode handoff reads with the configured text-file size guard.

## 0.27.1

- Fail closed when HTTP MCP auth is required but `CODEXPRO_HTTP_TOKEN` is missing, including public tunnel mode and non-loopback binds.
- Block additional safe-bash bypass paths for absolute paths, parent paths, environment expansion, sensitive paths, and `find` write/action flags.
- Added smoke coverage for the missing-token HTTP startup failure and safe-bash blocked command cases.

## 0.27.0

- Kept terminal startup focused on only the connector URL and essential controls; usage prompts now belong in README/docs only.
- Made `git_diff` data-only instead of a widget-rendered tool. This reduces noisy ChatGPT cards and avoids template fetch failures for empty/no-op diffs.
- Kept visual cards scoped to high-signal outputs: source writes, exact edits, Pro context exports, and Codex handoffs.
- Updated smoke coverage so routine inspection tools stay compact.

## 0.26.0

- Removed prompt management from the terminal control panel.
- Removed the `s` hotkey and all launcher-side suggested prompt generation.
- Kept usage prompts and workflow examples in documentation instead of runtime UI.

## 0.25.0

- Simplified the ready screen so startup shows one compact status block instead of a long boxed next-step panel.
- Reduced visible controls to the common actions: open ChatGPT, copy URL, open status, copy prompt, help, and quit.
- Changed the `s` control to copy the suggested ChatGPT prompt instead of printing the full prompt repeatedly.
- Cleaned up saved setup list formatting so reused ngrok/Cloudflare profiles are easier to scan in narrow terminals.

## 0.24.0

- Added `codexpro settings list` to show all saved workspace tunnel profiles.
- Added `codexpro settings use` and `--from-root` to copy a saved setup from one workspace to another.
- Improved first-run `codexpro start` behavior: if the current workspace has no settings but other saved setups exist, CodexPro shows them as a numbered list so users can reuse an existing ngrok or Cloudflare setup instead of retyping hostnames.
- Expanded settings smoke coverage for profile listing and reuse.

## 0.23.0

- Added a compact first-run tunnel picker to `codexpro start` when no workspace settings exist, so users can choose Cloudflare quick, ngrok, Cloudflare stable, or local mode without running the full setup wizard.
- Added `codexpro settings` with `show`, `set`, and `delete --yes` actions for persistent per-workspace tunnel preferences.
- Persisted the selected tunnel provider, hostname, port, mode, and CodexPro token until the user changes or deletes the workspace settings.
- Added `scripts/settings-smoke.mjs` and included it in `npm run smoke`.

## 0.22.0

- Added the v5 Apps SDK widget resource at `ui://widget/codexpro-tool-card-v5.html` with cleaner pending states and more polished diff/search/code cards.
- Added a token-protected local admin dashboard at `/` and `/setup` for workspace, mode, allowed-root, setup, profile, and ChatGPT connection visibility.
- Added the terminal `o` control to open the local admin dashboard while CodexPro is running.
- Updated HTTP smoke coverage to verify the onboarding page and v5 widget resource.

## 0.21.0

- Added `codexpro doctor` as a read-only setup diagnostic for Node, build artifacts, workspace profiles, port availability, tunnel prerequisites, clipboard support, and browser-open support.
- Added `scripts/doctor-smoke.mjs` and included it in `npm run smoke`.
- Added `PUBLIC_LAUNCH_CHECKLIST.md` with release gates, ChatGPT Developer Mode golden prompts, security checks, onboarding expectations, and current non-goals.
- Added `npm run doctor` and included the public launch checklist in the npm package surface.

## 0.20.0

- Made `codexpro setup` prompts clearer with a dim "Enter to proceed with default" hint before each defaulted input.
- Simplified the ready screen: the Server URL is described as already copied, and Enter is clearly labeled as opening ChatGPT connector settings.
- Added saved-profile hints so ngrok/Cloudflare stable setups tell users that future launches from the same workspace only need `codexpro start`.
- Added a local port preflight with clear guidance for running two repositories at the same time.
- Documented the multi-repo rule: each concurrent repo needs its own local port, and stable public tunnels need separate hostnames.

## 0.19.0

- Added per-workspace saved profiles under `~/.codexpro/profiles/`.
- `codexpro setup` now saves tunnel provider, hostname, port, mode, and a generated reusable CodexPro auth token by default.
- `codexpro start` now loads the saved profile for the current workspace unless `--no-profile` is passed.
- Added `--save-config`, `--no-save-config`, and `--no-profile` launcher flags.

## 0.18.0

- Added ngrok as a first-class tunnel mode with `codexpro ngrok --hostname <domain>` and `--tunnel ngrok`.
- Added ngrok support to the interactive `codexpro setup` public URL choices.
- Added ngrok executable/config resolution with clear setup errors for missing auth or unavailable domains.
- Documented reserved ngrok domains as a stable ChatGPT connector URL option.

## 0.17.0

- Added `codexpro setup` / `codexpro onboard` as an interactive onboarding wizard for workspace, port, mode, and public URL strategy.
- Reworked the launcher startup and ready screens into compact framed panels with status lines instead of long setup text.
- Added `npm run connect:setup` for source checkouts.
- Documented the guided onboarding path next to the one-command `codexpro start` flow.

## 0.16.0

- Reworked the widget pre-result state so in-progress tool calls show a compact running card instead of raw placeholder JSON.
- Added `codexpro stable` and `--stable` as shortcuts for Cloudflare named-tunnel mode.
- Added `codexpro stable-help` and friendlier missing-hostname guidance for fixed ChatGPT app URLs.
- Updated setup docs around stable URLs for users who cannot edit an existing ChatGPT app connector URL.

## 0.15.0

- Changed `codexpro start` to default to agent mode with workspace writes enabled.
- Added `--mode agent`, `--mode handoff`, `--mode pro`, plus shortcut flags `--agent`, `--handoff`, and `--pro-planning`.
- Reworked the terminal startup panel to copy the Server URL, hide long setup details by default, and expose details through controls.
- Updated the default suggested ChatGPT prompt so ChatGPT edits/writes/verifies directly instead of creating a handoff plan.
- Kept handoff and Pro-context workflows as explicit modes for planning-only use.

## 0.14.0

- Added cross-platform `cloudflared` bootstrap for macOS, Windows, and Linux.
- CodexPro now reuses `cloudflared` from PATH first, then `~/.codexpro/bin`, then downloads the official Cloudflare release into `~/.codexpro/bin` when needed.
- Changed `--install-cloudflared` to force a user-local reinstall instead of using Homebrew.
- Added `codexpro install-cloudflared` for stable-domain setup without starting the MCP server.
- Kept `--no-install-cloudflared` as the opt-out for locked-down or manually managed machines.
- Updated setup docs with OS-specific notes for clipboard, browser opening, and Cloudflare Tunnel.

## 0.13.0

- Added an interactive CodexPro terminal control panel after startup.
- Added Enter-to-open ChatGPT connector settings, `c` to copy URL, `p` to print app fields, `s` to print the suggested prompt, and `q` to stop.
- Quieted local MCP and Cloudflare logs by default so startup reads like a product flow.
- Made macOS/Homebrew `cloudflared` installation automatic by default when missing.
- Added `--no-install-cloudflared` to opt out of automatic installation.
- Changed the default user-facing start command to `npx codexpro@latest start`.

## 0.12.0

- Added clipboard-first `CodexPro Start` flow for ChatGPT Developer Mode.
- Public HTTPS connector URLs are copied automatically when clipboard support is available.
- Added `--open-chatgpt`, `--copy-url`, and `--no-copy-url` launcher flags.
- Added opt-in `--install-cloudflared` for macOS/Homebrew users.
- Added `npm run connect:chatgpt` for source checkouts.
- Updated README setup path around one command: `npx codexpro@latest start --open-chatgpt`.

## 0.11.0

- Renamed the package, CLI, app labels, widget metadata, and environment variables to CodexPro.
- Removed the duplicate CLI binary entry from `package.json`.
- Added `DOMAIN_SETUP.md` with Namecheap, Cloudflare, stable tunnel, and future hosted-relay guidance.
- Changed the generated model fallback bundle title to `CodexPro Context Bundle`.
- Regenerated build output and package lock metadata for the CodexPro package name.

## 0.10.0

- Prepared the project for public open-source use.
- Added npm package metadata, keywords, engine requirements, public package files, and `prepack`.
- Added `codexpro` as a package-name binary so `npx codexpro@latest ...` works.
- Added `codexpro pro-bundle` and `codexpro pro-apply` CLI subcommands.
- Added `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md`.
- Removed local runtime reports from the public package surface.
- Reworked docs to avoid private local paths and product-specific model claims.

## 0.9.0

- Added stable Cloudflare named-tunnel mode with `--tunnel cloudflare-named`.
- Added `npm run connect:stable`.
- Added support for existing tunnel names, Cloudflare dashboard tunnel tokens, token files, and cloudflared config files.
- Added stable-host health checks before printing the ChatGPT connector URL.

## 0.8.2

- Fixed duplicate `AGENTS.md` loading on case-insensitive filesystems.
- Kept `codex_context` data-only so it does not create noisy widget cards.

## 0.8.1

- Added `codex_context` for AGENTS-style instructions, `.ai-bridge` handoff files, git status, and optional git diff.

## 0.8.0

- Made widget rendering quieter by attaching visual cards only to high-signal change tools.
- Added request and tool-call logging without printing prompts, file contents, or tokens.

## 0.7.0

- Reworked the Apps SDK widget into compact developer cards.
- Kept widget CSP strict with no external fetches, fonts, scripts, images, or iframes.

## 0.6.0

- Added CSP metadata for ChatGPT Developer Mode widget rendering.
- Added `codexpro_inventory` for sanitized skill and MCP server names.

## 0.5.0

- Added Apps SDK widget resources for selected tool outputs.

## 0.4.x

- Added `export_pro_context`.
- Added terminal helpers for creating and applying planning-context bundles.
- Added `open_current_workspace` for safer first calls from ChatGPT.
