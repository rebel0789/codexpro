#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { expandHome, loadConfig, type CodexProConfig } from "./config.js";
import {
  profilePathForRoot,
  readRuntimeConnection,
  readWorkspaceProfile,
  sanitizeWorkspaceProfile,
  saveWorkspaceProfile,
  type ConnectorMode,
  type TunnelMode,
  type WorkspaceProfile
} from "./profileStore.js";
import { createCodexProServer } from "./server.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function copyCommand(title: string, description: string, command: string, displayCommand = command, copyKind = ""): string {
  const copyAttrs = copyKind
    ? `data-copy-kind="${escapeHtml(copyKind)}" data-copy-base="${escapeHtml(command)}"`
    : `data-copy="${escapeHtml(command)}"`;
  return `<div class="control">
    <div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
      <code>${escapeHtml(displayCommand)}</code>
    </div>
    <button type="button" class="copy-mini" ${copyAttrs}>Copy</button>
  </div>`;
}

const TUNNELS = ["cloudflare", "ngrok", "cloudflare-named", "none"] as const;
const MODES = ["agent", "handoff", "pro"] as const;
const BASH_MODES = ["safe", "off", "full"] as const;
const BASH_TRANSCRIPTS = ["compact", "full"] as const;
const CODEX_SESSIONS = ["off", "metadata", "read"] as const;
const WRITE_MODES = ["workspace", "handoff", "off"] as const;
const TOOL_MODES = ["standard", "minimal", "full"] as const;

const textField = (max: number) =>
  z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().max(max).optional());

const AdminProfilePatch = z.object({
  tunnel: z.enum(TUNNELS).optional(),
  hostname: textField(253),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  mode: z.enum(MODES).optional(),
  bash: z.enum(BASH_MODES).optional(),
  bashTranscript: z.enum(BASH_TRANSCRIPTS).optional(),
  codexSessions: z.enum(CODEX_SESSIONS).optional(),
  codexDir: textField(4096),
  bashSession: textField(64).refine(
    (value) => !value || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
    "bashSession must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number."
  ),
  requireBashSession: z.boolean().optional(),
  write: z.enum(WRITE_MODES).optional(),
  toolMode: z.enum(TOOL_MODES).optional(),
  widgetDomain: textField(2048),
  tunnelName: textField(128),
  ngrokConfig: textField(4096),
  cloudflareConfig: textField(4096),
  cloudflareTokenFile: textField(4096),
  noInstallCloudflared: z.boolean().optional()
}).strict();

type AdminProfilePatch = z.infer<typeof AdminProfilePatch>;

interface ProfileFormValues {
  port: string;
  mode: ConnectorMode;
  tunnel: TunnelMode;
  hostname: string;
  tunnelName: string;
  ngrokConfig: string;
  cloudflareConfig: string;
  cloudflareTokenFile: string;
  bash: "off" | "safe" | "full";
  bashTranscript: "compact" | "full";
  codexSessions: "off" | "metadata" | "read";
  codexDir: string;
  bashSession: string;
  requireBashSession: boolean;
  write: "off" | "handoff" | "workspace";
  toolMode: "minimal" | "standard" | "full";
  widgetDomain: string;
  noInstallCloudflared: boolean;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}

function runtimeTunnelFallback(): TunnelMode {
  if (process.env.CODEXPRO_TUNNEL && TUNNELS.includes(process.env.CODEXPRO_TUNNEL as TunnelMode)) {
    return process.env.CODEXPRO_TUNNEL as TunnelMode;
  }
  return process.env.CODEXPRO_TUNNEL_MODE === "0" ? "none" : "cloudflare";
}

function normalizePublicHostname(value: string | undefined): string {
  const raw = value?.trim().replace(/\/+$/, "") ?? "";
  if (!raw) return "";
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:") throw new Error("hostname must use https when a scheme is provided.");
  if (url.search || url.hash) throw new Error("hostname must not include query strings or fragments.");
  if (url.pathname !== "/" && url.pathname !== "/mcp") throw new Error("hostname must be a host, URL root, or /mcp URL.");
  return url.host;
}

function normalizeWidgetDomain(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("widgetDomain must use https.");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("widgetDomain must be an origin only, for example https://widgets.example.com.");
  }
  return url.origin;
}

function effectiveWriteMode(mode: ConnectorMode, write: ProfileFormValues["write"]): ProfileFormValues["write"] {
  if (mode === "agent") return write;
  return write === "off" ? "off" : "handoff";
}

function normalizeProfilePath(root: string, value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) || path.win32.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
}

function profileValues(config: CodexProConfig, profile = readWorkspaceProfile(config.defaultRoot)): ProfileFormValues {
  const hostname =
    profile.hostname ??
    process.env.CODEXPRO_PUBLIC_HOSTNAME ??
    process.env.CODEXPRO_HOSTNAME ??
    process.env.NGROK_DOMAIN ??
    "";
  const mode = oneOf(profile.mode ?? process.env.CODEXPRO_MODE, MODES, "agent");
  const write = effectiveWriteMode(mode, oneOf(profile.write ?? config.writeMode, WRITE_MODES, config.writeMode));
  return {
    port: String(profile.port ?? config.port),
    mode,
    tunnel: oneOf(profile.tunnel, TUNNELS, runtimeTunnelFallback()),
    hostname: String(hostname),
    tunnelName: String(profile.tunnelName ?? ""),
    ngrokConfig: String(profile.ngrokConfig ?? ""),
    cloudflareConfig: String(profile.cloudflareConfig ?? ""),
    cloudflareTokenFile: String(profile.cloudflareTokenFile ?? ""),
    bash: oneOf(profile.bash ?? config.bashMode, BASH_MODES, config.bashMode),
    bashTranscript: oneOf(profile.bashTranscript ?? config.bashTranscript, BASH_TRANSCRIPTS, config.bashTranscript),
    codexSessions: oneOf(profile.codexSessions ?? config.codexSessions, CODEX_SESSIONS, config.codexSessions),
    codexDir: String(profile.codexDir ?? config.codexDir),
    bashSession: String(profile.bashSession ?? config.bashSessionId ?? ""),
    requireBashSession: Boolean(profile.requireBashSession ?? config.requireBashSession),
    write,
    toolMode: oneOf(profile.toolMode ?? config.toolMode, TOOL_MODES, config.toolMode),
    widgetDomain: String(profile.widgetDomain ?? config.widgetDomain),
    noInstallCloudflared: Boolean(profile.noInstallCloudflared)
  };
}

