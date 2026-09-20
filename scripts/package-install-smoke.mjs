import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CODEXPRO_PACKAGE, assertCodexProReleaseEnvironment } from "./release-guard.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function runNpm(args, cwd) {
  return spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...args] : args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: cwd }
  });
}

function requireSuccess(result, label) {
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${(result.stderr || result.stdout || "no output").trim()}`);
  }
  return result;
}

const release = assertCodexProReleaseEnvironment();
const scratch = mkdtempSync(join(tmpdir(), "codexpro-package-smoke-"));
const packDir = join(scratch, "pack");
const consumerDir = join(scratch, "consumer");
mkdirSync(packDir);
mkdirSync(consumerDir);

try {
  const packed = requireSuccess(
    runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], release.root),
    "npm pack"
  );
  const packages = JSON.parse(packed.stdout);
  const tarball = Array.isArray(packages) ? packages[0] : null;
  assert.equal(tarball?.name, CODEXPRO_PACKAGE);
  assert.equal(tarball?.version, release.version);

  const tarballPath = join(packDir, tarball.filename);
  const installed = requireSuccess(
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarballPath], consumerDir),
    "clean package install"
  );
  assert.match(installed.stdout, /added \d+ package/);

  const packageDir = join(consumerDir, "node_modules", CODEXPRO_PACKAGE);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  assert.equal(manifest.version, release.version);

  for (const command of ["codexpro", "codexpro-mcp", "codexpro-mcp-http"]) {
    const entrypoint = manifest.bin?.[command];
    assert.equal(typeof entrypoint, "string", `Missing ${command} package entrypoint.`);
    const result = spawnSync(process.execPath, [resolve(packageDir, entrypoint), "--version"], {
      cwd: consumerDir,
      encoding: "utf8"
    });
    requireSuccess(result, `${command} --version`);
    assert.equal(result.stdout.trim(), release.version, `${command} reported the wrong version.`);
  }

  console.log(`✓ installed package smoke test passed for ${CODEXPRO_PACKAGE}@${release.version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
