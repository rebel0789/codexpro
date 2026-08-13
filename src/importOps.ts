import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { withFileWriteLocks } from "./fsOps.js";

export interface AttachmentFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export type MimeTypeStatus = "matched" | "mismatched" | "unknown";

export interface ImportFileResult {
  path: string;
  bytes: number;
  declared_mime_type: string | null;
  detected_mime_type: string | null;
  mime_type_status: MimeTypeStatus;
  sha256: string;
  verified: boolean;
  file_id: string;
  file_name: string | null;
  overwritten: boolean;
}

const DEFAULT_ALLOWED_IMPORT_HOSTS = [
  "files.oaiusercontent.com",
  "oaiusercontent.com",
  "chatgpt.com",
  "openai.com",
  "cdn.openai.com",
  "oaistatic.com"
];

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function boolFrom(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function splitHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function importAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...DEFAULT_ALLOWED_IMPORT_HOSTS, ...splitHosts(env.CODEXPRO_IMPORT_ALLOWED_HOSTS)])];
}

export function parseAttachmentFileReference(value: unknown): AttachmentFileReference {
  if (typeof value === "string") {
    throw new CodexProError(
      "Unsupported attachment reference. ChatGPT must pass an Apps SDK file object with download_url and file_id via openai/fileParams. A bare string file id or URL is not enough."
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexProError("Unsupported attachment reference. Expected { download_url, file_id, mime_type?, file_name? }.");
  }
  const record = value as Record<string, unknown>;
  const downloadUrl = typeof record.download_url === "string" ? record.download_url.trim() : "";
  const fileId = typeof record.file_id === "string" ? record.file_id.trim() : "";
  if (!downloadUrl || !fileId) {
    throw new CodexProError("Unsupported attachment reference. Both download_url and file_id are required.");
  }
  if (/^file:|^data:|^javascript:/i.test(downloadUrl)) {
    throw new CodexProError("Unsupported attachment reference scheme.");
  }
  return {
    download_url: downloadUrl,
    file_id: fileId,
    ...(typeof record.mime_type === "string" && record.mime_type.trim() ? { mime_type: record.mime_type.trim() } : {}),
    ...(typeof record.file_name === "string" && record.file_name.trim() ? { file_name: record.file_name.trim() } : {})
  };
}

function isPrivateOrLocalIp(address: string): boolean {
  if (net.isIP(address) === 0) return true;
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.includes(".")) {
    const parts = lower.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export async function assertSafeImportUrl(
  rawUrl: string,
  options: { allowLoopback?: boolean; allowedHosts?: string[]; env?: NodeJS.ProcessEnv } = {}
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CodexProError("Attachment download_url is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && !(options.allowLoopback && parsed.protocol === "http:")) {
    throw new CodexProError("Attachment download_url must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new CodexProError("Attachment download_url must not include credentials.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) throw new CodexProError("Attachment download_url is missing a hostname.");
  const allowLoopback = options.allowLoopback ?? boolFrom((options.env ?? process.env).CODEXPRO_IMPORT_ALLOW_LOOPBACK, false);
  const allowedHosts = options.allowedHosts ?? importAllowedHosts(options.env);
  const isLoopbackHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (isLoopbackHost) {
    if (!allowLoopback) throw new CodexProError("Attachment download_url points to a blocked host.");
  } else if (!hostAllowed(host, allowedHosts)) {
    throw new CodexProError("Attachment download_url host is not an approved ChatGPT file origin.");
  }

  if (net.isIP(host)) {
    if (isPrivateOrLocalIp(host) && !(allowLoopback && isLoopbackHost)) {
      throw new CodexProError("Attachment download_url resolves to a blocked address.");
    }
    return parsed;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new CodexProError("Attachment download_url hostname could not be resolved.");
  }
  if (!records.length) throw new CodexProError("Attachment download_url hostname could not be resolved.");
  for (const record of records) {
    if (isPrivateOrLocalIp(record.address) && !(allowLoopback && isLoopbackHost)) {
      throw new CodexProError("Attachment download_url resolves to a blocked address.");
    }
  }
  return parsed;
}

export function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && buffer[3] === 0x04) {
    return "application/zip";
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "application/gzip";
  return null;
}

export function mimeTypeStatus(declared: string | null | undefined, detected: string | null): MimeTypeStatus {
  if (!detected) return "unknown";
  if (!declared) return "unknown";
  const left = declared.trim().toLowerCase();
  const right = detected.trim().toLowerCase();
  if (!left) return "unknown";
  return left === right ? "matched" : "mismatched";
}

async function downloadToTempFile(
  url: URL,
  maxBytes: number,
  options: { allowLoopback: boolean; allowedHosts: string[]; env: NodeJS.ProcessEnv }
): Promise<{ tempPath: string; bytes: number; contentType: string | null }> {
  const tempPath = path.join(os.tmpdir(), `codexpro-import-${process.pid}-${randomBytes(8).toString("hex")}.bin`);
  let current = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertSafeImportUrl(current.href, options);
    const result = await new Promise<{
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      bytes: number;
      redirectedTo?: string;
    }>((resolve, reject) => {
      const transport = current.protocol === "http:" ? http : https;
      const request = transport.get(
        current,
        {
          timeout: DOWNLOAD_TIMEOUT_MS,
          headers: {
            Accept: "*/*",
            "User-Agent": "codexpro-import/0.30"
          }
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            response.resume();
            const location = response.headers.location;
            if (!location) {
              reject(new CodexProError("Attachment download redirected without a Location header."));
              return;
            }
            resolve({ statusCode, headers: response.headers, bytes: 0, redirectedTo: new URL(location, current).href });
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new CodexProError(`Attachment download failed with HTTP ${statusCode}.`));
            return;
          }
          const contentLength = Number(response.headers["content-length"] ?? "");
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            response.destroy();
            reject(new CodexProError(`Attachment is too large. Limit: ${maxBytes} bytes.`));
            return;
          }
          const output = fs.createWriteStream(tempPath, { flags: "wx" });
          let bytes = 0;
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            response.destroy();
            output.destroy();
            void fsp.rm(tempPath, { force: true }).finally(() => reject(error));
          };
          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > maxBytes) {
              fail(new CodexProError(`Attachment exceeded import size limit (${maxBytes} bytes).`));
            }
          });
          response.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
          output.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
          response.pipe(output);
          output.on("finish", () => {
            if (settled) return;
            settled = true;
            resolve({ statusCode, headers: response.headers, bytes });
          });
        }
      );
      request.on("timeout", () => {
        request.destroy(new CodexProError("Attachment download timed out."));
      });
      request.on("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    });

    if (result.redirectedTo) {
      current = new URL(result.redirectedTo);
      continue;
    }
    const contentType = typeof result.headers["content-type"] === "string"
      ? result.headers["content-type"].split(";")[0]?.trim() || null
      : null;
    return { tempPath, bytes: result.bytes, contentType };
  }
  throw new CodexProError("Attachment download exceeded redirect limit.");
}

