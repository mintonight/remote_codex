import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable, type Readable } from "node:stream";
import WebSocket from "ws";
import { bridgeExternalCliDir } from "../core/locations.js";
import { readLocalWorkspaceContext } from "../core/local-workspace-context.js";
import { discoverExternalCliSessions } from "./external-session-registry.js";
import { isRecord, parseRpcLine } from "./rpc.js";
import { SharedAppServer, type ExternalCliSessionDescriptor } from "./shared-app-server.js";

export const SERVICE_WORKER_ARGUMENT = "--bridge-local-service-worker";
const MAX_BUFFER = 16 * 1024 * 1024;

export interface LocalServiceOptions {
  serviceScope?: "user";
  appServerArgs: string[];
  codexExecutable: string;
  workspaceRoot: string;
  auditPath: string;
  serviceKey: string;
}

export async function userServiceKey(): Promise<string> {
  const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  return createHash("sha256").update(JSON.stringify({ scope: "user", home: await realpath(home).catch(() => home) })).digest("hex");
}

// Executable versions and window PIDs are diagnostics, not service identity.
export async function localServiceKey(root: string, args: readonly string[]): Promise<string> {
  const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  return createHash("sha256").update(JSON.stringify({
    home: await realpath(home).catch(() => home),
    root: await realpath(root),
    args,
  })).digest("hex");
}

export async function resolveServiceWorkspace(
  contextPath: string | undefined,
  inheritedRoot: string | undefined,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  if (!contextPath) return inheritedRoot ? await realpath(inheritedRoot) : undefined;
  const deadline = Date.now() + timeoutMs;
  do {
    const context = await readLocalWorkspaceContext(contextPath);
    if (context) return context.workspaceRoot ? await realpath(context.workspaceRoot) : undefined;
    await new Promise((done) => setTimeout(done, 25));
  } while (Date.now() < deadline);
  throw new Error("VS Code workspace context is not ready; refusing to start a competing service");
}

async function findService(key: string): Promise<ExternalCliSessionDescriptor | undefined> {
  const matches = (await discoverExternalCliSessions()).filter((entry) => entry.serviceKey === key);
  if (matches.length > 1) throw new Error("Multiple services claim this execution domain; refusing ambiguous attachment");
  return matches[0];
}

export async function ensureLocalService(
  options: LocalServiceOptions,
  launch = { command: process.execPath, args: resolve(process.argv[1] ?? process.execPath) === resolve(process.execPath) ? [] : [resolve(process.argv[1]!)] },
): Promise<ExternalCliSessionDescriptor> {
  const existing = await findService(options.serviceKey);
  if (existing) return existing;
  const directory = join(bridgeExternalCliDir(), "services");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Kernel lifetime lock: racing starters cannot spawn two writers, even if a
  // launcher dies midway. No stale PID-file removal or time-based lock stealing.
  const child = spawn("flock", ["--nonblock", "--no-fork", join(directory, `${options.serviceKey}.lock`),
    launch.command, ...launch.args, SERVICE_WORKER_ARGUMENT], {
    detached: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: process.env,
    cwd: options.workspaceRoot,
  });
  let failure: Error | undefined;
  let exited: number | null = null;
  let diagnostic = "";
  child.on("error", (error) => { failure = error; });
  child.on("exit", (code) => { exited = code; });
  child.stderr.on("data", (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4096); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(options));
  const deadline = Date.now() + 20_000;
  try {
    do {
      if (failure) throw failure;
      const descriptor = await findService(options.serviceKey);
      if (descriptor) return descriptor;
      // flock exits 1 when another bootstrap already holds the lifetime lock.
      if (exited !== null && exited !== 1) throw new Error(`Local service startup failed (${exited}): ${diagnostic}`);
      await new Promise((done) => setTimeout(done, 50));
    } while (Date.now() < deadline);
    throw new Error("Local service did not become ready; no competing backend was started");
  } finally {
    // Detach only the launcher's pipes. The service and native backend outlive it.
    child.stderr.destroy();
    child.unref();
  }
}

