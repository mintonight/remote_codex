import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { runUnifiedLocalClient } from "../src/shim/unified-local-client.js";
import type { ExternalCliSessionDescriptor } from "../src/shim/shared-app-server.js";

describe("shared desktop and VS Code callback entry", () => {
  it("routes two projects to their existing writers, preserves desktop config and never interrupts on detach", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-callback-test-"));
    const servers: WebSocketServer[] = [];
    const requests: Array<{ backend: number; message: any }> = [];
    const clients: Array<{ input: PassThrough; done: Promise<number> }> = [];
    const slow: Array<() => void> = [];
    const backend = async (pid: number, threadId: string): Promise<ExternalCliSessionDescriptor> => {
      const tokenPath = join(root, `${pid}.token`);
      await writeFile(tokenPath, "fixture-private-capability");
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0,
        verifyClient: ({ req }, done) => done(req.headers.authorization === "Bearer fixture-private-capability", 401) });
      servers.push(server);
      await new Promise<void>((done) => server.once("listening", done));
      server.on("connection", (socket) => socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        requests.push({ backend: pid, message });
        const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
        if (message.method === "initialize") return reply({ userAgent: message.params.clientInfo.name });
        if (message.method === "thread/loaded/list") return reply({ data: [threadId], nextCursor: null });
        if (message.method === "turn/start") { slow.push(() => reply({ turn: { id: "active", status: "inProgress" } })); return; }
        if (message.id !== undefined) return reply({ backend: pid, observed: message.params });
      }));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture listener");
      return { version: 3, pid, startedAtMs: pid, host: "local", workspaceRoot: `/project-${pid}`,
        endpoint: `ws://127.0.0.1:${address.port}`, tokenPath, tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
        appServer: { pid, startedAtMs: pid, executablePath: "/fixture" } };
    };
    const descriptors = [await backend(100, "thread-a"), await backend(200, "thread-b")];
    const launch = (kind: "desktop" | "vscode") => {
      const input = new PassThrough(); const output = new PassThrough();
      const messages: any[] = []; let buffer = "";
      output.on("data", (data) => { buffer += String(data); let end: number; while ((end = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
      const done = runUnifiedLocalClient({ appServerArgs: ["app-server", "-c", 'mcp_servers.codex_app={command="node",args=["fixture"]}'],
        codexExecutable: "/unused", auditPath: join(root, "audit.jsonl"), clientKind: kind,
        ...(kind === "vscode" ? { workspaceRoot: "/project-100" } : {}),
        input, output, discover: async () => descriptors });
      clients.push({ input, done });
      const send = (value: unknown) => input.write(JSON.stringify(value) + "\n");
      const response = async (id: number) => { await vi.waitFor(() => expect(messages.some((m) => m.id === id)).toBe(true)); const m = messages.find((m) => m.id === id); expect(m.error).toBeUndefined(); return m.result; };
      send({ id: 1, method: "initialize", params: { clientInfo: { name: kind, version: "1" } } });
      return { input, done, send, response, messages };
    };
    try {
      const desktop = launch("desktop"); const vscode = launch("vscode");
      expect((await desktop.response(1)).userAgent).toBe("desktop");
      expect((await vscode.response(1)).userAgent).toBe("vscode");
      desktop.send({ id: 2, method: "thread/resume", params: { threadId: "thread-b" } });
      const resumed = await desktop.response(2);
      expect(resumed.backend).toBe(200);
      expect(resumed.observed.config.mcp_servers.codex_app.args).toEqual(["fixture"]);
      vscode.send({ id: 2, method: "thread/resume", params: { threadId: "thread-a" } });
      expect((await vscode.response(2)).backend).toBe(100);
      desktop.send({ id: 3, method: "thread/list", params: {} });
      vscode.send({ id: 3, method: "thread/list", params: {} });
      expect((await desktop.response(3)).observed.cwd).toBeUndefined();
      expect((await vscode.response(3)).observed.cwd).toBe("/project-100");
      desktop.send({ id: 4, method: "turn/start", params: { threadId: "thread-b", input: [] } });
      await vi.waitFor(() => expect(slow).toHaveLength(1));
      desktop.send({ id: 5, method: "turn/interrupt", params: { threadId: "thread-b", turnId: "active" } });
      expect((await desktop.response(5)).backend).toBe(200);
      expect(desktop.messages.some((m) => m.id === 4)).toBe(false);
      slow[0]!(); await desktop.response(4);
      desktop.send({ id: 6, method: "thread/loaded/list", params: { limit: 1 } });
      const page = await desktop.response(6);
      expect(page.data).toEqual(["thread-a"]);
      desktop.send({ id: 7, method: "thread/loaded/list", params: { cursor: page.nextCursor, limit: 1 } });
      expect((await desktop.response(7)).data).toEqual(["thread-b"]);
      desktop.input.end(); expect(await desktop.done).toBe(0);
      expect(requests.filter((r) => r.message.method === "turn/interrupt")).toHaveLength(1);
      vscode.send({ id: 4, method: "turn/steer", params: { threadId: "thread-b", expectedTurnId: "active", input: [] } });
      expect((await vscode.response(4)).backend).toBe(200);
    } finally {
      for (const client of clients) { client.input.end(); await client.done; }
      for (const server of servers) { for (const socket of server.clients) socket.terminate(); await new Promise<void>((done) => server.close(() => done())); }
      await rm(root, { recursive: true, force: true });
    }
  });
});
