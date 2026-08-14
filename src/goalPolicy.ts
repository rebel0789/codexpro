import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type { GoalContentPolicySnapshot } from "./goalState.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createGoalContentPolicySnapshot(blockedGlobsInput: string[]): GoalContentPolicySnapshot {
  if (!Array.isArray(blockedGlobsInput) || blockedGlobsInput.length > 500) throw new Error("Goal content policy supports at most 500 blocked globs.");
  const blockedGlobs = [...new Set(blockedGlobsInput.map((value, index) => {
    if (typeof value !== "string" || !value.trim() || value.length > 1_000 || value.includes("\0")) throw new Error(`Invalid Goal blocked glob at index ${index}.`);
    return value.trim();
  }))].sort();
  const fingerprint = sha256(`codexpro-goal-content-policy-ci-v1\0${JSON.stringify(blockedGlobs)}`);
  return { version: 1, algorithm: "blocked-globs-ci-v1", blockedGlobs, fingerprint };
}

export function assertGoalContentPolicySnapshot(value: GoalContentPolicySnapshot): GoalContentPolicySnapshot {
  const normalized = createGoalContentPolicySnapshot(value.blockedGlobs);
  if (value.version !== 1 || value.algorithm !== "blocked-globs-ci-v1" || value.fingerprint !== normalized.fingerprint || JSON.stringify(value.blockedGlobs) !== JSON.stringify(normalized.blockedGlobs)) {
    throw new Error("Goal content policy snapshot is not canonical or its fingerprint is invalid.");
  }
  return normalized;
}

export function unionGoalContentPolicySnapshots(approved: GoalContentPolicySnapshot, runtime?: GoalContentPolicySnapshot): GoalContentPolicySnapshot {
  assertGoalContentPolicySnapshot(approved);
  if (!runtime) return approved;
  assertGoalContentPolicySnapshot(runtime);
  return createGoalContentPolicySnapshot([...approved.blockedGlobs, ...runtime.blockedGlobs]);
}

export function isGoalPathContentAllowed(snapshot: GoalContentPolicySnapshot, relativePath: string): boolean {
  assertGoalContentPolicySnapshot(snapshot);
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return !snapshot.blockedGlobs.some((pattern) => minimatch(relativePath, pattern, { dot: true, nocase: true }));
}
