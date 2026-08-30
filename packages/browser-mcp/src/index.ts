// Entry point: starts the MCP server (Streamable HTTP) and the WebSocket
// router on one HTTP server. The extension connects to the WebSocket; Eve
// connects to the MCP endpoint.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { HOST, MCP_PATH, PORT, WS_PATH } from "./config";
import { createMcpServer } from "./mcp-server";
import { WsRouter } from "./ws-router";

export interface BrowserMcpServer {
  close(): Promise<void>;
  readonly port: number;
}

export async function startBrowserMcpServer(options: {
  port?: number;
  host?: string;
} = {}): Promise<BrowserMcpServer> {
  const port = options.port ?? PORT;
  const host = options.host ?? HOST;

  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const router = new WsRouter(wsServer);
  router.attach();

  const mcp = createMcpServer(router);

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  });

  httpServer.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (url.pathname !== MCP_PATH) {
      response.writeHead(404).end("Not found");
      return;
    }
    void handleMcpRequest(mcp, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = (httpServer.address() as { port: number }).port;

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        router.close();
        httpServer.close(() => resolve());
      }),
  };
}

async function handleMcpRequest(
  mcp: { handleRequest(request: Request): Promise<Response> },
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(request);
    const headers = toHeaders(request.headers);
    const req = new Request(`http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`, {
      method: request.method ?? "GET",
      headers,
      body: ["GET", "HEAD"].includes(request.method ?? "") ? undefined : body,
      // The transport only reads the body for POST; GET/SSE streams are
      // handled without a body.
      duplex: "half",
    } as RequestInit);
    const res = await mcp.handleRequest(req);
    response.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    const resBody = await res.arrayBuffer();
    response.end(Buffer.from(resBody));
  } catch (error) {
    response.writeHead(500).end(`Internal error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function toHeaders(headers: import("node:http").IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else {
      out.append(key, value);
    }
  }
  return out;
}

// Allow running directly: `bun src/index.ts`.
if (import.meta.main) {
  const server = await startBrowserMcpServer();
  console.log(`MCP server:   http://${HOST}:${server.port}${MCP_PATH}`);
  console.log(`WebSocket:    ws://${HOST}:${server.port}${WS_PATH}`);
}
