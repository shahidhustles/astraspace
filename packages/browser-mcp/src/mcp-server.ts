// Streamable HTTP MCP server.
//
// Eve's MCP client (defineMcpClientConnection) speaks Streamable HTTP or SSE,
// so this server is reachable from Eve whether Eve runs locally or in the
// cloud. Each tools/call is routed to the extension connected for the session
// via the WsRouter.
//
// Stateful sessions: the SDK's WebStandardStreamableHTTPServerTransport
// maintains one session per transport. We keep a map of sessionId →
// { transport, server }. An initialize request (no session id) creates a new
// entry; subsequent requests carry the Mcp-Session-Id header and reuse it.
// This mirrors the SDK's own simpleStreamableHttp example.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TOOLS } from "./tool-schemas";
import { WsRouter } from "./ws-router";

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export function createMcpServer(router: WsRouter): {
  handleRequest(request: Request): Promise<Response>;
} {
  const sessions = new Map<string, McpSession>();

  return {
    handleRequest: async (request) => {
      const sessionId = request.headers.get("mcp-session-id") ?? undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        // New session: only valid for an initialize request (no session id).
        if (!isInitializeRequest(request)) {
          return jsonError("Invalid Request: no valid session id", -32000);
        }
        session = createSession(router, sessions);
      }

      try {
        return await session.transport.handleRequest(request);
      } catch (error) {
        return jsonError(
          error instanceof Error ? error.message : String(error),
          -32603,
        );
      }
    },
  };
}

function createSession(
  router: WsRouter,
  sessions: Map<string, McpSession>,
): McpSession {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server });
    },
  });
  const server = new McpServer(
    { name: "astra-browser-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, router);
  void server.connect(transport);
  return { transport, server };
}

function isInitializeRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  if (request.headers.get("mcp-session-id")) return false;
  return new URL(request.url).pathname.endsWith("/mcp");
}

function jsonError(message: string, code: number): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status: 400 },
  );
}

function registerTools(server: McpServer, router: WsRouter): void {
  for (const tool of TOOLS) {
    // The SDK's tool() is deeply generic over the param shape; a dynamic
    // Record<string, ZodTypeAny> makes it try to infer a union that explodes.
    // Cast through the SDK's own expected input type to keep inference flat.
    const paramsSchema = tool.paramShape as unknown as Parameters<McpServer["tool"]>[2];
    server.tool(
      tool.name,
      tool.description,
      paramsSchema,
      async (args: Record<string, unknown>) => {
        // Route to whatever extension is connected. Multi-session routing by
        // an explicit sessionId arg is a later refinement; for now a single
        // connected extension answers all calls.
        const sessionId = router.sessions.size > 0 ? firstSessionId(router) : null;
        if (!sessionId) {
          return mcpError("browser_not_connected", "No browser extension is connected.");
        }
        try {
          const result = await router.callTool(sessionId, tool.name, args);
          return asMcpToolResult(result);
        } catch (error) {
          return mcpError(
            error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string"
              ? (error as { code: string }).code
              : "browser_tool_error",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );
  }
}

type McpToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

function asMcpToolResult(result: unknown): { content: McpToolContent[] } {
  const content = contentFromBrowserResult(result);
  if (content !== null) return { content };

  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function contentFromBrowserResult(result: unknown): McpToolContent[] | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;

  const content: McpToolContent[] = [];
  for (const part of result.content) {
    if (!isRecord(part) || typeof part.type !== "string") return null;

    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
      continue;
    }

    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      continue;
    }

    return null;
  }

  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstSessionId(router: WsRouter): string | null {
  for (const record of router.sessions) {
    return record.sessionId;
  }
  return null;
}

function mcpError(code: string, message: string): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}
