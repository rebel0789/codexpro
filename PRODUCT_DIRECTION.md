# CodexPro Product Direction

**Accepted:** 2026-08-12  
**Status:** Product contract; implementation is incremental and current release status is called out below.

## Product promise

> **ChatGPT Pro as the coding orchestrator. Codex workers implement in local repositories; Pro designs, integrates, and reviews.**

CodexPro is for an individual developer working in an existing Git repository who wants to combine ChatGPT Pro's design and judgment with Codex's implementation throughput without uploading the repository to a CodexPro-hosted service.

## Three levels of work

1. **Direct coding** — ChatGPT inspects, edits, and verifies the allowed workspace itself.
2. **Independent CodingTask** — one durable worktree and Codex thread handle a focused delegated task; ChatGPT reviews, follows up, or takes ownership back.
3. **Goal orchestration** — ChatGPT Pro proposes and supervises a durable execution contract, assigns dependency-safe CodingTasks to parallel Codex workers, integrates their results, and judges completion.

Independent CodingTasks remain first-class. A Goal is added only when a request benefits from planning, decomposition, parallel work, or long-running recovery.

Platform availability is part of the capability boundary. Goal orchestration requires POSIX advisory locking and is wholly unavailable/hidden on Windows in this release. Direct coding and independent CodingTasks remain supported there.

## Authority model

| Actor | Authority |
| --- | --- |
| User | Approves scope, permission expansion, resource limits, and external effects |
| ChatGPT Pro | Interprets the goal; designs, decomposes, assigns, replans, integrates, reviews, and decides whether completion criteria are met |
| Codex worker | Implements and tests only its assigned scope, then reports results and blockers |
| Local CodexPro engine | Authoritative storage and enforcement for Goal state, approvals, leases, worktrees, worker runs, and recovery |

ChatGPT Pro is the semantic authority; the local engine is the execution
authority. Under Persistent, the local engine may schedule dependency-ready
workers and mechanically integrate exact terminal patches only when provenance,
scope, path policy, and the approved graph authorize it. It cannot invent work,
reinterpret completion criteria, publish a decision, complete the Goal, or
perform a source effect. Closing Chat does not erase a Goal, but the computer
and detached scheduler must remain running while work progresses; the CodexPro
server is required to start, control, or reconnect. This is local persistence—not
ChatGPT's built-in Scheduled Tasks and not offline Pro judgment. If new design
judgment or broader permission is required, execution stops until Pro and the
user return.

## Worker collaboration

Workers use a **Pro-supervised Blackboard**, not an unrestricted agent mesh.

Workers may publish and consume structured records for:

- evidence-backed discoveries;
- interface and schema contracts;
- file ownership and changed paths;
- dependency questions and answers;
- blockers;
- test and verification results;
- decisions approved by Pro.

Only Pro can create work, change scope, reassign responsibility, alter
dependencies, or approve a semantic integration decision. Persistent may only
perform the deterministic patch integration already authorized by that exact
fingerprinted contract.

## Execution policies

The same Goal engine supports two policies:

- **Supervised:** the user approves the plan, observes the work, and approves each source effect. Its default workspace policy is **Live**, so an exact Pro-reviewed integration checkpoint can be projected promptly into the user's current workspace through a separate confirmed action.
- **Persistent (Phase 8):** the user separately proposes, approves, and starts a strict **Isolated** contract. The engine launches dependency-ready Codex workers and mechanically integrates verified terminal patches in its private worktree, then stops at `waiting_review` / `semantic_review`. The Goal `commands` list is empty, network and every source-effect permission are false, each worker gets one turn, and there are zero fresh automatic retries.

Workers and Pro's integration worktree always remain isolated. `review_goal` attests an exact integration checkpoint; only the separate `project_goal` authority can move that reviewed checkpoint toward source. Live application must stop if source HEAD, changed-path content/index state, or repository topology makes the approved baseline unsafe.

