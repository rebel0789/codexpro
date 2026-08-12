export const TOOL_CARD_URI = "ui://widget/codexpro-tool-card-v17.html";
export const TOOL_CARD_LEGACY_URIS = [
  "ui://widget/codexpro-tool-card-v16.html",
  "ui://widget/codexpro-tool-card-v15.html",
  "ui://widget/codexpro-tool-card-v14.html",
  "ui://widget/codexpro-tool-card-v13.html",
  "ui://widget/codexpro-tool-card-v12.html",
  "ui://widget/codexpro-tool-card-v11.html",
  "ui://widget/codexpro-tool-card-v10.html",
  "ui://widget/codexpro-tool-card-v9.html",
  "ui://widget/codexpro-tool-card-v8.html"
];
export const TOOL_CARD_MIME_TYPE = "text/html;profile=mcp-app";

// This widget deliberately stays self-contained. It receives tool results through the
// Apps SDK bridge and does not make network requests, invoke tools, or persist data.
export const toolCardWidgetHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      color-scheme: light;
      --card: #ffffff;
      --canvas: #f7f7f8;
      --ink: #202123;
      --muted: #6e6e80;
      --faint: #ececf1;
      --line: #dedee5;
      --code: #f1f1f3;
      --good: #1f7a4c;
      --active: #245fbd;
      --warn: #a55200;
      --bad: #b42318;
      --shadow: 0 1px 2px rgba(15, 15, 20, .06), 0 8px 28px rgba(15, 15, 20, .05);
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
      --card: #2f2f2f;
      --canvas: #212121;
      --ink: #ececf1;
      --muted: #b4b4bf;
      --faint: #3a3a3a;
      --line: #4a4a4a;
      --code: #242424;
      --good: #5ccf91;
      --active: #8bb6ff;
      --warn: #f1a75b;
      --bad: #ff8a80;
      --shadow: 0 1px 2px rgba(0, 0, 0, .22), 0 10px 28px rgba(0, 0, 0, .18);
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 0; background: transparent; }
    body {
      color: var(--ink);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    button, summary { font: inherit; }
    .title, .task-mode { text-wrap: balance; }
    .summary, .notice, .task-activity, .task-next span { text-wrap: pretty; }
    #root { width: 100%; }
    .card {
      width: 100%;
      max-width: 780px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--card);
      box-shadow: var(--shadow);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 50px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--faint);
    }
    .tool-icon {
      display: grid;
      width: 26px;
      height: 26px;
      flex: 0 0 auto;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--canvas);
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      font-weight: 700;
    }
    .title-group { min-width: 0; flex: 1; }
    .title {
      overflow: hidden;
      color: var(--ink);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: -.01em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .subtitle {
      overflow: hidden;
      margin-top: 1px;
      color: var(--muted);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      flex: 0 0 auto;
      padding: 3px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--canvas);
      color: var(--muted);
      font-size: 10px;
      font-weight: 650;
      letter-spacing: .01em;
    }
    .badge.good { color: var(--good); }
    .badge.active { color: var(--active); }
    .badge.warn { color: var(--warn); }
    .badge.bad { color: var(--bad); }
    .body { padding: 13px 14px 14px; }
    .summary { margin: 0 0 12px; color: var(--muted); }
    .summary strong { color: var(--ink); font-weight: 600; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: 8px;
      margin: 0 0 12px;
    }
    .metric {
      min-width: 0;
      padding: 9px 10px;
      border: 1px solid var(--faint);
      border-radius: 10px;
      background: var(--canvas);
    }
    .metric-value {
      overflow: hidden;
      color: var(--ink);
      font-size: 15px;
      font-weight: 680;
      letter-spacing: -.02em;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .metric-label { margin-top: 1px; color: var(--muted); font-size: 10px; }
    .facts {
      display: grid;
      grid-template-columns: minmax(78px, auto) minmax(0, 1fr);
      gap: 7px 12px;
      margin: 0;
    }
    .facts dt { color: var(--muted); }
    .facts dd {
      min-width: 0;
      margin: 0;
      overflow-wrap: anywhere;
      color: var(--ink);
    }
    .mono, code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
    }
    .mono { color: var(--ink); }
    .path { overflow-wrap: anywhere; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      max-width: 100%;
      overflow: hidden;
      padding: 4px 7px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--canvas);
      color: var(--ink);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .list li {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
      color: var(--ink);
    }
    .list li::before {
      width: 4px;
      height: 4px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--muted);
      content: "";
    }
    .list span { min-width: 0; overflow-wrap: anywhere; }
    .notice {
      padding: 10px 11px;
      border: 1px solid var(--faint);
      border-radius: 10px;
      background: var(--canvas);
      color: var(--muted);
    }
    .notice.warn { border-color: color-mix(in srgb, var(--warn) 30%, var(--line)); color: var(--warn); }
    .notice.bad { border-color: color-mix(in srgb, var(--bad) 34%, var(--line)); color: var(--bad); }
    .task-card { --mode: var(--active); border-left: 3px solid var(--mode); }
    .task-card.mode-direct { --mode: var(--good); }
    .task-card.mode-codex { --mode: var(--active); }
    .task-card.mode-transition { --mode: var(--warn); }
    .task-state {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      margin-bottom: 12px;
      padding: 10px 11px;
      border: 1px solid color-mix(in srgb, var(--mode) 24%, var(--line));
      border-radius: 10px;
      background: color-mix(in srgb, var(--mode) 7%, var(--card));
    }
    .task-state-mark {
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      margin-top: 5px;
      border: 2px solid color-mix(in srgb, var(--mode) 25%, var(--card));
      border-radius: 50%;
      background: var(--mode);
      box-shadow: 0 0 0 2px var(--mode);
    }
    .task-state-copy { min-width: 0; flex: 1; }
    .task-mode { color: var(--ink); font-size: 12px; font-weight: 680; }
    .task-activity { margin-top: 2px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .task-next {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 11px;
      color: var(--muted);
      font-size: 11px;
    }
    .task-next::before { width: 12px; height: 1px; flex: 0 0 auto; background: var(--mode); content: ""; }
    .task-next span { min-width: 0; flex: 1; }
    .task-copy { flex: 0 0 auto; margin-left: auto; }
    .task-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .task-list li {
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr) auto;
      align-items: center;
      gap: 9px;
      padding: 9px 0;
      border-bottom: 1px solid var(--faint);
    }
    .task-list li:last-child { border-bottom: 0; }
    .task-list-mark { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
    .task-list-mark.good { background: var(--good); }
    .task-list-mark.active { background: var(--active); }
    .task-list-mark.warn { background: var(--warn); }
    .task-list-mark.bad { background: var(--bad); }
    .task-list-main { min-width: 0; }
    .task-list-title { overflow: hidden; color: var(--ink); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .task-list-meta, .task-list-status { color: var(--muted); font-size: 10px; }
    .task-list-status { padding-left: 8px; text-align: right; }
    details.fold { margin-top: 10px; border-top: 1px solid var(--faint); }
    details.fold summary {
      display: flex;
      cursor: pointer;
      align-items: center;
      min-height: 34px;
      color: var(--muted);
      font-size: 11px;
      list-style: none;
      user-select: none;
    }
    details.fold summary::-webkit-details-marker { display: none; }
    details.fold summary::after { margin-left: auto; content: "⌄"; font-size: 14px; }
    details.fold[open] summary::after { content: "⌃"; }
    .fold-content { padding: 0 0 3px; }
    .code-shell { position: relative; overflow: hidden; border: 1px solid var(--faint); border-radius: 10px; background: var(--code); }
    .code-topline {
      display: flex;
      align-items: center;
      min-height: 34px;
      padding: 0 8px 0 10px;
      border-bottom: 1px solid var(--faint);
      color: var(--muted);
      font-size: 10px;
    }
    .copy-card-output {
      min-width: 40px;
      min-height: 40px;
      margin-left: auto;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 4px 6px;
      font-size: 10px;
      transition-property: background-color, color, transform;
      transition-duration: 150ms;
      transition-timing-function: cubic-bezier(.2, 0, 0, 1);
    }
    .copy-card-output:hover, .copy-card-output:focus-visible { background: var(--faint); color: var(--ink); outline: none; }
    .copy-card-output:active { transform: scale(.96); }
    pre {
      max-height: 244px;
      margin: 0;
      padding: 10px;
      overflow: auto;
      color: var(--ink);
      line-height: 1.5;
      tab-size: 2;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .empty { color: var(--muted); }
    .pending .body { padding: 12px 14px; }
    @media (max-width: 420px) {
      .card { border-radius: 13px; }
      .head, .body { padding-left: 12px; padding-right: 12px; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .badge { display: none; }
    }
  </style>
</head>
<body>
  <main id="root" aria-live="polite"></main>
  <script>
    (() => {
      const root = document.getElementById("root");
      let copyableText = "";
      let fallbackTimer = null;

      const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
      })[character]);

      const toArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
      const asText = (value, fallback = "") => typeof value === "string" ? value : value == null ? fallback : String(value);
      const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
      const optionalNumber = (...values) => {
        for (const value of values) {
          if (value === undefined || value === null || value === "") continue;
          const parsed = Number(value);
          if (Number.isFinite(parsed)) return parsed;
        }
        return null;
      };
      const truncate = (value, max = 2600) => {
        const text = asText(value);
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
      };
      const fileName = (value) => {
        if (!value || typeof value !== "object") return asText(value);
        return asText(value.path || value.file || value.name || value.label || value.id || "");
      };
      const values = (items, limit = 12) => toArray(items).map(fileName).filter(Boolean).slice(0, limit);
      const list = (items, empty = "None") => {
        const entries = values(items);
        return entries.length
          ? '<ul class="list">' + entries.map((item) => '<li><span>' + escapeHtml(item) + '</span></li>').join("") + '</ul>'
          : '<div class="empty">' + escapeHtml(empty) + '</div>';
      };
      const chips = (items, empty = "None") => {
        const entries = values(items, 18);
        return entries.length
          ? '<div class="chips">' + entries.map((item) => '<span class="chip mono">' + escapeHtml(item) + '</span>').join("") + '</div>'
          : '<div class="empty">' + escapeHtml(empty) + '</div>';
      };
      const metric = (value, label) => '<div class="metric"><div class="metric-value">' + escapeHtml(value) + '</div><div class="metric-label">' + escapeHtml(label) + '</div></div>';
      function factRows(entries) {
        return '<dl class="facts">' + entries.filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "").map((entry) => {
          const value = entry[2] ? entry[1] : escapeHtml(entry[1]);
          return '<dt>' + escapeHtml(entry[0]) + '</dt><dd>' + value + '</dd>';
        }).join("") + '</dl>';
      }

      function header(title, subtitle, badge, tone = "") {
        return '<header class="head"><div class="tool-icon" aria-hidden="true">›_</div><div class="title-group"><div class="title">' + escapeHtml(title) + '</div>' +
          (subtitle ? '<div class="subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
          '</div>' + (badge ? '<span class="badge ' + escapeHtml(tone) + '">' + escapeHtml(badge) + '</span>' : '') + '</header>';
      }

      function card(title, subtitle, badge, tone, body, extraClass = "") {
        return '<section class="card ' + escapeHtml(extraClass) + '">' + header(title, subtitle, badge, tone) + '<div class="body">' + body + '</div></section>';
      }

      function fold(title, content, open = false) {
        return '<details class="fold"' + (open ? ' open' : '') + '><summary>' + escapeHtml(title) + '</summary><div class="fold-content">' + content + '</div></details>';
      }

      function codeBlock(label, text, copy = false, max = 9000) {
        const bounded = truncate(text, max);
        if (copy) copyableText = bounded;
        return '<div class="code-shell"><div class="code-topline"><span>' + escapeHtml(label) + '</span>' +
          (copy ? '<button type="button" class="copy-card-output" data-copy-card-output aria-label="Copy result">Copy</button>' : '') +
          '</div><pre>' + escapeHtml(bounded || "No output") + '</pre></div>';
      }

      const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const friendly = (value, fallback = "") => {
        const text = asText(value, fallback).replace(/[_-]+/g, " ").trim();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
      };
      const detailText = (value) => {
        if (value == null) return "";
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
        if (typeof value === "object") {
          try { return JSON.stringify(value, null, 2); } catch { return ""; }
        }
        return String(value);
      };

      function normalizedJson(value) {
        if (typeof value !== "string") return value;
        const text = value.trim();
        if (!text || (text[0] !== "{" && text[0] !== "[")) return value;
        try { return JSON.parse(text); } catch { return value; }
      }

      function extractStructuredContent(value, depth = 0, seen = new Set()) {
        const normalized = normalizedJson(value);
        if (!normalized || typeof normalized !== "object" || depth > 6 || seen.has(normalized)) return null;
        seen.add(normalized);
        if (Array.isArray(normalized)) {
          for (const item of normalized) {
            const match = extractStructuredContent(item, depth + 1, seen);
            if (match) return match;
          }
          return null;
        }
        if (normalized.codexpro_tool || normalized.codexpro_title) return normalized;
        const candidates = [
          normalized.structuredContent,
          normalized.toolOutput,
          normalized.toolResponseMetadata,
          normalized.toolResult,
          normalized.tool_result,
          normalized.mcp_tool_result,
          normalized.call_tool_result,
          normalized.result,
          normalized.output,
          normalized.payload,
          normalized.data,
          normalized.params
        ];
        for (const candidate of candidates) {
          const match = extractStructuredContent(candidate, depth + 1, seen);
          if (match) return match;
        }
        return null;
      }

      function applyHostTheme(globals = window.openai || {}) {
        const theme = asText(globals.theme || window.openai?.theme || "light").toLowerCase();
        document.documentElement.dataset.theme = theme.includes("dark") ? "dark" : "light";
      }

      function renderWorkspace(data) {
        const rootPath = asText(data.root, "Workspace");
        const git = asText(data.git_status, "");
        const changed = git && !/clean|nothing to commit|no changes/i.test(git);
        const summary = '<div class="summary"><strong>Ready to work.</strong> This workspace is connected for the current conversation.</div>' +
          factRows([
            ["Root", '<span class="mono path">' + escapeHtml(rootPath) + '</span>', true],
            ["Instructions", data.agents_loaded ? "AGENTS.md loaded" : "No AGENTS.md found"],
            ["Access", asText(data.tool_mode, "standard") + " tools · " + asText(data.write_mode, "off") + " writes"],
            ["Shell", asText(data.bash_mode, "off")]
          ]);
        const context = chips(data.ai_context_files || data.skills, "No extra workspace context");
        const status = git ? fold("Git status", codeBlock("Git", git), false) : "";
        return card("Connected workspace", rootPath, changed ? "Changes" : "Ready", changed ? "warn" : "good", summary + fold("Available context", context, false) + status);
      }

      function renderWorkspaceAnalysis(data) {
        const coverage = data.coverage && typeof data.coverage === "object" ? data.coverage : {};
        const analyzed = number(coverage.analyzedFiles ?? data.returned?.files ?? toArray(data.files).length);
        const inventory = number(coverage.inventoryFiles, analyzed);
        const symbols = number(coverage.symbolCount ?? data.returned?.symbols ?? toArray(data.symbols).length);
        const relationships = number(coverage.relationshipCount ?? data.returned?.relationships ?? toArray(data.relationships).length);
        const warnings = values(data.warnings, 6);
        const metrics = '<div class="metrics">' + metric(analyzed + (inventory ? "/" + inventory : ""), "files analyzed") + metric(symbols, "symbols") + metric(relationships, "relationships") + '</div>';
        const overview = factRows([
          ["Scope", '<span class="mono path">' + escapeHtml(asText(data.path, ".")) + '</span>', true],
          ["Languages", escapeHtml(values(data.languages).join(", ") || "Not detected"), true],
          ["Projects", escapeHtml(values(data.project_types).join(", ") || "Not detected"), true]
        ]);
        const warningBlock = warnings.length ? '<div class="notice warn">' + escapeHtml(warnings.join(" ")) + '</div>' : "";
        return card("Workspace map", asText(data.root, "Analysis complete"), data.output_limited ? "Partial" : "Ready", data.output_limited ? "warn" : "good", metrics + overview + warningBlock +
          fold("Entrypoints", list(data.entrypoints, "No entrypoints detected"), false) +
          fold("Important files", list(data.important_files || data.files, "No files returned"), false) +
          fold("Areas", list(data.areas, "No areas returned"), false));
      }

      function renderChanges(data) {
        const files = values(data.changed_files, 18);
        const failed = asText(data.status_error || data.diff_error, "");
        const hasChanges = Boolean(data.changed) || files.length > 0 || number(data.additions) > 0 || number(data.deletions) > 0;
        const metrics = '<div class="metrics">' + metric(files.length, "files") + metric("+" + number(data.additions), "additions") + metric("−" + number(data.deletions), "deletions") + '</div>';
        const result = failed
          ? '<div class="notice bad">' + escapeHtml(failed) + '</div>'
          : hasChanges ? list(files, "Changes detected") : '<div class="notice">No changes detected.</div>';
        const diff = asText(data.diff, "");
        return card("Changes", asText(data.path, "Workspace review"), failed ? "Unavailable" : hasChanges ? "Review" : "Clean", failed ? "bad" : hasChanges ? "warn" : "good", metrics + result +
          (diff ? fold("Raw diff", codeBlock("Diff", diff), false) : "") +
          (data.status ? fold("Git status", codeBlock("Git", asText(data.status)), false) : ""));
      }

      function renderChangeAnalysis(data) {
        const analysis = data.analysis && typeof data.analysis === "object" ? data.analysis : {};
        const changeCard = renderChanges({ ...data, analysis: undefined });
        const risks = toArray(analysis.risk_signals).map((risk) => typeof risk === "object" ? risk.label || risk.message || risk.path : risk).filter(Boolean);
        const tests = toArray(analysis.related_tests).map(fileName).filter(Boolean);
        const supplemental = '<div class="body">' +
          (risks.length ? '<div class="notice warn">' + escapeHtml(values(risks, 5).join(" · ")) + '</div>' : '') +
          fold("Affected areas", list(analysis.affected_areas, "No affected areas identified"), false) +
          fold("Related tests", list(tests, "No related tests identified"), false) +
          fold("Recommended checks", list(analysis.recommended_commands, "No additional checks suggested"), false) +
          '</div>';
        return changeCard.replace('</section>', supplemental + '</section>');
      }

      function renderStatus(data) {
        const status = asText(data.status, "");
        const failed = asText(data.status_error, "");
        const files = values(data.changed_files, 20);
        const changed = Boolean(data.changed) || files.length > 0;
        return card("Git status", asText(data.path, "Workspace"), failed ? "Unavailable" : changed ? "Changes" : "Clean", failed ? "bad" : changed ? "warn" : "good",
          failed ? '<div class="notice bad">' + escapeHtml(failed) + '</div>' : (changed ? list(files, "No changed files") : '<div class="notice">Working tree is clean.</div>') +
          (status ? fold("Full status", codeBlock("Git", status), false) : ""));
      }

      function renderHandoff(data) {
        const target = asText(data.agent_name || data.agent, "agent");
        const details = factRows([
          ["Target", target],
          ["Plan", '<span class="mono path">' + escapeHtml(asText(data.plan_path, "Not recorded")) + '</span>', true],
          ["Status", '<span class="mono path">' + escapeHtml(asText(data.status_path, "Not recorded")) + '</span>', true],
          ["Changes", "+" + number(data.additions) + " −" + number(data.deletions)]
        ]);
        return card("Handoff ready", target, "Written", "good", '<div class="summary">The implementation plan is available to the selected local agent.</div>' + details +
          (data.diff ? fold("Handoff diff", codeBlock("Diff", asText(data.diff)), false) : ""));
      }

      function renderBash(data) {
        const exitCode = data.exitCode ?? data.exit_code;
        const success = Number(exitCode) === 0 && !data.signal;
        const title = success ? "Verification completed" : "Verification needs attention";
        const command = asText(data.command, "");
        const output = "$ " + command + "\n\n" + (asText(data.stdout, "") || "(no stdout)") + (data.stderr ? "\n\n[stderr]\n" + asText(data.stderr) : "");
        const factsBlock = factRows([
          ["Directory", '<span class="mono path">' + escapeHtml(asText(data.cwd || data.root, "Workspace")) + '</span>', true],
          ["Exit", asText(exitCode, "unknown") + (data.signal ? " · " + asText(data.signal) : "")],
          ["Duration", number(data.durationMs ?? data.duration_ms) ? number(data.durationMs ?? data.duration_ms) + " ms" : "Not reported"]
        ]);
        return card(title, command || "Command finished", success ? "Passed" : "Review", success ? "good" : "warn", factsBlock + codeBlock("Terminal", output, true));
      }

      const CODING_TASK_TOOLS = [
        "create_coding_task", "open_coding_task", "get_coding_task", "list_coding_tasks",
        "transition_coding_task", "run_coding_task", "followup_coding_task", "cancel_coding_task", "review_coding_task"
      ];
      const GOAL_TOOLS = [
        "propose_goal", "get_goal", "list_goals", "approve_goal", "publish_goal_blackboard",
        "start_goal", "refresh_goal", "integrate_goal_work", "review_goal",
        "project_goal", "revert_goal_projection", "pause_goal", "resume_goal", "cancel_goal", "complete_goal", "apply_goal"
      ];

      function normalizedCodingTask(data) {
        const nestedCandidates = [
          data.task,
          data.coding_task,
          data.codingTask,
          record(data.result).task,
          record(data.payload).task,
          record(data.data).task,
          record(data.result).task_id ? data.result : null
        ];
        const nested = nestedCandidates.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
        return {
          ...data,
          ...nested,
          review: {
            ...record(data.review_summary),
            ...record(data.review),
            ...record(nested.review)
          },
          transition: Object.keys(record(nested.transition)).length ? nested.transition : data.transition,
          active_turn: nested.active_turn ?? data.active_turn
        };
      }

      function taskStatus(task, tool = "") {
        const lifecycle = task.lifecycle;
        const activeTurn = record(task.active_turn);
        const raw = typeof lifecycle === "object"
          ? lifecycle.status || lifecycle.state || lifecycle.phase
          : lifecycle;
        const inferred = tool === "cancel_coding_task" ? "canceled"
          : tool === "review_coding_task" ? "needs_review"
          : tool === "transition_coding_task" ? "transitioning"
          : tool === "run_coding_task" || tool === "followup_coding_task" ? "running"
          : "pending";
        return asText(raw || task.status || activeTurn.status || activeTurn.state, inferred).toLowerCase();
      }

      function taskTone(status) {
        if (/fail|error|cancel|aborted/.test(status)) return "bad";
        if (/attention|review|blocked|conflict|waiting|needs|transition|handoff/.test(status)) return "warn";
        if (/complete|completed|done|success|succeeded|closed/.test(status)) return "good";
        return "active";
      }

      function executorLabel(value) {
        return asText(value).toLowerCase().includes("codex") ? "Codex collaboration" : "Direct coding";
      }

      function transitionConfirmed(transition) {
        const readback = transition.authoritative_readback;
        if (readback === true) return true;
        if (typeof readback === "string") return /\b(confirmed|ready|success|succeeded|complete|completed)\b/.test(readback.toLowerCase());
        const value = record(readback);
        return value.confirmed === true || value.succeeded === true || value.ok === true || /\b(confirmed|ready|success|succeeded|complete|completed)\b/.test(asText(value.status || value.state).toLowerCase());
      }

      function taskMode(task, tool) {
        const transition = record(task.transition);
        const status = taskStatus(task, tool);
        const hasTransition = tool === "transition_coding_task" || /transition|handoff/.test(status) || Object.keys(transition).length > 0;
        if (hasTransition) return {
          key: "transition",
          label: transitionConfirmed(transition) ? "Ready for handoff" : "Transitioning",
          transition
        };
        const executor = asText(task.executor).toLowerCase() === "codex" ? "codex" : "direct";
        return { key: executor, label: executorLabel(executor), transition };
      }

      function taskActivity(task, tool, status) {
        const activeTurn = record(task.active_turn);
        const explicit = task.current_activity || task.activity || activeTurn.activity || activeTurn.message || activeTurn.summary || task.progress;
        if (explicit) return asText(explicit);
        if (/fail|error/.test(status)) return "Work stopped before the task could finish.";
        if (/cancel|aborted/.test(status)) return "Work on this task has been canceled.";
        if (/complete|done|success|closed/.test(status)) return "The current work is complete.";
        if (/review|attention|blocked|needs/.test(status)) return "The task is waiting for review or input.";
        if (tool === "followup_coding_task") return "Codex is applying the latest follow-up.";
        if (tool === "run_coding_task") return "The current turn is in progress.";
        return "The task is ready for its next step.";
      }

      function testSummary(value) {
        if (value == null || value === "") return { value: "—", detail: "" };
        if (typeof value === "string") return { value: friendly(value), detail: value };
        if (Array.isArray(value)) {
          const entries = values(value, 8);
          return { value: entries.length + " reported", detail: entries.join(" · ") };
        }
        const tests = record(value);
        const status = asText(tests.status || tests.result || tests.state, "");
        const passed = number(tests.passed, 0);
        const failed = number(tests.failed, 0);
        const valueText = status ? friendly(status) : failed ? failed + " failed" : passed ? passed + " passed" : "Reported";
        const parts = [
          passed ? passed + " passed" : "",
          failed ? failed + " failed" : "",
          asText(tests.command, "")
        ].filter(Boolean);
        return { value: valueText, detail: parts.join(" · ") || detailText(tests) };
      }

      function transitionSummary(mode, task) {
        if (mode.key !== "transition") return "";
        const from = mode.transition.from || task.executor || "direct";
        const to = mode.transition.to || (asText(from).toLowerCase() === "codex" ? "direct" : "codex");
        const confirmed = transitionConfirmed(mode.transition);
        const readback = mode.transition.authoritative_readback;
        const readbackRecord = record(readback);
        const readbackStatus = asText(readbackRecord.status || readbackRecord.state, "");
        const readbackText = confirmed ? "Confirmed" : readback === false || readback == null
          ? "Awaiting authoritative readback"
          : readbackStatus ? friendly(readbackStatus) : "Readback received; confirmation pending";
        const current = confirmed
          ? readbackRecord.executor || task.executor || to
          : readbackRecord.executor || from;
        return factRows([
          ["Current executor", executorLabel(current)],
          ["Handoff", executorLabel(from) + " → " + executorLabel(to)],
          ["Readback", readbackText]
        ]);
      }

      function taskNextAction(task, mode, status) {
        if (task.error || /fail|error/.test(status)) return "Resolve the reported error, then retry from the current executor.";
        if (mode.key === "transition") return transitionConfirmed(mode.transition)
          ? "The handoff is confirmed; continue from the destination executor."
          : "Wait for authoritative readback before continuing work in the destination executor.";
        if (/review|attention|blocked|needs/.test(status)) return "Review the changes and test evidence before continuing.";
        if (/complete|done|success|closed/.test(status)) return "Review the result; transition executors only if more work is needed.";
        if (/cancel|aborted/.test(status)) return "Start a new run when you are ready to resume this task.";
        return mode.key === "codex"
          ? "Continue by sending a follow-up to this Codex task."
          : "Continue editing directly, or transition when you want Codex to take over.";
      }

      function taskCopySummary(task, mode, status, activity, review, tests) {
        const changedFileCount = optionalNumber(review.changed_files_count, review.changedFileCount,
          Array.isArray(review.changed_files) ? review.changed_files.length : review.changed_files);
        const additions = optionalNumber(review.additions);
        const deletions = optionalNumber(review.deletions);
        const changes = changedFileCount === null && additions === null && deletions === null
          ? "Changes: not loaded"
          : "Changes: " + (changedFileCount ?? "—") + " files, " + (additions === null ? "—" : "+" + additions) + " " + (deletions === null ? "—" : "−" + deletions);
        const parts = [
          asText(task.title || task.goal, "Coding task"),
          "Mode: " + mode.label,
          "Status: " + friendly(status),
          activity ? "Activity: " + activity : "",
          changes,
          tests.detail ? "Tests: " + tests.detail : "",
          task.error ? "Error: " + truncate(detailText(task.error), 500) : ""
        ].filter(Boolean);
        return truncate(parts.join("\n"), 1800);
      }

      function renderCodingTaskList(data) {
        const candidates = data.tasks || record(data.result).tasks || record(data.payload).tasks || record(data.data).tasks;
        const tasks = toArray(candidates).filter((task) => task && typeof task === "object").slice(0, 8);
        if (!tasks.length) return card("Coding tasks", "Task workspace", "Empty", "", '<div class="notice">No coding tasks were returned.</div>');
        const rows = tasks.map((rawTask) => {
          const task = normalizedCodingTask({ task: rawTask });
          const status = taskStatus(task, "list_coding_tasks");
          const tone = taskTone(status);
          const mode = taskMode(task, "list_coding_tasks");
          return '<li><span class="task-list-mark ' + tone + '" aria-hidden="true"></span><div class="task-list-main"><div class="task-list-title">' +
            escapeHtml(asText(task.title || task.goal, "Untitled coding task")) + '</div><div class="task-list-meta">' + escapeHtml(mode.label + (task.task_id ? " · " + asText(task.task_id) : "")) +
            '</div></div><div class="task-list-status">' + escapeHtml(friendly(status)) + '</div></li>';
        }).join("");
        const total = number(data.total ?? data.task_count, tasks.length);
        return card("Coding tasks", total + (total === 1 ? " task" : " tasks"), "Ready", "good", '<ul class="task-list">' + rows + '</ul>');
      }

      function renderCodingTask(data, tool) {
        if (tool === "list_coding_tasks") return renderCodingTaskList(data);
        const task = normalizedCodingTask(data);
        const status = taskStatus(task, tool);
        const tone = task.error || data.error ? "bad" : taskTone(status);
        const mode = taskMode(task, tool);
        const review = record(task.review);
        const changedFileSource = review.changed_files ?? task.changed_files;
        const changedFiles = values(changedFileSource, 18);
        const changedFileCount = optionalNumber(
          review.changed_files_count,
          review.changedFileCount,
          task.changed_files_count,
          task.changedFileCount,
          Array.isArray(changedFileSource) ? changedFileSource.length : changedFileSource
        );
        const additions = optionalNumber(review.additions, task.additions);
        const deletions = optionalNumber(review.deletions, task.deletions);
        const tests = testSummary(review.tests ?? task.tests);
        const activity = truncate(taskActivity(task, tool, status), 700);
        const error = detailText(task.error || data.error);
        const diff = detailText(review.diff || task.diff);
        const activeTurn = record(task.active_turn);
        const log = detailText(task.log || task.logs || activeTurn.log || activeTurn.output || task.output);
        const title = truncate(asText(task.title || task.goal, "Coding task"), 180);
        const identity = truncate([task.task_id, mode.label].filter(Boolean).join(" · "), 260);
        const state = '<div class="task-state"><span class="task-state-mark" aria-hidden="true"></span><div class="task-state-copy"><div class="task-mode">' +
          escapeHtml(mode.label) + '</div><div class="task-activity">' + escapeHtml(activity) + '</div></div></div>';
        const metrics = '<div class="metrics">' + metric(changedFileCount ?? "—", "changed files") + metric(additions === null ? "—" : "+" + additions, review.content_complete === false ? "visible additions" : "additions") +
          metric(deletions === null ? "—" : "−" + deletions, review.content_complete === false ? "visible deletions" : "deletions") + metric(tests.value, "tests") + '</div>';
        const summary = truncate(asText(task.summary || review.summary, ""), 1200);
        const overview = summary ? '<div class="summary">' + escapeHtml(summary) + '</div>' : "";
        const errorBlock = error ? '<div class="notice bad" role="alert">' + escapeHtml(truncate(error, 1200)) + '</div>' : "";
        const transitionBlock = transitionSummary(mode, task);
        const contextEntries = [
          ["Worktree", task.worktree_root ? '<span class="mono path">' + escapeHtml(truncate(task.worktree_root, 500)) + '</span>' : "", true],
          ["Base", task.base_head ? '<span class="mono">' + escapeHtml(truncate(task.base_head, 120)) + '</span>' : "", true],
          ["Revision", task.revision],
          ["Thread", task.thread_id],
          ["Turn", task.turn_id || activeTurn.turn_id || activeTurn.id]
        ];
        const hasContext = contextEntries.some((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "");
        const contextFold = hasContext ? fold("Task context", factRows(contextEntries), false) : "";
        const detailFolds = (changedFiles.length ? fold("Changed files", list(changedFiles), false) : "") +
          (tests.detail ? fold("Test evidence", codeBlock("Tests", tests.detail, false, 3200), false) : "") +
          (diff ? fold("Review diff", codeBlock("Diff", diff, true, 6000), false) : "") +
          (log ? fold("Activity log", codeBlock("Log", log, false, 3600), false) : "");
        const next = taskNextAction(task, mode, status);
        const copySummary = taskCopySummary(task, mode, status, activity, {
          ...review,
          changed_files_count: changedFileCount,
          additions,
          deletions
        }, tests);
        if (!diff) copyableText = copySummary;
        const copyButton = !diff && copySummary
          ? '<button type="button" class="copy-card-output task-copy" data-copy-card-output aria-label="Copy task summary">Copy summary</button>'
          : "";
        const nextBlock = '<div class="task-next"><span>' + escapeHtml(next) + '</span>' + copyButton + '</div>';
        return card(title, identity || "CodingTask", friendly(status), tone, state + overview + transitionBlock + metrics + errorBlock + contextFold + detailFolds + nextBlock, "task-card mode-" + mode.key);
      }

      function normalizedGoal(data) {
        const nested = [data.goal, data.orchestration_goal, record(data.result).goal, record(data.payload).goal]
          .find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
        return { ...data, ...nested };
      }

      function renderGoalList(data) {
        const goals = toArray(data.goals || record(data.result).goals).filter((goal) => goal && typeof goal === "object").slice(0, 8);
        if (!goals.length) return card("Goals", "Pro orchestration", "Empty", "", '<div class="notice">No durable Goals were returned.</div>');
        const rows = goals.map((rawGoal) => {
          const goal = normalizedGoal({ goal: rawGoal });
          const status = asText(goal.lifecycle || goal.status, "proposed").toLowerCase();
          const scheduler = record(goal.scheduler);
          const health = goal.executionPolicy === "persistent" || goal.execution_policy === "persistent"
            ? " · scheduler " + friendly(asText(scheduler.status, goal.scheduler_alive ? "running" : "not started"))
            : "";
          return '<li><span class="task-list-mark ' + taskTone(status) + '" aria-hidden="true"></span><div class="task-list-main"><div class="task-list-title">' +
            escapeHtml(asText(goal.title, "Untitled Goal")) + '</div><div class="task-list-meta">' + escapeHtml(asText(goal.goal_id || goal.goalId, "Goal")) +
            escapeHtml(health) + '</div></div><div class="task-list-status">' + escapeHtml(friendly(status)) + '</div></li>';
        }).join("");
        return card("Goals", goals.length + (goals.length === 1 ? " Goal" : " Goals"), "Ready", "good", '<ul class="task-list">' + rows + '</ul>', "task-card");
      }

      function renderGoal(data, tool) {
        if (tool === "list_goals") return renderGoalList(data);
        const goal = normalizedGoal(data);
        const lifecycle = asText(goal.lifecycle || goal.status, "proposed").toLowerCase();
        const approval = record(goal.approval);
        const work = toArray(goal.work).filter((item) => item && typeof item === "object");
        const completed = optionalNumber(data.completed_work_count) ?? work.filter((item) => ["integrated", "waiting_review"].includes(asText(item.status))).length;
        const running = optionalNumber(data.running_work_count) ?? work.filter((item) => ["launching", "running", "continuing"].includes(asText(item.status))).length;
        const blocked = optionalNumber(data.blocked_work_count) ?? work.filter((item) => ["blocked", "failed"].includes(asText(item.status))).length;
        const goalId = asText(goal.goal_id || goal.goalId, "Goal");
        const approvalStatus = asText(approval.status, "pending").toLowerCase();
        const workspacePolicy = asText(goal.workspacePolicy || goal.workspace_policy, "isolated").toLowerCase();
        const executionPolicy = asText(goal.executionPolicy || goal.execution_policy, "supervised").toLowerCase();
        const persistent = executionPolicy === "persistent";
        const limits = record(goal.limits);
        const retryPolicy = record(goal.retryPolicy || goal.retry_policy);
        const maxRetries = optionalNumber(limits.maxRetriesPerWorker, limits.max_retries_per_worker) ?? 0;
        const scheduler = record(data.scheduler || goal.scheduler_health);
        const schedulerAlive = data.scheduler_alive === true || scheduler.runner_alive === true;
        const schedulerStranded = data.scheduler_stranded === true || scheduler.stranded === true;
        const recoveryNeeded = data.recovery_needed === true || scheduler.recovery_needed === true;
        const permissions = record(goal.permissions);
        const sourceEffects = record(permissions.sourceEffects || permissions.source_effects);
        const liveAllowed = workspacePolicy === "live" && sourceEffects.apply === true;
        const liveSupported = data.live_projection_supported !== false;
        const live = record(goal.live || data.live);
        const liveProjections = toArray(live.projections).filter((item) => item && typeof item === "object");
        const projection = record(data.projection || liveProjections[liveProjections.length - 1] || goal.liveProjection || goal.live_projection);
        const projectionStatus = asText(projection.status, liveAllowed ? "not projected" : "not enabled").toLowerCase();
        const integrationHead = asText(goal.integrationHeadSha || goal.integration_head_sha || data.integration_head_sha, "Not integrated");
        const projectedHead = asText(live.projectedIntegrationSha || live.projected_integration_sha || projection.toIntegrationSha || projection.to_integration_sha || projection.integrationHeadSha || projection.integration_head_sha || projection.targetIntegrationHeadSha || projection.target_integration_head_sha, "");
        const hasBackoff = work.some((item) => toArray(item.turns).some((turn) => toArray(record(turn).attempts).some((attempt) => asText(record(attempt).status) === "backoff")));
        const activity = approvalStatus === "pending" ? "The persisted contract is waiting for explicit approval."
          : lifecycle === "approved" ? "The exact contract is approved; execution remains inert until start_goal."
          : persistent && lifecycle === "waiting_review" ? "Automatic private integration is complete; Pro review and final judgment remain explicit."
          : persistent && hasBackoff ? "A fresh attempt is waiting for its approved deterministic retry deadline; the semantic turn has not been consumed."
          : persistent && schedulerStranded ? "The passive health observation suggests the detached scheduler needs explicit recovery."
          : persistent && schedulerAlive ? "The detached scheduler is observed alive under the approved persistent contract."
          : "The local engine is reporting authoritative Goal state.";
        const state = '<div class="task-state"><span class="task-state-mark" aria-hidden="true"></span><div class="task-state-copy"><div class="task-mode">Pro orchestration</div><div class="task-activity">' + escapeHtml(activity) + '</div></div></div>';
        const goalReview = record(goal.review || data.review);
        const reviewChangedPaths = Array.isArray(goalReview.changedPaths) ? goalReview.changedPaths : Array.isArray(goalReview.changed_paths) ? goalReview.changed_paths : null;
        const reviewChangedFileCount = optionalNumber(data.changed_files_count, reviewChangedPaths ? reviewChangedPaths.length : null, goalReview.changed_files_count, goalReview.changedFileCount);
        const metrics = '<div class="metrics">' + metric(completed + "/" + work.length, "work ready") + metric(running, "running") + metric(blocked, "blocked") + (reviewChangedFileCount === null ? metric(number(data.blackboard_count, toArray(goal.blackboard).length), "records") : metric(reviewChangedFileCount, "changed files")) + '</div>';
        const rows = work.slice(0, 12).map((item) => {
          const dependencies = toArray(item.dependsOn || item.depends_on).map(asText).filter(Boolean);
          const turns = toArray(item.turns).filter((turn) => turn && typeof turn === "object");
          const authorizedTurns = optionalNumber(item.authorizedTurnCount, item.authorized_turn_count) ?? (1 + toArray(item.continuationIntents || item.continuation_intents).length);
          const completedTurns = optionalNumber(item.completedTurnCount, item.completed_turn_count) ?? turns.filter((turn) => asText(turn.status) === "succeeded").length;
          const turnMeta = persistent ? " · turn " + Math.min(turns.length, authorizedTurns) + "/" + authorizedTurns + " · " + completedTurns + " completed" : "";
          const attemptCount = optionalNumber(item.attemptCount, item.attempt_count) ?? turns.reduce((count, turn) => count + Math.max(1, toArray(record(turn).attempts).length), 0);
          const retriesUsed = optionalNumber(item.retriesUsed, item.retries_used) ?? Math.max(0, attemptCount - turns.length);
          const retryMeta = persistent ? " · " + attemptCount + " attempt" + (attemptCount === 1 ? "" : "s") + " · retries " + retriesUsed + "/" + maxRetries : "";
          return '<li><span class="task-list-mark ' + taskTone(asText(item.status, "planned")) + '" aria-hidden="true"></span><div class="task-list-main"><div class="task-list-title">' +
            escapeHtml(asText(item.title, item.workId || item.work_id || "Work")) + '</div><div class="task-list-meta">' + escapeHtml(asText(item.workId || item.work_id, "") + (dependencies.length ? " · after " + dependencies.join(", ") : "")) +
            escapeHtml(turnMeta + retryMeta) + '</div></div><div class="task-list-status">' + escapeHtml(friendly(asText(item.status, "planned"))) + '</div></li>';
        }).join("");
        const workBlock = rows ? '<ul class="task-list">' + rows + '</ul>' : '<div class="empty">No work items.</div>';
        const context = factRows([
          ["Approval", friendly(approvalStatus)],
          ["Policy", friendly(executionPolicy) + " · " + friendly(workspacePolicy)],
          ["Turns / retries", persistent ? "1-4 semantic turns · " + maxRetries + " total fresh retries per work item" : "1 semantic turn · no retries"],
          ["Retry policy", persistent ? friendly(asText(retryPolicy.algorithm, "infra-pre-turn-v1")) + " · " + toArray(retryPolicy.backoffMs || retryPolicy.backoff_ms).map((value) => number(value) + "ms").join(" / ") : "Not applicable"],
          ["Scheduling", persistent ? (schedulerAlive ? "Observed alive" : schedulerStranded ? "Observed stranded · recovery needed" : friendly(asText(scheduler.status, "not started"))) : "Explicit Pro actions"],
          ["Live permission", !liveSupported ? "Unavailable on this platform" : liveAllowed ? "Approved source projection" : "Not approved"],
          ["Revision", goal.revision],
          ["Base", '<span class="mono">' + escapeHtml(truncate(goal.baseSha || goal.base_sha, 120)) + '</span>', true],
          ["Contract", '<span class="mono">' + escapeHtml(truncate(goal.contractFingerprint || goal.contract_fingerprint, 120)) + '</span>', true]
        ]);
        const records = toArray(goal.blackboard).slice(-8).map((item) => asText(item.kind, "record") + ": " + asText(item.summary)).filter(Boolean);
        const recordsFold = records.length ? fold("Blackboard", list(records), false) : "";
        const review = goalReview;
        const diff = detailText(review.diff);
        const reviewFold = diff ? fold("Integrated diff", codeBlock("Diff", diff, true, 6000), false) : "";
        const criteria = toArray(goal.completionCriteria || goal.completion_criteria).map(asText).filter(Boolean);
        const criteriaFold = criteria.length ? fold("Completion criteria", list(criteria), false) : "";
        const retryableFailures = toArray(retryPolicy.retryableFailures || retryPolicy.retryable_failures).map((entry) => {
          const value = record(entry);
          return friendly(asText(value.code, "unknown")) + " · " + friendly(asText(value.category, "unknown")) + " · " + friendly(asText(value.phase, "unknown")) + " · outcome known · turn not started";
        });
        const retryPolicyFold = persistent ? fold("Retry policy authority", factRows([
          ["Algorithm", friendly(asText(retryPolicy.algorithm, "infra-pre-turn-v1"))],
          ["Backoff", toArray(retryPolicy.backoffMs || retryPolicy.backoff_ms).map((value) => number(value) + "ms").join(" / ")],
          ["Fingerprint", '<span class="mono">' + escapeHtml(truncate(asText(retryPolicy.fingerprint, "Unavailable"), 120)) + '</span>', true],
          ["Retryable failures", retryableFailures.length ? list(retryableFailures) : "None", retryableFailures.length > 0]
        ]), false) : "";
        const turnHistory = work.slice(0, 12).flatMap((item) => {
          const intents = toArray(item.continuationIntents || item.continuation_intents).map((intent) => {
            const value = record(intent);
            return asText(item.workId || item.work_id, "work") + " · approved " + asText(value.intentId || value.intent_id, "continuation") + " · " + truncate(asText(value.promptSummary || value.prompt_summary, "Prompt hidden"), 180) + " · " + truncate(asText(value.fingerprint, ""), 18);
          });
          const turns = toArray(item.turns).map((turn) => {
            const value = record(turn);
            const attempts = toArray(value.attempts).map((attempt) => {
              const attemptValue = record(attempt);
              const failure = record(attemptValue.failure);
              const attemptNumber = optionalNumber(attemptValue.attemptNumber, attemptValue.attempt_number) ?? ((optionalNumber(attemptValue.attemptIndex, attemptValue.attempt_index) ?? 0) + 1);
              const failureMeta = failure.code
                ? " · " + friendly(asText(failure.code)) + " / " + friendly(asText(failure.category)) + " · outcome " + (failure.outcomeKnown === true ? "known" : "unknown") + " · " + (failure.retryable === true ? "retryable" : "not retryable")
                : "";
              const notBefore = asText(attemptValue.notBefore || attemptValue.not_before, "");
              return asText(item.workId || item.work_id, "work") + " · turn " + asText(value.turnIndex || value.turn_index, "?") + " · attempt " + attemptNumber + " · " + friendly(asText(attemptValue.status, "reserved")) + (notBefore && asText(attemptValue.status) === "backoff" ? " · not before " + notBefore : "") + failureMeta;
            });
            const turnLine = asText(item.workId || item.work_id, "work") + " · semantic turn " + asText(value.turnIndex || value.turn_index, "?") + " · " + friendly(asText(value.status, "reserved")) + " · " + friendly(asText(value.stopReason || value.stop_reason, "in progress"));
            return [turnLine, ...attempts];
          }).flat();
          return [...intents, ...turns];
        });
        const turnHistoryFold = persistent && turnHistory.length ? fold("Approved turns and attempt history", list(turnHistory), false) : "";
        const application = record(goal.sourceApplication || goal.source_application);
        const projectionError = asText(data.error || projection.error || goal.error, "");
        const publicErrorRecorded = data.has_error === true || goal.hasError === true || projection.hasError === true || application.hasError === true || scheduler.has_error === true;
        const projectionErrorBlock = projectionError
          ? '<div class="notice bad">' + escapeHtml(projectionError) + '</div>'
          : publicErrorRecorded ? '<div class="notice bad">An error is recorded in private Goal state. Review the safe status, classification, and hashes; raw error text and private paths are intentionally hidden.</div>' : "";
        const liveProjectionFact = !liveSupported ? "Unavailable on this platform" : liveAllowed
          ? escapeHtml(friendly(projectionStatus)) + (projectedHead ? ' · <span class="mono">' + escapeHtml(truncate(projectedHead, 80)) + '</span>' : "")
          : "Not approved";
        const stages = fold("Delivery stages", factRows([
          ["Integration checkpoint", '<span class="mono">' + escapeHtml(truncate(integrationHead, 120)) + '</span>', true],
          ["Private integration", persistent ? "Only after the final authorized turn passes terminal + provenance + path/content checks" : "Explicit Pro-reviewed action"],
          ["Live projection", liveProjectionFact, true],
          ["Final application", friendly(asText(application.status, "not applied")) + (application.zeroWrite === true ? " · adopted without rewrite" : "")]
        ]), true);
        const availableActions = toArray(data.available_actions || goal.available_actions).map((action) => typeof action === "object" ? asText(action.label || action.tool) : asText(action)).filter(Boolean);
        const actionsFold = availableActions.length ? fold("Available actions", list(availableActions), true) : "";
        const next = lifecycle === "proposed" ? (persistent ? "Review every semantic turn and the fingerprinted retry policy separately. The scheduler never invents prompts. Fresh retries repeat the exact prompt with a new operation ID, never consume a turn, and cannot expand the fixed pre-turn infrastructure allowlist; private integration still waits for the final authorized turn." : "Review the complete one-turn, zero-retry contract and fingerprint; approve only after the user explicitly agrees.")
          : lifecycle === "approved" ? (persistent ? "The contract is approved and inert. Start persistent scheduling explicitly when the execution gate is enabled." : "The contract is approved and remains inert until an explicit execution action.")
          : !liveSupported && workspacePolicy === "live" ? "Live projection is unavailable on this platform; inspect existing state without attempting a source mutation."
          : lifecycle === "paused" ? (persistent ? "Scheduling is durably paused. In-flight evidence may finish, but no backoff retry, next turn, or integration launches until resume_goal explicitly wakes the scheduler." : "Scheduling is paused; already-running workers retain only their approved leases.")
          : lifecycle === "canceling" ? "Cancellation authority is persisted before any scheduled backoff retry. Use refresh_goal for store-only reconciliation; no scheduler or Codex process is relaunched."
          : lifecycle === "canceled" ? "The Goal is canceled; review any isolated partial work before deciding on a new Goal."
          : lifecycle === "completed" && application.status === "applied" ? "The completed Goal result is finalized in source with persisted readback."
          : lifecycle === "completed" && liveAllowed && /projected|applied/.test(projectionStatus) ? "The completed checkpoint is already projected; final application should adopt it without writing the source twice."
          : lifecycle === "completed" ? "The integrated result is complete; source application still requires its separate approved action."
          : liveAllowed && /failed|conflict|recovery/.test(projectionStatus) ? "Live projection needs recovery; retry only with the same key or explicitly revert the recorded projection."
          : liveAllowed && integrationHead !== "Not integrated" && !/projected|applied/.test(projectionStatus) ? "Review the exact integration checkpoint, then explicitly project its fingerprint into source."
          : recoveryNeeded ? "Recover only through start_goal with the original start key and the execution gate enabled; passive reads never relaunch work."
          : hasBackoff ? "Wait for the displayed deterministic not-before time. Same-operation recovery is not a retry; the fresh attempt gets a new operation ID and repeats the exact approved prompt."
          : work.some((item) => asText(item.status) === "continuing") ? "An intermediate authorized turn succeeded but remains private and non-integrable. The scheduler may execute only the next approved continuation; dependencies stay locked until the final authorized turn succeeds."
          : /review/.test(lifecycle) ? "All authorized turns finished. Review the private integrated checkpoint and evidence; completion remains an explicit Pro judgment."
          : /failed|blocked/.test(lifecycle) ? "Inspect the blocker and let Pro decide whether a bounded replan is required."
          : "Use authoritative Goal status for the next Pro-supervised action.";
        return card(truncate(asText(goal.title, "Goal"), 180), goalId + " · " + friendly(approvalStatus), friendly(lifecycle), taskTone(lifecycle),
          state + metrics + context + stages + projectionErrorBlock + workBlock + criteriaFold + retryPolicyFold + turnHistoryFold + recordsFold + reviewFold + actionsFold + '<div class="task-next"><span>' + escapeHtml(next) + '</span></div>', "task-card goal-card");
      }

      function renderGeneric(data) {
        const title = asText(data.codexpro_title, "Tool result");
        const preview = JSON.stringify(data, null, 2);
        return card(title, "CodexPro", "Ready", "good", codeBlock("Result", preview));
      }

      function renderUnavailable() {
        copyableText = "";
        root.innerHTML = card("Result unavailable", "CodexPro", "Retry", "warn", '<div class="notice">The tool finished, but its display data did not reach this card. Refresh the ChatGPT plugin connection and try the action once more.</div>');
      }

      function renderPending() {
        copyableText = "";
        root.innerHTML = card("Preparing result", "CodexPro", "Loading", "", '<div class="notice">Loading the tool result…</div>', "pending");
      }

      function render(data) {
        if (!data || typeof data !== "object") return false;
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        copyableText = "";
        const tool = asText(data.codexpro_tool, "");
        if (tool === "open_current_workspace" || tool === "open_workspace" || tool === "workspace_snapshot") root.innerHTML = renderWorkspace(data);
        else if (tool === "inspect_workspace") root.innerHTML = renderWorkspaceAnalysis(data);
        else if (tool === "git_status") root.innerHTML = renderStatus(data);
        else if (tool === "show_changes") root.innerHTML = data.analysis ? renderChangeAnalysis(data) : renderChanges(data);
        else if (tool === "handoff_to_agent" || tool === "handoff_to_codex") root.innerHTML = renderHandoff(data);
        else if (tool === "bash") root.innerHTML = renderBash(data);
        else if (CODING_TASK_TOOLS.includes(tool)) root.innerHTML = renderCodingTask(data, tool);
        else if (GOAL_TOOLS.includes(tool)) root.innerHTML = renderGoal(data, tool);
        else root.innerHTML = renderGeneric(data);
        return true;
      }

      function renderFromHost(value) {
        const data = extractStructuredContent(value);
        if (data) render(data);
      }

      root.addEventListener("click", async (event) => {
        const target = event.target instanceof Element ? event.target.closest("[data-copy-card-output]") : null;
        if (!target || !copyableText) return;
        const original = target.textContent;
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(copyableText);
          target.textContent = "Copied";
        } catch {
          target.textContent = "Copy unavailable";
        }
        window.setTimeout(() => { target.textContent = original || "Copy"; }, 1400);
      });

      applyHostTheme();
      renderPending();
      fallbackTimer = window.setTimeout(renderUnavailable, 1200);
      renderFromHost(window.openai?.toolOutput || window.openai?.toolResponseMetadata || window.openai?.toolResult || {});
      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals || window.openai || {};
        applyHostTheme(globals);
        renderFromHost(globals.toolOutput || globals.toolResponseMetadata || globals.toolResult || globals);
      });
      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.type === "ui/notifications/tool-result" || message.method === "ui/notifications/tool-result") {
          renderFromHost(message.params || message.data || message);
        }
      });
    })();
  </script>
</body>
</html>`;
