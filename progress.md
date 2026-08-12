# Progress Log

## Session: 2026-08-12

### Phase 1: Product contract and baseline
- **Status:** complete
- **Started:** 2026-08-12
- Actions taken:
  - Completed a 12-round product-direction interview and received final user confirmation.
  - Classified the app as `interactive-decoupled`.
  - Fetched current official OpenAI plugin MCP, UI, tool-planning, and reference documentation.
  - Created persistent planning, findings, and progress files.
  - Ran the existing build and focused App Server, CodingTask, HTTP, widget, and background-job baseline tests; all passed.
  - Added the accepted product contract and linked it from the README without presenting planned Goal behavior as shipped.
  - Verified the release guard, package dry-run, and diff whitespace; `PRODUCT_DIRECTION.md` and the compiled CodingTask/App Server runtime are included in the npm artifact.
- Files created/modified:
  - `task_plan.md` (created)
  - `findings.md` (created)
  - `progress.md` (created)
  - `PRODUCT_DIRECTION.md` (created)
  - `README.md` (updated)
  - `package.json` (updated)

### Phase 2: Representative single-CodingTask validation
- **Status:** complete
- Actions taken:
  - Ran the real flow in ordinary Chat against the installed private plugin and installed Codex App Server.
  - Pro created a Direct task and draft; Codex edited one delegated file and ran `git diff --check`; Pro reviewed persisted output/diff, took Direct ownership back, and added the final review text.
  - Captured the final task/workspace/revision/thread/turn identifiers and card rendering.
  - Identified a misleading intermediate card metric: missing diff data rendered as numeric zero.
  - Traced the mismatch to the real `get_coding_task` structured response and implemented an honest review-summary contract plus unknown-state card rendering.
  - Added security-filtered changed-file/addition/deletion metrics to persisted review readback; partial review counts are labeled visible-only.
  - Verified the fix through the compiled widget, core worktree review, and built HTTP/MCP lifecycle.
- Files created/modified:
  - `src/codingTaskWorktree.ts`
  - `src/server.ts`
  - `src/toolCardWidget.ts`
  - `scripts/coding-task-core-smoke.mjs`
  - `scripts/widget-smoke.mjs`

### Phase 3: Durable Goal domain and execution contract
- **Status:** complete
- Actions taken:
  - Mapped the accepted Goal contract onto the existing canonical CodingTask data root and lock/atomic-write safety model.
  - Fixed the authority boundary: proposal is inert, approval is fingerprint-bound, and execution remains a separate explicit action.
  - Chose optional persisted Goal membership for worker CodingTasks so standalone tasks remain first-class.
  - Implemented canonical Goal state/store validation, DAG enforcement, fingerprint-bound approval, bounded Blackboard records, and response-loss-safe idempotency.
  - Added focused Chat/MCP tools for propose/get/list/approve/publish plus persistent Goal cards.
  - Added optional, validated Goal membership to CodingTask without changing standalone task behavior.
  - Verified proposal inertness, dirty-source exclusion, approval authority, Blackboard worker restrictions, persistence, cards, and MCP inventory.

### Phase 4: Parallel workers and Pro-supervised integration
- **Status:** complete for the supervised Isolated slice
- Actions taken:
  - Added explicit `start_goal`, passive `get_goal`, explicit `refresh_goal`, `integrate_goal_work`, and `review_goal` authority boundaries.
  - Launched two detached Goal-owned CodingTasks in parallel with the accepted model/effort/resource contract.
  - Enforced Goal and work-level file scopes before integration; blocked content cannot enter the Goal patch.
  - Integrated disjoint worker patches in Pro-controlled order into a dedicated detached Goal worktree using internal checkpoints; source HEAD and working tree stayed unchanged.
  - Prevented public standalone transition/run/follow-up tools from bypassing Goal assignment authority.
  - Added journaled final source application with exact-base and dirty-path overlap checks; unrelated user dirt is preserved and no stage/commit/push occurs.
  - Kept incremental Live projection and a persistent autonomous scheduler open rather than treating stored policy labels as implementation.

### Phase 5: Goal card and Chat control flow
- **Status:** complete
- Actions taken:
  - Added all Goal tools to the normal MCP inventory with accurate read/mutation annotations and explicit proposal → approval → start → review → completion → apply sequencing.
  - Added a persistent Goal renderer for lifecycle, approval, work graph, Blackboard, review, and next action.
  - Bumped the Apps resource to v11 while retaining legacy v10/v9/v8 resource compatibility.
  - Added deterministic HTTP/MCP coverage for reconnect, parallel execution, Blackboard, integration, completion, and source application.

