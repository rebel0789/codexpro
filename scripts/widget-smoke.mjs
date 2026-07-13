import assert from "node:assert/strict";
import { toolCardWidgetHtml } from "../dist/toolCardWidget.js";

const scripts = [...toolCardWidgetHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const widgetScript = scripts.at(-1)?.[1];
if (!widgetScript) throw new Error("tool-card widget script missing");

class FakeElement {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  closest(selector) {
    return selector === "[data-copy-card-output]" ? this : null;
  }
}

function mount(openai = {}) {
  const root = new FakeElement();
  const timers = [];
  const listeners = new Map();
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      return id === "root" ? root : null;
    }
  };
  const window = {
    openai,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    addEventListener(name, listener) {
      listeners.set(name, listener);
    }
  };
  let copied = "";
  const navigator = {
    clipboard: {
      async writeText(value) {
        copied = value;
      }
    }
  };
  new Function("window", "document", "navigator", "Element", widgetScript)(window, document, navigator, FakeElement);
  return {
    root,
    timers,
    listeners,
    document,
    copied: () => copied
  };
}

const bashPayload = {
  codexpro_tool: "bash",
  command: "npm run check",
  cwd: "/tmp/workspace",
  exitCode: 0,
  durationMs: 437,
  stdout: "✓ checks passed",
  stderr: ""
};

const nested = mount({
  theme: "light",
  toolOutput: { result: { payload: { structuredContent: bashPayload } } }
});
assert.match(nested.root.innerHTML, /Verification completed/);
assert.match(nested.root.innerHTML, /npm run check/);
assert.match(nested.root.innerHTML, /Passed/);
assert.equal(nested.document.documentElement.dataset.theme, "light");

const copyButton = new FakeElement();
await nested.root.listeners.get("click")({ target: copyButton });
assert.match(nested.copied(), /\$ npm run check/);
assert.equal(copyButton.textContent, "Copied");

const delayed = mount();
assert.match(delayed.root.innerHTML, /Preparing result/);
delayed.listeners.get("openai:set_globals")({
  detail: {
    globals: {
      theme: "dark",
      mcp_tool_result: {
        structuredContent: {
          codexpro_tool: "open_workspace",
          root: "/tmp/workspace",
          agents_loaded: true,
          tool_mode: "standard",
          write_mode: "handoff",
          bash_mode: "safe",
          git_status: "working tree clean"
        }
      }
    }
  }
});
assert.match(delayed.root.innerHTML, /Connected workspace/);
assert.equal(delayed.document.documentElement.dataset.theme, "dark");

const unavailable = mount();
assert.equal(unavailable.timers.length, 1);
unavailable.timers[0].callback();
assert.match(unavailable.root.innerHTML, /Result unavailable/);

console.log("✓ widget smoke test passed");
