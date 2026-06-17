#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type CodexProConfig } from "./config.js";
import { createCodexProServer } from "./server.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function onboardingPage(config: CodexProConfig): string {
  const localMcp = `http://${config.host}:${config.port}/mcp`;
  const allowedRoots = config.allowedRoots.map((root) => `<li>${escapeHtml(root)}</li>`).join("");
  const authLabel = config.authToken ? "Token protected" : "Disabled";
  const writeTone = config.writeMode === "workspace" ? "agent" : config.writeMode;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CodexPro Local Setup</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07090d;
      --panel: #10141b;
      --panel-2: #151a23;
      --line: rgba(148, 163, 184, 0.18);
      --line-strong: rgba(148, 163, 184, 0.3);
      --text: #f4f7fb;
      --soft: #cbd5e1;
      --muted: #8a96a8;
      --quiet: #667085;
      --blue: #7dd3fc;
      --teal: #5eead4;
      --green: #86efac;
      --amber: #fde68a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% 0, rgba(94, 234, 212, 0.14), transparent 28rem),
        radial-gradient(circle at 100% 10%, rgba(125, 211, 252, 0.1), transparent 26rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(960px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 48px 0;
    }
    .hero {
      display: grid;
      gap: 18px;
      margin-bottom: 18px;
      padding: 26px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.018)), var(--panel);
      box-shadow: 0 24px 60px rgba(0,0,0,0.34);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .logo {
      display: inline-grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border: 1px solid rgba(125, 211, 252, 0.3);
      border-radius: 9px;
      color: var(--blue);
      background: rgba(125, 211, 252, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    h1 {
      margin: 0;
      max-width: 760px;
      font-size: clamp(32px, 6vw, 56px);
      line-height: 0.98;
      letter-spacing: 0;
    }
    .lead {
      max-width: 700px;
      margin: 0;
      color: var(--soft);
      font-size: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 18px;
    }
    .card {
      min-width: 0;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(16, 20, 27, 0.82);
    }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .steps {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .steps li {
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      color: var(--soft);
    }
    .num {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--teal);
      font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .status {
      display: grid;
      gap: 8px;
    }
    .row {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }
    .row:last-child { border-bottom: 0; }
    .label {
      color: var(--quiet);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    code, .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: var(--soft);
      overflow-wrap: anywhere;
    }
    .pill {
      display: inline-flex;
      width: fit-content;
      padding: 3px 8px;
      border: 1px solid rgba(134, 239, 172, 0.28);
      border-radius: 999px;
      color: var(--green);
      background: rgba(134, 239, 172, 0.08);
      font-size: 12px;
      font-weight: 800;
    }
    .warn {
      border-color: rgba(253, 230, 138, 0.28);
      color: var(--amber);
      background: rgba(253, 230, 138, 0.08);
    }
    .roots {
      margin: 8px 0 0;
      padding-left: 18px;
      color: var(--muted);
    }
    .footer {
      margin-top: 14px;
      color: var(--quiet);
      font-size: 12px;
    }
    @media (max-width: 760px) {
      main { padding: 24px 0; }
      .grid { grid-template-columns: 1fr; }
      .hero { padding: 20px; }
      .row { grid-template-columns: 1fr; gap: 2px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="brand"><span class="logo">C</span><span>CodexPro local bridge</span></div>
      <h1>Local server is ready.</h1>
      <p class="lead">Use the Server URL copied by the terminal in ChatGPT Developer Mode. Keep the terminal running while ChatGPT edits, searches, or runs commands in this workspace.</p>
    </section>
    <section class="grid">
      <article class="card">
        <h2>ChatGPT setup</h2>
        <ol class="steps">
          <li><span class="num">1</span><span>Open ChatGPT settings, Apps, then Create app.</span></li>
          <li><span class="num">2</span><span>Set Connection to <code>Server URL</code>.</span></li>
          <li><span class="num">3</span><span>Paste the copied CodexPro URL into the Server URL field.</span></li>
          <li><span class="num">4</span><span>Use <code>No Authentication / None</code>. The private token is already inside the copied URL.</span></li>
          <li><span class="num">5</span><span>Start with: <code>Use CodexPro as a coding agent. Call server_config, then open_current_workspace.</code></span></li>
        </ol>
      </article>
      <article class="card">
        <h2>Current session</h2>
        <div class="status">
          <div class="row"><span class="label">Workspace</span><span class="mono">${escapeHtml(config.defaultRoot)}</span></div>
          <div class="row"><span class="label">Local MCP</span><span class="mono">${escapeHtml(localMcp)}</span></div>
          <div class="row"><span class="label">Write mode</span><span class="pill ${config.writeMode === "workspace" ? "" : "warn"}">${escapeHtml(writeTone)}</span></div>
          <div class="row"><span class="label">Bash mode</span><span class="pill ${config.bashMode === "safe" ? "" : "warn"}">${escapeHtml(config.bashMode)}</span></div>
          <div class="row"><span class="label">Auth</span><span class="pill">${escapeHtml(authLabel)}</span></div>
        </div>
      </article>
    </section>
    <section class="card" style="margin-top:18px">
      <h2>Allowed roots</h2>
      <ul class="roots">${allowedRoots}</ul>
      <p class="footer">This page does not print the CodexPro token. Use the terminal control panel to copy the full Server URL again.</p>
    </section>
  </main>
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
  app.use(express.json({ limit: "20mb" }));

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
      writeMode: config.writeMode,
      contextDir: config.contextDir,
      authEnabled: Boolean(config.authToken),
      authRequired: config.requireHttpToken
    });
  });

  app.post("/mcp", async (req, res) => {
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
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
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
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