const OPTION_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare quick tunnel",
  ngrok: "ngrok stable URL",
  "cloudflare-named": "Cloudflare named tunnel",
  none: "Local only",
  agent: "Agent",
  handoff: "Handoff",
  pro: "Pro bundle",
  safe: "Safe",
  off: "Off",
  full: "Full",
  compact: "Compact",
  metadata: "Metadata",
  read: "Read",
  workspace: "Workspace",
  minimal: "Minimal",
  standard: "Standard"
};

function optionLabel(value: string): string {
  return OPTION_LABELS[value] ?? value;
}

function selectOptions(values: readonly string[], current: string): string {
  return values
    .map((value) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(optionLabel(value))}</option>`)
    .join("");
}

function serverUrlDisplay(endpoint: string | undefined, authEnabled: boolean): string {
  if (!endpoint) return "";
  if (!authEnabled) return endpoint;
  const glue = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${glue}codexpro_token=<redacted>`;
}

function currentTunnelMessage(tunnel: TunnelMode, endpoint: string): string {
  if (endpoint) {
    if (tunnel === "cloudflare") return "Cloudflare generated this URL for the current run. Quick tunnel URLs change after restart.";
    if (tunnel === "ngrok") return "ngrok is using the saved public hostname for this run.";
    if (tunnel === "cloudflare-named") return "Cloudflare named tunnel is using the saved public hostname for this run.";
    return "Local-only endpoint for clients that can reach this machine.";
  }
  if (tunnel === "cloudflare") return "Cloudflare quick tunnels print a generated URL after the tunnel opens.";
  if (tunnel === "ngrok") return "Enter your reserved ngrok domain, or set NGROK_DOMAIN before starting CodexPro.";
  if (tunnel === "cloudflare-named") return "Enter the Cloudflare hostname routed to your named tunnel.";
  return "No public tunnel is saved; local MCP clients can use the local URL.";
}

function profileForm(config: CodexProConfig): string {
  const profile = readWorkspaceProfile(config.defaultRoot);
  const values = profileValues(config, profile);
  const runtime = readRuntimeConnection(config.defaultRoot);
  const profilePath = profile.profilePath ?? profilePathForRoot(config.defaultRoot);
  const savedLabel = profile.profilePath ? "saved" : "not saved yet";
  const runtimeEndpoint = typeof runtime.endpoint === "string" ? runtime.endpoint : "";
  const runtimeTunnel = oneOf(runtime.tunnel ?? values.tunnel, TUNNELS, values.tunnel);
  const runtimeUrl = serverUrlDisplay(runtimeEndpoint, Boolean(config.authToken));
  const savedEndpoint = values.hostname ? `https://${values.hostname}/mcp` : "";
  const savedUrl = serverUrlDisplay(savedEndpoint, Boolean(config.authToken));
  const ngrokHostname = process.env.NGROK_DOMAIN ?? (values.tunnel === "ngrok" ? values.hostname : "");
  const cloudflareHostname =
    process.env.CODEXPRO_PUBLIC_HOSTNAME ??
    process.env.CODEXPRO_HOSTNAME ??
    (values.tunnel === "cloudflare-named" ? values.hostname : "");
  const currentUrlBlock = runtimeUrl
    ? `<div class="current-url">
        <div>
          <span>Current Server URL</span>
          <code>${escapeHtml(runtimeUrl)}</code>
          <p>${escapeHtml(currentTunnelMessage(runtimeTunnel, runtimeEndpoint))}</p>
        </div>
        <button type="button" class="copy-mini" data-copy-kind="server-url" data-copy-base="${escapeHtml(runtimeEndpoint)}">Copy</button>
      </div>`
    : `<div class="current-url idle">
        <div>
          <span>${savedUrl ? "Saved Server URL preview" : "Current Server URL"}</span>
          <code>${savedUrl ? escapeHtml(savedUrl) : "No public URL detected for this run"}</code>
          <p>${escapeHtml(savedUrl ? "This is based on the saved hostname. It becomes current after the launcher starts that tunnel." : currentTunnelMessage(values.tunnel, ""))}</p>
        </div>
        ${savedEndpoint ? `<button type="button" class="copy-mini" data-copy-kind="server-url" data-copy-base="${escapeHtml(savedEndpoint)}">Copy</button>` : ""}
      </div>`;
  return `<section class="panel profile-panel" id="profile">
      <div class="section-head">
        <div>
          <h2>Connection profile</h2>
          <p>Use this for the next start. Current tunnel URLs appear here when the launcher knows them.</p>
        </div>
        <span class="pill ${profile.profilePath ? "" : "warn"}">${escapeHtml(savedLabel)}</span>
      </div>
      <form class="profile-form" data-profile-form>
        ${currentUrlBlock}
        <fieldset class="profile-group">
          <legend>Connection</legend>
          <p>Choose how ChatGPT reaches this local MCP server. Stable providers use the saved hostname; quick Cloudflare generates the URL at launch.</p>
          <div class="form-grid">
            <label><span>Tunnel</span><select name="tunnel" data-tunnel-select data-ngrok-hostname="${escapeHtml(ngrokHostname)}" data-cloudflare-hostname="${escapeHtml(cloudflareHostname)}">${selectOptions(TUNNELS, values.tunnel)}</select></label>
            <label><span>Public hostname</span><input name="hostname" value="${escapeHtml(values.hostname)}" data-hostname-input data-autofilled="0"></label>
            <label><span>Port</span><input name="port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}"></label>
            <label><span>Mode</span><select name="mode">${selectOptions(MODES, values.mode)}</select></label>
            <label><span>Cloudflare tunnel name</span><input name="tunnelName" value="${escapeHtml(values.tunnelName)}"></label>
            <label><span>ngrok config file</span><input name="ngrokConfig" value="${escapeHtml(values.ngrokConfig)}"></label>
            <label><span>Cloudflare config file</span><input name="cloudflareConfig" value="${escapeHtml(values.cloudflareConfig)}"></label>
            <label><span>Cloudflare token file</span><input name="cloudflareTokenFile" value="${escapeHtml(values.cloudflareTokenFile)}"></label>
          </div>
          <p class="field-help" data-hostname-help>${escapeHtml(currentTunnelMessage(values.tunnel, runtimeEndpoint))}</p>
          <label class="check-row"><input name="noInstallCloudflared" type="checkbox" value="true"${values.noInstallCloudflared ? " checked" : ""}><span>Do not auto-install cloudflared</span></label>
        </fieldset>
        <fieldset class="profile-group">
          <legend>Runtime policy</legend>
          <p>Save the default access level for the next launch. These settings do not mutate the process that is already running.</p>
          <div class="form-grid">
            <label><span>Bash</span><select name="bash">${selectOptions(BASH_MODES, values.bash)}</select></label>
            <label><span>Write mode</span><select name="write">${selectOptions(WRITE_MODES, values.write)}</select></label>
            <label><span>Tool mode</span><select name="toolMode">${selectOptions(TOOL_MODES, values.toolMode)}</select></label>
            <label><span>Codex sessions</span><select name="codexSessions">${selectOptions(CODEX_SESSIONS, values.codexSessions)}</select></label>
            <label><span>Codex directory</span><input name="codexDir" value="${escapeHtml(values.codexDir)}"></label>
            <label><span>Bash session</span><input name="bashSession" value="${escapeHtml(values.bashSession)}"></label>
          </div>
          <label class="check-row"><input name="requireBashSession" type="checkbox" value="true"${values.requireBashSession ? " checked" : ""}><span>Require matching bash session id</span></label>
        </fieldset>
        <fieldset class="profile-group readonly-group">
          <legend>Read-only this run</legend>
          <div class="readonly-grid">
            <div><span>Bash transcript</span><code>${escapeHtml(values.bashTranscript)}</code></div>
            <div><span>Widget origin</span><code>${escapeHtml(values.widgetDomain)}</code></div>
          </div>
        </fieldset>
        <div class="actions">
          <button type="submit" class="primary">Save profile</button>
          <span class="mono">${escapeHtml(profilePath)}</span>
        </div>
        <p class="note" data-profile-status>Tokens stay hidden. Restart CodexPro for saved profile changes to apply.</p>
      </form>
    </section>`;
}

