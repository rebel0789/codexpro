import type { GoalState, GoalWorkItem } from "./goalState.js";

export const GOAL_WORKER_PROMPT_MAX_BYTES = 256 * 1024;

export function buildGoalWorkerPrompt(goal: Pick<GoalState, "goalId" | "permissions" | "verification">, work: Pick<GoalWorkItem, "workId" | "title" | "goal" | "acceptanceCriteria" | "verification" | "fileGlobs">): string {
  const allowed = work.fileGlobs.length ? work.fileGlobs : goal.permissions.fileGlobs;
  const prompt = [
    `You are a Codex worker assigned by ChatGPT Pro to Goal ${goal.goalId}.`,
    `Work item: ${work.workId} — ${work.title}`,
    "", "Implement only this approved scope:", work.goal,
    "", "Acceptance criteria:", ...work.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "", "Allowed file globs:", ...allowed.map((glob) => `- ${glob}`),
    "", "Verification:", ...(work.verification.length ? work.verification : goal.verification).map((check) => `- ${check}`),
    "", "Authority constraints:",
    "- Do not broaden scope, create new work, reassign dependencies, commit, merge, push, or create a PR.",
    "- Network access and interactive approvals are disabled.",
    "- Do not execute Goal permissions.commands; they are descriptive approval metadata, not worker authority.",
    "- If the scope or file boundary is insufficient, stop and report a blocker for Pro; do not work around it.",
    "- Finish with a concise summary of files changed, checks run, results, and any Blackboard-worthy discovery."
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > GOAL_WORKER_PROMPT_MAX_BYTES) throw new Error("Serialized Goal worker prompt exceeds the 256KiB runner safety bound.");
  return prompt;
}
