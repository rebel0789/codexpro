# Findings & Decisions

## Requirements
- Position CodexPro as: “ChatGPT Pro as coding orchestrator; Codex workers implement locally; Pro designs, integrates, and reviews.”
- Preserve three levels: Direct coding, independent CodingTask, optional durable Goal orchestration.
- Support supervised and persistent autonomous Goal policies using one engine.
- Use dependency-safe parallel workers and a Pro-supervised structured Blackboard.
- Keep code, state, worktrees, and Codex execution local; ordinary Chat is the primary control surface and Work remains supported.
- Provide a persistent Goal card with approvals, progress, drill-down, interruption, recovery, review, and apply controls.
- Validate through a real representative user flow, not only mocks or low-level harnesses.

## Research Findings
- Current OpenAI plugin documentation recommends one focused tool per recognizable user goal, concise `structuredContent`, accurate annotations, and server instructions for cross-tool sequencing.
- Current UI guidance supports MCP UI resources attached through `_meta.ui.resourceUri`; compatibility metadata can coexist.
- Stateful widgets should use a stable snapshot plus monotonic event token, retry-safe handlers, and server-side authoritative state.
- Current source already contains durable CodingTask state, isolated Git worktrees, revision/lease fencing, resumable Codex App Server threads, and a shared card renderer.
- CodingTask/App Server additions are present in the working tree but remain untracked and `Unreleased`; published npm behavior must not be inferred from the local source.
- The focused baseline is green: TypeScript build plus App Server, CodingTask core, detached runner, HTTP lifecycle, widget, and background-job smokes all pass.
- The existing package manifest includes `dist`, scripts, and selected root documentation; the product contract must be explicitly listed to ship in the npm package.
- A real ordinary-Chat flow completed against the installed `codexpro-recovered` plugin and installed `codex-cli 0.147.0`: Pro created a Direct CodingTask, wrote the draft, transferred ownership, launched a real Codex App Server turn, inspected persisted status/review, transferred back, and made the final Direct edit.
- Authoritative task identity: `task_03833bc129df48f8a62627f9`, workspace `taskws_03833bc129df48f8a62627f9`, Codex thread `019ff58e-a98a-7e91-aeb0-27bd57e14d8d`, turn `019ff58e-aa6c-7a91-96d1-92577ba78888`, final revision 47.
- The real Codex result reported `git diff --check` passed and changed only `codexpro-flow-probe.md`; Pro then appended a separate review section after ownership returned to Direct.
- UX friction: an intermediate `waiting_review` CodingTask card displayed 0 changed files/additions/deletions despite a persisted non-empty Git observation and review diff. Status cards must not present unknown/not-loaded review metrics as factual zero.
- Root cause confirmed: the widget's generic numeric fallback coerced absent review metrics to zero, while `get_coding_task` intentionally returned only a Git observation and discarded the live review's display counts.
- A representative real Goal completed in ordinary Chat through the installed private plugin. Two real `gpt-5.6-sol`/`high` workers started 51 ms apart, ran concurrently in separate CodingTask worktrees/threads, and produced exact one-file patches. Pro integrated both, reviewed the combined two-file patch, recorded the authoritative integrated `git diff --check`, and completed the Goal without source application.
- Private Goal integration worktrees must remain outside generic allowed workspace roots. The semantic review surface is `review_goal`; generic `open_workspace`, `read`, and `bash` must not become alternate access paths. Tool instructions now make the expected denial explicit and `review_goal` owns integrated whitespace verification.
- Supervised Live does not make workers or the Pro integration worktree live. The only source-facing operation is a separate user-confirmed `project_goal` bound to `review_goal`'s exact integration HEAD and recomputed deterministic review fingerprint.
- Safe Live operation needs both repository-level and path-level concurrency control: a per-repository lock serializes Goal source effects, while exact HEAD/file-mode/content/index observations prevent stale writes to changed paths without rejecting unrelated source dirt.
- Durable projection manifests and journals make response-loss retry and partial-write reconciliation possible. An observed path may be wholly before or after the intended delta; any third state is a user conflict and must become `recovery_required`, never an overwrite guess.
- Cancellation and source rollback are different authorities. Cancel stops Goal execution but retains applied projections; explicit revert is latest-applied-first (LIFO), uses its own idempotency key, and remains unavailable after final adoption.
- The safest final Live apply is no apply at all: when the exact completed integration checkpoint is already present, final `apply_goal` records a zero-write adoption and seals the projection.
- Live projection deliberately supports only regular files and executable regular files. Symlinks, submodules, conflicted index entries, rename/copy change types, and unsafe parent topology fail closed.
- Focused core and built HTTP/MCP verification passed the production projection/revert path, including sequential same-path checkpoints, same-key retry after response loss and server restart, unrelated worktree/index preservation, explicit LIFO revert, conflict recovery without overwrite, passive safer modes, and final zero-write adoption. A deterministic fake supplied worker edits only; it did not replace the source-effect implementation under test.
- The GoalStore correctness contract depends on OS-backed POSIX advisory locks for both orchestration state and repository source effects. A Windows fallback cannot preserve the accepted cross-process crash-safety guarantee, so this release hides the entire Goal surface there and rejects proposal before storing state; Direct coding and independent CodingTasks are unaffected.
- A representative Supervised Live happy path passed in ordinary Chat through the installed private plugin and a real `gpt-5.6-sol`/`high` Codex App Server turn: exact integration review, separate projection approval, completion, and zero-write final adoption all used the intended public tool flow.
- The durable evidence is Goal `goal_660f5139b15aae20456ed421` revision 13, CodingTask `task_aa18164b7d2a7357a6270545`, thread `019ff637-6f0f-75c0-b40f-e3d6f28ca8c6`, turn `019ff637-6fd9-7652-8835-aec10bc230f1`, integration `a4f0277f6822754ba0b9931b7a77e51ee36eb175`, review fingerprint `b6025428e44e79c0cd28770274fb9feda2bf68a571e31aeb5ea0547371c5068c`, and adopted projection `proj_32ac83deacc868d2f4799002`.
- Source authority remained bounded: HEAD was unchanged with reported pre/post prefix `037e…`, the approved 2-line/70-byte file was the only projected source change, and the flow did not stage, commit, push, or open a PR.
- The real v13 default sandbox-fallback card rendered without increasing the template error count, but Chat could retain stale renderer bytes when a payload changed under the same resource URI. The first cache-safe fix moved to v14; a later authoritative changed-file-count UI change correctly moved again to current v15. v14 through v8 remain compatibility resources.
- OpenAI's long-running-work guidance treats pause/resume and return-for-decisions as explicit lifecycle boundaries, while its local automation guidance requires the user's computer to remain available for local-file work. CodexPro Persistent's actual execution authority is its detached local scheduler; the CodexPro server starts, controls, and reconnects to it. It does not claim ChatGPT built-in Scheduled Tasks or offline Pro judgment.
- Phase 8 Persistent passed through the intended ordinary-Chat surface with Goal `goal_cd1d3bf868c2bdade5b1c7af`: explicit propose/approve/start, navigation away, real parallel `gpt-5.6-sol`/`high` A/B workers, then a dependent summary worker, followed by reconnect `get_goal` / `review_goal` at revision 20.
- The real Persistent scheduler stopped at `waiting_review` with stop reason `semantic_review`. Private integration contained exactly `a.md`, `b.md`, and `summary.md` at reported integration HEAD prefix `e05a497…`; source HEAD/index/refs and the source target path were unchanged, so disconnected mechanical execution did not cross the source or semantic authority boundary.
- The production built HTTP/MCP path also passed with an installed real Codex App Server. Verified behavior included disconnect/reconnect, pause/resume/cancel fencing, same-attempt reservation/restart idempotency, dependency-safe integration, passive reads, authoritative review, and clean scheduler/runner process termination.
- Review counts must derive from the Goal base→private-integration HEAD diff, not private worktree status: internal integration commits make the worktree clean even while the Goal has real changes. The final API returns `changedFileCount=3`, `changed_files_count=3`, and the same three policy-visible paths.
- Persistent Phase 8 deliberately remains one turn per worker and zero fresh retries. Same-attempt crash recovery preserves the original attempt identity; multi-turn continuation and a new automatic attempt remain separate later-phase authorities.
- Native Windows execution was not run. This is not a coverage gap for a supported path: the entire Goal surface is intentionally hidden/unsupported on Windows because the accepted GoalStore locking contract requires POSIX advisory locks; Direct and independent CodingTask remain supported.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Extend the existing TypeScript MCP server instead of scaffolding a new app | The current app already satisfies the local HTTP/MCP and ChatGPT connection contract |
| Add a durable Goal layer above, not inside, CodingTask | Independent CodingTasks remain first-class while Goal owns planning and orchestration |
| Use versioned snapshots and append-only bounded events | Supports reconnect, retries, card refresh, and auditability |
| Keep tool mutation effects server-authoritative | Hidden widget or Chat state must never own approvals or execution |
| Treat real Chat and real Codex verification as release evidence | Harnesses are supplemental under the accepted outcome standard |
| Publish an explicit implemented-versus-planned status table | Prevents the Goal roadmap from being mistaken for current npm capability |
| Store Goals under the existing canonical CodingTask data root | Reuses the established local trust boundary and avoids a second configuration surface |
| Keep Goal approval separate from execution | A proposed plan must be durably inspectable and fingerprint-bound before any Codex worker can start |
| Give Goal tasks optional persisted CodingTask membership | Independent CodingTasks stay unchanged while Goal-owned workers gain authoritative provenance |
| Use internal detached Git checkpoints only inside Goal-owned worktrees | Dependency-safe workers need stable bases without committing, branching, merging, or pushing the user's source workspace |
| Make `review_goal` the sole public inspection path for the private integration worktree | Preserves isolation while giving Pro an authoritative combined diff and integrated verification result |
| Make Live projection a separate confirmed tool after review | Prevents policy selection, worker completion, integration, or review from implicitly mutating the source workspace |
| Re-attest the integration review inside `project_goal` | A caller-provided fingerprint is meaningful only when compared with a fresh authoritative observation under the source-effect lock |
| Serialize source effects per repository and CAS only changed paths | Prevents concurrent Goal writes while preserving unrelated tracked, staged, and untracked user work |
| Journal apply and revert with immutable before/after manifests | Supports same-key recovery without using broad reset or guessing after partial writes |
| Restrict revert to latest applied projection (LIFO) | Earlier inverses are unsafe while a later dependent projection remains applied |
| Adopt an already-projected final checkpoint with zero writes | Separates final approval/sealing from redundant filesystem mutation |
| Fail closed for all Goal orchestration on Windows | Avoids presenting an unsafe process-local or stale-lock fallback as equivalent to the POSIX advisory-locking contract; Direct and CodingTask provide the supported Windows paths |
| Make `persistent` a separately fingerprinted Isolated execution contract | Automatic dependency scheduling and mechanical private integration are materially different authority from supervised per-worker integration and cannot be inferred from an older approval |
| Keep passive reads passive and require explicit execution recovery | `get_goal`, `list_goals`, and `review_goal` may observe scheduler health but never resolve Codex, reconcile, spawn, or persist; the original `start_key` or an explicit persistent resume owns recovery |
| Stop persistent execution at final Pro review | The local engine may execute the approved DAG and deterministic policy checks, but it cannot invent work, reinterpret criteria, complete the Goal, project/apply source changes, or make new semantic decisions while Pro is absent |
| Persist cancel/pause authority before touching child processes | A detached scheduler makes child-first cancellation or unfenced launch/integration races unacceptable; lifecycle intent must dominate every later side effect |
| Keep Phase 8 single-turn and zero-retry | Same-attempt crash recovery is required now, while new continuation turns and fresh automatic attempts remain separate Phase 9/10 contracts |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Intermediate task status card showed zero diff metrics while changes existed | Return security-filtered live review counts, render absent counts as `—`, label partial counts as visible-only, and cover the exact persisted response shape |
| Pro treated a generic `open_workspace` denial for the private Goal worktree as a Goal verification failure | Keep the denial, add integrated `git diff --check` to `review_goal`, and explicitly route Pro away from generic workspace tools |
| Early Live projection draft accepted a caller fingerprint without authoritative comparison | Recompute the full review attestation under the locked operation and reject any HEAD/fingerprint mismatch before preparing source artifacts |
| Early path classification recorded each current path twice | Keep one current observation per manifest path so apply/revert CAS indexes remain aligned |
| Chat could fetch stale v13 Goal renderer bytes after the payload changed without a resource-URI change | Treat the UI resource URI as part of the renderer contract: v14 carried the initial cache-key fix, and the later changed-file-count UI moved to current v15; retain v14–v8 only for legacy descriptors |
| Persistent review reported zero changed files because it counted clean integration-worktree status | Count policy-visible paths from the authoritative Goal base→integration HEAD diff and keep `changedFileCount`, `changed_files_count`, and `changedPaths` consistent |
| Stopped scheduler fixtures could leave an owned process after state cleanup | Terminate/continue owned children before deleting fixtures, then verify scheduler, CodingTask runner, and App Server PIDs are absent from the final process table |

