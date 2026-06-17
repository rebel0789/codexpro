export const TOOL_CARD_URI = "ui://widget/codexpro-tool-card-v5.html";
export const TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const toolCardWidgetHtml = String.raw`
<div id="root" class="wrap">
  <article class="card pending">
    <div class="rail"></div>
    <header class="head">
      <span class="glyph">C</span>
      <div class="headline">
        <div class="title">CodexPro</div>
        <div class="subtitle">Working in the workspace...</div>
      </div>
      <span class="pill info">running</span>
    </header>
    <div class="skeleton">
      <span></span>
      <span></span>
      <span></span>
    </div>
  </article>
</div>

<style>
  :root {
    color-scheme: dark light;
    --bg: #090b0f;
    --panel: #10141b;
    --panel-2: #151a23;
    --panel-3: #0c1016;
    --line: rgba(148, 163, 184, 0.18);
    --line-strong: rgba(148, 163, 184, 0.28);
    --text: #f4f7fb;
    --soft: #cbd5e1;
    --muted: #8a96a8;
    --quiet: #647084;
    --blue: #7dd3fc;
    --teal: #5eead4;
    --green: #86efac;
    --red: #fda4af;
    --amber: #fde68a;
    --violet: #c4b5fd;
    --shadow: rgba(0, 0, 0, 0.32);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: transparent;
    color: var(--text);
    font: 12px/1.48 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    letter-spacing: 0;
  }

  .wrap {
    width: 100%;
  }

  .card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 10px;
    background:
      radial-gradient(circle at 14px 0, rgba(94, 234, 212, 0.12), transparent 32px),
      linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0)),
      var(--panel);
    box-shadow: 0 18px 44px var(--shadow);
  }

  .rail {
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: linear-gradient(180deg, var(--teal), #60a5fa 64%, transparent);
    opacity: 0.88;
  }

  .head {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 56px;
    padding: 11px 12px 10px 14px;
    border-bottom: 1px solid var(--line);
  }

  .glyph {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid rgba(125, 211, 252, 0.26);
    border-radius: 8px;
    background: linear-gradient(180deg, rgba(125, 211, 252, 0.16), rgba(94, 234, 212, 0.06));
    color: var(--blue);
    font-size: 11px;
    font-weight: 900;
  }

  .headline {
    min-width: 0;
  }

  .title {
    overflow: hidden;
    color: var(--text);
    font-size: 12px;
    font-weight: 900;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtitle {
    overflow: hidden;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    max-width: 22ch;
    overflow: hidden;
    padding: 2px 7px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.035);
    color: var(--muted);
    font-size: 10px;
    font-weight: 850;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill.good { color: var(--green); border-color: rgba(134, 239, 172, 0.28); background: rgba(134, 239, 172, 0.08); }
  .pill.bad { color: var(--red); border-color: rgba(253, 164, 175, 0.28); background: rgba(253, 164, 175, 0.08); }
  .pill.info { color: var(--blue); border-color: rgba(125, 211, 252, 0.28); background: rgba(125, 211, 252, 0.08); }
  .pill.warn { color: var(--amber); border-color: rgba(253, 230, 138, 0.28); background: rgba(253, 230, 138, 0.08); }

  .body {
    max-height: 420px;
    overflow: auto;
    padding: 10px;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 10px;
  }

  .metric {
    min-width: 0;
    padding: 8px 9px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
  }

  .metric .label {
    display: block;
    margin-bottom: 4px;
    color: var(--quiet);
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;
  }

  .metric .value {
    overflow: hidden;
    color: var(--soft);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .code {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-3);
  }

  .codebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 30px;
    padding: 6px 9px;
    border-bottom: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--muted);
    font-size: 11px;
    font-weight: 850;
  }

  pre {
    margin: 0;
    padding: 10px;
    overflow: visible;
    color: var(--soft);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .diff-line { display: block; min-height: 18px; padding: 0 3px; }
  .diff-add { color: var(--green); background: rgba(134, 239, 172, 0.075); }
  .diff-del { color: var(--red); background: rgba(253, 164, 175, 0.075); }
  .diff-hunk { color: var(--blue); }
  .terminal pre { color: #dbe7f5; }
  .prompt { color: var(--teal); }

  .search {
    display: grid;
    gap: 4px;
  }

  .hit {
    display: grid;
    grid-template-columns: minmax(120px, 0.34fr) minmax(0, 1fr);
    gap: 8px;
    padding: 6px 8px;
    border-radius: 7px;
  }

  .hit:nth-child(odd) {
    background: rgba(255, 255, 255, 0.025);
  }

  .hit-file {
    overflow: hidden;
    color: var(--blue);
    font-weight: 850;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hit-text {
    color: var(--soft);
    overflow-wrap: anywhere;
  }

  .muted { color: var(--muted); }

  .skeleton {
    display: grid;
    gap: 7px;
    padding: 11px 13px 13px 17px;
    border-top: 1px solid rgba(255, 255, 255, 0.02);
  }

  .skeleton span {
    height: 8px;
    max-width: 78%;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(148, 163, 184, 0.12), rgba(148, 163, 184, 0.22), rgba(148, 163, 184, 0.12));
    animation: codexpro-sheen 1.55s ease-in-out infinite;
  }

  .skeleton span:nth-child(2) { max-width: 52%; animation-delay: 0.12s; }
  .skeleton span:nth-child(3) { max-width: 66%; animation-delay: 0.24s; }

  @keyframes codexpro-sheen {
    0%, 100% { opacity: 0.46; transform: translateX(0); }
    50% { opacity: 1; transform: translateX(2px); }
  }

  @media (max-width: 640px) {
    .head { grid-template-columns: 28px minmax(0, 1fr); }
    .meta { grid-column: 1 / -1; justify-content: flex-start; }
    .metrics,
    .hit { grid-template-columns: 1fr; }
  }
</style>

<script>
  const root = document.getElementById("root");

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function truncate(value, max = 9000) {
    const text = String(value ?? "");
    return text.length > max ? text.slice(0, max) + "\n...[truncated in widget]" : text;
  }

  function basename(value) {
    const text = String(value || "");
    return text.split("/").filter(Boolean).pop() || text || ".";
  }

  function titleFor(tool) {
    const titles = {
      write: "Write File",
      edit: "Edit File",
      git_diff: "Git Diff",
      export_pro_context: "Pro Context",
      handoff_to_agent: "Agent Handoff",
      handoff_to_codex: "Codex Handoff",
      bash: "Terminal",
      search: "Search",
      read: "Read File"
    };
    return titles[tool] || "CodexPro";
  }

  function iconFor(tool) {
    if (tool === "write") return "W";
    if (tool === "edit") return "E";
    if (tool === "git_diff") return "G";
    if (tool === "export_pro_context") return "P";
    if (tool === "handoff_to_agent") return "A";
    if (tool === "handoff_to_codex") return "H";
    if (tool === "bash") return "$";
    if (tool === "search") return "S";
    if (tool === "read") return "R";
    return "C";
  }

  function subtitleFor(data) {
    if (data?.path) return data.path;
    if (data?.plan_path) return data.plan_path;
    if (data?.root) return data.root;
    if (data?.cwd) return data.cwd;
    return "Tool output";
  }

  function pill(text, cls) {
    return '<span class="pill ' + esc(cls || "") + '">' + esc(text) + '</span>';
  }

  function header(data, pills) {
    const tool = data?.codexpro_tool;
    return [
      '<div class="rail"></div>',
      '<header class="head">',
      '<span class="glyph">' + esc(iconFor(tool)) + '</span>',
      '<div class="headline"><div class="title">' + esc(titleFor(tool)) + '</div><div class="subtitle">' + esc(subtitleFor(data)) + '</div></div>',
      '<div class="meta">' + (pills || '') + '</div>',
      '</header>'
    ].join('');
  }

  function metric(label, value) {
    return '<div class="metric"><span class="label">' + esc(label) + '</span><div class="value">' + esc(value ?? "-") + '</div></div>';
  }

  function codebox(label, text, extraClass) {
    return '<div class="code ' + esc(extraClass || "") + '"><div class="codebar"><span>' + esc(label || "output") + '</span></div><pre>' + text + '</pre></div>';
  }

  function renderDiff(diff) {
    return truncate(diff, 14000).split("\n").map((line) => {
      let cls = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) cls += " diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls += " diff-del";
      else if (line.startsWith("@@")) cls += " diff-hunk";
      return '<span class="' + cls + '">' + esc(line) + '</span>';
    }).join("");
  }

  function renderFile(data) {
    const pills = [
      data.bytes !== undefined ? pill(data.bytes + " bytes") : "",
      data.additions !== undefined ? pill("+" + data.additions, "good") : "",
      data.deletions !== undefined ? pill("-" + data.deletions, "bad") : "",
      data.replacements !== undefined ? pill(data.replacements + " replacements", "info") : ""
    ].join("");
    const body = data.diff ? renderDiff(data.diff) : esc(truncate(data.text || ""));
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      codebox(basename(data.path || data.plan_path || "file"), body, "") +
      '</div></article>';
  }

  function renderBash(data) {
    const ok = Number(data.exitCode) === 0;
    const pills = pill("exit " + (data.exitCode ?? "-"), ok ? "good" : "bad") + pill((data.durationMs ?? "-") + " ms");
    const command = '<span class="prompt">$</span> ' + esc(data.command || "");
    const output = esc(truncate(data.stdout || data.stderr || ""));
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      codebox("command", command + "\\n\\n" + output, "terminal") +
      '</div></article>';
  }

  function renderSearch(data) {
    const count = Array.isArray(data.matches) ? data.matches.length : 0;
    const lines = String(data.text || "").split("\\n").filter(Boolean).slice(0, 90);
    const hits = lines.map((line) => {
      const parts = line.split(":");
      const file = parts.length > 2 ? parts.slice(0, 2).join(":") : (parts[0] || "match");
      const body = parts.length > 2 ? parts.slice(2).join(":").trim() : line;
      return '<div class="hit"><div class="hit-file">' + esc(file) + '</div><div class="hit-text">' + esc(body) + '</div></div>';
    }).join("") || '<div class="muted">No matches.</div>';
    return '<article class="card">' + header(data, pill(count + " matches", "info") + pill(data.used || "search")) +
      '<div class="body"><div class="search">' + hits + '</div></div></article>';
  }

  function renderGeneric(data) {
    const keys = Object.keys(data || {}).filter((key) => !key.startsWith("codexpro_"));
    const metrics = keys.slice(0, 3).map((key) => metric(key, typeof data[key] === "object" ? JSON.stringify(data[key]) : data[key])).join("");
    return '<article class="card">' + header(data, pill("structured", "info")) +
      '<div class="body">' + (metrics ? '<div class="metrics">' + metrics + '</div>' : '') +
      codebox("structured output", esc(truncate(JSON.stringify(data || {}, null, 2))), "") +
      '</div></article>';
  }

  function isPlaceholderPayload(data) {
    if (!data || typeof data !== "object") return true;
    const keys = Object.keys(data);
    return !keys.length || (keys.length === 1 && data.codexpro_tool === "codexpro");
  }

  function renderPending() {
    root.innerHTML = [
      '<article class="card pending">',
      '<div class="rail"></div>',
      '<header class="head">',
      '<span class="glyph">C</span>',
      '<div class="headline"><div class="title">CodexPro</div><div class="subtitle">Working in the workspace...</div></div>',
      '<span class="pill info">running</span>',
      '</header>',
      '<div class="skeleton"><span></span><span></span><span></span></div>',
      '</article>'
    ].join("");
  }

  function render(data) {
    if (isPlaceholderPayload(data)) {
      renderPending();
      return;
    }
    const tool = data.codexpro_tool;
    if (tool === "write" || tool === "edit" || tool === "git_diff" || tool === "export_pro_context" || tool === "handoff_to_agent" || tool === "handoff_to_codex" || tool === "read") {
      root.innerHTML = renderFile(data);
    } else if (tool === "bash") {
      root.innerHTML = renderBash(data);
    } else if (tool === "search") {
      root.innerHTML = renderSearch(data);
    } else {
      root.innerHTML = renderGeneric(data);
    }
  }

  render(window.openai?.toolOutput || window.openai?.toolResponseMetadata || {});

  window.addEventListener("openai:set_globals", (event) => {
    render(event.detail?.globals?.toolOutput || window.openai?.toolOutput || {});
  }, { passive: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      render(message.params?.structuredContent || {});
    }
  }, { passive: true });
</script>
`.trim();
