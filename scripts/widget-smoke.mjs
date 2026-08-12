import assert from "node:assert/strict";
import { toolCardWidgetHtml } from "../dist/toolCardWidget.js";

const scripts = [...toolCardWidgetHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const widgetScript = scripts.at(-1)?.[1];
if (!widgetScript) throw new Error("tool-card widget script missing");

class FakeElement {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  closest(selector) {
    return selector === "[data-copy-card-output]" ? this : null;
  }
}

function mount(openai = {}) {
  const root = new FakeElement();
  const timers = [];
  const listeners = new Map();
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      return id === "root" ? root : null;
    }
  };
  const window = {
    openai,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    addEventListener(name, listener) {
      listeners.set(name, listener);
    }
  };
  let copied = "";
  const navigator = {
    clipboard: {
      async writeText(value) {
        copied = value;
      }
    }
  };
  new Function("window", "document", "navigator", "Element", widgetScript)(window, document, navigator, FakeElement);
  return {
    root,
    timers,
    listeners,
    document,
    copied: () => copied
  };
}

const bashPayload = {
  codexpro_tool: "bash",
  command: "npm run check",
  cwd: "/tmp/workspace",
  exitCode: 0,
  durationMs: 437,
  stdout: "✓ checks passed",
  stderr: ""
};

const nested = mount({
  theme: "light",
  toolOutput: { result: { payload: { structuredContent: bashPayload } } }
});
assert.match(nested.root.innerHTML, /Verification completed/);
assert.match(nested.root.innerHTML, /npm run check/);
assert.match(nested.root.innerHTML, /Passed/);
assert.equal(nested.document.documentElement.dataset.theme, "light");

const copyButton = new FakeElement();
await nested.root.listeners.get("click")({ target: copyButton });
assert.match(nested.copied(), /\$ npm run check/);
assert.equal(copyButton.textContent, "Copied");

const delayed = mount();
assert.match(delayed.root.innerHTML, /Preparing result/);
delayed.listeners.get("openai:set_globals")({
  detail: {
    globals: {
      theme: "dark",
      mcp_tool_result: {
        structuredContent: {
          codexpro_tool: "open_workspace",
          root: "/tmp/workspace",
          agents_loaded: true,
          tool_mode: "standard",
          write_mode: "handoff",
          bash_mode: "safe",
          git_status: "working tree clean"
        }
      }
    }
  }
});
assert.match(delayed.root.innerHTML, /Connected workspace/);
assert.equal(delayed.document.documentElement.dataset.theme, "dark");

const directTask = mount({
  theme: "light",
  toolOutput: {
    structuredContent: {
      codexpro_tool: "review_coding_task",
      task: {
        task_id: "task_direct_01",
        title: "Tighten session validation",
        executor: "direct",
        lifecycle: "needs_review",
        current_activity: "Reviewing the direct edits before handoff.",
        summary: "Validation now rejects expired sessions at the boundary.",
        review: {
          changed_files: ["src/session.ts", "test/session.test.ts"],
          additions: 18,
          deletions: 4,
          tests: { status: "passed", passed: 7, command: "npm test -- session" }
        }
      }
    }
  }
});
assert.match(directTask.root.innerHTML, /Tighten session validation/);
assert.match(directTask.root.innerHTML, /Direct coding/);
assert.match(directTask.root.innerHTML, /Needs review/);
assert.match(directTask.root.innerHTML, /7 passed/);
assert.match(directTask.root.innerHTML, /Copy summary/);
const summaryButton = new FakeElement();
await directTask.root.listeners.get("click")({ target: summaryButton });
assert.match(directTask.copied(), /Mode: Direct coding/);