## Resources
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/reference
- https://learn.chatgpt.com/docs/long-running-work
- https://learn.chatgpt.com/docs/automations
- [Ordinary Chat Supervised Live verification](https://chatgpt.com/c/6a7c7597-7e44-83ee-b412-4248eea6202e)
- [Task plan](task_plan.md)

## Visual/Browser Findings
- Prior real Chat verification rendered the CodingTask card in both ordinary Chat and Work.
- The installed plugin currently exposes an empty-state CodingTask card because no durable task was present under the active allowed root.
- Ordinary Chat rendered multiple CodingTask cards across Direct creation, Codex collaboration, review, and ownership transfer. The final transcript included task/workspace/revision/thread/turn identifiers and a completed verification report.
- During the active-to-review transition, the visible card clearly said `Waiting review` but also showed `0 changed files`, `+0 additions`, `−0 deletions`, and no tests, which conflicts with the actual changed probe file.
- After refreshing the installed plugin, ordinary Chat rendered v11 proposal, approval, running/review, integration, and final `Completed` Goal cards. The final card showed both work items and explained that source application still requires a separate approved action.
- In the real Supervised Live flow, the v13 default sandbox-fallback card rendered and the template error count stayed flat; the later stale-cache finding established that renderer changes must use a new URI.
- In the real Persistent flow, reconnect mounted the v14 Goal card after the user navigated away, and the authoritative tools showed the scheduler stopped for semantic review. The subsequent changed-file-count renderer change is shipped under current v15 and passed widget/HTTP regressions; v15 itself was not claimed as a separate real-Chat mount in that run.