Persistent autonomy is bounded, not unlimited. The current contract retains
file, network, concurrency, time, and resource boundaries and does not authorize
source actions. Recovering the same reserved attempt after a crash or reconnect
does not count as a fresh retry. Multi-turn workers and fresh retries remain
later contracts rather than implicit extensions of Phase 8 approval.
Abnormal worker termination, stale terminal provenance, out-of-scope or blocked
content, and scheduler safety/reconciliation errors stop or fail execution
closed; they never trigger an autonomous replan or replacement attempt.

Pause, resume, and cancel are durable authorities. Once pause takes effect, no
new worker launch, integration, or dependency advancement begins; already
running worker processes may finish without being integrated. Resume is an
explicit idempotent execution action against the same fingerprint and resource
envelope, and completed work is not rerun. Cancel fences active workers and is
terminal, but never reverts source or deletes retained worktrees. Passive
`get_goal`, `list_goals`, and `review_goal` calls—and store-only
`refresh_goal`—never launch or resume execution.

## Goal experience in Chat

Ordinary Chat is the primary surface; Work remains supported. A complex request should cause Pro to propose Goal conversion rather than requiring a special command.

The approved plan is a structured execution contract containing:

- goal, exclusions, and completion criteria;
- verification requirements;
- CodingTasks, dependencies, and parallel groups;
- worker model and reasoning effort;
- concurrency, time, turn, retry, and log limits;
- file, command, and network permissions;
- integration and source-application policy.

A persistent Goal card shows overall state, current phase, approvals, scheduler
lease/stop reason, worker status, blockers, verification, integration state,
authoritative changed-file count, and bounded drill-down into each CodingTask.
Server state, not hidden widget state or chat history, is authoritative. The
current card resource is v15; v14 through v8 remain compatibility resources.
Renderer changes always receive a new URI so a stale Chat cache cannot preserve
old semantics.

## Git and source effects

- A Goal is anchored to an explicit committed base SHA even when the source workspace already contains unrelated uncommitted work.
- Parallel worker results are integrated in a dedicated Goal worktree in dependency order.
- Source drift and conflicts are checked before each Live projection, projection revert, or final Isolated application. Unrelated tracked, staged, and untracked work is preserved.
- Every Live projection is separately confirmed and bound to the exact integration HEAD and review fingerprint returned by `review_goal`.
- Goal source effects serialize under a per-repository lock, use exact path/content/index CAS, and persist immutable manifests plus a durable journal for idempotent retry recovery.
- Cancellation never implies source rollback. A revert is a separate latest-applied-first (LIFO) action and refuses to overwrite a user's later same-path edit; unresolved conflicts become `recovery_required`.
- A completed Live Goal adopts and seals an already-projected matching final checkpoint without writing source twice.
- The final review shows completion criteria, design decisions, worker results, combined diff, tests, skipped checks, risks, and source drift.
- Live projection and final apply are separate source permissions. The implemented slice never stages, commits, merges, pushes, or opens a PR.
- Unsupported symlink, submodule, conflicted-index, rename/copy, and non-regular-file cases fail closed.
- CodexPro never treats `git reset` as a safe generic undo for a dirty user workspace. Goal-owned changes require a bounded journal/checkpoint so pre-existing work is preserved.

## Distribution and trust

The product shape is:

1. a ChatGPT plugin as the user-facing tool and card surface;
2. an orchestration skill that teaches Pro the planning, assignment, review, and approval protocol;
3. a local engine that owns code, Git worktrees, state, and Codex processes.

The local engine, plugin, and Goal orchestration remain open source. Optional future hosted or team-management convenience may form a commercial boundary, but hosted source execution and multi-user collaboration are not part of the first product.

Installation is complete only when the local engine is running, a repository is explicitly allowed, the ChatGPT plugin is connected and refreshed, and the first card renders through the real ChatGPT flow.

## MVP proof

The first Goal vertical slice must demonstrate, through ordinary Chat and the public HTTPS MCP endpoint:

1. a Pro-proposed structured plan and explicit approval;
2. two or three dependency-safe CodingTasks executing concurrently;
3. structured Blackboard sharing without scope mutation by workers;
4. Pro-controlled integration and whole-repository verification;
5. Live or Isolated source policy;
6. interruption and reconnect recovery;
7. an applicable integrated result with at most one user-driven replan.

The primary metric is **Goal completion rate**: the share of representative Goals that produce an applicable, verified integrated result within the approved contract and with no more than one user-driven replan.

## Explicit non-goals for the first product

- multi-user team collaboration;
- CodexPro-hosted source execution;
- unrestricted worker-to-worker mesh authority;
- implicit push or merge;
- permissionless or resource-unbounded autonomy;
- a separate web dashboard as the primary interface;
- a general no-code app builder for non-developers.

## Current implementation status

| Capability | Status on 2026-08-13 |
| --- | --- |
| Direct ChatGPT coding | Implemented |
| Independent persistent CodingTask and Direct↔Codex transfer | Implemented in the current working tree; unreleased |
| Chat and Work task cards | Current resource is v15 with v14–v8 compatibility. Ordinary Chat mounted the v14 Persistent reconnect card; the later authoritative changed-file-count UI required v15 and passed widget/HTTP regressions. A stale v13 cache established the versioned-URI rule. |
| Durable Goal state and fingerprint-bound approval contract | Implemented in the current working tree; unreleased |
| Goal platform availability | Supported on POSIX hosts; all Goal tools are hidden on Windows and `server_config.goalOrchestration.supported=false`; Direct/CodingTask remain available |
| Parallel Goal workers and Pro-supervised Blackboard | Implemented for supervised and Persistent execution; deterministic HTTP/MCP and real ordinary-Chat flows verified |
| Pro integration worktree and final Isolated application | Implemented with drift/overlap checks and authoritative source readback |
| Supervised Live reviewed-checkpoint projection and explicit LIFO revert | Implemented and verified through a representative ordinary-Chat happy path on a supported POSIX host with the installed plugin and real `gpt-5.6-sol`/`high` App Server; focused core/HTTP tests separately cover CAS, recovery, LIFO revert, and retry |
| Persistent Isolated scheduler | Implemented in the current working tree and verified through ordinary Chat plus installed-real-Codex HTTP/MCP: explicit start, disconnect, dependency-safe parallel workers, mechanical private integration, passive reconnect, and `waiting_review` / `semantic_review` stop |
| Persistent interruption and recovery | Pause/resume/cancel fencing, same-attempt reservation/lease recovery, restart idempotency, and process cleanup pass focused core/HTTP regressions; native Windows was not run and Goal orchestration remains hidden there by contract |
| Multi-turn Persistent workers | Planned; unsupported values fail closed |
| Fresh automatic worker retries | Planned; Phase 8 permits zero fresh retries, while same-attempt crash recovery preserves identity |
| Representative real Isolated Goal completion in Chat | Verified in ordinary Chat through the installed private plugin and real Codex App Server: two `gpt-5.6-sol`/`high` workers overlapped, Pro integrated/reviewed/completed, and source application remained unset |
| Representative real Live Goal completion in Chat | Verified exact review → separate projection approval → completion → zero-write final adoption; projection `proj_32ac83deacc868d2f4799002` was adopted, source HEAD stayed unchanged, and only the approved 2-line/70-byte file was projected |
| Representative real Persistent Goal stop in Chat | Verified Goal `goal_cd1d3bf868c2bdade5b1c7af` through explicit propose/approve/start, navigation away, real parallel `gpt-5.6-sol`/`high` A/B workers followed by a summary dependency, and reconnect at revision 20. Exactly `a.md`, `b.md`, and `summary.md` reached private integration HEAD prefix `e05a497…`; source HEAD/index/refs and the source target path were unchanged at the semantic-review stop. |

This status table is part of the contract: documentation and tests must not present planned Goal behavior as a shipped capability.