function buildProfilePayload(config: CodexProConfig, existing: WorkspaceProfile, input: AdminProfilePatch): WorkspaceProfile {
  const current = profileValues(config, existing);
  const next: ProfileFormValues = {
    ...current,
    ...input,
    port: input.port ? String(input.port) : current.port,
    requireBashSession: input.requireBashSession ?? current.requireBashSession,
    noInstallCloudflared: input.noInstallCloudflared ?? current.noInstallCloudflared
  };
  next.hostname = normalizePublicHostname(next.hostname);
  next.widgetDomain = normalizeWidgetDomain(next.widgetDomain);
  if ((next.tunnel === "ngrok" || next.tunnel === "cloudflare-named") && !next.hostname) {
    throw new Error("hostname is required for ngrok and cloudflare-named profiles.");
  }
  if (next.requireBashSession && !next.bashSession) {
    throw new Error("requireBashSession requires a bashSession value.");
  }

  const token = typeof existing.token === "string" && existing.token ? existing.token : config.authToken ?? "";
  const cloudflareToken = typeof existing.cloudflareToken === "string" && existing.cloudflareToken ? existing.cloudflareToken : "";
  const write = effectiveWriteMode(next.mode, next.write);
  const ngrokConfig = normalizeProfilePath(config.defaultRoot, next.ngrokConfig);
  const cloudflareConfig = normalizeProfilePath(config.defaultRoot, next.cloudflareConfig);
  const cloudflareTokenFile = normalizeProfilePath(config.defaultRoot, next.cloudflareTokenFile);
  return {
    port: next.port,
    mode: next.mode,
    tunnel: next.tunnel,
    ...(next.hostname ? { hostname: next.hostname } : {}),
    ...(next.tunnelName ? { tunnelName: next.tunnelName } : {}),
    ...(ngrokConfig ? { ngrokConfig } : {}),
    ...(cloudflareConfig ? { cloudflareConfig } : {}),
    ...(cloudflareTokenFile ? { cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(cloudflareToken ? { cloudflareToken } : {}),
    bash: next.bash,
    ...(next.bashTranscript !== "compact" ? { bashTranscript: next.bashTranscript } : {}),
    ...(next.codexSessions !== "off" ? { codexSessions: next.codexSessions } : {}),
    ...(next.codexDir ? { codexDir: next.codexDir } : {}),
    ...(next.bashSession ? { bashSession: next.bashSession } : {}),
    ...(next.requireBashSession ? { requireBashSession: true } : {}),
    write,
    toolMode: next.toolMode,
    ...(next.widgetDomain ? { widgetDomain: next.widgetDomain } : {}),
    ...(next.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  };
}

function profileResponse(config: CodexProConfig): Record<string, unknown> {
  const profile = readWorkspaceProfile(config.defaultRoot);
  const runtime = readRuntimeConnection(config.defaultRoot);
  return {
    ok: true,
    profile_path: profile.profilePath ?? profilePathForRoot(config.defaultRoot),
    exists: Boolean(profile.profilePath),
    profile: sanitizeWorkspaceProfile(profile),
    effective: profileValues(config, profile),
    runtime_connection: runtime,
    runtime: {
      defaultRoot: config.defaultRoot,
      port: config.port,
      bashMode: config.bashMode,
      bashTranscript: config.bashTranscript,
      codexSessions: config.codexSessions,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      widgetDomain: config.widgetDomain,
      authEnabled: Boolean(config.authToken)
    }
  };
}

function jsonError(res: Response, status: number, code: string, message: string, issues?: unknown): void {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(issues ? { issues } : {}) }
  });
}

const LOCAL_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#2563eb"/>
  <rect x="8" y="8" width="48" height="48" rx="12" fill="#ffffff" fill-opacity=".12" stroke="#ffffff" stroke-opacity=".38"/>
  <path d="M38.4 40.3c-1.8 1.1-3.9 1.7-6.3 1.7-6.1 0-10.3-4.2-10.3-10s4.2-10 10.4-10c2.4 0 4.5.6 6.2 1.7l-2.1 4.1c-1.1-.7-2.3-1-3.8-1-2.9 0-4.9 2.1-4.9 5.2s2 5.2 4.9 5.2c1.5 0 2.8-.4 3.9-1.1l2 4.2Z" fill="#ffffff"/>
