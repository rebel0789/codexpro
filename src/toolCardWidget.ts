export const TOOL_CARD_URI = "ui://widget/codexpro-tool-card-v8.html";
export const TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const toolCardWidgetHtml = String.raw`
<div id="root" class="wrap">
  <article class="card pending">
    <div class="rail"></div>
    <header class="head">
      <span class="glyph">C</span>
      <div class="headline">
        <div class="title">CodexPro</div>
        <div class="subtitle">Waiting for tool result...</div>
      </div>
      <span class="pill info">waiting</span>
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
    --panel: #11151c;
    --panel-2: #161b24;
    --panel-3: #0c1016;
    --panel-4: #1d222b;
    --line: rgba(212, 219, 229, 0.13);
    --line-strong: rgba(212, 219, 229, 0.24);
    --text: #f2f4f7;
    --soft: #c9d0da;
    --muted: #97a1af;
    --quiet: #6f7988;
    --accent: #d7b56d;
    --accent-soft: rgba(215, 181, 109, 0.12);
    --blue: #9dc3ff;
    --green: #8edc99;
    --red: #f29a9a;
    --amber: #e8c978;
    --shadow: rgba(0, 0, 0, 0.26);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: transparent;
    color: var(--text);
    font: 12px/1.48 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0;
  }

  .wrap {
    width: 100%;
  }

  .card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background:
      radial-gradient(circle at 18px 0, rgba(215, 181, 109, 0.12), transparent 42px),
      linear-gradient(180deg, rgba(255, 255, 255, 0.042), rgba(255, 255, 255, 0)),
      var(--panel);
    box-shadow: 0 14px 34px var(--shadow);
  }

  .rail {
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: linear-gradient(180deg, var(--accent), rgba(142, 220, 153, 0.75) 64%, transparent);
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
    border: 1px solid rgba(215, 181, 109, 0.28);
    border-radius: 8px;
    background: linear-gradient(180deg, rgba(215, 181, 109, 0.16), rgba(215, 181, 109, 0.04));
    color: var(--accent);
    font-size: 10px;
    font-weight: 900;
  }

  .headline {
    min-width: 0;
  }

  .title {
    overflow: hidden;
    color: var(--text);
    font-size: 12px;
    font-weight: 760;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtitle {
    overflow: hidden;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
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
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.035);
    color: var(--muted);
    font-size: 10px;
    font-weight: 720;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill.good { color: var(--green); border-color: rgba(134, 239, 172, 0.28); background: rgba(134, 239, 172, 0.08); }
  .pill.bad { color: var(--red); border-color: rgba(253, 164, 175, 0.28); background: rgba(253, 164, 175, 0.08); }
  .pill.info { color: var(--blue); border-color: rgba(157, 195, 255, 0.28); background: rgba(157, 195, 255, 0.08); }
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
    border-radius: 7px;
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
    border-radius: 7px;
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
    font-weight: 720;
  }

  pre {
    margin: 0;
    padding: 10px;
    overflow: visible;
    color: var(--soft);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 11px;
    line-height: 1.52;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .diff-line { display: block; min-height: 18px; padding: 0 4px; border-radius: 3px; }
  .diff-add { color: var(--green); background: rgba(142, 220, 153, 0.08); }
  .diff-del { color: var(--red); background: rgba(242, 154, 154, 0.08); }
  .diff-hunk { color: var(--blue); }
  .terminal pre { color: #dbe7f5; }
  .prompt { color: var(--accent); }

  .summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 10px;
  }

  .summary-item {
    min-width: 0;
    padding: 9px 10px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.025);
  }

  .summary-label {
    display: block;
    margin-bottom: 4px;
    color: var(--quiet);
    font-size: 10px;
    font-weight: 760;
  }

  .summary-value {
    color: var(--text);
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    font-weight: 760;
  }

  .file-list {
    display: grid;
    gap: 4px;
    margin-bottom: 10px;
  }

  .section-label {
    margin: 10px 1px 6px;
    color: var(--quiet);
    font-size: 10px;
    font-weight: 850;
    text-transform: uppercase;
  }

  .fold {
    margin-top: 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.018);
  }

  .fold > summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    min-height: 34px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--soft);
    font-weight: 760;
    list-style: none;
  }

  .fold > summary::-webkit-details-marker { display: none; }

  .fold-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fold-count {
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
  }

  .fold-body {
    padding: 0 8px 8px;
  }

  .file-row {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    padding: 7px 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.022);
  }

  .file-code {
    color: var(--accent);
    font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-weight: 800;
  }

  .file-name {
    overflow: hidden;
    color: var(--soft);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    padding: 10px;
    border: 1px dashed var(--line-strong);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.018);
    color: var(--muted);
  }

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
    .summary,
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

  function countLines(value) {
    const text = String(value || "");
    if (!text) return 0;
    return text.replace(/\n$/, "").split("\n").length;
  }

  function previewLines(value, maxLines = 18) {
    const text = String(value || "").replace(/\n$/, "");
    if (!text) return "";
    const lines = text.split("\n");
    const shown = lines.slice(0, maxLines).join("\n");
    const remaining = lines.length - maxLines;
    return remaining > 0 ? shown + "\n...[" + remaining + " more lines]" : shown;
  }

  function basename(value) {
    const text = String(value || "");
    return text.split("/").filter(Boolean).pop() || text || ".";
  }

  function titleFor(tool) {
    const titles = {
      open_current_workspace: "Workspace",
      open_workspace: "Workspace",
      write: "File write",
      edit: "Exact edit",
      git_diff: "Git Diff",
      show_changes: "Change review",
      export_pro_context: "Pro context",
      handoff_to_agent: "Agent handoff",
      handoff_to_codex: "Codex handoff",
      bash: "Terminal",
      search: "Search",
      read: "Read file"
    };
    return titles[tool] || "CodexPro";
  }

  function iconFor(tool) {
    if (tool === "open_current_workspace" || tool === "open_workspace") return "W";
    if (tool === "write") return "W";
    if (tool === "edit") return "E";
    if (tool === "git_diff") return "G";
    if (tool === "show_changes") return "D";
    if (tool === "export_pro_context") return "P";
    if (tool === "handoff_to_agent") return "A";
    if (tool === "handoff_to_codex") return "H";
    if (tool === "bash") return "$";
    if (tool === "search") return "S";
    if (tool === "read") return "R";
    return "C";
  }

  function subtitleFor(data) {
    if (data?.codexpro_tool === "open_current_workspace" || data?.codexpro_tool === "open_workspace") {
      return data?.root || "Workspace opened";
    }
    if (data?.codexpro_tool === "show_changes") {
      if (data?.status_error || data?.diff_error) return "Git state unavailable";
      const count = Array.isArray(data?.changed_files) ? data.changed_files.length : 0;
      if (!count && !data?.changed) return "Workspace is clean";
      return count === 1 ? "1 changed file" : count + " changed files";
    }
    if (data?.codexpro_tool === "handoff_to_agent" && data?.agent_name) return data.agent_name;
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

  function summaryItem(label, value) {
    return '<div class="summary-item"><span class="summary-label">' + esc(label) + '</span><div class="summary-value">' + esc(value ?? "-") + '</div></div>';
  }

  function codebox(label, text, extraClass) {
    return '<div class="code ' + esc(extraClass || "") + '"><div class="codebar"><span>' + esc(label || "output") + '</span></div><pre>' + text + '</pre></div>';
  }

  function fold(title, count, body, open) {
    if (!body) return "";
    return '<details class="fold"' + (open ? " open" : "") + '><summary><span class="fold-title">' + esc(title) + '</span><span class="fold-count">' + esc(count || "") + '</span></summary><div class="fold-body">' + body + '</div></details>';
  }

  function shortSource(value) {
    if (value === "workspace") return "repo";
    if (value === "plugin") return "plug";
    if (value === "user") return "user";
    return "skill";
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

  function renderChanges(data) {
    const files = Array.isArray(data.changed_files) ? data.changed_files : [];
    const hasGitError = Boolean(data.status_error || data.diff_error);
    const changed = Boolean(data.changed);
    const pills = [
      hasGitError ? pill("git unavailable", "warn") : changed ? pill("changed", "info") : pill("clean", "good"),
      data.additions !== undefined ? pill("+" + data.additions, "good") : "",
      data.deletions !== undefined ? pill("-" + data.deletions, "bad") : ""
    ].join("");
    const fileRows = files.slice(0, 10).map((line) => {
      const status = String(line).slice(0, 2).trim() || "?";
      const name = String(line).slice(2).trim() || String(line);
      return '<div class="file-row"><span class="file-code">' + esc(status) + '</span><span class="file-name">' + esc(name) + '</span></div>';
    }).join("");
    const moreFiles = files.length > 10 ? '<div class="empty">+' + esc(files.length - 10) + ' more changed files</div>' : "";
    const state = hasGitError
      ? '<div class="empty">' + esc(data.status_error || data.diff_error) + '</div>'
      : fileRows
        ? '<div class="file-list">' + fileRows + '</div>' + moreFiles
        : '<div class="empty">No changed files.</div>';
    const diff = data.diff ? codebox("diff", renderDiff(data.diff), "") : "";
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Files", files.length) +
      summaryItem("Added", "+" + (data.additions ?? 0)) +
      summaryItem("Deleted", "-" + (data.deletions ?? 0)) +
      '</div>' +
      state +
      diff +
      '</div></article>';
  }

  function gitStatusRows(status, max = 8) {
    return String(status || "")
      .split("\\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("##"))
      .slice(0, max)
      .map((line) => {
        const code = line.slice(0, 2).trim() || "?";
        const name = line.slice(2).trim() || line;
        return '<div class="file-row"><span class="file-code">' + esc(code) + '</span><span class="file-name">' + esc(name) + '</span></div>';
      })
      .join("");
  }

  function renderWorkspace(data) {
    const skills = Array.isArray(data.skill_inventory) ? data.skill_inventory : (Array.isArray(data.skills) ? data.skills : []);
    const skillCount = Number(data.skill_counts?.total ?? skills.length);
    const changedRows = gitStatusRows(data.git_status, 8);
    const gitLines = String(data.git_status || "").split("\\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("##"));
    const agentsLabel = data.agents_loaded ? (data.agents_path || "AGENTS.md") : "no AGENTS";
    const pills = [
      pill(agentsLabel, data.agents_loaded ? "good" : "warn"),
      pill(skillCount + " skills", skillCount ? "info" : ""),
      data.tool_mode ? pill("tools " + data.tool_mode) : ""
    ].join("");
    const contextRows = [
      '<div class="file-row"><span class="file-code">root</span><span class="file-name">' + esc(data.root || ".") + '</span></div>',
      data.workspace_id ? '<div class="file-row"><span class="file-code">id</span><span class="file-name">' + esc(data.workspace_id) + '</span></div>' : "",
      data.agents_loaded ? '<div class="file-row"><span class="file-code">rules</span><span class="file-name">' + esc(data.agents_path || "AGENTS.md") + '</span></div>' : ""
    ].join("");
    const skillRows = skills.slice(0, 16).map((skill) => {
      const value = typeof skill === "string" ? skill : (skill?.name || "skill");
      const source = typeof skill === "string" ? "skill" : shortSource(skill?.source);
      return '<div class="file-row"><span class="file-code">' + esc(source) + '</span><span class="file-name">' + esc(value) + '</span></div>';
    }).join("");
    const skillText = skills.length
      ? '<div class="file-list">' + skillRows + '</div>' + (skills.length > 16 ? '<div class="empty">+' + esc(skills.length - 16) + ' more skills</div>' : "")
      : '<div class="empty">No skills discovered. Use include_global_skills=true if this is unexpected.</div>';
    const gitText = changedRows
      ? '<div class="file-list">' + changedRows + '</div>' + (gitLines.length > 8 ? '<div class="empty">+' + esc(gitLines.length - 8) + ' more changed files</div>' : "")
      : '<div class="empty">Working tree clean.</div>';
    const tree = data.tree ? codebox("tree", esc(previewLines(data.tree, 18)), "") : "";
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Write", data.write_mode || "-") +
      summaryItem("Bash", data.bash_mode || "-") +
      summaryItem("Tools", data.tool_mode || "-") +
      '</div>' +
      '<div class="section-label">Context</div><div class="file-list">' + contextRows + '</div>' +
      fold("Git", gitLines.length ? gitLines.length + " changed" : "clean", gitText, false) +
      fold("Skills", skillCount + " discovered", skillText, false) +
      fold("Tree", data.tree ? "available" : "", tree, false) +
      '</div></article>';
  }

  function renderHandoff(data) {
    const pills = [
      data.agent_name ? pill(data.agent_name, "info") : "",
      data.model ? pill(data.model) : "",
      data.additions !== undefined ? pill("+" + data.additions, "good") : "",
      data.deletions !== undefined ? pill("-" + data.deletions, "bad") : ""
    ].join("");
    const rows = [
      data.plan_path ? '<div class="file-row"><span class="file-code">plan</span><span class="file-name">' + esc(data.plan_path) + '</span></div>' : "",
      data.status_path ? '<div class="file-row"><span class="file-code">status</span><span class="file-name">' + esc(data.status_path) + '</span></div>' : "",
      data.diff_path ? '<div class="file-row"><span class="file-code">diff</span><span class="file-name">' + esc(data.diff_path) + '</span></div>' : ""
    ].join("");
    const diff = data.diff ? codebox("plan file diff", renderDiff(data.diff), "") : "";
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="file-list">' + rows + '</div>' +
      diff +
      '</div></article>';
  }

  function renderBash(data) {
    const ok = Number(data.exitCode) === 0;
    const stdoutLines = countLines(data.stdout);
    const stderrLines = countLines(data.stderr);
    const totalLines = stdoutLines + stderrLines;
    const pills = [
      pill(ok ? "passed" : "failed", ok ? "good" : "bad"),
      pill(totalLines + " lines", "info"),
      pill((data.durationMs ?? "-") + " ms")
    ].join("");
    const command = '<span class="prompt">$</span> ' + esc(data.command || "");
    const output = previewLines(data.stdout || data.stderr || "", 18);
    const outputBox = output ? codebox("output preview", esc(truncate(output, 5000)), "terminal") : '<div class="empty">Command produced no output.</div>';
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Exit", data.exitCode ?? "-") +
      summaryItem("Lines", totalLines) +
      summaryItem("Duration", (data.durationMs ?? "-") + " ms") +
      '</div>' +
      codebox("command", command, "terminal") +
      outputBox +
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
      '<div class="headline"><div class="title">CodexPro</div><div class="subtitle">Waiting for tool result...</div></div>',
      '<span class="pill info">waiting</span>',
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
    if (tool === "open_current_workspace" || tool === "open_workspace") {
      root.innerHTML = renderWorkspace(data);
    } else if (tool === "show_changes") {
      root.innerHTML = renderChanges(data);
    } else if (tool === "handoff_to_agent" || tool === "handoff_to_codex") {
      root.innerHTML = renderHandoff(data);
    } else if (tool === "write" || tool === "edit" || tool === "git_diff" || tool === "export_pro_context" || tool === "read") {
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
