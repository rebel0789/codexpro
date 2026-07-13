# ChatGPT-native tool cards

## Goal

Replace CodexPro's heavy, branded v9 widget with small, ChatGPT-native-feeling
result cards. The cards should make a workspace session easier to scan without
trying to copy or control ChatGPT's private Activity UI.

The current user-visible failure is also functional: a v9 card can remain on
its `Waiting for tool result...` skeleton even after ChatGPT has produced the
answer. The new renderer must show an actual result when one is present and
must never leave a permanent animated placeholder when delivery fails.

## Chosen approach

Use a decoupled, render-only card surface:

1. Preserve all existing CodexPro MCP tools and their normal structured/text
   results.
2. Attach the widget only to intentionally user-visible results:
   `open_current_workspace`, `open_workspace`, `workspace_snapshot`,
   `inspect_workspace`, `show_changes`, `git_status`, handoffs, and `bash`.
3. Keep raw file reads, searches, writes, edits, patches, inventory and server
   configuration as normal tool output. This prevents repeated iframe renders
   during exploratory work and keeps the model's data path unchanged.
4. Publish a new v10 resource URI so ChatGPT reloads the renderer instead of
   continuing to use a cached v9 iframe. Keep v9 available as a compatibility
   resource for already-loaded clients.

This follows the current Apps SDK guidance to keep data tools separate from UI
rendering tools. It does not add a remote service, external assets, telemetry,
or any new file/command capability.

## Card design

Cards use the host system font, transparent background, 10-12px spacing, a
subtle neutral border, and no gradient, accent rail, product badge, or animated
loading chrome. They inherit the ChatGPT light/dark theme from the component
bridge and remain readable in either mode.

Each card has one compact header: operation label, a plain-language result
summary, and a small status label. Its body contains only the information a
user needs to decide what to do next.

- **Workspace:** project root, available tools, rules file, and a short Git
  state. Long inventories remain collapsed.
- **Workspace analysis / changes:** three small counts, affected files, likely
  tests or risk signals, and a collapsible diff or detail area.
- **Terminal:** command, exit state, duration, and a bounded code preview.
  Standard output and errors remain collapsible rather than taking over the
  chat.
- **Handoff:** plan/status paths and a short next-step summary.
- **Git status:** changed files with clear status markers.

Cards do not repeat the assistant's prose answer. They give an inspectable
receipt for the work that produced it.

## Reliable result delivery

The v10 bridge adapter will accept the documented `toolOutput` and
`toolResponseMetadata` globals plus `openai:set_globals` and MCP
`ui/notifications/tool-result` messages. It will recursively unwrap the
standard MCP result envelope, rather than assuming `structuredContent` always
appears at one fixed depth.

The initial state will be a quiet non-animated placeholder. If no usable
result arrives, it becomes an explicit compact unavailable state instead of an
infinite skeleton. No result content is fabricated.

## Security and boundaries

The widget continues to have an empty network/resource CSP. It uses no remote
font, image, stylesheet, analytics, iframe, external link, browser storage, or
tool invocation from the UI. Existing redaction, payload bounds, filesystem
guarding, and tool-mode gates remain unchanged.

## Validation

1. Update focused HTTP smoke assertions for the v10 resource, descriptor
   attachment scope, CSP metadata, and representative structured result.
2. Add unit-like widget-source assertions for bridge envelope extraction and
   the no-permanent-spinner fallback.
3. Run the TypeScript build, the focused HTTP smoke test, the shared smoke
   suite, stress test, and whitespace check.
4. Restart the isolated npm beta serving the Web3 agent workspace with cards
   enabled, refresh the existing ChatGPT plugin, and verify one workspace card
   and one terminal/change card visually in ChatGPT.

## Out of scope

- Recreating ChatGPT's first-party Activity sidebar or internal tool UI.
- Changing CodexPro's available tools, approval model, paths, or write policy.
- Changing the Web3 agent project.
- Adding user controls that could execute local commands or alter workspace
  state from inside a card.
