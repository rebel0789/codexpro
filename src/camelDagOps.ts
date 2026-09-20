import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProError } from "./guard.js";

const DAG_SCHEMA = "codexpro.camel-cpu-dag.receipt.v1";
const MAX_STDIO_BYTES = 2_000_000;
const CAPABILITIES = Object.freeze([
  "hash.sha256",
  "inventory.canonicalize",
  "inventory.identity",
  "text.uppercase"
]);

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function jarPath(): string {
  return path.join(projectRoot(), "camel-cpu-dag", "target", "codexpro-camel-cpu-dag.jar");
}

function policyRoot(): string | null {
  const policy = path.join(
    projectRoot(),
    "camel-cpu-dag",
    "src",
    "main",
    "resources",
    "com",
    "synexia",
    "codexpro",
    "dag",
    "dag-admission.drl"
  );
  if (!fs.existsSync(policy)) return null;
  const field = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}\n`;
  const rules = fs.readFileSync(policy, "utf8");
  return createHash("sha256")
    .update(field("codexpro.dag-admission.v1") + field(rules), "utf8")
    .digest("hex");
}

function sha256File(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function javaAvailable(): boolean {
  const result = spawnSync("java", ["-version"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10_000
  });
  return !result.error && result.status === 0;
}

function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000
    });
    if (killed.status !== 0) child.kill();
    return;
  }
  try { child.kill("SIGKILL"); } catch {}
}

export function camelDagContract() {
  const jar = jarPath();
  return {
    schema: "codexpro.camel-cpu-dag.contract.v1",
    engine: "Apache Camel 4.22.1 LTS",
    rules_engine: "Apache Drools 10.1.0",
    java_release: 17,
    planner: {
      role: "propose-data-only",
      endpoint_uris_allowed: false,
      shell_allowed: false,
      model_on_hot_path: false
    },
    compiler: {
      fail_closed: true,
      policy: "project-owned DRL evaluated by an embedded stateless KIE session",
      policy_root: policyRoot(),
      allowlisted_capability_ids_only: true,
      capabilities: CAPABILITIES
    },
    route: ["admit", "split", "allowlisted-route", "bounded-seda", "stable-fan-in", "sha256-receipt"],
    physical_limits: {
      max_items: 512,
      max_payload_bytes_per_item: 65_536,
      max_total_payload_bytes: 4_194_304,
      queue_size_per_capability: 64,
      max_workers: 8,
      cpu_worker_fraction: 0.8
    },
    logical_route_growth: "capability-registry",
    runtime: {
      jar,
      jar_present: fs.existsSync(jar),
      jar_sha256: sha256File(jar),
      java_present: javaAvailable()
    },
    proof: {
      input_hashes: true,
      output_hashes: true,
      stable_input_order: true,
      replayable_receipt_root: true
    }
  } as const;
}

export async function runCamelDag(requestJson: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const inputBytes = Buffer.byteLength(requestJson, "utf8");
  if (inputBytes < 2 || inputBytes > 1_000_000) {
    throw new CodexProError("Camel DAG request must be between 2 and 1000000 UTF-8 bytes.");
  }
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(requestJson);
  } catch {
    throw new CodexProError("Camel DAG request is not valid JSON.");
  }
  if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput)) {
    throw new CodexProError("Camel DAG request must be a JSON object.");
  }

  const contract = camelDagContract();
  if (!contract.runtime.jar_present) {
    throw new CodexProError("Camel CPU DAG sidecar is not built. Run npm run build:camel.");
  }
  if (!contract.runtime.java_present) {
    throw new CodexProError("Java 17 or newer is required for the Camel CPU DAG sidecar.");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("java", ["-jar", contract.runtime.jar], {
      cwd: projectRoot(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let done = false;
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: unknown): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      if (next.length > MAX_STDIO_BYTES) {
        terminate(child);
        throw new CodexProError("Camel CPU DAG output exceeded its 2000000-byte boundary.");
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { if (!done) { done = true; reject(error); } }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { if (!done) { done = true; reject(error); } }
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      reject(new CodexProError(`Camel CPU DAG failed to launch: ${error.message}`));
    });
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      terminate(child);
    }, Math.max(2_000, Math.min(timeoutMs, 120_000)));
    timer.unref();
    child.on("close", (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new CodexProError("Camel CPU DAG timed out."));
        return;
      }
      if (exitCode !== 0) {
        const lines = stderr.toString("utf8").split(/\r?\n/).filter(Boolean);
        const causes = lines.filter((line) => /(?:Caused by:|IllegalArgumentException:|SecurityException:)/.test(line)).slice(-4);
        const diagnostic = [...new Set([...causes, ...lines.slice(-8)])].join("\n");
        reject(new CodexProError(`Camel CPU DAG failed with exit ${exitCode}. ${diagnostic}`));
        return;
      }
      let receipt: unknown;
      try {
        receipt = JSON.parse(stdout.toString("utf8"));
      } catch {
        reject(new CodexProError("Camel CPU DAG returned non-JSON output."));
        return;
      }
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
        reject(new CodexProError("Camel CPU DAG returned an invalid receipt object."));
        return;
      }
      const record = receipt as Record<string, unknown>;
      if (record.schema !== DAG_SCHEMA || !/^[a-f0-9]{64}$/.test(String(record.receiptRoot || ""))) {
        reject(new CodexProError("Camel CPU DAG receipt failed schema/root validation."));
        return;
      }
      resolve(record);
    });
    child.stdin.end(Buffer.from(requestJson, "utf8"));
  });
}
