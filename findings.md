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
- The real v13 default sandbox-fallback card rendered without increasing the template error count. Repeated explicit endpoint-domain runs had intermittent card fetch errors, so that alternate card-delivery route remains an open surface-specific reliability limit; it does not convert the successful default-path Goal/source-effect flow into a failure.

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

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Intermediate task status card showed zero diff metrics while changes existed | Return security-filtered live review counts, render absent counts as `—`, label partial counts as visible-only, and cover the exact persisted response shape |
| Pro treated a generic `open_workspace` denial for the private Goal worktree as a Goal verification failure | Keep the denial, add integrated `git diff --check` to `review_goal`, and explicitly route Pro away from generic workspace tools |
| Early Live projection draft accepted a caller fingerprint without authoritative comparison | Recompute the full review attestation under the locked operation and reject any HEAD/fingerprint mismatch before preparing source artifacts |
| Early path classification recorded each current path twice | Keep one current observation per manifest path so apply/revert CAS indexes remain aligned |
| Explicit endpoint-domain runs intermittently failed to fetch the v13 Goal card | Keep the verified default sandbox-fallback route as the current real-web evidence and track endpoint-domain delivery as a separate reliability follow-up; do not infer a Goal/source-effect failure from a card-only fetch error |

## Resources
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/reference
- [Ordinary Chat Supervised Live verification](https://chatgpt.com/c/6a7c7597-7e44-83ee-b412-4248eea6202e)
- `/Users/lyeun0314/Desktop/coding/codexpro-upstream/task_plan.md`

## Visual/Browser Findings
- Prior real Chat verification rendered the CodingTask card in both ordinary Chat and Work.
- The installed plugin currently exposes an empty-state CodingTask card because no durable task was present under the active allowed root.
- Ordinary Chat rendered multiple CodingTask cards across Direct creation, Codex collaboration, review, and ownership transfer. The final transcript included task/workspace/revision/thread/turn identifiers and a completed verification report.
- During the active-to-review transition, the visible card clearly said `Waiting review` but also showed `0 changed files`, `+0 additions`, `−0 deletions`, and no tests, which conflicts with the actual changed probe file.
- After refreshing the installed plugin, ordinary Chat rendered v11 proposal, approval, running/review, integration, and final `Completed` Goal cards. The final card showed both work items and explained that source application still requires a separate approved action.
- In the real Supervised Live flow, the v13 default sandbox-fallback card rendered and the template error count stayed flat. Explicit endpoint-domain variants intermittently failed at card fetch, so their delivery reliability is not yet verified.
