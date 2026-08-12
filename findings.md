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

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Intermediate task status card showed zero diff metrics while changes existed | Return security-filtered live review counts, render absent counts as `—`, label partial counts as visible-only, and cover the exact persisted response shape |
| Pro treated a generic `open_workspace` denial for the private Goal worktree as a Goal verification failure | Keep the denial, add integrated `git diff --check` to `review_goal`, and explicitly route Pro away from generic workspace tools |

## Resources
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/reference
- `/Users/lyeun0314/Desktop/coding/codexpro-upstream/task_plan.md`

## Visual/Browser Findings
- Prior real Chat verification rendered the CodingTask card in both ordinary Chat and Work.
- The installed plugin currently exposes an empty-state CodingTask card because no durable task was present under the active allowed root.
- Ordinary Chat rendered multiple CodingTask cards across Direct creation, Codex collaboration, review, and ownership transfer. The final transcript included task/workspace/revision/thread/turn identifiers and a completed verification report.
- During the active-to-review transition, the visible card clearly said `Waiting review` but also showed `0 changed files`, `+0 additions`, `−0 deletions`, and no tests, which conflicts with the actual changed probe file.
- After refreshing the installed plugin, ordinary Chat rendered v11 proposal, approval, running/review, integration, and final `Completed` Goal cards. The final card showed both work items and explained that source application still requires a separate approved action.