export async function relayServiceStdio(
  descriptor: ExternalCliSessionDescriptor,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<number> {
  const token = await readFile(descriptor.tokenPath, "utf8");
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid local service credential");
  const socket = new WebSocket(descriptor.endpoint, {
    headers: { Authorization: `Bearer ${token}`, "x-codex-bridge-client": "vscode" },
    handshakeTimeout: 5_000,
    maxPayload: MAX_BUFFER,
  });
  return await new Promise<number>((done) => {
    let settled = false;
    let lines: ReturnType<typeof createInterface> | undefined;
    let lastPong = Date.now();
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      lines?.close();
      input.off("end", detached);
      input.off("close", detached);
      input.off("error", failed);
      output.off("error", failed);
      process.off("SIGTERM", detached);
      process.off("SIGINT", detached);
      socket.terminate();
      done(code);
    };
    const detached = (): void => finish(0);
    const failed = (): void => finish(1);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 25_000) failed();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 10_000);
    heartbeat.unref();
    input.once("end", detached);
    input.once("close", detached);
    input.once("error", failed);
    output.once("error", failed);
    process.once("SIGTERM", detached);
    process.once("SIGINT", detached);
    socket.on("error", failed);
    socket.on("close", failed);
    socket.on("pong", () => { lastPong = Date.now(); });
    socket.on("message", (data) => {
      if (output.destroyed || output.writableLength > MAX_BUFFER) return failed();
      output.write(`${data.toString()}\n`);
    });
    socket.once("open", () => {
      if (input.destroyed || input.readableEnded) return detached();
      lines = createInterface({ input });
      lines.on("line", (line) => {
        // Never replay writes after transport loss: their outcome may be unknown.
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFER || Buffer.byteLength(line) > MAX_BUFFER) return failed();
        try { parseRpcLine(line); socket.send(line); } catch { failed(); }
      });
    });
  });
}

export async function runLocalServiceWorker(): Promise<number> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Service bootstrap is too large");
  }
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || typeof value.workspaceRoot !== "string" || typeof value.codexExecutable !== "string" ||
      typeof value.auditPath !== "string" || typeof value.serviceKey !== "string" ||
      !Array.isArray(value.appServerArgs) || !value.appServerArgs.every((arg) => typeof arg === "string")) {
    throw new Error("Invalid service bootstrap");
  }
  const options = value as unknown as LocalServiceOptions;
  if (options.serviceKey !== await (options.serviceScope === "user" ? userServiceKey() : localServiceKey(options.workspaceRoot, options.appServerArgs))) throw new Error("Service execution domain mismatch");
  if ((await discoverExternalCliSessions()).some((entry) => entry.host === "local" &&
      entry.workspaceRoot === options.workspaceRoot && !entry.serviceKey)) {
    throw new Error("A legacy window-owned backend is still connected; reload its windows before service migration");
  }
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  // No window owns this control connection. It recovers all loaded threads and
  // supplies the service's lifecycle handshake independently of any UI.
  const server = new SharedAppServer({
    ...options,
    config: null,
    controlDir: options.workspaceRoot,
    appServerCwd: options.workspaceRoot,
    localWorkspaceRoot: options.workspaceRoot,
    persistentSession: true,
    serviceKey: options.serviceKey,
    serviceScope: options.serviceScope,
    input,
    output,
    errorOutput: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  });
  input.write(JSON.stringify({ id: "bridge-service-init", method: "initialize", params: {
    clientInfo: { name: "codex_bridge_service", version: "1" }, capabilities: { experimentalApi: true },
  } }) + "\n");
  // Send initialized only after the initialize response, not optimistically.
  let responseBuffer = "";
  output._write = (chunk, _encoding, callback) => {
    responseBuffer += String(chunk);
    let end: number;
    while ((end = responseBuffer.indexOf("\n")) >= 0) {
      const message = parseRpcLine(responseBuffer.slice(0, end));
      responseBuffer = responseBuffer.slice(end + 1);
      if ("id" in message && message.id === "bridge-service-init") {
        if ("error" in message && message.error) input.end();
        else input.write('{"method":"initialized"}\n');
      }
    }
    callback();
  };
  return await server.run();
}