</svg>`;

function onboardingPage(config: CodexProConfig): string {
  const localMcp = `http://${config.host}:${config.port}/mcp`;
  const localMcpDisplay = config.authToken ? `${localMcp}?codexpro_token=<redacted>` : localMcp;
  const allowedRoots = config.allowedRoots.map((root) => `<li>${escapeHtml(root)}</li>`).join("");
  const authLabel = config.authToken ? "Token protected" : "Disabled";
  const writeTone = config.writeMode === "workspace" ? "agent" : config.writeMode;
  const rootArg = shellQuote(config.defaultRoot);
  const sessionArg = shellQuote(config.bashSessionId || "main");
  const githubUrl = "https://github.com/rebel0789/codexpro";
  const npmUrl = "https://www.npmjs.com/package/codexpro";
  const docsUrl = "https://rebel0789.github.io/codexpro/";
  const chatgptUrl = "https://chatgpt.com/#settings/Connectors";
  const controls = [
    copyCommand("Re-run setup wizard", "Use the CLI for broader profile edits that are intentionally not exposed here.", "codexpro setup"),
    copyCommand("Copy local MCP URL", "Useful for a local MCP client. ChatGPT usually needs the public tunnel URL copied by the terminal.", localMcp, localMcpDisplay, "local-mcp"),
    copyCommand("Start without bash", "Restart with file tools but no ChatGPT-triggered bash tool.", `codexpro start --root ${rootArg} --no-bash`),
    copyCommand("Require explicit bash target", "Restart so bash calls must include this matching session_id.", `codexpro start --root ${rootArg} --bash-session ${sessionArg} --require-bash-session`),
    copyCommand("Show Codex session list", "Restart with read-only local Codex session metadata in full tool mode.", `codexpro start --root ${rootArg} --tool-mode full --codex-sessions metadata`),
    copyCommand("Read Codex transcripts", "Restart with bounded local transcript reads from Codex JSONL history.", `codexpro start --root ${rootArg} --tool-mode full --codex-sessions read`),
    copyCommand("Use full bash transcript", "Restart with the raw stdout/stderr transcript instead of compact tool cards.", `codexpro start --root ${rootArg} --bash-transcript full`)
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.ico">
  <title>CodexPro Local Control - ChatGPT Workspace Agent</title>
  <style>
    /* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
    /* Hallmark · macrostructure: Workbench · genre: modern-minimal · theme: CC Switch-inspired light manager · tone: technical admin · nav: section switcher · footer: Ft2 · contrast: pass (40-41) · mobile: pass (34, 49, 50-57) */
    :root {
      color-scheme: light;
      --font-display: "Geist", "Aptos", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-body: "Geist", "Aptos", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "Fira Code", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --color-paper: oklch(98.5% 0.004 250);
      --color-surface: oklch(100% 0 0);
      --color-panel: oklch(100% 0 0);
      --color-panel-2: oklch(96.5% 0.008 252);
      --color-row: oklch(99.2% 0.004 250);
      --color-rule: oklch(88% 0.012 250);
      --color-rule-strong: oklch(78% 0.018 250);
      --color-ink: oklch(23% 0.026 255);
      --color-soft: oklch(39% 0.026 255);
      --color-muted: oklch(53% 0.022 255);
      --color-subtle: oklch(64% 0.018 255);
      --color-accent: oklch(58% 0.19 256);
      --color-accent-strong: oklch(50% 0.22 256);
      --color-accent-ink: oklch(99% 0.004 250);
      --color-action: var(--color-accent);
      --color-action-strong: var(--color-accent-strong);
      --color-good: oklch(56% 0.14 154);
      --color-warn: oklch(54% 0.17 256);
      --color-focus: oklch(61% 0.2 256);
      --surface-accent: oklch(95% 0.036 256);
      --surface-good: oklch(94.5% 0.035 154);
      --surface-warn: oklch(95% 0.036 256);
      --surface-hover: oklch(93.5% 0.025 256);
      --shadow-panel: 0 18px 50px oklch(24% 0.03 255 / 0.10);
      --shadow-row: 0 8px 18px oklch(24% 0.03 255 / 0.06);
      --space-1: 0.25rem;
      --space-2: 0.5rem;
      --space-3: 0.75rem;
      --space-4: 1rem;
      --space-5: 1.25rem;
      --space-6: 1.5rem;
      --space-7: 2rem;
      --space-8: 2.5rem;
      --space-9: 3rem;
      --radius-1: 6px;
      --radius-2: 8px;
      --dur-micro: 120ms;
      --dur-short: 180ms;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
    }
    * { box-sizing: border-box; }
    html,
    body {
      overflow-x: clip;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--color-paper);
      color: var(--color-ink);
      font: 14px/1.55 var(--font-body);
      letter-spacing: 0;
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    button,
    input,
    select {
      font: inherit;
    }
    main {
      width: min(1240px, calc(100% - (var(--space-4) * 2)));
      margin: 0 auto;
      padding: var(--space-5) 0 var(--space-8);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-bottom: var(--space-3);
      padding: var(--space-2) 0 var(--space-3);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
    }
    .logo {
      display: inline-grid;
      place-items: center;
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border: 1px solid var(--color-accent);
      border-radius: 12px;
      background: var(--color-accent);
      color: var(--color-accent-ink);
      box-shadow: var(--shadow-row);
      font: 900 15px/1 var(--font-mono);
    }
    .logo img {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: inherit;
    }
    .brand-kicker {
      display: block;
      color: var(--color-muted);
      font-size: 12px;
      font-weight: 800;
      line-height: 1.1;
      text-transform: uppercase;
    }
    .brand-title {
      display: block;
      overflow-wrap: anywhere;
      color: var(--color-accent);
      font: 900 28px/1 var(--font-display);
    }
    .quick-links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .resource-link,
    .action-link,
    .copy-mini,
    .primary {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-2);
      white-space: nowrap;
      transition: background-color var(--dur-short) var(--ease-out),
        border-color var(--dur-short) var(--ease-out),
        color var(--dur-short) var(--ease-out),
        transform var(--dur-micro) var(--ease-out);
    }
    .resource-link,
    .action-link {
      border: 1px solid var(--color-rule);
      background: var(--color-surface);
      color: var(--color-soft);
      font-size: 12px;
      font-weight: 800;
      padding: 0 var(--space-3);
      box-shadow: var(--shadow-row);
    }
    .action-link.primary-link {
      border-color: var(--color-action);
      background: var(--color-action);
      color: var(--color-accent-ink);
    }
    .section-tabs {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-1);
      flex-wrap: wrap;
      margin: 0 0 var(--space-5);
      padding: var(--space-1);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-surface);
      box-shadow: var(--shadow-panel);
    }
    .section-tabs a {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
      color: var(--color-muted);
      font-size: 13px;
      font-weight: 900;
      white-space: nowrap;
      padding: 0 var(--space-4);
    }
    .section-tabs a[aria-current="page"] {
      background: var(--color-accent);
      color: var(--color-accent-ink);
      box-shadow: var(--shadow-row);
    }
    .overview {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(330px, 0.52fr);
      gap: var(--space-5);
      align-items: start;
      margin-bottom: var(--space-5);
    }
    .intro-stack {
      display: grid;
      gap: var(--space-5);
      min-width: 0;
    }
    .intro {
      min-width: 0;
      padding: var(--space-6);
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-surface);
      box-shadow: var(--shadow-panel);
    }
    h1 {
      margin: 0;
      max-width: 18ch;
      font: 900 2rem/1.05 var(--font-display);
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .lead {
      max-width: 64ch;
      margin: var(--space-4) 0 0;
      color: var(--color-soft);
      font-size: 15px;
    }
    .scope-note {
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-rule);
      color: var(--color-muted);
      font-size: 13px;
    }
    .run-card,
    .panel {
      min-width: 0;
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-panel);
      box-shadow: var(--shadow-panel);
    }
    .run-card,
    .panel {
      padding: var(--space-5);
    }
    .run-card h2,
    .panel h2 {
      margin: 0;
      color: var(--color-ink);
      font: 700 16px/1.25 var(--font-display);
      letter-spacing: 0;
    }
    .workspace-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(310px, 0.58fr);
      gap: var(--space-5);
      align-items: start;
    }
    .side-stack {
      display: grid;
      gap: var(--space-5);
    }
    .section-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: var(--space-4);
      margin-bottom: var(--space-4);
    }
    .section-head p,
    .panel > p {
      margin: var(--space-1) 0 0;
      color: var(--color-muted);
      font-size: 13px;
    }
    .status {
      display: grid;
    }
    .row {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr);
      gap: var(--space-3);
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--color-rule);
    }
    .row:last-child { border-bottom: 0; }
    .label {
      color: var(--color-subtle);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    code,
    .mono {
      font-family: var(--font-mono);
      color: var(--color-soft);
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .pill {
      display: inline-flex;
      width: fit-content;
      align-items: center;
      min-height: 26px;
      padding: 0 var(--space-2);
      border: 1px solid var(--color-good);
      border-radius: 999px;
      background: var(--surface-good);
      color: var(--color-good);
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
      white-space: nowrap;
    }
    .warn {
      border-color: var(--color-warn);
      background: var(--surface-warn);
      color: var(--color-warn);
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .control {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-3);
      align-items: center;
      min-width: 0;
      min-height: 112px;
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-row);
      box-shadow: var(--shadow-row);
    }
    .control strong {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--color-ink);
      font-size: 13px;
    }
    .control p {
      margin: 0 0 var(--space-2);
      color: var(--color-muted);
      font-size: 12px;
    }
    .control code {
      display: block;
      padding: var(--space-2);
      border: 1px solid var(--color-rule);
      border-radius: 10px;
      background: var(--color-panel-2);
      line-height: 1.45;
    }
    .steps {
      display: grid;
      gap: var(--space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .guide-list {
      display: grid;
      gap: var(--space-3);
    }
    .guide-item {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-row);
    }
    .guide-item strong {
      display: block;
      color: var(--color-ink);
      font-size: 13px;
    }
    .guide-item p {
      margin: var(--space-1) 0 0;
      color: var(--color-muted);
      font-size: 12px;
    }
    .steps li {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: var(--space-3);
      align-items: start;
      color: var(--color-soft);
    }
    .num {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border: 1px solid var(--color-accent);
      border-radius: 999px;
      background: var(--color-accent);
      color: var(--color-accent-ink);
      font: 800 11px/1 var(--font-mono);
    }
    .roots {
      margin: var(--space-3) 0 0;
      padding-left: var(--space-5);
      color: var(--color-muted);
    }
    .profile-form {
      display: grid;
      gap: var(--space-4);
    }
    .current-url {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-3);
      align-items: center;
      min-width: 0;
      padding: var(--space-4);
      border: 1px solid var(--color-accent);
      border-radius: 18px;
      background: var(--surface-accent);
    }
    .current-url.idle {
      border-color: var(--color-rule);
      background: var(--color-row);
    }
    .current-url span,
    .readonly-grid span {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--color-muted);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .current-url code {
      display: block;
      color: var(--color-ink);
      font-size: 12px;
      line-height: 1.45;
    }
    .current-url p {
      margin: var(--space-2) 0 0;
      color: var(--color-soft);
      font-size: 12px;
    }
    .profile-group {
      min-width: 0;
      margin: 0;
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-row);
      box-shadow: var(--shadow-row);
    }
    .profile-group legend {
      padding: 0 var(--space-2);
      color: var(--color-ink);
      font: 900 13px/1 var(--font-display);
    }
    .profile-group p {
      margin: 0 0 var(--space-3);
      color: var(--color-muted);
      font-size: 12px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .profile-form label {
      display: grid;
      gap: var(--space-2);
      color: var(--color-soft);
      font-size: 12px;
      font-weight: 800;
    }
    .profile-form label span {
      color: var(--color-muted);
      text-transform: uppercase;
    }
    .profile-form input,
    .profile-form select {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      outline: 2px solid transparent;
      outline-offset: 1px;
      background: var(--color-surface);
      color: var(--color-ink);
      font: 13px/1.25 var(--font-body);
      padding: 0 var(--space-3);
    }
    .field-help {
      min-height: 1lh;
      margin: var(--space-3) 0 0 !important;
      color: var(--color-soft) !important;
      font-size: 12px !important;
    }
    .check-row {
      width: fit-content;
      display: inline-flex !important;
      grid-template-columns: none !important;
      align-items: center;
      gap: var(--space-2) !important;
      margin-top: var(--space-3);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 999px;
      background: var(--color-surface);
      color: var(--color-soft);
    }
    .check-row input {
      width: 18px;
      min-height: 18px;
      height: 18px;
      padding: 0;
      accent-color: var(--color-accent);
    }
    .check-row span {
      color: var(--color-soft) !important;
      text-transform: none !important;
    }
    .readonly-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .readonly-grid > div {
      min-width: 0;
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-surface);
    }
    .readonly-grid code {
      display: block;
      font-size: 12px;
      line-height: 1.45;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
      flex-wrap: wrap;
    }
    .primary {
      border: 1px solid var(--color-accent);
      background: var(--color-accent);
      color: var(--color-accent-ink);
      cursor: pointer;
      font: 800 13px/1 var(--font-body);
      padding: 0 var(--space-4);
      box-shadow: var(--shadow-row);
    }
    .copy-mini {
      border: 1px solid var(--color-action);
      background: var(--color-action);
      color: var(--color-accent-ink);
      cursor: pointer;
      font: 800 12px/1 var(--font-body);
      padding: 0 var(--space-3);
    }
    .note {
      min-height: 1lh;
      margin: var(--space-1) 0 0;
      color: var(--color-subtle);
      font-size: 12px;
    }
    .scope-list {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-3) 0 0;
      padding: 0;
      list-style: none;
    }
    .scope-list li {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: var(--space-3);
      padding-block: var(--space-2);
      border-bottom: 1px solid var(--color-rule);
      color: var(--color-muted);
    }
    .scope-list li:last-child {
      border-bottom: 0;
    }
    .scope-list strong {
      color: var(--color-soft);
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .details-panel {
      margin-top: var(--space-5);
    }
    details summary {
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      cursor: pointer;
      color: var(--color-ink);
      font: 800 14px/1 var(--font-body);
      list-style: none;
    }
    details summary::-webkit-details-marker {
      display: none;
    }
    details summary::after {
      content: "+";
      color: var(--color-accent);
      font: 800 18px/1 var(--font-mono);
    }
    details[open] summary {
      margin-bottom: var(--space-4);
    }
    details[open] summary::after {
      content: "-";
    }
    .foot {
      margin-top: var(--space-6);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-rule);
      color: var(--color-subtle);
      font-size: 12px;
    }
    :focus {
      outline: none;
    }
    :focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
    .profile-form input:focus-visible,
    .profile-form select:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 1px;
    }
    .resource-link:active,
    .action-link:active,
    .copy-mini:active,
    .primary:active {
      transform: translateY(1px);
    }
    .resource-link[aria-disabled="true"],
    .action-link[aria-disabled="true"],
    .copy-mini:disabled,
    .primary:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    @media (hover: hover) and (pointer: fine) {
      .resource-link:hover,
      .action-link:hover,
      .copy-mini:hover,
      .primary:hover {
        border-color: var(--color-accent);
        background: var(--surface-hover);
        color: var(--color-accent-strong);
        transform: translateY(-1px);
      }
      .action-link.primary-link:hover,
      .copy-mini:hover,
      .primary:hover {
        border-color: var(--color-action-strong);
        background: var(--color-action-strong);
        color: var(--color-accent-ink);
      }
      .section-tabs a:hover {
        background: var(--surface-hover);
        color: var(--color-accent-strong);
      }
      .profile-form input:hover,
      .profile-form select:hover {
        border-color: var(--color-rule-strong);
        background: var(--color-panel-2);
      }
    }
    @media (min-width: 52rem) {
      h1 {
        font-size: 2.45rem;
      }
    }
    @media (max-width: 58rem) {
      .overview,
      .workspace-grid {
        grid-template-columns: 1fr;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .quick-links {
        justify-content: flex-start;
      }
      .section-tabs {
        justify-content: flex-start;
      }
    }
    @media (max-width: 42rem) {
      main {
        width: min(100% - (var(--space-3) * 2), 1180px);
        padding-block: var(--space-4) var(--space-7);
      }
      .intro,
      .run-card,
      .panel {
        padding: var(--space-4);
      }
      .section-head {
        align-items: start;
        flex-direction: column;
      }
      h1 {
        font-size: 1.85rem;
      }
      .row,
      .scope-list li {
        grid-template-columns: 1fr;
        gap: var(--space-1);
      }
      .controls,
      .form-grid {
        grid-template-columns: 1fr;
      }
      .control {
        grid-template-columns: 1fr;
      }
      .current-url,
      .readonly-grid {
        grid-template-columns: 1fr;
      }
      .actions {
        align-items: stretch;
        flex-direction: column;
      }
      .primary {
        width: 100%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 150ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 150ms !important;
      }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div class="brand">
        <span class="logo" aria-hidden="true"><img src="/favicon.ico" alt=""></span>
        <span>
          <span class="brand-kicker">Workspace control</span>
          <span class="brand-title">CodexPro</span>
        </span>
      </div>
      <nav class="quick-links" aria-label="CodexPro resources">
        <a class="action-link primary-link" href="${chatgptUrl}" target="_blank" rel="noreferrer">Open ChatGPT settings</a>
        <a class="resource-link" href="${githubUrl}" target="_blank" rel="noreferrer">Open GitHub</a>
        <a class="resource-link" href="${npmUrl}" target="_blank" rel="noreferrer">NPM</a>
        <a class="resource-link" href="${docsUrl}" target="_blank" rel="noreferrer">Docs</a>
      </nav>
    </header>
    <nav class="section-tabs" aria-label="Admin sections">
      <a href="#profile" aria-current="page">Profile</a>
      <a href="#status">Status</a>
      <a href="#connect">ChatGPT</a>
      <a href="#access">Access</a>
      <a href="#cli">CLI</a>
    </nav>
    <section class="overview">
      ${profileForm(config)}
      <aside class="side-stack">
        <section class="panel guide-panel" id="guide">
          <div class="section-head">
            <div>
              <h2>Quick path</h2>
              <p>Use ChatGPT like a coding agent for this workspace without widening the local trust boundary.</p>
            </div>
          </div>
          <div class="guide-list">
            <div class="guide-item"><span class="num">1</span><span><strong>Review the profile</strong><p>Choose the tunnel, port, mode, bash, write, tool, Codex session, and workspace defaults for the next launch.</p></span></div>
            <div class="guide-item"><span class="num">2</span><span><strong>Copy the Server URL</strong><p>Use the current public URL shown in the profile when available, or the one printed by the terminal after launch.</p></span></div>
            <div class="guide-item"><span class="num">3</span><span><strong>Create the ChatGPT app</strong><p>Choose Server URL, paste the copied URL, and use no extra authentication. The private token is already in the URL.</p></span></div>
            <div class="guide-item"><span class="num">4</span><span><strong>Restart for policy changes</strong><p>Saved profile changes apply when CodexPro starts again. The live server does not mutate under an active ChatGPT session.</p></span></div>
          </div>
        </section>
        <article class="run-card" id="status" aria-label="Current runtime">
          <h2>Runtime guardrails</h2>
          <div class="status">
            <div class="row"><span class="label">Workspace</span><span class="mono">${escapeHtml(config.defaultRoot)}</span></div>
            <div class="row"><span class="label">Local MCP</span><span class="mono">${escapeHtml(localMcp)}</span></div>
            <div class="row"><span class="label">Write mode</span><span class="pill ${config.writeMode === "workspace" ? "" : "warn"}">${escapeHtml(writeTone)}</span></div>
            <div class="row"><span class="label">Tool mode</span><span class="pill ${config.toolMode === "standard" ? "" : "warn"}">${escapeHtml(config.toolMode)}</span></div>
            <div class="row"><span class="label">Bash mode</span><span class="pill ${config.bashMode === "safe" ? "" : "warn"}">${escapeHtml(config.bashMode)}</span></div>
            <div class="row"><span class="label">Transcript</span><span class="pill ${config.bashTranscript === "compact" ? "" : "warn"}">${escapeHtml(config.bashTranscript)}</span></div>
            <div class="row"><span class="label">Bash session</span><span class="pill ${config.requireBashSession ? "warn" : ""}">${escapeHtml(config.bashSessionId ? `${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : "not set")}</span></div>
            <div class="row"><span class="label">Codex sessions</span><span class="pill ${config.codexSessions === "off" ? "" : "warn"}">${escapeHtml(config.codexSessions)}</span></div>
            <div class="row"><span class="label">Widget domain</span><span class="mono">${escapeHtml(config.widgetDomain)}</span></div>
            <div class="row"><span class="label">Auth</span><span class="pill">${escapeHtml(authLabel)}</span></div>
          </div>
        </article>
      </aside>
    </section>
    <section class="workspace-grid">
      <section class="panel" id="connect">
        <div class="section-head">
          <div>
          <h2>Connect ChatGPT</h2>
            <p>Create an app connection that points at the public Server URL copied by the terminal.</p>
          </div>
        </div>
        <ol class="steps">
          <li><span class="num">1</span><span>Open ChatGPT settings and create an app connection.</span></li>
          <li><span class="num">2</span><span>Set Connection to <code>Server URL</code>.</span></li>
          <li><span class="num">3</span><span>Paste the public CodexPro URL from the terminal.</span></li>
          <li><span class="num">4</span><span>Use <code>No Authentication / None</code>; the private token is already in the copied URL.</span></li>
        </ol>
        <p class="note"><a class="action-link" href="${chatgptUrl}" target="_blank" rel="noreferrer">Open ChatGPT settings</a></p>
      </section>
      <aside class="side-stack">
        <section class="panel" id="access">
          <h2>Admin boundary</h2>
          <ul class="scope-list">
            <li><strong>/setup</strong><span>this setup and settings page</span></li>
            <li><strong>/admin/profile</strong><span>saved workspace profile API</span></li>
            <li><strong>/healthz</strong><span>authenticated status check</span></li>
            <li><strong>/mcp</strong><span>MCP endpoint for ChatGPT and local clients</span></li>
          </ul>
        </section>
      </aside>
    </section>
    <section class="panel cli-panel details-panel" id="cli">
      <div class="section-head">
        <div>
          <h2>CLI controls</h2>
          <p>Copy these when you need to restart with a different runtime policy. They do not mutate the running process from the browser.</p>
        </div>
      </div>
      <div class="controls">${controls}</div>
    </section>
    <details class="panel details-panel">
      <summary>Allowed roots</summary>
      <ul class="roots">${allowedRoots}</ul>
      <p class="note">CodexPro rejects workspace access outside these roots.</p>
    </details>
    <footer class="foot">Token-protected local control surface for this workspace. Public sharing still happens only through your chosen tunnel.</footer>
  </main>
  <script>
    document.querySelectorAll("[data-copy], [data-copy-kind]").forEach((button) => {
      button.addEventListener("click", async () => {
        let value = button.getAttribute("data-copy") || "";
        if (button.getAttribute("data-copy-kind") === "local-mcp") {
          const base = button.getAttribute("data-copy-base") || value;
          const params = new URLSearchParams(window.location.search);
          const token = params.get("codexpro_token") || params.get("token") || "";
          value = token ? base + "?codexpro_token=" + encodeURIComponent(token) : base;
        } else if (button.getAttribute("data-copy-kind") === "server-url") {
          const base = button.getAttribute("data-copy-base") || value;
          const params = new URLSearchParams(window.location.search);
          const token = params.get("codexpro_token") || params.get("token") || "";
          value = token ? base + "?codexpro_token=" + encodeURIComponent(token) : base;
        }
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = "Copy"; }, 1400);
        } catch {
          button.textContent = "Select";
        }
      });
    });
    const profileForm = document.querySelector("[data-profile-form]");
    const tunnelSelect = document.querySelector("[data-tunnel-select]");
    const hostnameInput = document.querySelector("[data-hostname-input]");
    const hostnameHelp = document.querySelector("[data-hostname-help]");
    const tokenEnabled = ${config.authToken ? "true" : "false"};
    function serverPreviewFor(hostname) {
      const clean = String(hostname || "").trim().replace(/^https?:\\/\\//, "").replace(/\\/mcp\\/?$/, "").replace(/\\/+$/, "");
      if (!clean) return "";
      return "https://" + clean + "/mcp" + (tokenEnabled ? "?codexpro_token=<redacted>" : "");
    }
    function updateTunnelHelp() {
      if (!tunnelSelect || !hostnameInput || !hostnameHelp) return;
      const tunnel = tunnelSelect.value;
      const ngrokHost = tunnelSelect.getAttribute("data-ngrok-hostname") || "";
      const cloudflareHost = tunnelSelect.getAttribute("data-cloudflare-hostname") || "";
      if (tunnel === "ngrok" && !hostnameInput.value && ngrokHost) {
        hostnameInput.value = ngrokHost;
        hostnameInput.setAttribute("data-autofilled", "1");
      }
      if (tunnel === "cloudflare-named" && !hostnameInput.value && cloudflareHost) {
        hostnameInput.value = cloudflareHost;
        hostnameInput.setAttribute("data-autofilled", "1");
      }
      if ((tunnel === "cloudflare" || tunnel === "none") && hostnameInput.getAttribute("data-autofilled") === "1") {
        hostnameInput.value = "";
        hostnameInput.setAttribute("data-autofilled", "0");
      }
      const preview = serverPreviewFor(hostnameInput.value);
      if (tunnel === "cloudflare") {
        hostnameHelp.textContent = "Cloudflare quick tunnel generates the public URL at launch and this page shows it when the launcher reports it.";
      } else if (tunnel === "ngrok") {
        hostnameHelp.textContent = preview ? "Next Server URL preview: " + preview : "Enter the reserved ngrok domain from your local ngrok setup.";
      } else if (tunnel === "cloudflare-named") {
        hostnameHelp.textContent = preview ? "Next Server URL preview: " + preview : "Enter the hostname routed to your Cloudflare named tunnel.";
      } else {
        hostnameHelp.textContent = "Local-only mode does not expose a public ChatGPT Server URL.";
      }
    }
    tunnelSelect?.addEventListener("change", updateTunnelHelp);
    hostnameInput?.addEventListener("input", () => {
      hostnameInput.setAttribute("data-autofilled", "0");
      updateTunnelHelp();
    });
    updateTunnelHelp();
    if (profileForm) {
      profileForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const status = document.querySelector("[data-profile-status]");
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
          tunnel: data.tunnel,
          hostname: data.hostname,
          tunnelName: data.tunnelName,
          ngrokConfig: data.ngrokConfig,
          cloudflareConfig: data.cloudflareConfig,
          cloudflareTokenFile: data.cloudflareTokenFile,
          port: Number(data.port),
          mode: data.mode,
          bash: data.bash,
          write: data.write,
          toolMode: data.toolMode,
          codexSessions: data.codexSessions,
          codexDir: data.codexDir,
          bashSession: data.bashSession,
          requireBashSession: Boolean(form.elements.requireBashSession?.checked),
          noInstallCloudflared: Boolean(form.elements.noInstallCloudflared?.checked)
        };
        if (status) status.textContent = "Saving...";
        try {
          const response = await fetch("/admin/profile" + window.location.search, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error?.message || "Save failed");
          if (status) status.textContent = "Saved. Restart CodexPro for these profile settings to apply.";
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : "Save failed";
        }
      });
    }
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.requireHttpToken && !config.authToken) {
    throw new Error(
      "CODEXPRO_HTTP_TOKEN is required for this HTTP binding. " +
        "Set CODEXPRO_HTTP_TOKEN, use `codexpro start` to generate one, " +
        "or set CODEXPRO_ALLOW_NO_HTTP_TOKEN=1 only for a trusted local-only setup."
    );
  }

  const app = express();
  const logRequests = process.env.CODEXPRO_LOG_REQUESTS === "1";

  function tokenMatches(value: unknown): boolean {
    if (!config.authToken || typeof value !== "string") return false;
    const expected = Buffer.from(config.authToken);
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  const adminRateWindow = new Map<string, { count: number; resetAt: number }>();

  function adminRateLimit(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "local";
    const current = adminRateWindow.get(key);
    if (!current || current.resetAt <= now) {
      adminRateWindow.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    current.count += 1;
    if (current.count > 30) {
      jsonError(res, 429, "rate_limited", "Too many profile save attempts. Try again in a minute.");
      return;
    }
    next();
  }

  function adminBodyLimit(req: Request, res: Response, next: NextFunction): void {
    const length = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > 32_768) {
      jsonError(res, 413, "payload_too_large", "Profile request body is too large.");
      return;
    }
    next();
  }

  app.use((req, res, next) => {
    if (!logRequests) {
      next();
      return;
    }
    const started = Date.now();
    res.on("finish", () => {
      console.error(`[CodexPro] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));
  app.get("/favicon.ico", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/svg+xml").send(LOCAL_FAVICON);
  });
  app.use((req, res, next) => {
    if (!config.authToken) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const queryToken = typeof req.query.codexpro_token === "string"
      ? req.query.codexpro_token
      : typeof req.query.token === "string"
        ? req.query.token
        : undefined;
    if (!tokenMatches(bearer) && !tokenMatches(queryToken)) {
      res.status(401).send("Unauthorized");
      return;
    }
    next();
  });

  type TransportRecord = {
    transport: StreamableHTTPServerTransport;
    createdAt: number;
    lastSeenAt: number;
  };

  const transports = new Map<string, TransportRecord>();
  const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function closeTransport(record: TransportRecord): void {
    void record.transport.close?.();
  }

  function pruneTransports(): void {
    const now = Date.now();
    for (const [sessionId, record] of transports) {
      if (now - record.lastSeenAt > config.httpSessionTtlMs) {
        transports.delete(sessionId);
        closeTransport(record);
      }
    }
    while (transports.size > config.maxHttpSessions) {
      const oldest = [...transports.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!oldest) break;
      transports.delete(oldest[0]);
      closeTransport(oldest[1]);
    }
  }

  function getTransport(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
    if (!sessionId || !sessionIdPattern.test(sessionId)) return undefined;
    pruneTransports();
    const record = transports.get(sessionId);
    if (!record) return undefined;
    record.lastSeenAt = Date.now();
    return record.transport;
  }

  const pruneTimer = setInterval(pruneTransports, Math.min(config.httpSessionTtlMs, 60_000));
  pruneTimer.unref();

  app.get("/", (_req, res) => {
    res.type("html").send(onboardingPage(config));
  });

  app.get("/setup", (_req, res) => {
    res.type("html").send(onboardingPage(config));
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: "CodexPro",
      defaultRoot: config.defaultRoot,
      allowedRoots: config.allowedRoots,
      bashMode: config.bashMode,
      bashTranscript: config.bashTranscript,
      bashSessionId: config.bashSessionId ?? null,
      requireBashSession: config.requireBashSession,
      codexSessions: config.codexSessions,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      widgetDomain: config.widgetDomain,
      contextDir: config.contextDir,
      authEnabled: Boolean(config.authToken),
      authRequired: config.requireHttpToken
    });
  });

  app.get("/admin/profile", (_req, res) => {
    res.json(profileResponse(config));
  });

  app.post("/admin/profile", adminRateLimit, adminBodyLimit, express.json({ limit: "32kb" }), (req, res) => {
    const parsed = AdminProfilePatch.safeParse(req.body ?? {});
    if (!parsed.success) {
      jsonError(res, 400, "invalid_profile", "Invalid profile settings.", parsed.error.flatten());
      return;
    }
    try {
      const existing = readWorkspaceProfile(config.defaultRoot);
      const payload = buildProfilePayload(config, existing, parsed.data);
      const profilePath = saveWorkspaceProfile(config.defaultRoot, payload);
      res.json({
        ...profileResponse(config),
        saved: true,
        profile_path: profilePath,
        message: "Saved. Restart CodexPro for these profile settings to apply."
      });
    } catch (error) {
      jsonError(res, 400, "invalid_profile", error instanceof Error ? error.message : String(error));
    }
  });

  app.all("/admin/profile", (_req, res) => {
    jsonError(res, 405, "method_not_allowed", "Use GET or POST for /admin/profile.");
  });

  app.post("/mcp", express.json({ limit: "20mb" }), async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      const existingTransport = getTransport(sessionId);
      if (existingTransport) {
        transport = existingTransport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            pruneTransports();
            transports.set(newSessionId, {
              transport,
              createdAt: Date.now(),
              lastSeenAt: Date.now()
            });
            pruneTransports();
          }
        } as any);

        (transport as any).onclose = () => {
          const closedSessionId = (transport as any).sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createCodexProServer(config);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing or invalid MCP session id" },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal CodexPro MCP error. Check the local terminal for details." },
          id: null
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = getTransport(sessionId);
    if (!transport) {
      res.status(400).send("Invalid or missing MCP session id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  app.listen(config.port, config.host, () => {
    console.error(`[CodexPro] HTTP MCP listening on http://${config.host}:${config.port}/mcp`);
    console.error(`[CodexPro] defaultRoot=${config.defaultRoot}`);
    console.error(`[CodexPro] allowedRoots=${config.allowedRoots.join(", ")}`);
    console.error(`[CodexPro] bashMode=${config.bashMode}`);
    console.error(`[CodexPro] writeMode=${config.writeMode}`);
    console.error(`[CodexPro] widgetDomain=${config.widgetDomain}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
