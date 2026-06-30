export const TOOL_CARD_URI = "ui://widget/codexpro-tool-card-v9.html";
export const TOOL_CARD_LEGACY_URIS = ["ui://widget/codexpro-tool-card-v8.html"];
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
      server_config: "Server config",
      codexpro_self_test: "Self-test",
      codexpro_inventory: "Inventory",
      load_skill: "Skill",
      list_workspaces: "Workspaces",
      open_current_workspace: "Workspace",
      open_workspace: "Workspace",
      workspace_snapshot: "Workspace snapshot",
      tree: "File tree",
      write: "File write",
      edit: "Exact edit",
      apply_patch: "Patch",
      git_status: "Git Status",
      git_diff: "Git Diff",
      show_changes: "Change review",
      read_handoff: "Handoff context",
      codex_context: "Codex context",
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
    if (tool === "server_config") return "S";
    if (tool === "codexpro_self_test") return "T";
    if (tool === "codexpro_inventory") return "I";
    if (tool === "load_skill") return "L";
    if (tool === "list_workspaces") return "W";
    if (tool === "open_current_workspace" || tool === "open_workspace") return "W";
    if (tool === "workspace_snapshot") return "W";
    if (tool === "tree") return "T";
    if (tool === "write") return "W";
    if (tool === "edit") return "E";
    if (tool === "apply_patch") return "P";
    if (tool === "git_status" || tool === "git_diff") return "G";
    if (tool === "show_changes") return "D";
    if (tool === "read_handoff") return "H";
    if (tool === "codex_context") return "C";
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
    if (data?.codexpro_tool === "codexpro_self_test") return data?.status ? "Status " + data.status : "Local diagnostic";
    if (data?.codexpro_tool === "codexpro_inventory") return (data?.skill_count ?? 0) + " skills, " + (data?.mcp_server_count ?? 0) + " MCP servers";
    if (data?.codexpro_tool === "list_workspaces") return (data?.count ?? 0) + " open workspaces";
    if (data?.codexpro_tool === "server_config") {
      const session = data?.bashSessionId || data?.bash_session_id;
      return "tools " + (data?.toolMode || data?.tool_mode || "-") + ", bash " + (data?.bashMode || data?.bash_mode || "-") + (session ? ", session " + session : "");
    }
    if (data?.codexpro_tool === "workspace_snapshot") return data?.root || "Workspace snapshot";
    if (data?.codexpro_tool === "git_status") {
      const count = Array.isArray(data?.changed_files) ? data.changed_files.length : 0;
      return count ? count + " changed entries" : "Working tree clean";
    }
    if (data?.codexpro_tool === "codex_context") return (data?.agents_files?.length ?? 0) + " AGENTS, " + (data?.ai_context_files?.length ?? 0) + " bridge files";
    if (data?.codexpro_tool === "read_handoff") return (data?.file_count ?? 0) + " bridge files";
    if (data?.codexpro_tool === "load_skill" && data?.skill?.name) return data.skill.name;
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
      .split("\n")
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
    const gitLines = String(data.git_status || "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("##"));
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
    const outputBox = output
      ? fold("Output preview", totalLines + " lines", codebox("output preview", esc(truncate(output, 5000)), "terminal"), false)
      : '<div class="empty">Command produced no output.</div>';
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

  function renderSelfTest(data) {
    const checks = Array.isArray(data.checks) ? data.checks : [];
    const status = String(data.status || "unknown");
    const pills = [
      pill(status, status === "pass" ? "good" : status === "fail" ? "bad" : "warn"),
      pill((data.expected_tool_count ?? "-") + " tools", "info"),
      pill((data.duration_ms ?? "-") + " ms")
    ].join("");
    const rows = checks.slice(0, 16).map((check) => {
      const state = String(check?.status || "?").toUpperCase();
      const cls = check?.status === "pass" ? "good" : check?.status === "fail" ? "bad" : "warn";
      return '<div class="file-row"><span class="file-code ' + esc(cls) + '">' + esc(state) + '</span><span class="file-name">' + esc((check?.name || "check") + ": " + (check?.detail || "")) + '</span></div>';
    }).join("");
    const terms = data.terms_boundary
      ? '<div class="file-list">' +
          '<div class="file-row"><span class="file-code">tos</span><span class="file-name">local repo bridge only; no model access, quota, resale, or bypass behavior</span></div>' +
        '</div>'
      : "";
    return '<article class="card">' + header(data, pills) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Passed", data.passed ?? 0) +
      summaryItem("Warned", data.warned ?? 0) +
      summaryItem("Failed", data.failed ?? 0) +
      '</div>' +
      '<div class="file-list">' + (rows || '<div class="empty">No checks returned.</div>') + '</div>' +
      fold("Terms boundary", "", terms, false) +
      fold("Expected tools", Array.isArray(data.expected_tools) ? data.expected_tools.length + " tools" : "", codebox("tools", esc((data.expected_tools || []).join("\\n")), ""), false) +
      '</div></article>';
  }

  function renderInventory(data) {
    const skills = Array.isArray(data.skills) ? data.skills : [];
    const servers = Array.isArray(data.mcp_servers) ? data.mcp_servers : [];
    const skillRows = skills.slice(0, 18).map((skill) =>
      '<div class="file-row"><span class="file-code">' + esc(shortSource(skill?.source)) + '</span><span class="file-name">' + esc((skill?.name || "skill") + (skill?.description ? " — " + skill.description : "")) + '</span></div>'
    ).join("");
    const serverRows = servers.slice(0, 18).map((server) =>
      '<div class="file-row"><span class="file-code">mcp</span><span class="file-name">' + esc((server?.name || "server") + (server?.source ? " — " + server.source : "")) + '</span></div>'
    ).join("");
    return '<article class="card">' + header(data, pill((data.skill_count ?? skills.length) + " skills", "info") + pill((data.mcp_server_count ?? servers.length) + " MCP")) +
      '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Write", data.write_mode || "-") +
      summaryItem("Bash", data.bash_mode || "-") +
      summaryItem("Tools", data.tool_mode || "-") +
      '</div>' +
      fold("Skills", (data.skill_count ?? skills.length) + " found", '<div class="file-list">' + (skillRows || '<div class="empty">No skills discovered.</div>') + '</div>', false) +
      fold("MCP servers", (data.mcp_server_count ?? servers.length) + " found", '<div class="file-list">' + (serverRows || '<div class="empty">No MCP server names discovered.</div>') + '</div>', false) +
      '</div></article>';
  }

  function renderWorkspaces(data) {
    const spaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const rows = spaces.map((workspace) =>
      '<div class="file-row"><span class="file-code">ws</span><span class="file-name">' + esc((workspace?.id || "workspace") + " — " + (workspace?.root || "")) + '</span></div>'
    ).join("");
    return '<article class="card">' + header(data, pill((data.count ?? spaces.length) + " open", "info")) +
      '<div class="body"><div class="file-list">' + (rows || '<div class="empty">No workspaces opened yet.</div>') + '</div></div></article>';
  }

  function renderServerConfig(data) {
    const blocked = Array.isArray(data.blockedGlobs) ? data.blockedGlobs : [];
    const allowed = Array.isArray(data.allowedRoots) ? data.allowedRoots : [];
    const bashSession = data.bashSessionId || data.bash_session_id || "";
    const bashSessionRequired = Boolean(data.requireBashSession || data.require_bash_session);
    const rootRows = [
      '<div class="file-row"><span class="file-code">root</span><span class="file-name">' + esc(data.defaultRoot || "-") + '</span></div>',
      '<div class="file-row"><span class="file-code">url</span><span class="file-name">' + esc((data.host || "127.0.0.1") + ":" + (data.port || "-")) + '</span></div>',
      '<div class="file-row"><span class="file-code">ui</span><span class="file-name">' + esc(data.widgetDomain || "-") + '</span></div>',
      bashSession ? '<div class="file-row"><span class="file-code">bash</span><span class="file-name">' + esc("session " + bashSession + (bashSessionRequired ? " required" : "")) + '</span></div>' : ""
    ].join("");
    const allowedRows = allowed.map((root) =>
      '<div class="file-row"><span class="file-code">allow</span><span class="file-name">' + esc(root) + '</span></div>'
    ).join("");
    const blockedRows = blocked.slice(0, 24).map((pattern) =>
      '<div class="file-row"><span class="file-code">block</span><span class="file-name">' + esc(pattern) + '</span></div>'
    ).join("");
    const limits = [
      summaryItem("Read", data.maxReadBytes ?? "-"),
      summaryItem("Write", data.maxWriteBytes ?? "-"),
      summaryItem("Output", data.maxOutputBytes ?? "-")
    ].join("");
    return '<article class="card">' + header(data, [
      pill("tools " + (data.toolMode || "-"), "info"),
      pill("bash " + (data.bashMode || "-")),
      bashSession ? pill("session " + bashSession, bashSessionRequired ? "warn" : "info") : "",
      pill(data.authEnabled ? "auth on" : "auth off", data.authEnabled ? "good" : "warn")
    ].join("")) + '<div class="body">' +
      '<div class="summary">' +
      summaryItem("Write", data.writeMode || "-") +
      summaryItem("Bash", data.bashMode || "-") +
      summaryItem("Session", bashSession ? bashSession + (bashSessionRequired ? " required" : "") : "-") +
      summaryItem("Tools", data.toolMode || "-") +
      '</div>' +
      '<div class="section-label">Runtime</div><div class="file-list">' + rootRows + '</div>' +
      fold("Allowed roots", allowed.length + " roots", '<div class="file-list">' + (allowedRows || '<div class="empty">No roots configured.</div>') + '</div>', false) +
      fold("Limits", "", '<div class="summary">' + limits + '</div>', false) +
      fold("Blocked paths", blocked.length + " patterns", '<div class="file-list">' + (blockedRows || '<div class="empty">No blocked globs configured.</div>') + '</div>', false) +
      fold("Raw config", "", codebox("config", esc(truncate(JSON.stringify(data || {}, null, 2), 8000)), ""), false) +
      '</div></article>';
  }

  function renderStatus(data) {
    const files = Array.isArray(data.changed_files) ? data.changed_files : [];
    const rows = files.slice(0, 14).map((line) => {
      const status = String(line).slice(0, 2).trim() || "?";
      const name = String(line).slice(2).trim() || String(line);
      return '<div class="file-row"><span class="file-code">' + esc(status) + '</span><span class="file-name">' + esc(name) + '</span></div>';
    }).join("");
    const state = data.status_error ? '<div class="empty">' + esc(data.status_error) + '</div>' : rows || '<div class="empty">Working tree clean.</div>';
    return '<article class="card">' + header(data, pill(files.length ? files.length + " changed" : "clean", files.length ? "info" : "good")) +
      '<div class="body"><div class="file-list">' + state + '</div>' +
      fold("Raw status", countLines(data.status) + " lines", codebox("git status", esc(previewLines(data.status, 40)), ""), false) +
      '</div></article>';
  }

  function renderTextSummary(data, label) {
    const files = Array.isArray(data.files) ? data.files : Array.isArray(data.ai_context_files) ? data.ai_context_files : [];
    const preview = data.preview || data.text || data.status || "";
    const rows = files.slice(0, 14).map((file) =>
      '<div class="file-row"><span class="file-code">file</span><span class="file-name">' + esc(file) + '</span></div>'
    ).join("");
    return '<article class="card">' + header(data, pill(files.length + " files", "info")) +
      '<div class="body">' +
      (rows ? '<div class="file-list">' + rows + '</div>' : '<div class="empty">No files listed.</div>') +
      fold(label || "Preview", countLines(preview) + " lines", codebox(label || "preview", esc(previewLines(preview, 40)), ""), false) +
      '</div></article>';
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
    if (tool === "server_config") {
      root.innerHTML = renderServerConfig(data);
    } else if (tool === "codexpro_self_test") {
      root.innerHTML = renderSelfTest(data);
    } else if (tool === "codexpro_inventory") {
      root.innerHTML = renderInventory(data);
    } else if (tool === "list_workspaces") {
      root.innerHTML = renderWorkspaces(data);
    } else if (tool === "open_current_workspace" || tool === "open_workspace" || tool === "workspace_snapshot") {
      root.innerHTML = renderWorkspace(data);
    } else if (tool === "git_status") {
      root.innerHTML = renderStatus(data);
    } else if (tool === "show_changes") {
      root.innerHTML = renderChanges(data);
    } else if (tool === "handoff_to_agent" || tool === "handoff_to_codex") {
      root.innerHTML = renderHandoff(data);
    } else if (tool === "write" || tool === "edit" || tool === "apply_patch" || tool === "git_diff" || tool === "export_pro_context" || tool === "read") {
      root.innerHTML = renderFile(data);
    } else if (tool === "bash") {
      root.innerHTML = renderBash(data);
    } else if (tool === "search") {
      root.innerHTML = renderSearch(data);
    } else if (tool === "read_handoff") {
      root.innerHTML = renderTextSummary(data, "handoff");
    } else if (tool === "codex_context") {
      root.innerHTML = renderTextSummary(data, "context");
    } else {
      root.innerHTML = renderGeneric(data);
    }
  }

  function extractStructuredContent(value) {
    if (!value || typeof value !== "object") return {};
    if (value.codexpro_tool || value.codexpro_title) return value;
    const candidates = [
      value.structuredContent,
      value.toolOutput?.structuredContent,
      value.toolOutput,
      value.toolResponseMetadata?.structuredContent,
      value.mcp_tool_result?.structuredContent,
      value.call_tool_result?.structuredContent,
      value.result?.structuredContent
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object") return candidate;
    }
    return {};
  }

  render(extractStructuredContent(window.openai?.toolOutput || window.openai?.toolResponseMetadata || {}));

  window.addEventListener("openai:set_globals", (event) => {
    render(extractStructuredContent(
      event.detail?.globals?.toolOutput ||
      event.detail?.globals?.toolResponseMetadata ||
      event.detail ||
      window.openai?.toolOutput ||
      window.openai?.toolResponseMetadata ||
      {}
    ));
  }, { passive: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      render(extractStructuredContent(message.params || {}));
    }
  }, { passive: true });
</script>
`.trim();
