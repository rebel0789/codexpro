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

## Authority model

| Actor | Authority |
| --- | --- |
| User | Approves scope, permission expansion, resource limits, and external effects |
| ChatGPT Pro | Interprets the goal; designs, decomposes, assigns, replans, integrates, reviews, and decides whether completion criteria are met |
| Codex worker | Implements and tests only its assigned scope, then reports results and blockers |
| Local CodexPro engine | Authoritative storage and enforcement for Goal state, approvals, leases, worktrees, worker runs, and recovery |

ChatGPT Pro is the semantic authority; the local engine is the execution authority. Closing Chat does not erase a Goal, but the local engine may only execute an already approved contract. If new design judgment or broader permission is required, execution pauses until Pro and the user return.

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

Only Pro can create work, change scope, reassign responsibility, alter dependencies, or approve an integration decision.

## Execution policies

The same Goal engine supports two policies:

- **Supervised:** the user approves the plan, observes the work, and approves the final source effect. Its default workspace policy is **Live**, so Pro-reviewed integration changes can appear promptly in the user's current workspace.
- **Persistent autonomous:** the user approves the goal, permissions, and resource envelope once. The engine continues planned Codex work without intermediate approval and pauses when fresh semantic judgment is required. Its default workspace policy is **Isolated**.

Workers always execute in isolated worktrees. Only Pro's integration flow can move a reviewed result toward the source workspace. Live application must stop if source drift makes the approved baseline unsafe.

Persistent autonomy is bounded, not unlimited. The contract always retains file, command, network, concurrency, retry, time, and resource boundaries, plus explicit interruption and recovery.

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

A persistent Goal card shows overall state, current phase, approvals, worker status, blockers, verification, integration state, and bounded drill-down into each CodingTask. Server state, not hidden widget state or chat history, is authoritative.

## Git and source effects

- A Goal is anchored to an explicit committed base SHA even when the source workspace already contains unrelated uncommitted work.
- Parallel worker results are integrated in a dedicated Goal worktree in dependency order.
- Source drift and conflicts are checked before each Live application or final isolated application.
- The final review shows completion criteria, design decisions, worker results, combined diff, tests, skipped checks, risks, and source drift.
- Apply, commit, push, and draft-PR effects are separate permissions. Push and PR creation require explicit remote authority.
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

| Capability | Status on 2026-08-12 |
| --- | --- |
| Direct ChatGPT coding | Implemented |
| Independent persistent CodingTask and Direct↔Codex transfer | Implemented in the current working tree; unreleased |
| Chat and Work task cards | Verified in the installed private plugin |
| Durable Goal state and fingerprint-bound approval contract | Implemented in the current working tree; unreleased |
| Parallel Goal workers and Pro-supervised Blackboard | Implemented for supervised execution; deterministic HTTP/MCP and real ordinary-Chat flows verified |
| Pro integration worktree and final Isolated application | Implemented with drift/overlap checks and authoritative source readback |
| Persistent autonomous scheduler, automatic retries/multi-turn work, and incremental Live projection | Planned; unsupported values fail closed rather than behaving like supervised Isolated mode |
| Representative real Goal completion in Chat | Verified in ordinary Chat through the installed private plugin and real Codex App Server: two `gpt-5.6-sol`/`high` workers overlapped, Pro integrated/reviewed/completed, and source application remained unset |

This status table is part of the contract: documentation and tests must not present planned Goal behavior as a shipped capability.