### Phase 6: End-to-end verification and delivery
- **Status:** complete for the supervised Isolated MVP
- Actions taken:
  - Updated product status, README/FAQ, security guidance, and changelog to distinguish the implemented supervised Isolated slice from planned persistent, Live, multi-turn, and retry behavior.
  - Added fail-closed validation so unsupported Goal policy/resource values cannot masquerade as implemented behavior.
  - Refreshed the installed private plugin and verified v11 Goal cards in ordinary Chat, including the stable `codexpro` wrapper path.
  - Completed real Goal `goal_127968d00a9deb6cb64b0c93`: ChatGPT Pro approved the exact fingerprint, launched two real `gpt-5.6-sol`/`high` Codex workers, reviewed both CodingTasks, integrated exact disjoint patches, ran the authoritative combined `git diff --check`, and persisted completion at revision 15.
  - Verified real concurrency: alpha started at `11:37:01.509Z`, beta at `11:37:01.560Z`, and both finished near `11:37:28Z`, so both entire run intervals overlapped.
  - Verified source non-application after completion: source HEAD, status hash, and refs hash match the pre-execution readback; both Goal probe files remain absent from source and `sourceApplication` is unset.
  - Corrected an actual Chat usability defect: private Goal worktrees remain intentionally inaccessible through `open_workspace`, while `review_goal` now owns the combined diff plus integrated `git diff --check` evidence and tells Pro that an allowed-root denial is not a Goal failure.