const codexTask = mount({
  theme: "dark",
  toolOutput: {
    result: {
      structuredContent: {
        codexpro_tool: "run_coding_task",
        coding_task: {
          task_id: "task_codex_01",
          title: "Trace the flaky retry",
          executor: "codex",
          status: "running",
          active_turn: {
            activity: "Codex is tracing retry ownership.",
            log: "Opened retry.ts\nFollowing the scheduler edge"
          }
        }
      }
    }
  }
});
assert.match(codexTask.root.innerHTML, /Codex collaboration/);
assert.match(codexTask.root.innerHTML, /Codex is tracing retry ownership/);
assert.match(codexTask.root.innerHTML, /Activity log/);
assert.equal(codexTask.document.documentElement.dataset.theme, "dark");

const persistedTaskWithoutReviewMetrics = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "get_coding_task",
      task: {
        taskId: "task_0123456789abcdef01234567",
        title: "Persisted Codex result",
        executor: "codex",
        lifecycle: "waiting_review"
      },
      git_observation: { dirty: true, status: " M src/session.ts" }
    }
  }
});
assert.match(persistedTaskWithoutReviewMetrics.root.innerHTML, /Waiting review/);
assert.match(persistedTaskWithoutReviewMetrics.root.innerHTML, /—<\/div><div class="metric-label">changed files/);
assert.doesNotMatch(persistedTaskWithoutReviewMetrics.root.innerHTML, />0<\/div><div class="metric-label">changed files/);

const persistedTaskWithReviewSummary = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "get_coding_task",
      task: {
        taskId: "task_0123456789abcdef01234567",
        title: "Persisted Codex result",
        executor: "codex",
        lifecycle: "waiting_review"
      },
      review_summary: {
        changed_files_count: 1,
        additions: 6,
        deletions: 2,
        content_complete: true
      }
    }
  }
});
assert.match(persistedTaskWithReviewSummary.root.innerHTML, />1<\/div><div class="metric-label">changed files/);
assert.match(persistedTaskWithReviewSummary.root.innerHTML, />\+6<\/div><div class="metric-label">additions/);
assert.match(persistedTaskWithReviewSummary.root.innerHTML, />−2<\/div><div class="metric-label">deletions/);

const proposedGoal = mount({
  theme: "light",
  toolOutput: {
    structuredContent: {
      codexpro_tool: "propose_goal",
      goal: {
        goalId: "goal_0123456789abcdef01234567",
        title: "Harden authentication boundaries",
        lifecycle: "proposed",
        revision: 1,
        executionPolicy: "supervised",
        workspacePolicy: "isolated",
        baseSha: "a".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "pending" },
        completionCriteria: ["All worker acceptance criteria pass"],
        blackboard: [],
        work: [
          { workId: "work_contract", title: "Define contract", status: "planned", dependsOn: [] },
          { workId: "work_tests", title: "Add tests", status: "planned", dependsOn: [] },
          { workId: "work_integrate", title: "Integrate", status: "planned", dependsOn: ["work_contract", "work_tests"] }
        ]
      },
      completed_work_count: 0,
      running_work_count: 0,
      blocked_work_count: 0,
      blackboard_count: 0
    }
  }
});
assert.match(proposedGoal.root.innerHTML, /Harden authentication boundaries/);
assert.match(proposedGoal.root.innerHTML, /Pro orchestration/);
assert.match(proposedGoal.root.innerHTML, /Pending/);
assert.match(proposedGoal.root.innerHTML, /Define contract/);
assert.match(proposedGoal.root.innerHTML, /after work_contract, work_tests/);
assert.match(proposedGoal.root.innerHTML, /approve only after the user explicitly agrees/i);

const approvedGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "approve_goal",
      goal: {
        goalId: "goal_0123456789abcdef01234567",
        title: "Harden authentication boundaries",
        lifecycle: "approved",
        revision: 2,
        executionPolicy: "supervised",
        workspacePolicy: "isolated",
        baseSha: "a".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        completionCriteria: ["All worker acceptance criteria pass"],
        blackboard: [{ kind: "decision", summary: "Keep validation at the boundary." }],
        work: [{ workId: "work_contract", title: "Define contract", status: "planned", dependsOn: [] }]
      },
      blackboard_count: 1
    }
  }
});
assert.match(approvedGoal.root.innerHTML, /Approved/);
assert.match(approvedGoal.root.innerHTML, /remains inert until an explicit execution action/i);
assert.match(approvedGoal.root.innerHTML, /Blackboard/);

const liveGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "project_goal",
      goal: {
        goalId: "goal_0123456789abcdef01234567",
        title: "Supervised Live implementation",
        lifecycle: "completed",
        revision: 8,
        executionPolicy: "supervised",
        workspacePolicy: "live",
        permissions: { sourceEffects: { apply: true, commit: false, push: false, draftPr: false } },
        baseSha: "a".repeat(40),
        integrationHeadSha: "c".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        live: { projectedIntegrationSha: "c".repeat(40), adoptedAt: "2026-08-12T00:00:00.000Z", projections: [{ status: "adopted", toIntegrationSha: "c".repeat(40), projectionId: "proj_0123456789abcdef01234567" }] },
        sourceApplication: { status: "applied", zeroWrite: true, adoptedProjectionId: "proj_0123456789abcdef01234567" },
        completionCriteria: ["Live checkpoint is reviewed"],
        blackboard: [],
        work: [{ workId: "work_live", title: "Implement live flow", status: "integrated", dependsOn: [] }]
      },
      projection: { status: "adopted", to_integration_sha: "c".repeat(40) }
    }
  }
});
assert.match(liveGoal.root.innerHTML, /Live permission/);
assert.match(liveGoal.root.innerHTML, /Approved source projection/);
assert.match(liveGoal.root.innerHTML, /Delivery stages/);
assert.match(liveGoal.root.innerHTML, /Integration checkpoint/);
assert.match(liveGoal.root.innerHTML, /Live projection/);
assert.match(liveGoal.root.innerHTML, /Adopted/);
assert.match(liveGoal.root.innerHTML, /Final application/);
assert.match(liveGoal.root.innerHTML, /adopted without rewrite/);

const passiveLiveGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "get_goal",
      goal: {
        goalId: "goal_0123456789abcdef01234567",
        title: "Passive Live Goal",
        lifecycle: "running",
        revision: 7,
        executionPolicy: "supervised",
        workspacePolicy: "live",
        permissions: { sourceEffects: { apply: true } },
        baseSha: "a".repeat(40),
        integrationHeadSha: "c".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        live: { projectedIntegrationSha: "c".repeat(40), projections: [{ status: "applied", toIntegrationSha: "c".repeat(40), projectionId: "proj_0123456789abcdef01234567" }] },
        work: [{ workId: "work_live", title: "Implement live flow", status: "integrated", dependsOn: [] }]
      }
    }
  }
});
assert.match(passiveLiveGoal.root.innerHTML, /Live projection/);
assert.match(passiveLiveGoal.root.innerHTML, /Applied/);
assert.match(passiveLiveGoal.root.innerHTML, new RegExp("c{20}"));

const unsupportedLiveGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "get_goal",
      live_projection_supported: false,
      goal: {
        goalId: "goal_0123456789abcdef01234567",
        title: "Existing Windows Live Goal",
        lifecycle: "paused",
        revision: 4,
        executionPolicy: "supervised",
        workspacePolicy: "live",
        permissions: { sourceEffects: { apply: true } },
        baseSha: "a".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        live: { projectedIntegrationSha: "a".repeat(40), projections: [] },
        work: [{ workId: "work_live", title: "Keep state passive", status: "planned", dependsOn: [] }]
      }
    }
  }
});
assert.match(unsupportedLiveGoal.root.innerHTML, /Unavailable on this platform/);
assert.match(unsupportedLiveGoal.root.innerHTML, /inspect existing state without attempting a source mutation/i);

const liveRecoveryGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "project_goal",
      error: "Goal source contains an external same-path edit.",
      goal: {
        goalId: "goal_0123456789abcdef01234567",
        title: "Recover Live projection",
        lifecycle: "running",
        revision: 9,
        executionPolicy: "supervised",
        workspacePolicy: "live",
        permissions: { sourceEffects: { apply: true } },
        baseSha: "a".repeat(40),
        integrationHeadSha: "c".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        live: { projectedIntegrationSha: "a".repeat(40), pendingProjectionId: "proj_0123456789abcdef01234567", projections: [{ status: "recovery_required", toIntegrationSha: "c".repeat(40), projectionId: "proj_0123456789abcdef01234567" }] },
        work: [{ workId: "work_live", title: "Implement live flow", status: "integrated", dependsOn: [] }]
      }
    }
  }
});
assert.match(liveRecoveryGoal.root.innerHTML, /Recovery required/);
assert.match(liveRecoveryGoal.root.innerHTML, /external same-path edit/);
assert.match(liveRecoveryGoal.root.innerHTML, /retry only with the same key or explicitly revert/i);

const proposedPersistentGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "propose_goal",
      available_actions: [{ tool: "approve_goal", label: "Approve exact contract" }],
      goal: {
        goalId: "goal_1123456789abcdef01234567",
        title: "Persistent dependency scheduler",
        lifecycle: "proposed",
        revision: 1,
        executionPolicy: "persistent",
        workspacePolicy: "isolated",
        permissions: { commands: [], sourceEffects: { apply: false, commit: false, push: false, draftPr: false } },
        limits: { maxTurnsPerWorker: 1, maxRetriesPerWorker: 0 },
        baseSha: "a".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "pending" },
        completionCriteria: ["Pro reviews the private integration checkpoint"],
        blackboard: [],
        work: [{ workId: "work_one", title: "Implement bounded change", status: "planned", dependsOn: [] }]
      }
    }
  }
});
assert.match(proposedPersistentGoal.root.innerHTML, /Persistent/);
assert.match(proposedPersistentGoal.root.innerHTML, /automatic dependency scheduling and deterministic private integration/i);
assert.match(proposedPersistentGoal.root.innerHTML, /never source application or completion/i);
assert.match(proposedPersistentGoal.root.innerHTML, /Approve exact contract/);

const strandedPersistentGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "get_goal",
      scheduler_alive: false,
      scheduler_stranded: true,
      recovery_needed: true,
      scheduler_health_authority: "read_only_observation",
      scheduler: { status: "failed", runner_alive: false, stranded: true, recovery_needed: true, recovery_action: "start_goal", start_key: "persistent-start" },
      available_actions: [
        { tool: "start_goal", label: "Recover scheduler" },
        { tool: "cancel_goal", label: "Cancel Goal" }
      ],
      goal: {
        goalId: "goal_2123456789abcdef01234567",
        title: "Recover persistent scheduling",
        lifecycle: "running",
        revision: 6,
        executionPolicy: "persistent",
        workspacePolicy: "isolated",
        permissions: { sourceEffects: { apply: false } },
        baseSha: "a".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        completionCriteria: ["Scheduler reaches Pro review"],
        blackboard: [],
        work: [{ workId: "work_one", title: "Implement bounded change", status: "running", dependsOn: [] }]
      }
    }
  }
});
assert.match(strandedPersistentGoal.root.innerHTML, /Observed stranded · recovery needed/i);
assert.match(strandedPersistentGoal.root.innerHTML, /passive health observation/i);
assert.match(strandedPersistentGoal.root.innerHTML, /Recover scheduler/);
assert.match(strandedPersistentGoal.root.innerHTML, /passive reads never relaunch work/i);

const reviewedPersistentGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "review_goal",
      changed_files_count: 3,
      review: {
        changedFileCount: 0,
        changedPaths: ["src/a.txt", "src/b.txt", "src/c.txt"],
        additions: 3,
        deletions: 0,
        diff: "diff --git a/src/a.txt b/src/a.txt"
      },
      goal: {
        goalId: "goal_4123456789abcdef01234567",
        title: "Review persistent integration",
        lifecycle: "waiting_review",
        revision: 9,
        executionPolicy: "persistent",
        workspacePolicy: "isolated",
        permissions: { sourceEffects: { apply: false } },
        baseSha: "a".repeat(40),
        integrationHeadSha: "c".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        completionCriteria: ["Review three integrated files"],
        blackboard: [],
        work: [{ workId: "work_one", title: "Integrate files", status: "integrated", dependsOn: [] }]
      }
    }
  }
});
assert.match(reviewedPersistentGoal.root.innerHTML, />3<\/div><div class="metric-label">changed files/);
assert.match(reviewedPersistentGoal.root.innerHTML, /Automatic private integration is complete/i);

const cancelingPersistentGoal = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "cancel_goal",
      scheduler: { status: "stopped", runner_alive: false },
      available_actions: [{ tool: "refresh_goal", label: "Refresh cancellation" }],
      goal: {
        goalId: "goal_3123456789abcdef01234567",
        title: "Drain persistent scheduling",
        lifecycle: "canceling",
        revision: 8,
        executionPolicy: "persistent",
        workspacePolicy: "isolated",
        permissions: { sourceEffects: { apply: false } },
        baseSha: "a".repeat(40),
        contractFingerprint: "b".repeat(64),
        approval: { status: "approved" },
        completionCriteria: ["Cancel workers"],
        blackboard: [],
        work: [{ workId: "work_one", title: "Drain child", status: "running", dependsOn: [] }]
      }
    }
  }
});
assert.match(cancelingPersistentGoal.root.innerHTML, /Cancellation authority is persisted/i);
assert.match(cancelingPersistentGoal.root.innerHTML, /store-only reconciliation/i);
assert.match(cancelingPersistentGoal.root.innerHTML, /Refresh cancellation/);

const transitionTask = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "transition_coding_task",
      task: {
        task_id: "task_handoff_01",
        title: "Move checkout work to Codex",
        executor: "codex",
        lifecycle: "ready_for_handoff",
        transition: {
          from: "direct",
          to: "codex",
          authoritative_readback: { confirmed: true, status: "ready" }
        },
        review: {
          changed_files: ["src/checkout.ts"],
          additions: 9,
          deletions: 2,
          diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n+safe handoff"
        }
      }
    }
  }
});
assert.match(transitionTask.root.innerHTML, /Ready for handoff/);
assert.match(transitionTask.root.innerHTML, /Direct coding → Codex collaboration/);
assert.match(transitionTask.root.innerHTML, /Confirmed/);
assert.match(transitionTask.root.innerHTML, /Review diff/);
assert.doesNotMatch(transitionTask.root.innerHTML, /Copy summary/);
const diffButton = new FakeElement();
await transitionTask.root.listeners.get("click")({ target: diffButton });
assert.match(transitionTask.copied(), /diff --git a\/src\/checkout.ts/);

const pendingTransition = mount({
  toolOutput: {
    structuredContent: {
      codexpro_tool: "transition_coding_task",
      task: {
        title: "Hand off only after readback",
        executor: "direct",
        transition: {
          from: "direct",
          to: "codex",
          authoritative_readback: "authoritative readback pending"
        }
      }
    }
  }
});
assert.match(pendingTransition.root.innerHTML, /Transitioning/);
assert.match(pendingTransition.root.innerHTML, /Wait for authoritative readback/);
assert.doesNotMatch(pendingTransition.root.innerHTML, /Ready for handoff/);

const unavailable = mount();
assert.equal(unavailable.timers.length, 1);
unavailable.timers[0].callback();
assert.match(unavailable.root.innerHTML, /Result unavailable/);

console.log("✓ widget smoke test passed");
