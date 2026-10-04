import { AsyncLocalStorage } from "node:async_hooks";

export type McpRequestContext = {
  requestId: string;
  receivedAt: number;
  mcpSessionId?: string;
  jsonRpcId?: string | number | null;
  jsonRpcMethod?: string;
  requestedTool?: string;
  clientCorrelation?: Record<string, string>;
};

const storage = new AsyncLocalStorage<McpRequestContext>();

export function runWithMcpRequestContext<T>(context: McpRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentMcpRequestContext(): McpRequestContext | undefined {
  return storage.getStore();
}

export function requestCorrelationSnapshot(): Record<string, unknown> | undefined {
  const context = storage.getStore();
  if (!context) return undefined;
  return {
    requestId: context.requestId,
    ...(context.mcpSessionId ? { mcpSessionId: context.mcpSessionId } : {}),
    ...(context.jsonRpcId !== undefined ? { jsonRpcId: context.jsonRpcId } : {}),
    ...(context.jsonRpcMethod ? { jsonRpcMethod: context.jsonRpcMethod } : {}),
    ...(context.requestedTool ? { requestedTool: context.requestedTool } : {}),
    ...(context.clientCorrelation && Object.keys(context.clientCorrelation).length
      ? { clientCorrelation: context.clientCorrelation }
      : {})
  };
}
