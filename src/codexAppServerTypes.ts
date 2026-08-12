export type CodexAppServerRequestId = number | string;

export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export interface CodexAppServerLimits {
  maxLineBytes: number;
  maxMessageBytes: number;
  maxCapturedOutputBytes: number;
  maxStderrBytes: number;
  maxWarnings: number;
}

export interface CodexAppServerClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexAppServerClientOptions {
  /** Exact executable passed to spawn(). It is never resolved through a shell. */
  codexBinary: string;
  /** Task worktree. Its real path is the only writable sandbox root. */
  cwd: string;
  /** Preserve the parent process environment before applying env overrides. Default: true. */
  inheritEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  clientInfo?: Partial<CodexAppServerClientInfo>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  interruptGraceMs?: number;
  shutdownGraceMs?: number;
  idleShutdownMs?: number;
  limits?: Partial<CodexAppServerLimits>;
  onEvent?: (event: CodexAppServerEvent) => void;
}

export interface CodexThreadOptions {
  threadId?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccess?: boolean;
}

export interface CodexThreadIdentity {
  threadId: string;
  sessionId: string;
  resumed: boolean;
  model: string;
  effort: string;
  cwd: string;
}

export interface CodexTurnOptions {
  prompt: string;
  model?: string;
  effort?: string;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccess?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  clientUserMessageId?: string;
}

export interface CodexPlanStep {
  step: string;
  status: string;
}

export interface CodexPlanSnapshot {
  explanation: string | null;
  steps: CodexPlanStep[];
  text?: string;
}

export type CodexTurnFinalStatus = "completed" | "interrupted" | "failed";

export interface CodexTurnResult extends CodexThreadIdentity {
  turnId: string;
  status: CodexTurnFinalStatus;
  finalText: string;
  latestPlan: CodexPlanSnapshot | null;
  latestDiff: string;
  warnings: string[];
  errors: string[];
  timedOut: boolean;
  aborted: boolean;
}

export type CodexAppServerEvent =
  | { type: "turn_started"; threadId: string; turnId: string }
  | { type: "agent_delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item_completed"; threadId: string; turnId: string; itemType: string; itemId: string }
  | { type: "plan"; threadId: string; turnId: string; plan: CodexPlanSnapshot }
  | { type: "diff"; threadId: string; turnId: string; diff: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; willRetry: boolean }
  | { type: "server_request_declined"; method: string; threadId?: string; turnId?: string }
  | { type: "turn_completed"; threadId: string; turnId: string; status: CodexTurnFinalStatus };

export interface ExecuteCodexAppServerTurnOptions extends CodexAppServerClientOptions, CodexThreadOptions, CodexTurnOptions {}
