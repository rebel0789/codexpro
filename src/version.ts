import { readFileSync } from "node:fs";

type PackageManifest = {
  name?: unknown;
  version?: unknown;
};

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as PackageManifest;

if (manifest.name !== "codexpro" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error("CodexPro package metadata is missing a valid version.");
}

export const CODEXPRO_VERSION = manifest.version;
