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
- **Persistent (Phase 8 scheduler, Phase 9 continuations, Phase 10 retries):** the user separately proposes, approves, and starts a strict **Isolated** contract. The engine launches dependency-ready Codex workers and mechanically integrates verified final terminal patches in its private worktree, then stops at `waiting_review` / `semantic_review`. The Goal `commands` list is empty, network and every source-effect permission are false, each worker has 1–4 semantic turns including its initial turn, and an aggregate 0–2 fresh retries across all turns (default 0). Any turns after the first are mandatory ordered `continuation_intents`; retry authority is the separate fingerprinted `infra-pre-turn-v1` policy.

Workers and Pro's integration worktree always remain isolated. `review_goal` attests an exact integration checkpoint; only the separate `project_goal` authority can move that reviewed checkpoint toward source. Live application must stop if source HEAD, changed-path content/index state, or repository topology makes the approved baseline unsafe.

Persistent autonomy is bounded, not unlimited. The current contract retains
file, network, concurrency, time, turn, and resource boundaries and does not
authorize source actions. A continuation resumes the same CodingTask, worktree,
Codex thread, and session as a distinct operation. Intermediate success is
`continuing`: it remains private, cannot integrate, and cannot unlock a
dependency. Only the exact final authorized successful turn may integrate the
cumulative patch once. A continuation is a new approved semantic turn. A fresh
retry repeats the same semantic prompt/scope/task/worktree/model/effort under a
new deterministic operation without consuming a turn, preserving the
thread/session if already established. Same-operation recovery preserves the
original operation and consumes no retry.

Fresh retry authority is deliberately narrow: only positively structured
`app_server_startup / infrastructure / runner_start` or
`app_server_initialize_transport / infrastructure / app_server_initialize`
failures with a known outcome, no returned identity for that failed attempt, no
written thread-establish/turn-start request, and exact unchanged authoritative
Git observation may use the aggregate budget. A thread/session established by
an earlier semantic turn remains the immutable resume target. The fixed
backoff is 1 second then 5 seconds. Timeout,
model/tool/input/approval, policy/path/content/provenance/validation/identity
conflict, cancellation, any partial change, ambiguous response loss, and
unknown outcome stop without retry. This is a CodexPro safety contract, not an
inference from App Server's transport behavior. Official App Server semantics
only establish that `thread/resume` reopens a thread and later `turn/start`
appends a turn.

Pause, resume, and cancel are durable authorities. Once pause takes effect, no
new worker launch, backoff retry, integration, or dependency advancement begins; already
running worker processes may finish without being integrated. Resume is an
explicit idempotent execution action against the same fingerprint and resource
envelope, and completed work is not rerun. Cancel fences active workers and is
terminal, but never reverts source or deletes retained worktrees. Passive
`get_goal`, `list_goals`, and `review_goal` calls—and store-only
`refresh_goal`—never launch a retry or resume execution.

