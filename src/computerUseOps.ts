import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CodexProConfig } from "./config.js";

const execute = promisify(execFile);
const SOURCE_PATH = fileURLToPath(new URL("../native/macos/CodexProComputerUse.swift", import.meta.url));
const MAX_STATE_ELEMENTS = 1000;

export interface ComputerUseState {
  app_id: string;
  app_name: string;
  pid: number;
  trusted: boolean;
  elements: Array<{
    id: string;
    role?: string;
    title?: string;
    value?: string;
    description?: string;
    enabled?: boolean;
    position?: { x: number; y: number };
    size?: { width: number; height: number };
  }>;
  truncated: boolean;
}

function assertMac(): void {
  if (process.platform !== "darwin") throw new Error("computer_use_unsupported_platform: 当前仅支持 macOS。");
}

function assertAllowed(config: CodexProConfig, appId: string): void {
  if (!config.computerUseAllowedApps.length) {
    throw new Error("computer_use_allowlist_empty: 请通过 --computer-use-apps 或 CODEXPRO_COMPUTER_USE_APPS 显式配置允许的应用 bundle id。");
  }
  if (!config.computerUseAllowedApps.includes(appId)) {
    throw new Error(`computer_use_app_not_allowed: ${appId}`);
  }
}

async function helperBinary(): Promise<string> {
  assertMac();
  const source = await fsp.readFile(SOURCE_PATH);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const output = path.join(os.tmpdir(), `codexpro-computer-use-${digest}`);
  if (fs.existsSync(output)) return output;
  const temp = `${output}.${process.pid}.tmp`;
  const swiftArgs = ["swiftc", SOURCE_PATH, "-parse-as-library", "-O"];
  if (process.arch === "arm64" || process.arch === "x64") {
    swiftArgs.push("-target", `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macosx14.0`);
  }
  swiftArgs.push("-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "ScreenCaptureKit", "-o", temp);
  await execute("/usr/bin/xcrun", swiftArgs, { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  await fsp.chmod(temp, 0o700);
  try {
    await fsp.rename(temp, output);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    await fsp.rm(temp, { force: true });
  }
  return output;
}

async function invoke(args: string[], timeout = 15_000): Promise<any> {
  const binary = await helperBinary();
  try {
    const { stdout } = await execute(binary, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout || "{}");
  } catch (error: any) {
    const stderr = String(error?.stderr || "").trim();
    throw new Error(stderr || error?.message || "computer_use_helper_failed");
  }
}

export function computerUseStatus(config: CodexProConfig): Record<string, unknown> {
  return {
    supported: process.platform === "darwin",
    mode: config.computerUseMode,
    allowed_apps: config.computerUseAllowedApps,
    allowlist_configured: config.computerUseAllowedApps.length > 0,
    backend: process.platform === "darwin" ? "macos-ax-swift" : "unavailable",
    minimum_macos: "14.0"
  };
}

export async function listComputerApps(config: CodexProConfig): Promise<any[]> {
  assertMac();
  if (config.computerUseMode === "off") throw new Error("computer_use_disabled");
  if (!config.computerUseAllowedApps.length) return [];
  const result = await invoke(["list-apps", "--allowlist", config.computerUseAllowedApps.join(",")]);
  const allowed = new Set(config.computerUseAllowedApps);
  return Array.isArray(result.apps) ? result.apps.filter((app: any) => allowed.has(app.app_id)) : [];
}

export async function getComputerState(config: CodexProConfig, appId: string, maxElements = 400): Promise<ComputerUseState> {
  assertMac();
  assertAllowed(config, appId);
  if (config.computerUseMode === "off") throw new Error("computer_use_disabled");
  return invoke(["get-state", "--app", appId, "--max-elements", String(Math.min(maxElements, MAX_STATE_ELEMENTS))]) as Promise<ComputerUseState>;
}

export async function clickComputerElement(config: CodexProConfig, appId: string, elementId: string): Promise<any> {
  assertMac();
  assertAllowed(config, appId);
  if (config.computerUseMode !== "interact") throw new Error("computer_use_interaction_disabled");
  return invoke(["click", "--app", appId, "--element", elementId]);
}

export async function pressComputerKey(config: CodexProConfig, appId: string, key: string): Promise<any> {
  assertMac();
  assertAllowed(config, appId);
  if (config.computerUseMode !== "interact") throw new Error("computer_use_interaction_disabled");
  return invoke(["press-key", "--app", appId, "--key", key]);
}

export async function screenshotComputerApp(config: CodexProConfig, appId: string): Promise<{ data: string; mimeType: "image/png"; width?: number; height?: number }> {
  assertMac();
  assertAllowed(config, appId);
  if (config.computerUseMode === "off") throw new Error("computer_use_disabled");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-shot-"));
  const output = path.join(dir, "window.png");
  try {
    const meta = await invoke(["screenshot", "--app", appId, "--output", output], 30_000);
    const bytes = await fsp.readFile(output);
    return { data: bytes.toString("base64"), mimeType: "image/png", width: meta.width, height: meta.height };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
