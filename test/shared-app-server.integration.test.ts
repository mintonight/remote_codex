import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/core/audit-log.js";
import { parseBridgeConfig } from "../src/core/config.js";
import {
  bridgeExternalCliSessionPath,
  bridgeExternalCliTokenPath,
} from "../src/core/locations.js";
import { loadShimRuntimeStatus } from "../src/core/shim-runtime-status.js";
import {
  SharedAppServer,
  withSharedWebSocketTransport,
  type ExternalCliSessionDescriptor,
} from "../src/shim/shared-app-server.js";
import {
  interveneVsCodeConversation,
  interruptVsCodeConversation,
  listVsCodeConversations,
  readVsCodeConversation,
} from "../src/shim/vscode-conversation-client.js";
import { inspectProcessIdentities } from "../src/shim/process-identity.js";
import { saveLocalWorkspaceContext } from "../src/core/local-workspace-context.js";

const originalStateDirectory = process.env.CODEX_BRIDGE_STATE_DIR;

afterEach(() => {
  if (originalStateDirectory === undefined) {
    delete process.env.CODEX_BRIDGE_STATE_DIR;
  } else {
    process.env.CODEX_BRIDGE_STATE_DIR = originalStateDirectory;
  }
});

function fakeWebSocketAppServer(
  command: string,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  const source = `
    const { readFileSync } = require("node:fs");
    const { WebSocketServer } = require("ws");
    const args = JSON.parse(process.env.FAKE_CODEX_ARGS);
    const listenIndex = args.indexOf("--listen");
    const tokenIndex = args.indexOf("--ws-token-file");
    const endpoint = new URL(args[listenIndex + 1]);
    const token = readFileSync(args[tokenIndex + 1], "utf8");
    const server = new WebSocketServer({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      verifyClient: ({ req }, done) => {
        done(req.headers.authorization === "Bearer " + token, 401, "Unauthorized");
      },
    });
    let activeTurnId = null;
    let turnNumber = 0;
    const broadcastNotifications = process.env.FAKE_BROADCAST_NOTIFICATIONS === "1";
    const broadcastServerRequests = process.env.FAKE_BROADCAST_SERVER_REQUESTS === "1";
    const workspaceWrite = process.env.FAKE_WORKSPACE_WRITE === "1";
    const notify = (origin, message) => {
      const raw = JSON.stringify(message);
      if (!broadcastNotifications) {
        origin.send(raw);
        return;
      }
      for (const client of server.clients) {
        if (client.readyState === 1) client.send(raw);
      }
    };
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
          return;
        }
        if (message.method === "thread/start" || message.method === "thread/resume") {
          const thread = { id: message.params?.threadId ?? "thread-shared", cwd: message.params?.cwd ?? args[args.indexOf("--fake-workspace") + 1] };
          socket.send(JSON.stringify({
            id: message.id,
            result: { thread, observedParams: message.params },
          }));
          notify(socket, { method: "thread/started", params: { thread } });
          return;
        }
        if (message.method === "thread/loaded/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: args.includes("--fake-empty") ? [] : ["thread-shared"], nextCursor: null } }));
          return;
        }
        if (message.method === "thread/unsubscribe") {
          socket.send(JSON.stringify({ id: message.id, result: { status: "unsubscribed" } }));
          return;
        }
        if (message.method === "thread/list") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              data: [{ id: "thread-shared", name: "VS Code active task" }],
              nextCursor: null,
              observedParams: message.params,
            },
          }));
          return;
        }
        if (message.method === "thread/read") {
          socket.send(JSON.stringify({
            id: message.id,
            result: args.includes("--fake-workspace") ? { thread: { id: message.params.threadId, cwd: args[args.indexOf("--fake-workspace") + 1], status: { type: "active" }, turns: [] } } : {},
          }));
          return;
        }
        if (message.method === "thread/turns/list") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              data: activeTurnId
                ? [{ id: activeTurnId, status: "inProgress", items: [] }]
                : [],
              nextCursor: null,
            },
          }));
          return;
        }
        if (message.method === "turn/start") {
          turnNumber += 1;
          activeTurnId = turnNumber === 1 ? "turn-shared" : "turn-shared-" + turnNumber;
          const turn = { id: activeTurnId, status: "inProgress" };
          socket.send(JSON.stringify({ id: message.id, result: { turn } }));
          notify(socket, {
            method: "turn/started",
            params: { threadId: "thread-shared", turn },
          });
          notify(socket, {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-shared",
              turnId: activeTurnId,
              itemId: "agent-message",
              delta: "streamed",
            },
          });
          const request = {
            id: "remote-tool-request",
            method: "item/tool/call",
            params: {
              callId: "remote-item",
              threadId: "thread-shared",
              turnId: activeTurnId,
              tool: workspaceWrite ? "workspace_write_file" : "remote_exec",
              arguments: workspaceWrite
                ? {
                    contentBase64: Buffer.from("updated\\n").toString("base64"),
                    expectedHash: "a".repeat(64),
                    path: "note.txt",
                  }
                : { argv: ["printf", "hello"] },
            },
          };
          const rawRequest = JSON.stringify(request);
          if (broadcastServerRequests) {
            for (const client of server.clients) {
              if (client.readyState === 1) client.send(rawRequest);
            }
          } else {
            socket.send(rawRequest);
          }
          return;
        }
        if (message.method === "turn/steer") {
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              turnId: "turn-shared",
              observedExpectedTurnId: message.params.expectedTurnId,
            },
          }));
          notify(socket, {
            method: "bridge/fakeSteered",
            params: { threadId: "thread-shared", turnId: "turn-shared" },
          });
          return;
        }
        if (message.method === "turn/interrupt") {
          activeTurnId = null;
          socket.send(JSON.stringify({ id: message.id, result: {} }));
          notify(socket, {
            method: "turn/completed",
            params: {
              threadId: "thread-shared",
              turn: { id: message.params.turnId, status: "interrupted" },
            },
          });
          return;
        }
        if (message.id === "remote-tool-request") {
          notify(socket, {
            method: "bridge/fakeRemoteToolResult",
            params: { result: message.result },
          });
        }
      });
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  return spawn(command.startsWith("/") ? command : process.execPath, ["-e", source, "--", "app-server", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_CODEX_ARGS: JSON.stringify(args),
      FAKE_BROADCAST_NOTIFICATIONS: command.includes("broadcast-notifications")
        ? "1"
        : "0",
      FAKE_BROADCAST_SERVER_REQUESTS: command.includes("broadcast-requests")
        ? "1"
        : "0",
      FAKE_WORKSPACE_WRITE: command.includes("workspace-write") ? "1" : "0",
    },
    stdio: "pipe",
  });
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for shared app-server test state");
}

async function readDescriptor(path: string): Promise<ExternalCliSessionDescriptor | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ExternalCliSessionDescriptor;
  } catch {
    return undefined;
  }
}

function collectJsonLines(
  stream: PassThrough,
  onMessage?: (message: Record<string, unknown>) => void,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      onMessage?.(message);
    }
  });
  return messages;
}

describe("SharedAppServer", () => {

  it("does not lose initialize callbacks while the connection audit is delayed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-audit-race-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const seen = new Promise<void>((done) => { entered = done; });
    const original = AuditLog.prototype.write;
    const spy = vi.spyOn(AuditLog.prototype, "write").mockImplementation(async function (this: AuditLog, event) {
      if (event.operation === "external_cli.connect") { entered(); await gate; }
      await original.call(this, event);
    });
    const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
    errors.resume();
    const messages = collectJsonLines(output);
    const server = new SharedAppServer({ appServerArgs: ["app-server"], auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fixture", config: null, controlDir: directory, input, output, errorOutput: errors,
      spawnCodex: fakeWebSocketAppServer });
    const running = server.run();
    let socket: WebSocket | undefined;
    try {
      input.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } }) + "\n");
      await waitFor(() => messages.find((m) => m.id === 1));
      const descriptor = await waitFor(async () => { const d = await readDescriptor(bridgeExternalCliSessionPath()); return d?.lifecycle === "ready" ? d : undefined; });
      socket = new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${await readFile(descriptor.tokenPath, "utf8")}` } });
      const external: Array<Record<string, unknown>> = [];
      socket.on("message", (raw) => external.push(JSON.parse(raw.toString())));
      await new Promise<void>((done, reject) => { socket!.once("open", done); socket!.once("error", reject); });
      await seen;
      socket.send(JSON.stringify({ id: 77, method: "initialize", params: { clientInfo: { name: "late-audit", version: "1" } } }));
      await new Promise((done) => setTimeout(done, 50));
      release();
      expect(await waitFor(() => external.find((m) => m.id === 77))).toMatchObject({ result: { userAgent: "fake" } });
    } finally {
      release(); socket?.terminate(); input.end(); await running; spy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not delete existing recovery state when input was already closed before startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-closed-input-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    await mkdir(join(directory, "external-cli"));
    const path = bridgeExternalCliSessionPath();
    await writeFile(path, "existing recovery journal");
    const input = new PassThrough();
    input.destroy();
    const server = new SharedAppServer({ appServerArgs: ["app-server"], auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "must-not-spawn", config: null, controlDir: directory, input,
      spawnCodex: () => { throw new Error("Closed input must not spawn"); } });
    try {
      await expect(server.run()).resolves.toBe(0);
      expect(await readFile(path, "utf8")).toBe("existing recovery journal");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses to spawn before the expected workspace context is published", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-missing-context-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const server = new SharedAppServer({ appServerArgs: ["app-server"], auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "must-not-spawn", config: null, controlDir: directory, input, persistentSession: true,
      localWorkspaceContextPath: join(directory, "missing.json"), workspaceContextTimeoutMs: 25,
      spawnCodex: () => { throw new Error("Must not guess a launcher cwd"); } });
    try { await expect(server.run()).rejects.toThrow("workspace context is not ready"); }
    finally { input.destroy(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["inherited", "context-file", "delayed-context", "context-and-empty", "deleted-legacy", "deleted-legacy-and-empty", "deleted-legacy-bad-token-and-empty"])("reclaims a detached server using %s workspace identity before spawn", async (contextSource) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-handoff-integration-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const registry = join(directory, "external-cli");
    await mkdir(registry, { recursive: true });
    const deadPid = 2_147_483_647;
    const upstreamTokenPath = join(registry, `${deadPid}.upstream.token`);
    await writeFile(upstreamTokenPath, "handoff-test-token", { mode: 0o600 });
    const net = await import("node:net");
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const endpoint = `ws://127.0.0.1:${port}`;
    const legacyDeleted = contextSource.startsWith("deleted-legacy");
    const binary = join(directory, "old-extension-node");
    if (legacyDeleted) await copyFile(process.execPath, binary);
    const child = fakeWebSocketAppServer(legacyDeleted ? binary : "fake-codex", ["--listen", endpoint, "--ws-token-file", upstreamTokenPath, "--fake-workspace", directory]);
    const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    let diagnostic = "";
    errors.on("data", (chunk) => { diagnostic += String(chunk); });
    const messages = collectJsonLines(output);
    let running: Promise<number> | undefined;
    let emptyChild: ChildProcessWithoutNullStreams | undefined;
    let emptyExit: Promise<void> | undefined;
    try {
      await waitFor(() => new Promise<boolean | undefined>((resolve) => {
        const probe = new WebSocket(endpoint, { headers: { Authorization: "Bearer handoff-test-token" } });
        probe.once("open", () => { probe.close(); resolve(true); });
        probe.once("error", () => resolve(undefined));
      }));
      const appServer = await waitFor(async () => (await inspectProcessIdentities([child.pid!])).get(child.pid!));
      if (legacyDeleted) {
        delete appServer.executableFileId;
        const relocated = join(directory, "removed-by-upgrade");
        await rename(binary, relocated);
        await rm(relocated);
      }
      await writeFile(join(registry, `${deadPid}.json`), JSON.stringify({ version: 3,
        pid: deadPid, startedAtMs: 1, executablePath: process.execPath, appServer,
        endpoint, upstreamEndpoint: endpoint, host: "local", workspaceRoot: directory,
        tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN", tokenPath: join(registry, `${deadPid}.token`), lifecycle: "detached" }), { mode: 0o600 });
      const contextPath = join(directory, "local-workspaces", "987.json");
      if (contextSource === "context-file" || contextSource === "context-and-empty" || legacyDeleted) await saveLocalWorkspaceContext(contextPath, directory);
      if (contextSource === "context-and-empty" || contextSource.endsWith("-and-empty")) {
        const emptyPid = deadPid - 1;
        const emptyToken = join(registry, `${emptyPid}.upstream.token`);
        await writeFile(emptyToken, "empty-test-token", { mode: 0o600 });
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const emptyEndpoint = `ws://127.0.0.1:${(listener.address() as import("node:net").AddressInfo).port}`;
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        emptyChild = fakeWebSocketAppServer("fake-codex", ["--listen", emptyEndpoint, "--ws-token-file", emptyToken, "--fake-empty"]);
        emptyExit = new Promise<void>((resolve) => emptyChild!.once("exit", () => resolve()));
        await waitFor(() => new Promise<boolean | undefined>((resolve) => {
          const probe = new WebSocket(emptyEndpoint, { headers: { Authorization: "Bearer empty-test-token" } });
          probe.once("open", () => { probe.close(); resolve(true); });
          probe.once("error", () => resolve(undefined));
        }));
        const emptyIdentity = (await inspectProcessIdentities([emptyChild.pid!])).get(emptyChild.pid!);
        await writeFile(join(registry, `${emptyPid}.json`), JSON.stringify({ version: 3, pid: emptyPid,
          startedAtMs: 2, executablePath: process.execPath, appServer: emptyIdentity, endpoint: emptyEndpoint,
          upstreamEndpoint: emptyEndpoint, host: "local", workspaceRoot: directory, lifecycle: "detached" }), { mode: 0o600 });
      }
      const contextReady = contextSource === "delayed-context"
        ? new Promise<void>((resolve, reject) => setTimeout(() => {
          void saveLocalWorkspaceContext(contextPath, directory).then(resolve, reject);
        }, 75)) : Promise.resolve();
      if (contextSource.includes("bad-token")) await writeFile(upstreamTokenPath, "invalid-capability", { mode: 0o600 });
      const server = new SharedAppServer({ appServerArgs: ["app-server"], appServerCwd: join(directory, "launcher-home"),
        auditPath: join(directory, "audit.jsonl"), codexExecutable: "must-not-spawn", config: null,
        controlDir: directory, ...(contextSource === "inherited" ? { localWorkspaceRoot: directory } : { localWorkspaceContextPath: contextPath }),
        input, output, errorOutput: errors, persistentSession: true,
        spawnCodex: () => { throw new Error("Handoff must not spawn a second writer"); } });
      running = server.run();
      if (contextSource.includes("bad-token")) {
        await expect(running).rejects.toThrow("identity is unverifiable");
        expect(child.exitCode).toBeNull();
        return;
      }
      await contextReady;
      input.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } }) + "\n");
      await waitFor(() => messages.find((message) => message.id === 1));
      input.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      await waitFor(() => messages.find((message) => message.method === "thread/started")).catch((error) => {
        throw new Error(`${String(error)}; recovery diagnostic=${diagnostic}; methods=${messages.map((message) => message.method ?? message.id).join(",")}`);
      });
      const descriptor = await waitFor(async () => {
        const value = await readDescriptor(bridgeExternalCliSessionPath());
        return value?.loadedThreadIds?.includes("thread-shared") ? value : undefined;
      });
      expect(descriptor.appServer?.pid).toBe(child.pid);
      if (legacyDeleted) expect(descriptor.appServer?.executableFileId).toMatch(/^\d+:\d+$/);
      expect(descriptor.workspaceRoot).toBe(directory);
      expect(descriptor.threadId).toBeUndefined();
      input.end();
      await expect(running).resolves.toBe(0);
      expect(child.exitCode).toBeNull();
      if (emptyChild) expect(emptyChild.exitCode).toBeNull();
      expect(await readDescriptor(bridgeExternalCliSessionPath())).toMatchObject({ lifecycle: "detached", appServer: { pid: child.pid } });
      await expect(readFile(join(registry, `${deadPid}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      input.destroy();
      emptyChild?.kill("SIGKILL");
      await emptyExit;
      child.kill("SIGKILL");
      await childExit;
      await running?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces stdio transport and stale websocket credentials", () => {
    expect(
      withSharedWebSocketTransport(
        [
          "-c",
          "feature=true",
          "app-server",
          "--listen",
          "stdio://",
          "--ws-auth",
          "signed-bearer-token",
          "--ws-shared-secret-file",
          "/tmp/old",
        ],
        "ws://127.0.0.1:3456",
        "/tmp/new-token",
      ),
    ).toEqual([
      "-c",
      "feature=true",
      "app-server",
      "--listen",
      "ws://127.0.0.1:3456",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      "/tmp/new-token",
    ]);
  });
  });

  it.skipIf(process.env.GITHUB_ACTIONS === "true")(
    "lets an authenticated external client resume, steer, and interrupt the VS Code thread",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "codex-shared-app-server-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output, (message) => {
      if (
        message.method === "item/commandExecution/requestApproval" &&
        typeof message.id === "string"
      ) {
        input.write(
          `${JSON.stringify({ id: message.id, result: { decision: "accept" } })}\n`,
        );
      }
    });
    let sshSpawns = 0;
    const runtimeStatusPath = join(directory, "shim-runtime.json");
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex-broadcast-requests",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      extensionHostPid: 12_345,
      input,
      output,
      errorOutput,
      runtimeStatusPath,
      spawnCodex: fakeWebSocketAppServer,
      spawnSsh: () => {
        sshSpawns += 1;
        return spawn(
          process.execPath,
          ["-e", "process.stdout.write('/remote/workspace\\\\0hello\\\\n')"],
          { stdio: "pipe" },
        );
      },
    });
    const running = server.run();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    const startupDescriptor = await waitFor(() => readDescriptor(bridgeExternalCliSessionPath()));
    expect(startupDescriptor.lifecycle).toBe("starting");
    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: "/local/decoy", permissions: "full-access" },
      })}\n`,
    );
    await waitFor(() =>
      vscodeMessages.some((message) => message.id === 2) ? true : undefined,
    );
    const initializedRuntime = await waitFor(async () => {
      const current = await loadShimRuntimeStatus(runtimeStatusPath);
      return current?.appServerInitializedAtMs ? current : undefined;
    });
    expect(initializedRuntime).toMatchObject({
      extensionHostPid: 12_345,
      host: "g1_1",
      workspaceRoot: "/remote/workspace",
      running: true,
      shimLastExitCode: null,
      appServerLastError: null,
    });

    const descriptorPath = bridgeExternalCliSessionPath();
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(descriptorPath);
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    expect(descriptor).toMatchObject({
      version: 3,
      appServer: {
        executablePath: realpathSync.native(process.execPath),
        pid: expect.any(Number),
        startedAtMs: expect.any(Number),
      },
      executablePath: realpathSync.native(process.execPath),
      pid: process.pid,
    });
    const token = await readFile(bridgeExternalCliTokenPath(), "utf8");
    const unauthorizedStatus = await new Promise<number>((resolvePromise, reject) => {
      const unauthorized = new WebSocket(descriptor.endpoint);
      unauthorized.once("unexpected-response", (_request, response) => {
        resolvePromise(response.statusCode ?? 0);
      });
      unauthorized.once("open", () => reject(new Error("Unauthenticated client connected")));
      unauthorized.once("error", () => undefined);
    });
    expect(unauthorizedStatus).toBe(401);

    await expect(listVsCodeConversations(5)).resolves.toMatchObject({
      sessions: [
        {
          sessionPid: process.pid,
          activeThreadId: "thread-shared",
          threads: {
            data: [{ id: "thread-shared", name: "VS Code active task" }],
          },
        },
      ],
    });
    await expect(readVsCodeConversation("thread-shared", 5)).resolves.toMatchObject({
      threadId: "thread-shared",
      turns: { data: [] },
    });
    await expect(
      interveneVsCodeConversation({
        threadId: "thread-shared",
        text: "start self-test",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-shared",
      action: "new-turn",
      result: { turn: { id: "turn-shared" } },
    });
    await waitFor(() =>
      vscodeMessages.some(
        (message) => message.method === "bridge/fakeRemoteToolResult",
      )
        ? true
        : undefined,
    );
    expect(sshSpawns).toBe(1);
    expect(
      vscodeMessages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    await expect(
      interveneVsCodeConversation({
        threadId: "thread-shared",
        text: "add verification",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-shared",
      action: "steer",
      result: {
        turnId: "turn-shared",
        observedExpectedTurnId: "turn-shared",
      },
    });
    await expect(
      interruptVsCodeConversation({
        threadId: "thread-shared",
        turnId: "turn-shared",
      }),
    ).resolves.toMatchObject({
      threadId: "thread-shared",
      turnId: "turn-shared",
    });

    const external = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const externalMessages: Array<Record<string, unknown>> = [];
    external.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      externalMessages.push(message);
      if (
        message.method === "item/commandExecution/requestApproval" &&
        typeof message.id === "string"
      ) {
        external.send(
          JSON.stringify({ id: message.id, result: { decision: "accept" } }),
        );
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      external.once("open", resolvePromise);
      external.once("error", reject);
    });
    external.send(
      JSON.stringify({ id: 10, method: "initialize", params: { clientInfo: {} } }),
    );
    external.send(
      JSON.stringify({
        id: 11,
        method: "thread/resume",
        params: {
          threadId: descriptor.threadId,
          cwd: "/local/decoy",
          permissions: "read-only",
        },
      }),
    );
    external.send(
      JSON.stringify({
        id: 12,
        method: "turn/start",
        params: { threadId: descriptor.threadId, input: [] },
      }),
    );
    external.send(
      JSON.stringify({
        id: 13,
        method: "turn/steer",
        params: {
          threadId: descriptor.threadId,
          expectedTurnId: "turn-shared",
          input: [{ type: "text", text: "intervene" }],
        },
      }),
    );
    external.send(
      JSON.stringify({
        id: 14,
        method: "turn/interrupt",
        params: { threadId: descriptor.threadId, turnId: "turn-shared" },
      }),
    );

    await waitFor(() =>
      externalMessages.some((message) => message.id === 14) ? true : undefined,
    );
    expect(vscodeMessages).toContainEqual({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-shared",
        turnId: "turn-shared",
        itemId: "agent-message",
        delta: "streamed",
      },
    });
    expect(externalMessages).toContainEqual(expect.objectContaining({
      id: 11,
      result: expect.objectContaining({ thread: expect.objectContaining({ id: "thread-shared" }) }),
    }));
    expect(externalMessages).toContainEqual({
      id: 13,
      result: {
        turnId: "turn-shared",
        observedExpectedTurnId: "turn-shared",
      },
    });
    await waitFor(() => (sshSpawns === 2 ? true : undefined));
    expect(sshSpawns).toBe(2);
    expect(vscodeMessages).toContainEqual({
      method: "bridge/fakeSteered",
      params: { threadId: "thread-shared", turnId: "turn-shared" },
    });
    expect(vscodeMessages).toContainEqual({
      method: "turn/completed",
      params: {
        threadId: "thread-shared",
        turn: { id: "turn-shared", status: "interrupted" },
      },
    });

    const externalTurnStarts = externalMessages.filter(
      (message) => message.method === "turn/started",
    ).length;
    input.write(
      `${JSON.stringify({
        id: 15,
        method: "turn/start",
        params: {
          threadId: descriptor.threadId,
          input: [{ type: "text", text: "from vscode" }],
        },
      })}\n`,
    );
    const mirroredVsCodeTurn = await waitFor(() =>
      externalMessages.filter((message) => message.method === "turn/started")[
        externalTurnStarts
      ],
    );
    const mirroredVsCodeTurnId = (
      (mirroredVsCodeTurn.params as Record<string, unknown>).turn as Record<
        string,
        unknown
      >
    ).id;
    expect(externalMessages).toContainEqual({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-shared",
        turnId: mirroredVsCodeTurnId,
        itemId: "agent-message",
        delta: "streamed",
      },
    });
    const externalCompletions = externalMessages.filter(
      (message) => message.method === "turn/completed",
    ).length;
    input.write(
      `${JSON.stringify({
        id: 16,
        method: "turn/interrupt",
        params: {
          threadId: descriptor.threadId,
          turnId: mirroredVsCodeTurnId,
        },
      })}\n`,
    );
    await waitFor(() =>
      externalMessages.filter((message) => message.method === "turn/completed").length >
      externalCompletions
        ? true
        : undefined,
    );

    input.write(
      `${JSON.stringify({
        id: 17,
        method: "thread/list",
        params: { limit: 1, sourceKinds: ["vscode"] },
      })}\n`,
    );
    await waitFor(() =>
      vscodeMessages.some((message) => message.id === 17) ? true : undefined,
    );
    expect(vscodeMessages.find((message) => message.id === 17)).toMatchObject({
      result: {
        observedParams: {
          cwd: join(directory, "control"),
          limit: 1,
          sourceKinds: ["vscode"],
        },
      },
    });
    const externalClosed = new Promise<{ code: number; reason: string }>(
      (resolvePromise) => {
        external.once("close", (code, reason) => {
          resolvePromise({ code, reason: reason.toString("utf8") });
        });
      },
    );
    input.end();
    await expect(externalClosed).resolves.toEqual({
      code: 1_012,
      reason: "Bridge app-server restarting",
    });
    await expect(running).resolves.toBe(0);
    await expect(loadShimRuntimeStatus(runtimeStatusPath)).resolves.toMatchObject({
      running: false,
      shimLastExitCode: 0,
      appServerLastError: null,
    });
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const auditEntries = (await readFile(join(directory, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      auditEntries.some((entry) => {
        const details = entry.details as Record<string, unknown> | undefined;
        return (
          entry.operation === "external_cli.disconnect" &&
          typeof details?.notificationsRelayedToVsCode === "number" &&
          details.notificationsRelayedToVsCode > 0
        );
      }),
    ).toBe(true);
    expect(
      auditEntries.filter(
        (entry) => entry.operation === "remote_exec" && entry.outcome === "started",
      ),
    ).toHaveLength(3);
    expect(
      auditEntries
        .filter(
          (entry) =>
            entry.operation === "remote_exec" && entry.outcome === "started",
        )
        .map((entry) => entry.clientSource)
        .sort(),
    ).toEqual(["external-cli", "external-mcp", "vscode"]);
    const completedExternalRequests = auditEntries.filter(
      (entry) =>
        entry.operation === "external_cli.request" &&
        entry.outcome === "succeeded",
    );
    expect(completedExternalRequests.length).toBeGreaterThan(0);
    expect(
      completedExternalRequests.every(
        (entry) =>
          typeof entry.clientId === "string" &&
          typeof entry.clientSource === "string" &&
          typeof entry.operationId === "string",
      ),
    ).toBe(true);
    expect(
      new Set(completedExternalRequests.map((entry) => entry.clientSource)),
    ).toEqual(new Set(["external-cli", "external-mcp"]));
    const startedExternalRequests = auditEntries.filter(
      (entry) =>
        entry.operation === "external_cli.request" &&
        entry.outcome === "started",
    );
    expect(startedExternalRequests.length).toBeGreaterThan(0);
    // A request may be started and then interrupted before reaching a
    // `succeeded` completion (the test steers and interrupts turns), especially
    // under contended CI runners. Rather than requiring every started request
    // to complete, assert that at least one started request has a matching
    // completed entry.
    expect(
      startedExternalRequests.some((started) =>
        completedExternalRequests.some(
          (entry) =>
            entry.clientId === started.clientId &&
            entry.operationId === started.operationId,
        ),
      ),
    ).toBe(true);
    const rawAudit = await readFile(join(directory, "audit.jsonl"), "utf8");
    expect(rawAudit).not.toContain("start self-test");
    expect(rawAudit).not.toContain("add verification");
    expect(rawAudit).not.toContain("intervene");
  }, 30_000);

  it.skipIf(process.env.GITHUB_ACTIONS === "true")(
    "honors full-access for a thread started by an external CLI client",
    async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-full-access-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    let sshSpawns = 0;
    const auditPath = join(directory, "audit.jsonl");
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      auditPath,
      codexExecutable: "fake-codex-external-full-access-workspace-write",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
      spawnSsh: () => {
        sshSpawns += 1;
        const source = `
          process.stdin.resume();
          process.stdin.on("end", () => {
            const zero = String.fromCharCode(0);
            process.stdout.write(
              "/remote/workspace" + zero +
              "/remote/workspace/note.txt" + zero +
              "8" + zero +
              "81a4" + zero +
              "1721779200" + zero +
              "${"b".repeat(64)}"
            );
          });
        `;
        return spawn(
          process.execPath,
          ["-e", source],
          { stdio: "pipe" },
        );
      },
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: {
          cwd: "/local/decoy",
          permissions: "workspace-write",
          approvalPolicy: "on-request",
        },
      })}\n`,
    );
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    const token = await readFile(bridgeExternalCliTokenPath(), "utf8");
    const external = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const externalMessages: Array<Record<string, unknown>> = [];
    external.on("message", (data) => {
      externalMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolvePromise, reject) => {
      external.once("open", resolvePromise);
      external.once("error", reject);
    });
    external.send(
      JSON.stringify({ id: 10, method: "initialize", params: { clientInfo: {} } }),
    );
    external.send(
      JSON.stringify({
        id: 11,
        method: "thread/start",
        params: {
          cwd: "/local/decoy",
          permissions: "full-access",
          approvalPolicy: "never",
        },
      }),
    );
    await waitFor(
      () =>
        externalMessages.some((message) => message.id === 11)
          ? true
          : undefined,
      60_000,
    );
    external.send(
      JSON.stringify({
        id: 12,
        method: "turn/start",
        params: { threadId: "thread-shared", input: [] },
      }),
    );
    await waitFor(
      () =>
        externalMessages.some(
          (message) => message.method === "bridge/fakeRemoteToolResult",
        )
          ? true
          : undefined,
      60_000,
    );

    expect(sshSpawns).toBe(1);
    expect(
      externalMessages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);
    expect(
      vscodeMessages.some(
        (message) => message.method === "item/commandExecution/requestApproval",
      ),
    ).toBe(false);

    external.close();
    input.end();
    await expect(running).resolves.toBe(0);
    const auditEntries = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        operation: "workspace_mutation.approval",
        outcome: "succeeded",
        clientSource: "external-cli",
        operationId: "remote-item",
        details: expect.objectContaining({
          automatic: true,
          permissionMode: "full-access",
          tool: "workspace_write_file",
        }),
      }),
    );
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        operation: "workspace_write_file",
        outcome: "succeeded",
        clientSource: "external-cli",
        operationId: "remote-item",
        details: expect.objectContaining({
          bytesWritten: 8,
          path: "note.txt",
        }),
      }),
    );
  }, 120_000);

  it.skipIf(process.env.GITHUB_ACTIONS === "true")(
    "interrupts an active turn when its external CLI client disconnects",
    async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-disconnect-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    let sshSpawns = 0;
    const auditPath = join(directory, "audit.jsonl");
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      auditPath,
      codexExecutable: "fake-codex",
      config: parseBridgeConfig({
        host: "g1_1",
        workspaceRoot: "/remote/workspace",
      }),
      controlDir: join(directory, "control"),
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
      spawnSsh: () => {
        sshSpawns += 1;
        return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "pipe",
        });
      },
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: "/local/decoy" },
      })}\n`,
    );
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    const token = await readFile(bridgeExternalCliTokenPath(), "utf8");
    const external = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const externalMessages: Array<Record<string, unknown>> = [];
    const externalClosed = new Promise<void>((resolvePromise) => {
      external.once("close", () => resolvePromise());
    });
    external.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      externalMessages.push(message);
    });
    await new Promise<void>((resolvePromise, reject) => {
      external.once("open", resolvePromise);
      external.once("error", reject);
    });
    external.send(
      JSON.stringify({ id: 10, method: "initialize", params: { clientInfo: {} } }),
    );
    external.send(
      JSON.stringify({
        id: 11,
        method: "thread/start",
        params: {
          approvalPolicy: "on-request",
          cwd: "/local/decoy",
          permissions: "workspace-write",
        },
      }),
    );
    await waitFor(() =>
      externalMessages.some((message) => message.id === 11) ? true : undefined,
    );
    external.send(
      JSON.stringify({
        id: 12,
        method: "turn/start",
        params: { threadId: "thread-shared", input: [] },
      }),
    );

    await waitFor(() => (sshSpawns === 1 ? true : undefined));
    external.close(1_000, "acceptance-disconnect");
    await externalClosed;
    await waitFor(() =>
      vscodeMessages.some((message) => {
        if (message.method !== "turn/completed") {
          return false;
        }
        const params = message.params as Record<string, unknown> | undefined;
        const turn = params?.turn;
        return (
          typeof turn === "object" &&
          turn !== null &&
          (turn as Record<string, unknown>).status === "interrupted"
        );
      })
        ? true
        : undefined,
    );
    expect(sshSpawns).toBe(1);

    input.end();
    await expect(running).resolves.toBe(0);
    const auditEntries = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        operation: "external_cli.disconnect",
        outcome: "succeeded",
        details: expect.objectContaining({
          turnInterrupts: {
            confirmed: 1,
            requested: 1,
            unconfirmed: 0,
          },
        }),
      }),
    );
  }, 30_000);

  it("publishes a local VS Code thread without applying Remote SSH rewrites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-local-app-server-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const workspaceRoot = join(directory, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      appServerCwd: directory,
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex",
      config: null,
      controlDir: directory,
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
      spawnSsh: () => {
        throw new Error("Local shared app-server must not start SSH");
      },
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/read",
        params: { threadId: "thread-shared", includeTurns: false },
      })}\n`,
    );
    await waitFor(() => vscodeMessages.find((message) => message.id === 2));
    const restoredDescriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.lifecycle === "ready" ? current : undefined;
    });
    expect(restoredDescriptor).toMatchObject({
      host: "local",
      workspaceRoot: directory,
    });
    expect(restoredDescriptor.threadId).toBeUndefined();
    input.write(
      `${JSON.stringify({
        id: 3,
        method: "thread/start",
        params: {
          cwd: workspaceRoot,
          permissions: "workspace-write",
          approvalPolicy: "on-request",
        },
      })}\n`,
    );
    const response = await waitFor(() =>
      vscodeMessages.find((message) => message.id === 3),
    );
    expect(response).toMatchObject({
      result: {
        observedParams: {
          cwd: workspaceRoot,
          permissions: "workspace-write",
          approvalPolicy: "on-request",
        },
      },
    });
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    expect(descriptor).toMatchObject({
      host: "local",
      workspaceRoot,
      threadId: "thread-shared",
    });

    input.end();
    await expect(running).resolves.toBe(0);
  });

  it.skipIf(process.env.GITHUB_ACTIONS === "true")(
    "deduplicates notifications broadcast by multiple upstream connections",
    async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-shared-broadcast-app-server-"));
    process.env.CODEX_BRIDGE_STATE_DIR = directory;
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const vscodeMessages = collectJsonLines(output);
    const server = new SharedAppServer({
      appServerArgs: ["app-server", "--listen", "stdio://"],
      appServerCwd: directory,
      auditPath: join(directory, "audit.jsonl"),
      codexExecutable: "fake-codex-broadcast-notifications",
      config: null,
      controlDir: directory,
      input,
      output,
      errorOutput,
      spawnCodex: fakeWebSocketAppServer,
    });
    const running = server.run();

    input.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: {} } })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { cwd: directory, permissions: "full-access" },
      })}\n`,
    );
    const descriptor = await waitFor(async () => {
      const current = await readDescriptor(bridgeExternalCliSessionPath());
      return current?.threadId === "thread-shared" ? current : undefined;
    });
    const initialVsCodeNotifications = vscodeMessages.filter(
      (message) => message.method === "thread/started",
    ).length;
    const token = await readFile(bridgeExternalCliTokenPath(), "utf8");
    const external = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const externalMessages: Array<Record<string, unknown>> = [];
    external.on("message", (data) => {
      externalMessages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolvePromise, reject) => {
      external.once("open", resolvePromise);
      external.once("error", reject);
    });
    external.send(
      JSON.stringify({ id: 10, method: "initialize", params: { clientInfo: {} } }),
    );
    external.send(
      JSON.stringify({
        id: 11,
        method: "thread/resume",
        params: { threadId: descriptor.threadId, cwd: directory },
      }),
    );
    await waitFor(() =>
      externalMessages.some((message) => message.id === 11) ? true : undefined,
    );
    // Do not rely on a fixed sleep: poll until the broadcast thread/started
    // notification has reached both the VS Code transport and the external
    // client. This keeps the test robust on slow or loaded CI runners.
    await waitFor(() => {
      const vsCodeCount = vscodeMessages.filter(
        (message) => message.method === "thread/started",
      ).length;
      const externalCount = externalMessages.filter(
        (message) => message.method === "thread/started",
      ).length;
      return vsCodeCount === initialVsCodeNotifications + 1 &&
        externalCount === 1
        ? true
        : undefined;
    });

    external.close();
    input.end();
    await expect(running).resolves.toBe(0);
  }, 30_000);
});