async function finalizeImportFile(tempPath: string, destinationAbs: string, overwrite: boolean): Promise<boolean> {
  const parent = path.dirname(destinationAbs);
  await fsp.mkdir(parent, { recursive: true });
  if (!overwrite) {
    try {
      await fsp.link(tempPath, destinationAbs);
      await fsp.rm(tempPath, { force: true });
      return false;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "EEXIST") {
        throw new CodexProError(`Destination already exists and overwrite=false: ${path.basename(destinationAbs)}`);
      }
      // Windows junctions/filesystems may not support hard links; fall back to exclusive create copy.
      try {
        await fsp.copyFile(tempPath, destinationAbs, fs.constants.COPYFILE_EXCL);
        await fsp.rm(tempPath, { force: true });
        return false;
      } catch (copyError) {
        const copyCode = copyError && typeof copyError === "object" && "code" in copyError ? String(copyError.code) : "";
        if (copyCode === "EEXIST") {
          throw new CodexProError(`Destination already exists and overwrite=false: ${path.basename(destinationAbs)}`);
        }
        throw copyError;
      }
    }
  }
  await fsp.rename(tempPath, destinationAbs);
  return true;
}

export async function importAttachmentFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    file: unknown;
    destination: string;
    overwrite?: boolean;
    expectedSha256?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<ImportFileResult> {
  const env = options.env ?? process.env;
  const reference = parseAttachmentFileReference(options.file);
  const destination = String(options.destination ?? "").trim();
  if (!destination) throw new CodexProError("destination is required.");
  const overwrite = options.overwrite === true;
  const resolved = guard.resolve(workspace, destination, { forWrite: true });
  const maxBytes = config.maxImportBytes;
  const allowLoopback = boolFrom(env.CODEXPRO_IMPORT_ALLOW_LOOPBACK, false);
  const allowedHosts = importAllowedHosts(env);

  let tempPath = "";
  try {
    const downloaded = await downloadToTempFile(new URL(reference.download_url), maxBytes, {
      allowLoopback,
      allowedHosts,
      env
    });
    tempPath = downloaded.tempPath;
    const handle = await fsp.open(tempPath, "r");
    let hash = "";
    let detected: string | null = null;
    try {
      const probe = Buffer.alloc(Math.min(64, downloaded.bytes));
      if (probe.length) {
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
        detected = detectMimeType(probe.subarray(0, bytesRead));
      }
      const hasher = createHash("sha256");
      const stream = handle.createReadStream();
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk) => hasher.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve());
      });
      hash = hasher.digest("hex");
    } finally {
      await handle.close();
    }

    if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== hash) {
      throw new CodexProError(`Attachment SHA-256 mismatch for ${resolved.relPath}.`);
    }

    const declared = reference.mime_type ?? downloaded.contentType;
    const status = mimeTypeStatus(declared, detected);
    const existedBefore = fs.existsSync(resolved.absPath);
    const replaced = await withFileWriteLocks([resolved.absPath], async () => {
      if (!overwrite && existedBefore) {
        throw new CodexProError(`Destination already exists and overwrite=false: ${resolved.relPath}`);
      }
      return finalizeImportFile(tempPath, resolved.absPath, overwrite);
    });
    tempPath = "";

    return {
      path: resolved.relPath,
      bytes: downloaded.bytes,
      declared_mime_type: declared ?? null,
      detected_mime_type: detected,
      mime_type_status: status,
      sha256: hash,
      verified: Boolean(options.expectedSha256),
      file_id: reference.file_id,
      file_name: reference.file_name ?? null,
      overwritten: Boolean(existedBefore && replaced)
    };
  } finally {
    if (tempPath) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