### Phase 7: Supervised Live source effects
- **Status:** complete for implementation, focused core/built HTTP-MCP verification, and one representative ordinary-Chat Live happy path
- Actions taken:
  - Kept every Goal worker and the Pro integration worktree isolated; Live begins only at a separately confirmed `project_goal` after `review_goal` returns an exact integration HEAD and deterministic review fingerprint.
  - Added authoritative review re-attestation, expected-revision/idempotency fencing, exact source HEAD and changed-path content/index CAS, per-repository locking, immutable manifests, and durable apply/revert journals.
  - Preserved unrelated pre-existing tracked, staged, and untracked work while rejecting same-path user edits without overwrite and persisting `recovery_required` for deliberate recovery.
  - Added explicit latest-applied-first `revert_goal_projection`; `cancel_goal` never reverts source.
  - Added zero-write final adoption/sealing when a completed Live Goal's final integration checkpoint is already projected.
  - Kept stage, commit, merge, push, and PR effects out of every Goal source operation; unsupported symlink, submodule, conflicted-index, rename/copy, and non-regular topology fail closed.
  - Passed the focused core matrix and the built HTTP/MCP flow: sequential same-path projections, same-key and post-restart idempotency, unrelated worktree/index preservation, latest-first revert, user-edit conflict recovery without overwrite, blocked/symlink fail-closed behavior, passive safer modes, and final zero-write adoption. Deterministic workers supplied the test edits; the source projection/revert path was production code.
  - Confirmed TypeScript build, Goal core/execution regressions, widget rendering, and general smoke remain green.
  - Made platform capability explicit: the whole Goal surface is hidden on Windows because the required crash-safe GoalStore locking contract is unavailable; proposal also rejects before persisting state, while Direct coding and standalone CodingTasks remain supported.
  - Completed the intended flow in [ordinary Chat](https://chatgpt.com/c/6a7c7597-7e44-83ee-b412-4248eea6202e): Pro used the installed plugin and a real `gpt-5.6-sol`/`high` Codex App Server turn, reviewed integration `a4f0277f6822754ba0b9931b7a77e51ee36eb175`, separately approved Live projection, completed Goal `goal_660f5139b15aae20456ed421` at revision 13, and finalized with a zero-write apply that adopted `proj_32ac83deacc868d2f4799002`.
  - Authoritative identity was CodingTask `task_aa18164b7d2a7357a6270545`, thread `019ff637-6f0f-75c0-b40f-e3d6f28ca8c6`, turn `019ff637-6fd9-7652-8835-aec10bc230f1`, and review fingerprint `b6025428e44e79c0cd28770274fb9feda2bf68a571e31aeb5ea0547371c5068c`. Source HEAD was unchanged, with the reported pre/post prefix `037e…`; the approved 2-line/70-byte file was the only projected source change, with no stage, commit, push, or PR.
  - The v13 default sandbox-fallback card rendered in the real web flow and the template error count did not increase. Explicit endpoint-domain runs intermittently failed to fetch the card, so that alternate delivery path remains a separate reliability limitation rather than verified coverage.

### Phase 8: Persistent autonomous scheduler
- **Status:** complete for the accepted one-turn/zero-fresh-retry POSIX contract; native Windows execution not run and all Goal tools remain unsupported there
- Actions taken:
  - Re-read the official plugin MCP/UI contract and the Codex App Server contract before changing the public surface.
  - Audited the existing Goal, CodingTask runner, MCP/card, HTTP verification, security, and documentation boundaries in parallel.
  - Froze persistent execution as a new fingerprinted authority rather than reinterpreting existing supervised approvals: POSIX-only, Isolated, network disabled, no source effects, one turn, and zero fresh retries for this phase.
  - Fixed the scheduler boundary on paper before implementation: detached local execution may launch approved dependency-ready workers and mechanically integrate an exact policy-valid terminal patch into the private integration worktree, then must stop at final Pro review.
  - Identified release blockers that implementation must close: cancel-first authority, monotonic lease-fenced work transitions, passive reads, launch reservations, immutable blocked-path policy, exact terminal Git provenance, scheduler advisory locking, prompt/state bounds, and two partial CodingTask terminalization crash windows.
  - Split implementation ownership so Goal scheduler/core and CodingTask runner resilience can progress in parallel without overlapping files; server, HTTP, card, and docs changes wait for stable runtime APIs.
  - Implemented the detached, shell-free scheduler with durable launch reservations, epoch/lease fencing, POSIX advisory locks, deterministic task identity, bounded state/prompt handling, and same-attempt crash recovery.
  - Kept passive observation passive: `get_goal`, `list_goals`, and `review_goal` do not spawn or persist; `refresh_goal` is store-only; only explicit start/resume owns execution recovery.
  - Implemented durable pause/resume/cancel authority. After pause linearizes, no new worker launch, integration, or dependency advancement begins; resume is idempotent and does not rerun complete work; cancel fences children and becomes terminal without source rollback or worktree deletion.
  - Fixed authoritative review counting to derive policy-visible changed paths from the private integration base→HEAD diff rather than the clean integration worktree status. `changedFileCount`, `changed_files_count`, and `changedPaths.length` now agree.
  - Closed scheduler/fixture process leaks by terminating owned runners before state deletion and handling stopped children during cleanup; final process-table readback found no Persistent Goal scheduler left behind.
  - Passed the built HTTP/MCP flow with an installed real Codex App Server, including reconnect, pause/resume/cancel, same-start recovery/idempotency, three-file private integration review, and clean process exit.
  - Completed the intended ordinary-Chat flow with Goal `goal_cd1d3bf868c2bdade5b1c7af`: explicit propose/approve/start, navigation away, real parallel `gpt-5.6-sol`/`high` A/B workers, then their summary dependency. The scheduler stopped at `waiting_review` / `semantic_review` revision 20; reconnect `get_goal` / `review_goal` showed exactly `a.md`, `b.md`, and `summary.md` at private integration HEAD prefix `e05a497…` while source HEAD/index/refs and the source target path remained unchanged.
  - Finalized the card cache contract: the stale v13 payload required a new v14 URI, the real Persistent reconnect mounted v14, and the later authoritative changed-file-count UI required current v15; v14 through v8 remain legacy compatibility resources.

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Documentation fetch | Official plugin MCP/UI/tool/reference pages | Current pages reachable | All four fetched | PASS |
| TypeScript build | `npm run build` | Compile succeeds | Compile succeeded | PASS |
| Focused baseline | App Server, CodingTask core/runner/HTTP, widget, background job smokes | All pass | All passed | PASS |
| Release baseline | release guard + `npm pack --dry-run --json` + diff check | Artifact includes product/runtime contract and is clean | Passed; final artifact has 138 package entries | PASS |
| Real Chat/Codex task flow | Ordinary Chat → private plugin → Direct draft → real Codex turn → review → Direct final edit | Complete with persistent identity and no source application | Completed at task revision 47 | PASS |
| Honest CodingTask card metrics | Exact persisted get shape with and without a live review summary | Unknown is `—`; loaded values match review | Widget/core/HTTP smokes passed | PASS |
| Real ordinary-Chat Goal | Chat → installed private plugin → exact approval → 2 real Codex workers → Pro integration/review/completion | Completed in isolated state with real threads/turns and no source application | Goal revision 15; both work items integrated; combined diff check passed | PASS |
| Real parallelism | Two approved independent work items with max concurrency 2 | Both worker intervals overlap | Starts 51 ms apart; both completed after ~27 s | PASS |
| Source non-application | Compare source HEAD/status/refs and target paths before/after Goal | Byte-identical Git readback and no Goal probe files | HEAD `3dafb839...`, status hash `dc0faed...`, refs hash `cacfd97...`; target paths absent | PASS |
| Full release smoke | `npm run smoke` | Every configured regression exits successfully | Full chain exited 0, including release guard | PASS |
| Package dry run | `npm pack --dry-run --json` | Goal runtime and product contract ship in the artifact | 140 entries; `dist/goalProjection.js`, Goal execution/store runtime, and `PRODUCT_DIRECTION.md` present | PASS |
| Supervised Live source effects | Core + built HTTP/MCP projection/revert/recovery/final-adoption matrix | Preserve unrelated dirt; exact review/HEAD/path CAS; journal/restart recovery; LIFO revert; zero-write adoption | Passed sequential same-path projection, stable-key retry/restart, worktree/index preservation, conflict no-overwrite, latest revert, fail-closed topology, passive-mode, and zero-write adoption checks; source HEAD/refs/log were unchanged | PASS |
| Real ordinary-Chat Live Goal | ChatGPT Pro → installed plugin → real App Server → integration review → separately approved projection → completion → final apply | Exact reviewed checkpoint projected once, then adopted without a second write or Git side effects | Goal `goal_660f5139b15aae20456ed421` revision 13 completed; projection `proj_32ac83deacc868d2f4799002` adopted; source HEAD unchanged (reported pre/post prefix `037e…`); only one 2-line/70-byte file projected | PASS |
| Real ordinary-Chat Persistent Goal | Propose → approve → start → navigate away → parallel A/B → summary dependency → reconnect review | Scheduler continues only approved mechanical work, stops for semantic review, and leaves source unchanged | Goal `goal_cd1d3bf868c2bdade5b1c7af` reached `waiting_review` / `semantic_review` revision 20; exact private paths `a.md`, `b.md`, `summary.md`; source HEAD/index/refs and target path unchanged | PASS |
| Installed-real-Codex Persistent HTTP/MCP | Built public HTTP tools with installed Codex App Server | Primary control flow, recovery, interruption, counts, and process cleanup all authoritative | Disconnect/reconnect, pause/resume/cancel, same-key recovery, three-file review, and terminal PID readback passed | PASS |
| Persistent changed-file count | Private integration base→HEAD policy-visible review | Count equals authoritative changed paths | `changedFileCount=3`, `changed_files_count=3`, and three exact paths | PASS |
| Persistent process cleanup | Terminal/canceled/stopped fixtures and final process table | No owned scheduler/worker process survives terminal cleanup | Scheduler, CodingTask runner, and deterministic App Server PIDs exited; no Persistent Goal scheduler remained | PASS |
| Goal card resource/cache contract | v13 stale cache → v14 URI fix → changed-count renderer update | Every renderer payload change gets a fresh URI | Real Persistent reconnect mounted v14; v15 is current after changed-count UI regressions; v14–v8 remain legacy | PASS |
| Windows Goal capability gate | Tool inventory/registration, `server_config`, and core proposal guard | No Goal tools or Goal state creation without the required POSIX locking contract; Direct/CodingTask unaffected | All Goal tools hidden on Windows; `goalOrchestration.supported=false`; pre-store proposal rejection covered | PASS |
| Native Windows Goal runtime | Physical Windows host | Not part of the accepted release capability | Not run; Goal orchestration is unsupported/hidden on Windows by contract | NOT RUN |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-08-12 | Core smoke expected 5 changed files but the fixture actually changes 6 including `app.txt` | 1 | Corrected only the regression expectation; implementation output was authoritative |
| 2026-08-12 | TypeScript widened two appended Goal event `kind` literals to `string` | 1 | Preserved the literal event types explicitly; no runtime contract changed |
| 2026-08-12 | macOS resolves `/var` temp paths through `/private/var`, so the Goal smoke supplied a non-canonical fixture path | 1 | Canonicalized the fixture before constructing the security-sensitive data root |
| 2026-08-12 | TypeScript could not infer non-null Git stdio streams from the conditional stdin tuple | 1 | Added local non-null assertions after the spawn contract fixes stdout/stderr to pipes |
| 2026-08-12 | Detached Goal runners had not yet created their launch marker when the smoke read it immediately | 1 | Poll the authoritative marker for a bounded 3 seconds before evaluating parallel overlap |
| 2026-08-12 | The bounded Git review helper trims stdout, so piping its patch directly to `git apply` omitted the final record newline | 1 | Normalize only the transport framing by appending a trailing newline before check/apply |
| 2026-08-12 | Fake workers claimed A/B by process race, which could intentionally violate their work-specific file contract | 1 | Bind the deterministic fake edit to the approved `work_id` in the actual turn prompt; retained the post-run scope rejection |
| 2026-08-12 | A canceled run can become terminal just before the CodingTask lease finish is persisted | 1 | Goal cancellation now waits for both run=`canceled` and authoritative task lease/lifecycle cancellation before terminalizing the Goal |
| 2026-08-12 | The new Goal HTTP smoke polled the authenticated `/healthz` endpoint without its bearer token and timed out although the server was listening | 1 | Sent the same configured bearer token during readiness polling; left the production authentication contract unchanged |
| 2026-08-12 | Goal contracts accepted `persistent`, `live`, multi-turn, and retry settings although the vertical slice did not execute those semantics | 1 | Restored contract authority by rejecting unimplemented values; Persistent was accepted later only with the separate Phase 8 Isolated/no-source/one-turn/zero-fresh-retry fingerprinted contract |
| 2026-08-12 | Ordinary Chat selected the stable `codexpro` wrapper for `propose_goal`; the wrapped result preserved Goal identity but the wrapper descriptor had its card metadata stripped | 1 | Added the wrapper to the opt-in card surface and verified that wrapped actions retain their specific renderer identity |
| 2026-08-12 | Pro reopened the private Goal integration worktree with generic `open_workspace` after a successful `review_goal`, then treated the expected allowed-root rejection as a verification error | 1 | Preserved the private-worktree boundary, moved combined `git diff --check` into `review_goal`, clarified the tool/server instructions, and completed through the intended review path |
| 2026-08-13 | The shared build temporarily failed while the runner worker converted file locks to `RunLockLease`; seven call sites still used the former handle signature | 1 | Treated the tree as an in-progress worker mutation, reported the exact compiler locations to the owning worker, and withheld downstream integration until the owner restores a green build |
| 2026-08-13 | The old Goal core smoke still expected every `persistent` proposal to fail after the runtime began accepting the new fingerprinted policy | 1 | Classified the assertion as in-progress TEST DRIFT, sent it to the core owner, and required replacement coverage for the new Isolated/no-source/content-policy contract rather than preserving the obsolete rejection |
| 2026-08-13 | Early scheduler/runner drafts introduced launch-reservation crash gaps, cancel fail-open behavior, duplicate waiting scheduler processes, and advisory-lock probes inside passive reads | 1 | Stopped public-surface integration, retained the higher-authority passive/cancel/crash contracts, and sent each exact interleaving to the owning core/runner worker for architectural correction rather than weakening the contracts or tests |
| 2026-08-13 | Adding deterministic task identity to the launch reservation temporarily left the scheduler constructor missing the new `taskKey`/`taskId` fields | 1 | Reported the exact TypeScript failure to the core owner and kept the server/HTTP layers blocked until the runtime compiles and the full reservation recovery path is coherent |
| 2026-08-13 | Persistent `review_goal` showed zero changed files after clean private commits even though three integrated files differed from the Goal base | 1 | Replaced worktree-status counting with the authoritative policy-filtered integration base→HEAD diff and asserted both count aliases equal the returned path list |
| 2026-08-13 | Stopped scheduler fixtures could survive cleanup when deletion occurred before the owned process was continued and terminated | 1 | Made fixture/runtime cleanup terminate owned processes before state deletion, including stopped children, and verified the final process table has no Persistent scheduler |
| 2026-08-13 | Chat retained stale v13 renderer bytes under an unchanged UI resource URI | 1 | Made renderer-payload versioning explicit: v14 fixed the stale resource, and the later changed-count UI moved the current card to v15 while retaining v14–v8 compatibility |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Supervised Isolated, Supervised Live, and Phase 8 Persistent Isolated flows are verified through ordinary Chat on a supported POSIX host; production HTTP/MCP paths also pass with an installed real Codex App Server |
| Where am I going? | Multi-turn Persistent workers and fresh bounded retries remain roadmap work; Goal orchestration remains unavailable on Windows |
| What's the goal? | Deliver a real Pro-orchestrated local Goal vertical slice |
| What have I learned? | See `findings.md` |
| What have I done? | Product contract, real CodingTask flow, supervised Isolated/Live Goals, Persistent scheduling/recovery/interruption, real ordinary-Chat reconnect, installed-real-Codex HTTP/MCP, and the versioned v15 card path are complete |
