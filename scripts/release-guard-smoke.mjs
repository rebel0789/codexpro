import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These harnesses realpath and stat the paths CodexPro returns, so they need the raw
// absolute form. Production defaults to redacted labels; see the redaction assertions
// at the end of scripts/smoke.mjs for coverage of the default behaviour.
process.env.CODEXPRO_EXPOSE_ABSOLUTE_PATHS = '1';

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "package.json"), "utf8"));

assert.equal(manifest.scripts.prepublishOnly, "node scripts/release-guard.mjs");
assert.equal(manifest.scripts["release:guard"], "node scripts/release-guard.mjs");
assert.equal(manifest.scripts["release:pack"], "node scripts/release-pack.mjs");
assert.equal(manifest.scripts["release:publish"], "node scripts/release-publish.mjs");

function run(command, args, { cwd, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

const wrongCwd = mkdtempSync(join(tmpdir(), "codexpro-release-guard-"));

try {
  const allowed = run(process.execPath, ["scripts/release-guard.mjs"], { cwd: root });
  assert.equal(allowed.status, 0, allowed.output);
  assert.match(allowed.output, /CodexPro release guard: codexpro@\d+\.\d+\.\d+/);

  const wrongDirectory = run(process.execPath, [join(root, "scripts/release-guard.mjs")], { cwd: wrongCwd });
  assert.notEqual(wrongDirectory.status, 0, wrongDirectory.output);
  assert.match(wrongDirectory.output, /Release commands must run from the CodexPro root/);

  const prefixArgs = ["--prefix", root, "run", "release:guard", "--silent"];
  const prefixInvocation = npmCli
    ? run(process.execPath, [npmCli, ...prefixArgs], { cwd: wrongCwd })
    : run(npm, prefixArgs, { cwd: wrongCwd });
  assert.notEqual(prefixInvocation.status, 0, prefixInvocation.output);
  assert.match(prefixInvocation.output, /Release commands must run from the CodexPro root/);

  const packed = run(process.execPath, ["scripts/release-pack.mjs"], { cwd: root });
  assert.equal(packed.status, 0, packed.output);
  const tarball = JSON.parse(packed.output);
  assert.equal(tarball.name, "codexpro");
  assert.match(tarball.version, /^\d+\.\d+\.\d+$/);
  assert.equal(tarball.filename, `codexpro-${tarball.version}.tgz`);
} finally {
  rmSync(wrongCwd, { recursive: true, force: true });
}

console.log("✓ release guard smoke test passed");
