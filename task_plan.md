# Task Plan: CodexPro Pro-Orchestrated Goal MVP

## Goal
Deliver the first real vertical slice in which ChatGPT Pro plans and supervises a durable local Goal, Codex workers execute isolated CodingTasks, and the user can observe, interrupt, resume, review, and apply an integrated result from ordinary Chat.

## Current Phase
Phase 6

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
- [ ] Implement incremental supervised Live projection and the persistent autonomous scheduler
- **Status:** complete for the accepted supervised Isolated slice; roadmap work remains

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

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Core review-metric regression expected 5 changed files although the fixture changes 6 | 1 | Corrected the test expectation; implementation output was authoritative |
| Ordinary Chat tried to open the private Goal integration worktree after `review_goal` and treated the expected allowed-root denial as verification failure | 1 | Kept the isolation boundary, made `review_goal` run authoritative integrated `git diff --check`, and explicitly instructed Pro not to use generic workspace tools for private Goal worktrees |

## Notes
- Existing user and prior-worker changes are preserved. No reset, checkout, broad cleanup, commit, push, or PR is authorized.
- A fake App Server may support regression tests but cannot replace one representative real Codex and ChatGPT flow.
- Official OpenAI documentation favors focused tools, accurate annotations, server instructions for shared sequencing, and concise structured content.
