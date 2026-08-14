# Task Plan: CodexPro Pro-Orchestrated Goal MVP

## Goal
Deliver the first real vertical slice in which ChatGPT Pro plans and supervises a durable local Goal, Codex workers execute isolated CodingTasks, and the user can observe, interrupt, resume, review, and apply an integrated result from ordinary Chat.

## Current Phase
Phase 11 complete

## Phases

### Phase 1: Product contract and baseline
- [x] Record the accepted product direction in a durable product document
- [x] Audit repository guidance, current CodingTask architecture, tests, and dirty-tree ownership
- [x] Turn the current untracked CodingTask implementation into a coherent, reviewable baseline without overwriting unrelated user work
- **Status:** complete

### Phase 2: Representative single-CodingTask validation
- [x] Exercise create → Direct edit → Direct→Codex → real Codex run → follow-up/review → Codex→Direct through the intended Chat/MCP entry point
- [x] Record actual usability friction and fix release-blocking issues
- [x] Confirm authoritative state, worktree, Git observation, and card readback
- **Status:** complete

### Phase 3: Durable Goal domain and execution contract
- [x] Add Goal state, store, revisions, approvals, resource limits, dependency graph, Blackboard events, and recovery rules
- [x] Add focused MCP tools with accurate annotations and retry-safe contracts
- [x] Preserve independent CodingTasks and allow optional Goal membership
- **Status:** complete

### Phase 4: Parallel workers and Pro-supervised integration
- [x] Launch 2–3 dependency-safe CodingTasks concurrently
- [x] Publish structured Blackboard discoveries, contracts, blockers, file ownership, and test results
- [x] Integrate worker results in a Goal worktree with Pro-controlled sequencing
- [x] Implement the accepted supervised Isolated vertical slice without weakening source-workspace safety
- [x] Implement incremental supervised Live projection
- [x] Implement the persistent autonomous scheduler
- **Status:** complete for the accepted supervised Isolated, Live, and persistent Isolated slices

### Phase 5: Goal card and Chat control flow
- [x] Render a persistent Goal snapshot with monotonic state version
- [x] Expose plan approval, pause/cancel/resume, drill-down, review, and apply actions
- [x] Keep concise model-visible state separate from bounded widget-only detail
- **Status:** complete

### Phase 6: End-to-end verification and delivery
- [x] Run compile, focused smokes, deterministic HTTP/MCP flow, and diff checks
- [x] Validate a representative Goal through the public HTTPS MCP endpoint in ordinary Chat
- [x] Verify reconnect recovery and authoritative source/worktree readback
- [x] Update README, changelog, security guidance, and execution progress
- **Status:** complete for the supervised Isolated MVP

### Phase 7: Supervised Live projection
- [x] Define the exact approved Live contract, source-mutation boundary, recovery journal, and rollback semantics
- [x] Implement restart-safe, idempotent projection of Pro-reviewed integration checkpoints into the source workspace
- [x] Preserve unrelated pre-existing work and fail closed on overlapping edits, HEAD drift, blocked paths, symlinks, or stale revisions
- [x] Expose focused MCP actions and honest Goal-card state for project, inspect, recover, and revert
- [x] Verify core, execution, HTTP/MCP, widget, and full release flows, then exercise a representative ordinary-Chat Live Goal with a real Codex worker
- **Status:** complete

### Phase 8: Persistent autonomous scheduler
- [x] Freeze the durable scheduler authority, lease, recovery, pause, resume, and cancel contract
- [x] Launch dependency-ready isolated workers from a detached scheduler that survives Chat/MCP disconnects
- [x] Mechanically verify and integrate only pre-approved worker results, then stop at Pro review when semantic judgment is required
- [x] Prove passive reads never launch work and explicit resume/recovery is idempotent
- [x] Verify the intended MCP entry point with a real Codex worker and authoritative restart readback
- **Status:** complete

### Phase 9: Multi-turn workers
- [x] Preserve one Codex thread per Goal work item across bounded continuation turns
- [x] Keep every continuation inside the approved work goal, file scope, commands, network policy, and turn budget
- [x] Persist turn identity, prompt intent, results, and stop reason for Pro inspection
- [x] Verify a real worker needs and completes a second turn through the intended Goal flow
- **Status:** complete

### Phase 10: Bounded automatic retries
- [x] Define retryable infrastructure failures separately from semantic, policy, validation, and conflict failures
- [x] Persist attempt identity, backoff, exhaustion, and response-loss-safe idempotency within the approved retry budget
- [x] Ensure retry never expands scope, overwrites source, or hides the original failure
- [x] Verify transient recovery and deterministic fail-closed exhaustion through the intended Goal flow
- **Status:** complete

### Phase 11: Final real-world verification and delivery
- [x] Run compile, focused, full, security, and package verification on the final architecture
- [x] Exercise persistent scheduling, multi-turn continuation, and bounded retry from ordinary ChatGPT Pro with a real Codex worker
- [x] Confirm source/worktree/state authority, disconnect recovery, cards, and no unintended Git or external effects
- [x] Update user documentation and delivery evidence, then commit the coherent completed stage
- **Status:** complete