Tool metadata follows the same boundary. `start_goal` is execution-bearing and
still requires explicit start plus workspace-write/full-bash authority, but its
MCP destructive hint is `false` because Persistent execution stays in private
isolated worktrees and has no source effect. Projection and application remain
separate confirmed source actions.

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
lease/stop reason, worker status, authorized/completed/remaining semantic turn
counts, distinct attempt number and aggregate retries used/limit, deterministic
backoff deadline, bounded safe failure/Git attestation, intent summaries and
fingerprints, per-turn identity/status/stop reason, blockers, verification,
final-only integration state, authoritative changed-file count, and bounded
drill-down into each CodingTask. `list_goals` stays compact; exact prompts, raw
errors/logs, private paths, raw state, full ledgers, and Blackboard evidence
remain private.
Server state, not hidden widget state or chat history, is authoritative. The
current card resource is v17; v16 through v8 remain compatibility resources.
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
| Chat and Work task cards | Current resource is v17 with v16–v8 compatibility. Ordinary Chat mounted v14 for Phase 8, v16 for Phase 9 turn history, and v17 for Phase 10's separate semantic-turn/attempt/retry ledger. The real v17 card showed 1/1 turn, two attempts, retries 1/1, and one changed file. A stale v13 cache established the versioned-URI rule. |
| Durable Goal state and fingerprint-bound approval contract | Implemented in the current working tree; unreleased |
| Goal platform availability | Supported on POSIX hosts; all Goal tools are hidden on Windows and `server_config.goalOrchestration.supported=false`; Direct/CodingTask remain available |
| Parallel Goal workers and Pro-supervised Blackboard | Implemented for supervised and Persistent execution; deterministic HTTP/MCP and real ordinary-Chat flows verified |
| Pro integration worktree and final Isolated application | Implemented with drift/overlap checks and authoritative source readback |
| Supervised Live reviewed-checkpoint projection and explicit LIFO revert | Implemented and verified through a representative ordinary-Chat happy path on a supported POSIX host with the installed plugin and real `gpt-5.6-sol`/`high` App Server; focused core/HTTP tests separately cover CAS, recovery, LIFO revert, and retry |
| Persistent Isolated scheduler | Implemented in the current working tree and verified through ordinary Chat plus installed-real-Codex HTTP/MCP: explicit start, disconnect, dependency-safe parallel workers, mechanical private integration, passive reconnect, and `waiting_review` / `semantic_review` stop |
| Persistent interruption and recovery | Pause/resume/cancel fencing, same-attempt reservation/lease recovery, restart idempotency, and process cleanup pass focused core/HTTP regressions; native Windows was not run and Goal orchestration remains hidden there by contract |
| Bounded multi-turn Persistent workers | Implemented and verified through built public HTTP/MCP, an installed real Codex App Server, and canonical ordinary Chat: 1–4 total approved turns, immutable ordered continuation intents, same task/worktree/thread/session, intermediate integration/dependency gate, and one final cumulative integration. |
| Bounded fresh infrastructure retries | Implemented for Persistent only: aggregate 0–2 per work item (default 0), fingerprinted `infra-pre-turn-v1`, fixed 1s/5s backoff, positive pre-turn infrastructure proof plus exact unchanged Git, full attempt retention, and no semantic-turn consumption. Same-operation recovery remains distinct. |
| Representative real Isolated Goal completion in Chat | Verified in ordinary Chat through the installed private plugin and real Codex App Server: two `gpt-5.6-sol`/`high` workers overlapped, Pro integrated/reviewed/completed, and source application remained unset |
| Representative real Live Goal completion in Chat | Verified exact review → separate projection approval → completion → zero-write final adoption; projection `proj_32ac83deacc868d2f4799002` was adopted, source HEAD stayed unchanged, and only the approved 2-line/70-byte file was projected |
| Representative real Persistent Goal stop in Chat | Verified Goal `goal_cd1d3bf868c2bdade5b1c7af` through explicit propose/approve/start, navigation away, real parallel `gpt-5.6-sol`/`high` A/B workers followed by a summary dependency, and reconnect at revision 20. Exactly `a.md`, `b.md`, and `summary.md` reached private integration HEAD prefix `e05a497…`; source HEAD/index/refs and the source target path were unchanged at the semantic-review stop. |
| Representative real-Codex bounded continuation | Verified through built HTTP/MCP with Goal `goal_f18e1e62ec5797e868fd6421`, CodingTask `task_8eb28bf1e327e3cbb2ac2a92`, thread `019ff6ef-94b9-7bc3-adbb-ced648a29472`, two distinct turns, one final integration commit, and exact source authority preservation. |
| Representative ordinary-Chat bounded continuation | Verified Goal `goal_d96c4d1de3d6382cc4ebcc86` revision 15 through the installed plugin: one task/thread/session, operations `run:1` / `run:2`, no intermediate integration, exactly one final commit `124787d868b3d89a1191d394192831cd3fb5c46e`, exact two-line path, byte-identical passive reconnect/source readback, and a fully rendered v16 2/2 card. The source's unrelated `cd0f3e18…` commit predated start; Goal base remained `ce4421d…`. |
| Representative real-Codex infrastructure retry | Verified through built HTTP/MCP with Goal `goal_b134f2acc8a910aedd6d31d5`: injected initialize failure, then real `gpt-5.6-sol`/`high` success on attempt 1, one private integration commit, source unchanged. |
| Representative ordinary-Chat infrastructure retry | Verified Goal `goal_855e97294fe7d3a8f25a06fe` revision 14 through the installed plugin: allowed initialize-transport failure with no turn/changes, exact 1s backoff, real Codex success on attempt 1, one private integration commit, unchanged source authority, byte-identical duplicate passive reads, and a fully rendered v17 1-turn/2-attempt/retries-1-of-1 card. |

This status table is part of the contract: documentation and tests must not present planned Goal behavior as a shipped capability.
