import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText, redactStructured } from "./redact.js";
import type {
  CodexAppServerClientInfo,
  CodexAppServerClientOptions,
  CodexAppServerEvent,
  CodexAppServerLimits,
  CodexAppServerRequestId,
  CodexApprovalPolicy,
  CodexPlanSnapshot,
  CodexThreadIdentity,
  CodexThreadOptions,
  CodexTurnFinalStatus,
  CodexTurnOptions,
  CodexTurnResult,
  ExecuteCodexAppServerTurnOptions
} from "./codexAppServerTypes.js";

const DEFAULT_LIMITS: CodexAppServerLimits = {
  maxLineBytes: 4 * 1024 * 1024,
  maxMessageBytes: 4 * 1024 * 1024,
  maxCapturedOutputBytes: 2 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxWarnings: 100
};

const DEFAULT_CLIENT_INFO: CodexAppServerClientInfo = {
  name: "codexpro",
  title: "CodexPro",
  version: "0.29.0"
};

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  completion: Promise<CodexTurnResult>;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
  finalText: string;
  latestPlan: CodexPlanSnapshot | null;
  latestDiff: string;
  warnings: string[];
  errors: string[];
  timedOut: boolean;
  aborted: boolean;
  interruptSent: boolean;
  completed: boolean;
  timeoutTimer?: NodeJS.Timeout;
  interruptTimer?: NodeJS.Timeout;
  abortCleanup?: () => void;
}

export class CodexAppServerProtocolError extends Error {
  constructor(message: string) {
    super(redactSensitiveText(message));
    this.name = "CodexAppServerProtocolError";
  }
}

export class CodexAppServerClient {
  private readonly options: Required<
    Pick<
      CodexAppServerClientOptions,
      "inheritEnv" | "requestTimeoutMs" | "turnTimeoutMs" | "interruptGraceMs" | "shutdownGraceMs" | "idleShutdownMs"
    >
  > &
    CodexAppServerClientOptions;
  private readonly limits: CodexAppServerLimits;
  private readonly clientInfo: CodexAppServerClientInfo;
  private child?: ChildProcessWithoutNullStreams;
  private cwd = "";
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = "";
  private nextRequestId = 1;
  private readonly pending = new Map<CodexAppServerRequestId, PendingRequest>();
  private initialized = false;
  private identity?: CodexThreadIdentity;
  private threadOptions?: Required<Pick<CodexThreadOptions, "model" | "effort" | "approvalPolicy" | "networkAccess">>;
  private activeTurn?: ActiveTurn;
  private startingTurn = false;
  private queuedTurnNotifications: Array<{ method: string; params: JsonObject }> = [];
  private queuedDeclinedServerRequests: string[] = [];
  private preTurnWarnings: string[] = [];
  private fatalError?: Error;
  private idleTimer?: NodeJS.Timeout;
  private closing?: Promise<void>;

