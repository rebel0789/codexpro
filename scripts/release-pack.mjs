import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODEXPRO_PACKAGE, assertCodexProReleaseEnvironment } from "./release-guard.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCliCandidate = process.env.npm_execpath ||
  (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : undefined);
const npmCli = npmCliCandidate && existsSync(npmCliCandidate) ? npmCliCandidate : undefined;

function fail(message) {
  throw new Error(message);
}

try {
  const release = assertCodexProReleaseEnvironment();
  const packArgs = ["pack", "--dry-run", "--ignore-scripts", "--json"];
  const packed = spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...packArgs] : packArgs, {
    cwd: release.root,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: release.root }
  });

  if (packed.error) fail(`npm pack could not start: ${packed.error.message}`);
  if (packed.status !== 0) fail(`npm pack failed: ${(packed.stderr || packed.stdout).trim()}`);

  let packages;
  try {
    packages = JSON.parse(packed.stdout);
  } catch {
    fail("npm pack did not return a JSON package manifest.");
  }
  const tarball = Array.isArray(packages) ? packages[0] : null;
  if (!tarball || tarball.name !== CODEXPRO_PACKAGE || tarball.version !== release.version) {
    fail(`Expected ${CODEXPRO_PACKAGE}@${release.version}; npm pack selected ${tarball?.name ?? "(missing)"}@${tarball?.version ?? "(missing)"}.`);
  }
  if (tarball.filename !== `${CODEXPRO_PACKAGE}-${release.version}.tgz`) {
    fail(`Unexpected tarball filename: ${tarball.filename ?? "(missing)"}.`);
  }
  const forbiddenInternal = (tarball.files ?? [])
    .map((entry) => entry.path)
    .filter((file) => file.startsWith("docs/superpowers/"));
  if (forbiddenInternal.length) {
    fail(`Internal planning files entered the public tarball: ${forbiddenInternal.join(", ")}.`);
  }

  console.log(JSON.stringify({
    name: tarball.name,
    version: tarball.version,
    filename: tarball.filename,
    size: tarball.size,
    unpackedSize: tarball.unpackedSize
  }, null, 2));
} catch (error) {
  console.error(`[release pack] ${error.message}`);
  process.exitCode = 1;
}
