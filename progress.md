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
| Package dry run | `npm pack --dry-run --json` | Goal runtime and product contract ship in the artifact | 138 entries; all five Goal runtime modules plus `PRODUCT_DIRECTION.md` present | PASS |

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
| 2026-08-12 | Goal contracts accepted `persistent`, `live`, multi-turn, and retry settings although the vertical slice did not execute those semantics | 1 | Restored contract authority by accepting only supervised isolated execution, one turn per worker, and zero automatic retries until the durable scheduler and Live projection are implemented |
| 2026-08-12 | Ordinary Chat selected the stable `codexpro` wrapper for `propose_goal`; the wrapped result preserved Goal identity but the wrapper descriptor had its card metadata stripped | 1 | Added the wrapper to the opt-in card surface and verified that wrapped actions retain their specific renderer identity |
| 2026-08-12 | Pro reopened the private Goal integration worktree with generic `open_workspace` after a successful `review_goal`, then treated the expected allowed-root rejection as a verification error | 1 | Preserved the private-worktree boundary, moved combined `git diff --check` into `review_goal`, clarified the tool/server instructions, and completed through the intended review path |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Supervised Isolated Goal MVP is complete and verified through ordinary Chat |
| Where am I going? | Incremental Live projection, persistent scheduling, multi-turn workers, and bounded retries remain roadmap work |
| What's the goal? | Deliver a real Pro-orchestrated local Goal vertical slice |
| What have I learned? | See `findings.md` |
| What have I done? | Product contract, real CodingTask flow, Goal state/execution/integration, v11 cards, deterministic E2E, and a real two-worker ordinary-Chat Goal are complete |