## Key Questions
1. What is the smallest Goal contract that preserves the accepted final architecture instead of creating a throwaway orchestration layer?
2. How can Pro remain the semantic authority when Chat is closed, while the local engine executes only a pre-approved contract?
3. How should worker results be integrated without exposing partial parallel changes or overwriting pre-existing dirty source changes?
4. Which actions require explicit user approval, and which are safe within the approved Goal contract?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Primary user is an individual developer with an existing Git repository | Matches the implemented local trust boundary and Direct↔Codex workflow |
| ChatGPT Pro is the orchestrator; Codex instances are workers | Product differentiation is Pro's design, decomposition, integration, and review quality |
| Product hierarchy is Direct coding → independent CodingTask → optional Goal | Keeps simple work simple while enabling durable orchestration for complex work |
| Workers use a Pro-supervised Blackboard, not an unrestricted mesh | Enables fast structured sharing without delegating scope or assignment authority |
| Supervised mode defaults Live; persistent autonomous mode defaults Isolated | Preserves Codex-like immediacy while protecting the source during unattended work |
| Local engine is execution authority; Pro is semantic authority | Enables restart-safe execution without pretending the plugin can wake ChatGPT for fresh judgment |
| Primary app archetype is interactive-decoupled | Goal cards require long-lived state, repeated actions, and retry-safe tool calls |
| Local engine/plugin/Goal remain open source; future hosted/team convenience is the commercial boundary | Preserves local trust and adoption while keeping future business options |
| Supervised Live source effects use a separate reviewed projection action | Keeps private integration, source mutation, idempotency, and recovery authorities explicit |
| Live projection approval is carried by `workspacePolicy=live` plus the existing `sourceEffects.apply=true` contract | Avoids changing the meaning of existing Isolated approvals while keeping one source-effect permission |
| Cancel never silently reverts projected source changes | Prevents cancellation from overwriting user edits; rollback is a separate latest-first confirmed action |
| Live v1 supports only regular file add/modify/delete and executable-mode changes | Symlink, submodule, and unsafe topology changes fail closed until an equally safe manifest contract exists |
| The implicit legacy widget domain is omitted from runtime metadata | It is a documentation origin, not a dedicated hosted component origin; omission lets ChatGPT use its sandbox while explicit custom domains remain available |
| Persistent fresh retries default to 0 and are capped at 2 per work across all semantic turns | Preserves backward safety and prevents a multi-turn contract from multiplying the approved retry budget |
| Retry backoff is immutable policy v1 at 1 second then 5 seconds | Makes restart recovery deterministic and keeps timing inside the approved contract rather than runtime configuration |
| Only structured pre-thread/turn infrastructure failure plus exact unchanged Git authority may consume a fresh retry | Prevents semantic failures, response-loss ambiguity, partial edits, and error-text heuristics from amplifying Codex execution |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Core review-metric regression expected 5 changed files although the fixture changes 6 | 1 | Corrected the test expectation; implementation output was authoritative |
| Ordinary Chat tried to open the private Goal integration worktree after `review_goal` and treated the expected allowed-root denial as verification failure | 1 | Kept the isolation boundary, made `review_goal` run authoritative integrated `git diff --check`, and explicitly instructed Pro not to use generic workspace tools for private Goal worktrees |
| Cards intermittently failed when the documentation-site legacy domain was forced as the iframe origin | 1 | Preserved explicit custom domains, omitted only the implicit legacy default, bumped the resource to v13, refreshed the plugin, and verified a completed Goal card through ChatGPT's default sandbox |
| The Phase 8 card HTML changed while its prior template URI remained cached | 1 | Treated the Apps SDK resource URI as the cache key, published the final v15 URI, retained v14-v8 read compatibility, refreshed the plugin, and re-verified the card in ordinary Chat |
| Goal review counted a clean private integration worktree as zero changed files | 1 | Bound `changedFileCount` to the same policy-filtered base-to-HEAD `changedPaths`, added core/HTTP/widget regressions, and confirmed all three public count forms equal 3 in the ordinary-Chat card |
| A failed scheduler smoke left two deliberately SIGSTOPed fixture processes alive after deleting their temp roots | 1 | Made cleanup track exact fixture-owned processes, always continue and terminate them before removing state, and assert no scheduler process remains |
| Ordinary Chat hid canonical `start_goal` while it was annotated as destructive even though it cannot mutate the source workspace | 1 | Corrected start/resume to non-read-only, non-destructive private execution mutations, rebuilt and refreshed the plugin, then completed the canonical ordinary-Chat two-turn flow |

## Notes
- Existing user and prior-worker changes are preserved. No reset, checkout, broad cleanup, commit, push, or PR is authorized.
- A fake App Server may support regression tests but cannot replace one representative real Codex and ChatGPT flow.
- Official OpenAI documentation favors focused tools, accurate annotations, server instructions for shared sequencing, and concise structured content.
