#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createCodexProServer } from "./server.js";

async function main(): Promise<void> {
  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN ??= "1";
  const config = loadConfig();
  const server = createCodexProServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
