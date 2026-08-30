// Unit test for the WebSocket router: session registration, tool_request
// dispatch, and response correlation. Uses a real WebSocket connection to a
// server started in-process (no browser needed).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WebSocket as WsClient } from "ws";
import { startBrowserMcpServer, type BrowserMcpServer } from "../src/index";

let server: BrowserMcpServer;
let base: string;

beforeAll(async () => {
  server = await startBrowserMcpServer({ port: 0, host: "localhost" });
  base = `ws://localhost:${server.port}/ws`;
});

afterAll(async () => {
  await server.close();
});

function connect(sessionId: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(base);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "register", sessionId }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "registered") resolve(ws);
    });
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WsClient, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    const onMsg = (raw: any) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(msg);
      }
    };
    ws.on("message", onMsg);
  });
}

describe("ws-router", () => {
  it("registers a session and routes a tool_request to it", async () => {
    const ext = await connect("session-a");
    const requestPromise = waitForMessage(ext, "tool_request");
    // Use the MCP tools/call path to trigger a tool_request.
    const httpBase = `http://localhost:${server.port}/mcp`;
    const init = await fetch(httpBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    expect(sessionId).toBeTruthy();

    const callPromise = fetch(httpBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_page", arguments: { tabId: 1 } },
      }),
    });

    const request = await requestPromise;
    expect(request.tool).toBe("read_page");
    expect(request.args).toEqual({ tabId: 1 });

    // Simulate the extension answering.
    ext.send(JSON.stringify({ type: "tool_response", id: request.id, result: { ok: true, tree: "button [ref_1]" } }));

    const response = await (await callPromise).json();
    expect(response.result.content[0].text).toContain("button [ref_1]");
    ext.close();
  });

  it("returns browser_not_connected when no extension is registered", async () => {
    const httpBase = `http://localhost:${server.port}/mcp`;
    const init = await fetch(httpBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    const call = await fetch(httpBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_page", arguments: { tabId: 1 } } }),
    });
    const data = await call.json();
    expect(data.result.isError).toBe(true);
    expect(data.result.content[0].text).toContain("browser_not_connected");
  });

  it("keeps a screenshot as an MCP image content part", async () => {
    const ext = await connect("session-screenshot");
    const requestPromise = waitForMessage(ext, "tool_request");
    const httpBase = `http://localhost:${server.port}/mcp`;
    const init = await fetch(httpBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id")!;
    const callPromise = fetch(httpBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "computer", arguments: { action: "screenshot", tabId: 1 } },
      }),
    });

    const request = await requestPromise;
    ext.send(JSON.stringify({
      type: "tool_response",
      id: request.id,
      result: {
        content: [
          { type: "text", text: "Captured screenshot" },
          { type: "image", data: "/9j/", mimeType: "image/jpeg" },
        ],
      },
    }));

    const response = await (await callPromise).json();
    expect(response.result.content).toEqual([
      { type: "text", text: "Captured screenshot" },
      { type: "image", data: "/9j/", mimeType: "image/jpeg" },
    ]);
    ext.close();
  });
});
