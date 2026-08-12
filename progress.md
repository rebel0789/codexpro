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
  - Finalized the Phase 8 card cache contract: the stale v13 payload required a new v14 URI, the real Persistent reconnect mounted v14, and the later authoritative changed-file-count UI required v15. Phase 9 subsequently moves the current URI again for its changed payload.

### Phase 9: Bounded Persistent continuations
- **Status:** complete for built public HTTP/MCP, installed-real-Codex, and canonical ordinary-Chat verification on POSIX; native Windows unsupported with all Goal tools hidden
- Actions taken:
  - Extended only the separately fingerprinted Persistent policy to 1–4 total turns per worker including the initial turn. Every proposal supplies exactly `maxTurns - 1` ordered immutable `continuation_intents` (maximum three); Supervised remains one turn and every policy remains zero fresh retries.
  - Bound each continuation to the same CodingTask, base, worktree, Codex thread, and session while giving it a distinct deterministic operation and turn identity. The App client rejects a returned thread mismatch, and the runner rejects expected-session drift before starting a turn.
  - Made every successful intermediate turn `continuing`, private, non-integrable, and unable to unlock dependencies. Only the exact final authorized successful terminal provenance can create one cumulative integration; failure or cancellation does not advance and cannot create a replacement attempt.
  - Kept reconnect observation passive. `get_goal` and `review_goal` expose bounded intent/turn summaries and identities; `list_goals` exposes compact counts/status only. Exact prompts, raw Goal state, full ledgers, and Blackboard evidence remain private local state.
  - Upgraded the current card URI to v16 for authorized/completed/remaining turn counts, intent summary/fingerprint, turn N/M history, stop reason, and final-only integration messaging. v15 through v8 remain legacy compatibility resources.
  - Passed the deterministic built public HTTP/MCP flow. At the turn-two gate, turn one had succeeded but integration HEAD still equaled base, `base..HEAD` had zero commits, no integration journal or dependency unlock existed, and the work remained private. Turn two reused the same task/base/thread/session, observed turn one's exact bytes, and produced exactly one final cumulative integration commit with no third turn or retry.
  - Killed the MCP client and HTTP server while the scheduler was active. Detached work continued; after restart, passive get/list/review preserved byte-identical Goal/run evidence and launched nothing. Terminal same-key start was byte-idempotent, and source HEAD/refs/index plus staged, unstaged, and untracked state remained exact.
  - Passed the same two-turn contract with an installed real Codex App Server: Goal `goal_f18e1e62ec5797e868fd6421`, CodingTask `task_8eb28bf1e327e3cbb2ac2a92`, thread `019ff6ef-94b9-7bc3-adbb-ced648a29472`, two distinct turn IDs, and one final integration commit.
  - Completed the canonical [ordinary-Chat flow](https://chatgpt.com/c/6a7cab4a-fa74-83ee-bb1c-5040c68524c0) with Goal `goal_d96c4d1de3d6382cc4ebcc86`, contract fingerprint `9851972a680218074a44e12e7830691c0353cf466b92752eb56ffba082ccb8a4`, and scheduler stop at revision 15 `waiting_review` / `semantic_review`.
  - Verified one persistent identity end to end: CodingTask `task_f1c84e9b39654c8aaebb2e6b`, thread/session `019ff70a-ea6f-7a83-94d6-f81fe92527a2`, operations `run:1` / `run:2`, and turn IDs `019ff70a-eb7c-7611-b700-539667ba8c4e` / `019ff70b-a812-7a13-a9cb-6936fc1ba359`.
  - Captured the intermediate turn-two-running state with integration HEAD still equal to Goal base `ce4421d…` and `integratedCommitSha` absent. Final private integration `124787d868b3d89a1191d394192831cd3fb5c46e` contained exactly one commit and exactly the two-line `phase9-chat/multi-turn.md`; review fingerprint was `e36aa461a0ca684d9fe85efd253e0e3431255baf1951e471266d3eedba663c8b`.
  - Confirmed the source path remained absent and source status/diff/index plus Goal state were byte-identical across start, disconnect, and reconnect. Source commit `cd0f3e18…` was an unrelated external commit made at 02:29:50 before Goal start at 02:35; the Goal remained based on `ce4421d…` and did not create or absorb it. Chat-host duplicate passive get/review calls were harmless and state-identical.
  - Mounted the final v16 get/review card in ordinary Chat with 2/2 turns, the same task/thread/session and two turn identities, `semantic_review`, and final-only integration. Older supertool/start mounts briefly rendered “Result unavailable,” but the authoritative final v16 cards rendered fully.
  - Corrected the initial tool-discovery failure: `start_goal` was hidden while annotated `destructive=true`. Persistent start has no source effect, so the hint is now `false`; after build, server restart, and plugin refresh, the canonical `start_goal` call succeeded.

### Phase 10: Bounded fresh infrastructure retries
- **Status:** complete for deterministic full-smoke, built production HTTP/MCP, installed-real-Codex, and canonical ordinary-Chat verification on POSIX; native Windows Goal orchestration remains unsupported/hidden
- Actions taken:
  - Added a Persistent-only aggregate 0–2 fresh-retry budget per work item across all semantic turns, defaulting to 0; Supervised stays exactly zero-retry. The immutable fingerprinted `infra-pre-turn-v1` policy uses fixed `[1000,5000]` ms backoff.
  - Restricted fresh retry to positive runner proof of exactly `app_server_startup / infrastructure / runner_start` or `app_server_initialize_transport / infrastructure / app_server_initialize`, with known outcome, no returned identity for the failed attempt, no written thread-establish/turn-start request, and exact unchanged authoritative Git observation. A thread/session established by an earlier semantic turn remains the immutable resume target.
  - Retained every failed attempt. A retry repeats the exact prompt/scope/task/worktree/model/effort under a new deterministic attempt operation, preserves an established thread/session, and does not consume a semantic turn. Same-operation crash/response-loss reconciliation preserves the original operation and consumes no retry.
  - Made timeout, model/tool/input/approval, policy/path/content/provenance/validation/identity conflict, cancellation, partial Git change, ambiguous response loss, and unknown outcome nonretryable. Pause/cancel dominates backoff; passive reads do not spawn; Persistent source effects remain false.
  - Added bounded get/review attempt histories and compact list counts. Public projections omit exact prompts, raw errors/logs, private paths, raw Goal state, full ledgers, and Blackboard evidence.
  - Moved the current card URI to v17 and retained v16–v8 as legacy. The card separates semantic turn from attempt/retry counts, shows deterministic backoff and safe failure/Git authority, and preserves the final-turn-only integration gate.
  - Passed the full deterministic npm smoke and built production HTTP/MCP flow: exact 1s/5s delays, aggregate budget across continuation turns, exhaustion, passive restart reads, free concurrency slots during backoff, pause/cancel/resume fencing, the semantic/dirty/ambiguous non-retry matrix, one final private integration, and unchanged source.
  - Passed the installed-real-Codex HTTP retry with Goal `goal_b134f2acc8a910aedd6d31d5`: an injected initialize failure was retained as attempt 0; attempt 1 ran real `gpt-5.6-sol`/`high` successfully, produced one private integration commit, and left source unchanged.
  - Completed the canonical [ordinary-Chat retry flow](https://chatgpt.com/c/6a7cc1a8-bd5c-83ee-9779-7e032776dadd). Goal `goal_855e97294fe7d3a8f25a06fe` reached revision 14 `waiting_review` / `semantic_review`, base `f77e993103a54d4c6f0573d429aaa5f78cd68136`, integration `b1fe3f18e44601ebbc7c9af42e144e95fa77c1f9`, and contract fingerprint `273019c6d5f124f87d6240be9997b1571c9f73445839b941d449e6ffa3759578`.
  - Verified CodingTask `task_5fe51f8b7cf5b5911361e416` attempt 0 failed with the allowed initialize-transport tuple, `retryable=true`, `outcomeKnown=true`, `turnStarted=false`, and zero changed paths. After 1 second, attempt 1 succeeded with real Codex on thread/session `019ff759-a258-7480-9765-c075c6f867a3`, turn `019ff759-a318-7283-83d4-c0d2477a42eb`; integration had exactly one commit.
  - Confirmed source HEAD/ref stayed `f77e…`, write-tree `2a1e80…`, file-byte hash `f34848…`, with empty status/diff. Chat duplicated passive get/review calls, but state SHA-256 remained `5fd32c…` and no launch/write occurred; no exactly-once host-call claim is made.
  - Mounted the final v17 get card with 1/1 semantic turn, two attempts, retries 1/1, and one changed file. Initial approve/start cards had transient “Failed to fetch template” during the live endpoint swap; fresh resources/read/get mounted v17 correctly.

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
| Phase 9 deterministic continuation HTTP/MCP | Approved two-turn Persistent worker, gated second turn, client/server disconnect, passive restart reads | Intermediate turn remains private; exact same identity resumes; only final turn integrates once; no source effect or retry | Same task/base/thread/session with distinct deterministic operations and turn IDs; turn two observed turn-one bytes; exactly one final integration; byte-identical passive evidence and source authority | PASS |
| Phase 9 installed-real-Codex continuation | Built public HTTP/MCP with installed real Codex App Server | Exact approved prompts execute as two turns on one persisted thread with one final integration | Goal `goal_f18e1e62ec5797e868fd6421`, task `task_8eb28bf1e327e3cbb2ac2a92`, thread `019ff6ef-94b9-7bc3-adbb-ced648a29472`; two turns, one integration commit | PASS |
| Phase 9 ordinary-Chat UI | Installed plugin → exact approval → canonical start → disconnect/reconnect → final review | Same task/thread/session; intermediate nonintegration; one final commit; passive/source authority unchanged; v16 2/2 card | Goal `goal_d96c4d1de3d6382cc4ebcc86` revision 15; operations `run:1` / `run:2`; integration `124787d868b3d89a1191d394192831cd3fb5c46e`; exact two-line path; byte-identical passive/source readback; v16 mounted | PASS |
| Phase 10 full retry smoke | Full npm smoke plus built production HTTP/MCP retry matrix | Fixed backoff, aggregate budget, retry/no-retry gates, lifecycle dominance, passive restart, final-only integration, source neutrality | Exact 1s/5s, cross-turn exhaustion, free backoff slot, pause/cancel/resume, semantic/dirty/ambiguous no-retry, one final integration, unchanged source all passed | PASS |
| Phase 10 installed-real-Codex retry | Inject initialize failure before real Codex attempt | Attempt retained; one fresh retry; real success; one private commit; source unchanged | Goal `goal_b134f2acc8a910aedd6d31d5` passed with real `gpt-5.6-sol`/`high` on attempt 1 | PASS |
| Phase 10 ordinary-Chat retry | Installed plugin → approved retry budget → canonical start → injected eligible failure → backoff → real Codex → review | One semantic turn, two attempts, one retry, one private commit, passive/source state unchanged, v17 mounted | Goal `goal_855e97294fe7d3a8f25a06fe` revision 14; exact failure tuple; 1s backoff; real thread/turn; integration `b1fe3f18e44601ebbc7c9af42e144e95fa77c1f9`; v17 1/1 + retries 1/1 | PASS |
| Persistent changed-file count | Private integration base→HEAD policy-visible review | Count equals authoritative changed paths | `changedFileCount=3`, `changed_files_count=3`, and three exact paths | PASS |
| Persistent process cleanup | Terminal/canceled/stopped fixtures and final process table | No owned scheduler/worker process survives terminal cleanup | Scheduler, CodingTask runner, and deterministic App Server PIDs exited; no Persistent Goal scheduler remained | PASS |
| Goal card resource/cache contract | v13 stale cache → v14 URI fix → v15 changed-count → v16 turn history → v17 retry history | Every renderer payload change gets a fresh URI | Real Phase 8 mounted v14, Phase 9 mounted v16, and Phase 10 final get mounted v17; v16–v8 remain legacy | PASS |
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
| 2026-08-13 | The Phase 9 crash fixture manually began an operation before calling the hardened runner, which now owns that transition and correctly rejected the pre-existing active operation | 1 | Launched from idle, captured the runner-created active state, waited for terminal quiescence, then restored that state to model the intended crash window without weakening production fencing |
| 2026-08-13 | Empty terminal `finalText` was hashed correctly but produced empty optional summary fields | 1 | Kept the result hash and omitted empty optional summaries so bounded public projections remain truthful |
| 2026-08-13 | Ordinary Chat hid `start_goal` while its descriptor claimed `destructive=true`, blocking the canonical private-execution entry point | 1 | Corrected only the hint to `false` because Persistent start has no source effect; retained explicit start and full-bash/write gates, rebuilt/restarted/refreshed, then passed the actual call |
| 2026-08-13 | Older supertool/start card mounts briefly displayed “Result unavailable” during the real Phase 9 Chat run | 1 | Kept tool state authoritative and verified the final get/review v16 card rendered the complete 2/2 ledger, identities, stop reason, and final integration |
| 2026-08-13 | Phase 10 draft used `app_server_initialize_transport` in the runner but `app_server_initialize` in Goal retry validation | 1 | Kept the runner's structured real initialize-transport evidence authoritative and required one canonical tuple across runner, Goal parser, scheduler, and tests before accepting retry execution |
| 2026-08-13 | A not-yet-due retry attempt was represented as generic `launching` and selected before other ready work | 1 | Required scheduler eligibility and concurrency accounting to exclude backoff-only reservations until `notBefore`, so another approved work item can use the free slot |
| 2026-08-13 | The Phase 10 full suite observed a successful second continuation run before terminal thread/session/Git authority was fully published and failed the Goal as a provenance mismatch | 1 | Kept terminal provenance fail-closed, but deferred its evaluation until the runner is quiescent and the task's exact completed operation is authoritative; required the same built HTTP multi-turn flow to pass again |
| 2026-08-13 | A fresh retry of a continuation turn reached its valid 5-second backoff, then the generic continuation API rejected the task because the failed pre-turn attempt had durably moved it from `waiting_review` to `failed` | 1 | Classified this as missing first-class retry authority, not a fixture issue: the runner must bind the new attempt to both the exact failed retryable predecessor and the prior successful semantic turn without erasing either ledger |
| 2026-08-13 | A stale App Server replayed the previous semantic `turnId` for a continuation and the scheduler initially accepted and integrated it | 1 | Added runner and Goal-state identity fencing: the replay is now persisted as nonretryable `identity_mismatch / identity / turn_start`, creates no retry or integration journal/commit, and leaves dependents planned; the built MCP regression verifies the source and passive review remain unchanged |
| 2026-08-13 | A detached child could exhaust its bounded advisory-lock handoff wait and leave an otherwise recoverable queued operation reported as a fatal no-ack launch | 1 | Kept the timeout fixed and losing-child writes forbidden, then added one bounded same-operation reconciliation under the exclusive run lock; a late live owner is observed, otherwise exactly one replacement is fenced and spawned, and repeated public retry flows pass without spending retry budget |
| 2026-08-13 | Initial Phase 10 approve/start cards reported “Failed to fetch template” while the live HTTP endpoint/plugin resource was being swapped | 1 | Did not treat the transient host fetch as runtime state; refreshed the installed plugin and verified fresh resources/read/get plus the final v17 card through the canonical Chat flow |
| 2026-08-13 | Final release audit found that public Goal projections retained raw failure/error strings and absolute source or private-worktree roots across attempt, work, scheduler, projection, source-application, and review payloads | 1 | Kept authoritative raw evidence only in private state; public get/list/review/project/revert projections now expose safe status, relative changed paths, presence flags, and SHA-256 evidence without raw error text or absolute roots. MCP regressions inject real source/data/worktree/Codex paths plus secret sentinels and prove the complete content/structured/card/meta serialization omits them |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Supervised Isolated/Live and Persistent Phases 8–10—including bounded continuations and bounded infrastructure retries—are verified through ordinary Chat on POSIX; deterministic HTTP/MCP and installed-real-Codex paths also pass |
| Where am I going? | Complete the final delivery audit; Goal orchestration remains unavailable on Windows |
| What's the goal? | Deliver a real Pro-orchestrated local Goal vertical slice |
| What have I learned? | See `findings.md` |
| What have I done? | Product contract, real CodingTask flow, supervised Isolated/Live Goals, Persistent scheduling/recovery/interruption, bounded same-thread continuations, bounded infrastructure retries, final-only integration, real Codex/ordinary Chat verification, and the versioned v17 card path are complete |