  constructor(options: CodexAppServerClientOptions) {
    if (!options.codexBinary?.trim()) throw new Error("codexBinary is required.");
    if (!options.cwd?.trim()) throw new Error("cwd is required.");
    this.options = {
      ...options,
      inheritEnv: options.inheritEnv ?? true,
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, 15_000, "requestTimeoutMs"),
      turnTimeoutMs: positiveInteger(options.turnTimeoutMs, 30 * 60_000, "turnTimeoutMs"),
      interruptGraceMs: positiveInteger(options.interruptGraceMs, 5_000, "interruptGraceMs"),
      shutdownGraceMs: positiveInteger(options.shutdownGraceMs, 2_000, "shutdownGraceMs"),
      idleShutdownMs: nonNegativeInteger(options.idleShutdownMs, 250, "idleShutdownMs")
    };
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.clientInfo = {
      ...DEFAULT_CLIENT_INFO,
      ...options.clientInfo
    };
  }

  async connect(): Promise<void> {
    if (this.initialized) return;
    if (this.child) throw new Error("Codex app-server connection is already starting.");
    this.cwd = await realDirectory(this.options.cwd);
    this.spawnServer();
    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        extensions: null
      }
    });
    this.notify("initialized");
    this.initialized = true;
  }

  async startOrResumeThread(options: CodexThreadOptions = {}): Promise<CodexThreadIdentity> {
    await this.connect();
    this.clearIdleTimer();
    if (this.identity) throw new Error("This client already owns a thread.");
    const model = cleanRequired(options.model ?? "gpt-5.6-sol", "model");
    const effort = cleanRequired(options.effort ?? "high", "effort");
    const approvalPolicy = options.approvalPolicy ?? "never";
    const networkAccess = options.networkAccess ?? false;
    const baseParams = {
      model,
      cwd: this.cwd,
      approvalPolicy,
      approvalsReviewer: "user",
      sandbox: "workspace-write"
    };
    const requestedThreadId = options.threadId?.trim();
    const result = asObject(
      await this.request(requestedThreadId ? "thread/resume" : "thread/start", {
        ...(requestedThreadId ? { threadId: requestedThreadId } : { ephemeral: false, threadSource: "codexpro" }),
        ...baseParams
      }),
      requestedThreadId ? "thread/resume result" : "thread/start result"
    );
    const thread = asObject(result.thread, "thread");
    const threadId = asString(thread.id, "thread.id");
    const sessionId = asString(thread.sessionId, "thread.sessionId");
    if (requestedThreadId && threadId !== requestedThreadId) {
      throw new CodexAppServerProtocolError(`thread/resume returned unexpected thread id: ${threadId}`);
    }
    if (thread.ephemeral === true) {
      throw new CodexAppServerProtocolError("Codex app-server returned an ephemeral thread.");
    }
    this.threadOptions = { model, effort, approvalPolicy, networkAccess };
    this.identity = { threadId, sessionId, resumed: Boolean(requestedThreadId), model, effort, cwd: this.cwd };
    return { ...this.identity };
  }

  async runTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
    if (!this.identity || !this.threadOptions) throw new Error("Start or resume a thread before starting a turn.");
    if (this.activeTurn) throw new Error("A turn is already active on this client.");
    this.clearIdleTimer();
    const prompt = cleanRequired(options.prompt, "prompt");
    const model = cleanRequired(options.model ?? this.threadOptions.model, "model");
    const effort = cleanRequired(options.effort ?? this.threadOptions.effort, "effort");
    const approvalPolicy = options.approvalPolicy ?? this.threadOptions.approvalPolicy;
    const networkAccess = options.networkAccess ?? this.threadOptions.networkAccess;
    this.startingTurn = true;
    let response: JsonObject;
    try {
      response = asObject(await this.request("turn/start", {
        threadId: this.identity.threadId,
        ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.cwd,
        approvalPolicy,
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [this.cwd],
          networkAccess,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        },
        model,
        effort
      }), "turn/start result");
    } catch (error) {
      this.startingTurn = false;
      this.queuedTurnNotifications = [];
      this.queuedDeclinedServerRequests = [];
      throw error;
    }
    const turn = asObject(response.turn, "turn/start turn");
    const turnId = asString(turn.id, "turn.id");
    const active = createActiveTurn(this.identity.threadId, turnId);
    this.activeTurn = active;
    active.warnings.push(...this.preTurnWarnings.splice(0, this.limits.maxWarnings));
    this.emit({ type: "turn_started", threadId: active.threadId, turnId: active.turnId });

    const timeoutMs = positiveInteger(options.timeoutMs, this.options.turnTimeoutMs, "timeoutMs");
    active.timeoutTimer = setTimeout(() => {
      active.timedOut = true;
      void this.interruptActiveTurn("turn timeout");
    }, timeoutMs);
    active.timeoutTimer.unref();

    if (options.signal) {
      const onAbort = () => {
        active.aborted = true;
        void this.interruptActiveTurn("abort signal");
      };
      if (options.signal.aborted) onAbort();
      else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        active.abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
    }

    this.startingTurn = false;
    const queuedDeclines = this.queuedDeclinedServerRequests;
    this.queuedDeclinedServerRequests = [];
    for (const method of queuedDeclines) this.recordDeclinedServerRequest(method);
    const queuedNotifications = this.queuedTurnNotifications;
    this.queuedTurnNotifications = [];
    for (const queued of queuedNotifications) this.handleNotification(queued.method, queued.params);

    return active.completion;
  }

  async steer(prompt: string, clientUserMessageId?: string): Promise<string> {
    const active = this.activeTurn;
    if (!active || active.completed) throw new Error("No active turn is available for steering.");
    const result = asObject(
      await this.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        input: [{ type: "text", text: cleanRequired(prompt, "steering prompt"), text_elements: [] }]
      }),
      "turn/steer result"
    );
    const turnId = asString(result.turnId, "turn/steer turnId");
    if (turnId !== active.turnId) throw new CodexAppServerProtocolError(`turn/steer returned unexpected turn id: ${turnId}`);
    return turnId;
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurn) return;
    await this.interruptActiveTurn("caller interrupt");
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeProcess();
    return this.closing;
  }

  private spawnServer(): void {
    const explicitEnv = sanitizedSpawnEnv(this.options.env ?? {});
    const child = spawn(this.options.codexBinary, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: this.options.inheritEnv ? { ...process.env, ...explicitEnv } : explicitEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.on("error", (error) => this.fail(new Error(`Unable to start Codex app-server: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (this.closing) return;
      const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      this.fail(new Error(`Codex app-server exited unexpectedly with ${detail}${this.stderr ? `: ${this.stderr}` : ""}`));
    });
  }

  private request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    this.assertWritable();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.assertWritable();
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  private writeMessage(message: JsonObject): void {
    const encoded = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (encoded.byteLength > this.limits.maxMessageBytes) {
      throw new CodexAppServerProtocolError(`Outgoing Codex app-server message exceeds ${this.limits.maxMessageBytes} bytes.`);
    }
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Codex app-server stdin is not writable.");
    stdin.write(encoded);
  }

  private onStdout(chunk: Buffer): void {
    if (this.fatalError) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.byteLength > this.limits.maxLineBytes) {
          this.fail(new CodexAppServerProtocolError(`Codex app-server line exceeds ${this.limits.maxLineBytes} bytes.`));
        }
        return;
      }
      const rawLine = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
      if (line.byteLength > this.limits.maxLineBytes || line.byteLength > this.limits.maxMessageBytes) {
        this.fail(new CodexAppServerProtocolError("Codex app-server response exceeds the configured size limit."));
        return;
      }
      if (!line.toString("utf8").trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch (error) {
        this.fail(new CodexAppServerProtocolError(`Malformed JSON from Codex app-server: ${errorMessage(error)}`));
        return;
      }
      try {
        this.handleMessage(asObject(message, "Codex app-server message"));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private handleMessage(message: JsonObject): void {
    const id = requestId(message.id);
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method && id !== undefined) {
      this.handleServerRequest(id, method);
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error !== undefined) {
        pending.reject(new Error(`${pending.method} failed: ${rpcErrorMessage(message.error)}`));
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CodexAppServerProtocolError(`Response to ${pending.method} has neither result nor error.`));
      }
      return;
    }
    if (method) this.handleNotification(method, asObjectOrEmpty(message.params));
  }

  private handleServerRequest(id: CodexAppServerRequestId, method: string): void {
    let result: unknown;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "decline" };
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        result = { decision: { denied: { rejection: "CodexPro does not approve server-initiated actions." } } };
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      case "mcpServer/elicitation/request":
        result = { action: "decline", content: null, _meta: null };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn", strictAutoReview: true };
        break;
      case "item/tool/call":
        result = { contentItems: [], success: false };
        break;
      default:
        this.writeMessage({
          id,
          error: { code: -32601, message: "CodexPro declines unsupported server requests." }
        });
        this.recordDeclinedServerRequest(method);
        return;
    }
    this.writeMessage({ id, result });
    this.recordDeclinedServerRequest(method);
  }

  private recordDeclinedServerRequest(method: string): void {
    const active = this.activeTurn;
    if (!active && this.startingTurn) {
      if (this.queuedDeclinedServerRequests.length >= 100) {
        throw new CodexAppServerProtocolError("Too many server requests arrived before turn/start completed.");
      }
      this.queuedDeclinedServerRequests.push(method);
      return;
    }
    const event: CodexAppServerEvent = active
      ? { type: "server_request_declined", method, threadId: active.threadId, turnId: active.turnId }
      : { type: "server_request_declined", method };
    this.emit(event);
    const message = `Declined server request: ${method}`;
    this.addWarning(message);
    this.addError(message);
    if (active && !active.completed) void this.interruptActiveTurn(`declined server request ${method}`);
  }

  private handleNotification(method: string, params: JsonObject): void {
    const active = this.activeTurn;
    if (method === "warning" || method === "guardianWarning") {
      const message = safeString(params.message) ?? "Codex app-server warning";
      this.addWarning(message);
      return;
    }
    if (method === "configWarning" || method === "deprecationNotice") {
      const summary = safeString(params.summary) ?? method;
      const details = safeString(params.details);
      this.addWarning(details ? `${summary}: ${details}` : summary);
      return;
    }
    if (!active) {
      if (this.startingTurn && isAuthoritativeTurnNotification(method)) {
        if (this.queuedTurnNotifications.length >= 1_000) {
          throw new CodexAppServerProtocolError("Too many turn notifications arrived before turn/start completed.");
        }
        this.queuedTurnNotifications.push({ method, params });
      }
      return;
    }
    if (!matchesActive(params, active)) return;
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = this.capture(safeString(params.delta) ?? "");
        this.emit({
          type: "agent_delta",
          threadId: active.threadId,
          turnId: active.turnId,
          itemId: safeString(params.itemId) ?? "",
          delta
        });
        break;
      }
      case "turn/diff/updated": {
        active.latestDiff = this.capture(safeString(params.diff) ?? "");
        this.emit({ type: "diff", threadId: active.threadId, turnId: active.turnId, diff: active.latestDiff });
        break;
      }
      case "turn/plan/updated": {
        active.latestPlan = this.capturePlan(planFromParams(params));
        this.emit({ type: "plan", threadId: active.threadId, turnId: active.turnId, plan: active.latestPlan });
        break;
      }
      case "item/completed": {
        const item = asObject(params.item, "item/completed item");
        this.consumeCompletedItem(active, item);
        this.emit({
          type: "item_completed",
          threadId: active.threadId,
          turnId: active.turnId,
          itemType: safeString(item.type) ?? "unknown",
          itemId: safeString(item.id) ?? ""
        });
        break;
      }
      case "error": {
        const error = asObjectOrEmpty(params.error);
        const message = safeString(error.message) ?? "Unknown Codex turn error";
        this.addError(message);
        this.emit({ type: "error", message: this.capture(message), willRetry: params.willRetry === true });
        break;
      }
      case "turn/completed":
        this.completeTurn(active, params);
        break;
    }
  }

  private consumeCompletedItem(active: ActiveTurn, item: JsonObject): void {
    if (item.type === "agentMessage") {
      const text = safeString(item.text);
      if (text !== undefined && (item.phase === "final_answer" || item.phase === null || item.phase === undefined)) {
        active.finalText = this.capture(text);
      }
    } else if (item.type === "plan") {
      const text = safeString(item.text);
      if (text !== undefined) active.latestPlan = { explanation: null, steps: [], text: this.capture(text) };
    }
  }

  private completeTurn(active: ActiveTurn, params: JsonObject): void {
    if (active.completed) return;
    const turn = asObject(params.turn, "turn/completed turn");
    const turnId = asString(turn.id, "turn/completed turn.id");
    if (turnId !== active.turnId) throw new CodexAppServerProtocolError(`turn/completed returned unexpected turn id: ${turnId}`);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) this.consumeCompletedItem(active, asObject(item, "turn/completed item"));
    const status = turnStatus(turn.status);
    const turnError = asObjectOrEmpty(turn.error);
    const turnErrorMessage = safeString(turnError.message);
    if (turnErrorMessage) this.addError(turnErrorMessage);
    active.completed = true;
    this.cleanupActiveTurn(active);
    const result: CodexTurnResult = {
      ...this.identity!,
      turnId: active.turnId,
      status,
      finalText: active.finalText,
      latestPlan: active.latestPlan,
      latestDiff: active.latestDiff,
      warnings: [...active.warnings],
      errors: [...active.errors],
      timedOut: active.timedOut,
      aborted: active.aborted
    };
    this.emit({ type: "turn_completed", threadId: active.threadId, turnId: active.turnId, status });
    active.resolve(result);
    this.activeTurn = undefined;
    this.scheduleIdleClose();
  }

  private async interruptActiveTurn(reason: string): Promise<void> {
    const active = this.activeTurn;
    if (!active || active.completed || active.interruptSent) return;
    active.interruptSent = true;
    active.interruptTimer = setTimeout(() => {
      if (!active.completed) {
        this.fail(new Error(`Codex turn did not complete within ${this.options.interruptGraceMs}ms after ${reason}.`));
      }
    }, this.options.interruptGraceMs);
    active.interruptTimer.unref();
    try {
      await this.request(
        "turn/interrupt",
        { threadId: active.threadId, turnId: active.turnId },
        Math.min(this.options.requestTimeoutMs, this.options.interruptGraceMs)
      );
    } catch (error) {
      this.addError(`Unable to interrupt turn after ${reason}: ${errorMessage(error)}`);
    }
  }

  private onStderr(chunk: Buffer): void {
    const combined = `${this.stderr}${chunk.toString("utf8")}`;
    this.stderr = truncateUtf8(redactSensitiveText(combined), this.limits.maxStderrBytes);
  }

  private addWarning(message: string): void {
    const redacted = this.capture(message);
    const active = this.activeTurn;
    if (active && active.warnings.length < this.limits.maxWarnings) active.warnings.push(redacted);
    else if (!active && this.preTurnWarnings.length < this.limits.maxWarnings) this.preTurnWarnings.push(redacted);
    this.emit({ type: "warning", message: redacted });
  }

  private addError(message: string): void {
    const redacted = this.capture(message);
    const active = this.activeTurn;
    if (active && active.errors.length < this.limits.maxWarnings) active.errors.push(redacted);
  }

  private capture(text: string): string {
    return truncateUtf8(redactSensitiveText(text), this.limits.maxCapturedOutputBytes);
  }

  private capturePlan(plan: CodexPlanSnapshot): CodexPlanSnapshot {
    const safe = redactStructured(plan);
    if (Buffer.byteLength(JSON.stringify(safe), "utf8") <= this.limits.maxCapturedOutputBytes) return safe;
    const bounded: CodexPlanSnapshot = {
      explanation: safe.explanation ? truncateUtf8(safe.explanation, Math.floor(this.limits.maxCapturedOutputBytes / 4)) : null,
      steps: []
    };
    let used = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    for (const step of safe.steps) {
      const candidate = {
        step: truncateUtf8(step.step, Math.floor(this.limits.maxCapturedOutputBytes / 2)),
        status: truncateUtf8(step.status, 1_024)
      };
      const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1;
      if (used + bytes > this.limits.maxCapturedOutputBytes - 64) break;
      bounded.steps.push(candidate);
      used += bytes;
    }
    bounded.steps.push({ step: "[truncated]", status: "unknown" });
    return bounded;
  }

  private emit(event: CodexAppServerEvent): void {
    if (!this.options.onEvent) return;
    try {
      this.options.onEvent(redactStructured(event));
    } catch (error) {
      const warning = this.capture(`Codex app-server event callback failed: ${errorMessage(error)}`);
      if (this.activeTurn && this.activeTurn.warnings.length < this.limits.maxWarnings) this.activeTurn.warnings.push(warning);
      else if (this.preTurnWarnings.length < this.limits.maxWarnings) this.preTurnWarnings.push(warning);
    }
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.close(), this.options.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private cleanupActiveTurn(active: ActiveTurn): void {
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (active.interruptTimer) clearTimeout(active.interruptTimer);
    active.abortCleanup?.();
  }

  private assertWritable(): void {
    if (this.fatalError) throw this.fatalError;
    if (!this.child) throw new Error("Codex app-server is not connected.");
  }

  private fail(error: Error): void {
    if (this.fatalError || this.closing) return;
    const safeError = error instanceof CodexAppServerProtocolError ? error : new Error(redactSensitiveText(error.message));
    this.fatalError = safeError;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safeError);
    }
    this.pending.clear();
    if (this.activeTurn && !this.activeTurn.completed) {
      this.cleanupActiveTurn(this.activeTurn);
      this.activeTurn.reject(safeError);
      this.activeTurn = undefined;
    }
    void this.close();
  }

  private async closeProcess(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server client closed."));
    }
    this.pending.clear();
    if (this.activeTurn && !this.activeTurn.completed) {
      const active = this.activeTurn;
      this.cleanupActiveTurn(active);
      active.reject(new Error("Codex app-server client closed during an active turn."));
      this.activeTurn = undefined;
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.end();
      child.kill("SIGTERM");
      const graceful = await Promise.race([
        exited.then(() => true),
        delay(this.options.shutdownGraceMs).then(() => false)
      ]);
      if (!graceful && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(this.options.shutdownGraceMs)]);
      }
    }
    this.child = undefined;
    this.initialized = false;
  }
}

export async function executeCodexAppServerTurn(options: ExecuteCodexAppServerTurnOptions): Promise<CodexTurnResult> {
  const client = new CodexAppServerClient(options);
  try {
    await client.startOrResumeThread({
      threadId: options.threadId,
      model: options.model,
      effort: options.effort,
      approvalPolicy: options.approvalPolicy,
      networkAccess: options.networkAccess
    });
    return await client.runTurn({
      prompt: options.prompt,
      model: options.model,
      effort: options.effort,
      approvalPolicy: options.approvalPolicy,
      networkAccess: options.networkAccess,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      clientUserMessageId: options.clientUserMessageId
    });
  } finally {
    await client.close();
  }
}

function createActiveTurn(threadId: string, turnId: string): ActiveTurn {
  let resolve!: (result: CodexTurnResult) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<CodexTurnResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    threadId,
    turnId,
    completion,
    resolve,
    reject,
    finalText: "",
    latestPlan: null,
    latestDiff: "",
    warnings: [],
    errors: [],
    timedOut: false,
    aborted: false,
    interruptSent: false,
    completed: false
  };
}

function planFromParams(params: JsonObject): CodexPlanSnapshot {
  const rawPlan = Array.isArray(params.plan) ? params.plan : [];
  return {
    explanation: safeString(params.explanation) ?? null,
    steps: rawPlan.map((raw) => {
      const step = asObject(raw, "plan step");
      return { step: asString(step.step, "plan step text"), status: asString(step.status, "plan step status") };
    })
  };
}

function matchesActive(params: JsonObject, active: ActiveTurn): boolean {
  const threadId = safeString(params.threadId);
  const turnId = safeString(params.turnId) ?? safeString(asObjectOrEmpty(params.turn).id);
  return (!threadId || threadId === active.threadId) && (!turnId || turnId === active.turnId);
}

function isAuthoritativeTurnNotification(method: string): boolean {
  return (
    method === "item/completed" ||
    method === "turn/completed" ||
    method === "turn/diff/updated" ||
    method === "turn/plan/updated" ||
    method === "error"
  );
}

function turnStatus(value: unknown): CodexTurnFinalStatus {
  if (value === "completed" || value === "interrupted" || value === "failed") return value;
  throw new CodexAppServerProtocolError(`Invalid final turn status: ${String(value)}`);
}

function requestId(value: unknown): CodexAppServerRequestId | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexAppServerProtocolError(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function asObjectOrEmpty(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new CodexAppServerProtocolError(`${label} must be a non-empty string.`);
  return value;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cleanRequired(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} is required.`);
  return cleaned;
}

function rpcErrorMessage(error: unknown): string {
  const object = asObjectOrEmpty(error);
  return redactSensitiveText(safeString(object.message) ?? JSON.stringify(redactStructured(error)));
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function sanitizedSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${label} must be a positive integer.`);
  return selected;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error(`${label} must be a non-negative integer.`);
  return selected;
}

function validateLimits(limits: CodexAppServerLimits): CodexAppServerLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  }
  return limits;
}

async function realDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const real = await fs.realpath(resolved);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error(`Codex task worktree is not a directory: ${resolved}`);
  return real;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  const suffix = "\n[truncated]";
  const suffixBytes = Buffer.byteLength(suffix);
  const kept = buffer.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf8").replace(/\uFFFD$/u, "");
  return `${kept}${suffix}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
