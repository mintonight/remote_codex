import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, resolve, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { AuditLog } from "../core/audit-log.js";
import { chmodIfSupported } from "../core/file-permissions.js";
import { loadLocalWorkspaceContext, readLocalWorkspaceContext } from "../core/local-workspace-context.js";
import {
  bridgeExternalCliDir,
  bridgeExternalCliSessionPath,
  bridgeExternalCliTokenPath,
  bridgeUpstreamTokenPath,
} from "../core/locations.js";
import {
  saveShimRuntimeStatus,
  type ShimRuntimeStatus,
} from "../core/shim-runtime-status.js";
import type { SpawnProcess } from "../core/ssh-executor.js";
import type {
  AuditEvent,
  BridgeClientIdentity,
  BridgeConfig,
} from "../core/types.js";
import { isVsCodeConversationClientName } from "./external-client-identity.js";
import {
  currentProcessStartedAtMs,
  inspectProcessIdentities,
  type ProcessIdentity,
} from "./process-identity.js";
import {
  RemoteTurnClientTracker,
  RemoteToolCallCoordinator,
  ShimProxy,
  type RpcMessageWriter,
} from "./proxy.js";
import { RemoteApprovalPolicyTracker } from "./remote-approval-policy.js";
import {
  isRecord,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  parseRpcLine,
  type RpcId,
  type RpcMessage,
} from "./rpc.js";
import type { ToolRouteInventory } from "./tool-routing.js";
import { ThreadLifecycleIndex } from "./thread-lifecycle.js";
import { cleanupStaleOfficialAppServers } from "../extension/stale-app-server-cleanup.js";
import { claimAppServerHandoff, type AppServerHandoff } from "./app-server-handoff.js";
import { ThreadSubscriptionRecovery } from "./thread-recovery.js";
import { ServiceRequests } from "./service-requests.js";

const LOOPBACK_HOST = "127.0.0.1";
const EXTERNAL_TOKEN_ENV = "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN";
const NOTIFICATION_DEDUP_MS = 1_000;
const EXTERNAL_CLOSE_CODE = 1_012;
const EXTERNAL_CLOSE_REASON = "Bridge app-server restarting";
const EXTERNAL_CLOSE_GRACE_MS = 250;
const EXTERNAL_DISCONNECT_INTERRUPT_TIMEOUT_MS = 2_000;

interface RelayedNotification {
  expiresAtMs: number;
  sources: Set<string>;
}

interface PendingClientRequest {
  clientIdentity: BridgeClientIdentity;
  method: string;
  threadId?: string;
  turnId?: string;
}

interface PendingExternalRequest {
  details: Record<string, unknown>;
  operationId: string;
  startedAtMs: number;
}

interface ExternalTurnInterruptSummary {
  confirmed: number;
  requested: number;
  unconfirmed: number;
}

export interface ExternalCliSessionDescriptor {
  codexHome?: string;
  serviceScope?: "user";
  serviceKey?: string;
  version: 1 | 2 | 3;
  appServer?: ProcessIdentity;
  endpoint: string;
  executablePath?: string;
  executableFileId?: string;
  host: string;
  pid: number;
  startedAtMs: number;
  tokenEnv: string;
  tokenPath: string;
  workspaceRoot: string;
  threadId?: string;
  loadedThreadIds?: string[];
  lifecycle?: "starting" | "ready" | "stopping" | "detached" | "failed";
  upstreamEndpoint?: string;
  retainUntilMs?: number;
}

export interface SharedAppServerOptions {
  appServerArgs: readonly string[];
  appServerCwd?: string;
  auditPath: string;
  codexExecutable: string;
  config: BridgeConfig | null;
  controlDir: string;
  localWorkspaceContextPath?: string;
  localWorkspaceRoot?: string;
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  extensionHostPid?: number;
  toolRouteInventory?: ToolRouteInventory;
  runtimeStatusPath?: string;
  persistentSession?: boolean;
  serviceKey?: string;
  workspaceContextTimeoutMs?: number;
  serviceScope?: "user";
  spawnCodex?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  spawnSsh?: SpawnProcess;
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  return match?.[1];
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return address.port;
}

export function withSharedWebSocketTransport(
  appServerArgs: readonly string[],
  endpoint: string,
  tokenPath: string,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < appServerArgs.length; index += 1) {
    const argument = appServerArgs[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--stdio") {
      continue;
    }
    if (argument === "--listen") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--listen=")) {
      continue;
    }
    if (
      argument === "--ws-auth" ||
      argument === "--ws-token-file" ||
      argument === "--ws-token-sha256" ||
      argument === "--ws-shared-secret-file" ||
      argument === "--ws-issuer" ||
      argument === "--ws-audience" ||
      argument === "--ws-max-clock-skew-seconds"
    ) {
      index += 1;
      continue;
    }
    result.push(argument);
  }
  return [
    ...result,
    "--listen",
    endpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenPath,
  ];
}

function webSocketWriter(socket: WebSocket): RpcMessageWriter {
  return (message) => {
    if (socket.bufferedAmount > 16 * 1024 * 1024) {
      socket.close(1013, "Slow client; reconnect to recover state");
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
}

function streamWriter(stream: Writable, onStalled: () => void): RpcMessageWriter {
  return (message) => {
    if (stream.destroyed || stream.writableLength > 16 * 1024 * 1024) {
      onStalled();
      return;
    }
    stream.write(`${JSON.stringify(message)}\n`);
  };
}

function rawMessage(data: RawData): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

export class SharedAppServer {
  readonly #options: SharedAppServerOptions;
  readonly #audit: AuditLog;
  readonly #approvalPolicies = new RemoteApprovalPolicyTracker();
  readonly #remoteToolCalls = new RemoteToolCallCoordinator();
  readonly #turnClients = new RemoteTurnClientTracker();
  readonly #sessionPath = bridgeExternalCliSessionPath();
  readonly #externalTokenPath = bridgeExternalCliTokenPath();
  readonly #upstreamTokenPath = bridgeUpstreamTokenPath();
  readonly #processExecutablePath = (() => {
    try {
      return realpathSync.native(process.execPath);
    } catch {
      return process.execPath;
    }
  })();
  readonly #startedAtMs = currentProcessStartedAtMs();
  readonly #threads = new ThreadLifecycleIndex();
  readonly #upstreams = new Set<WebSocket>();
  readonly #serviceRequests = new ServiceRequests();
  #serviceIdleConfirmed = false;
  #selfIdentity: ProcessIdentity | undefined;
  readonly #activeThreads = new Map<string, string>();
  readonly #orphanedClients = new Map<string, { upstream: WebSocket; session: ShimProxy; pending: Map<RpcId, PendingExternalRequest> }>();
  #refreshSubscriptions: (() => void) | undefined;
  #lifecycle: "starting" | "ready" | "stopping" | "detached" | "failed" = "starting";
  #detached = false;
  #ready = false;
  #persistentSession = false;
  #ownsState = false;
  #pendingHandoff: AppServerHandoff | null = null;
  #resolveStopped: () => void = () => undefined;
  readonly #stopped = new Promise<void>((resolvePromise) => { this.#resolveStopped = resolvePromise; });
  #stopping = false;
  #closeTask: Promise<void> | undefined;
  #stopChildTask: Promise<boolean> | undefined;
  #childExited: Promise<number> | undefined;
  #activeWorkspaceRoot: string;
  #appServerIdentity: ProcessIdentity | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #externalServer: WebSocketServer | null = null;
  #externalToken = "";
  #upstreamEndpoint = "";
  #upstreamToken = "";
  #descriptorQueue = Promise.resolve();
  #auditQueue = Promise.resolve();
  #runtimeStatus: ShimRuntimeStatus | null = null;
  #runtimeStatusQueue = Promise.resolve();
  #stdioWriter: RpcMessageWriter | null = null;
  readonly #externalWriters = new Map<string, RpcMessageWriter>();
  readonly #externalRelayCounts = new Map<string, number>();
  readonly #externalCleanupTasks = new Set<Promise<void>>();
  readonly #relayedNotifications = new Map<string, RelayedNotification>();
  readonly #vscodeInitialized: Promise<void>;
  #resolveVsCodeInitialized: () => void = () => undefined;

  constructor(options: SharedAppServerOptions) {
    this.#options = options;
    this.#persistentSession = options.persistentSession ?? false;
    this.#audit = new AuditLog(options.auditPath);
    this.#vscodeInitialized = new Promise<void>((resolvePromise) => {
      this.#resolveVsCodeInitialized = resolvePromise;
    });
    this.#activeWorkspaceRoot =
      options.config?.workspaceRoot ??
      options.localWorkspaceRoot ??
      options.appServerCwd ??
      process.cwd();
  }

  async run(): Promise<number> {
    const input = this.#options.input ?? process.stdin;
    const output = this.#options.output ?? process.stdout;
    const stop = (): void => this.#requestStop();
    input.once("end", stop);
    input.once("close", stop);
    input.once("error", stop);
    output.once("error", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const ownerPid = this.#options.extensionHostPid;
    const ownerMonitor = ownerPid ? setInterval(() => {
      try { process.kill(ownerPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") stop();
      }
    }, 1_000) : undefined;
    ownerMonitor?.unref();
    let idleSince = Date.now();
    const serviceMonitor = this.#options.serviceKey ? setInterval(() => {
      for (const [id, client] of this.#orphanedClients) {
        if (client.upstream.readyState === WebSocket.CLOSED ||
            (this.#activeThreads.size === 0 && client.pending.size === 0 && !this.#serviceRequests.has(id))) {
          client.session.closeSession();
          client.upstream.close();
          this.#serviceRequests.remove(id);
          this.#orphanedClients.delete(id);
        }
      }
      // Loaded/unknown work is retained conservatively. Never infer idleness
      // from the lack of a foreground window or from an elapsed turn timeout.
      if (!this.#serviceIdleConfirmed || this.#externalServer?.clients.size || this.#threads.loaded.size || this.#orphanedClients.size) idleSince = Date.now();
      else if (this.#ready && Date.now() - idleSince > 30 * 60_000) stop();
    }, 1_000) : undefined;
    try {
      if (input.destroyed || input.readableEnded) return 0;
      await this.#resolveStartupWorkspace();
      this.#selfIdentity = (await inspectProcessIdentities([process.pid])).get(process.pid);
      const cleanup = this.#persistentSession ? null : await cleanupStaleOfficialAppServers();
      if (cleanup && cleanup.staleCount > 0) {
        await this.#audit.write({
          operation: "app_server.stale_cleanup",
          outcome: cleanup.failedPids.length ? "failed" : "succeeded",
          details: { ...cleanup, phase: "before-spawn" },
        });
      }
      if (this.#stopping) return 0;
      return await this.#runOwned();
    } catch (error) {
      if (this.#stopping) return 0;
      throw error;
    } finally {
      if (ownerMonitor) clearInterval(ownerMonitor);
      if (serviceMonitor) clearInterval(serviceMonitor);
      try { await this.#close(); }
      finally {
        await this.#pendingHandoff?.release(false);
        this.#pendingHandoff = null;
        input.off("end", stop);
        input.off("close", stop);
        input.off("error", stop);
        output.off("error", stop);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
  }

  async #resolveStartupWorkspace(): Promise<void> {
    if (!this.#persistentSession || this.#options.config) return;
    const path = this.#options.localWorkspaceContextPath;
    if (!path) {
      // A launcher's cwd is not evidence of the open VS Code workspace.
      if (!this.#options.localWorkspaceRoot) this.#persistentSession = false;
      return;
    }
    const deadline = Date.now() + (this.#options.workspaceContextTimeoutMs ?? 5_000);
    do {
      if (this.#stopping) return;
      const context = await readLocalWorkspaceContext(path);
      if (context) {
        if (context.workspaceRoot === null) this.#persistentSession = false;
        else this.#activeWorkspaceRoot = context.workspaceRoot;
        await this.#audit.write({ operation: "app_server.workspace_resolved", outcome: "succeeded",
          details: { source: "extension-host-context", workspaceRoot: context.workspaceRoot, persistentSession: this.#persistentSession } });
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    } while (Date.now() < deadline);
    throw new Error("VS Code workspace context is not ready; refusing to start a competing app-server");
  }

  async #runOwned(): Promise<number> {
    const input = this.#options.input ?? process.stdin;
    const output = this.#options.output ?? process.stdout;
    const errorOutput = this.#options.errorOutput ?? process.stderr;
    const spawnCodex = this.#options.spawnCodex ?? spawn;
    const directory = bridgeExternalCliDir();
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmodIfSupported(directory, 0o700);
    try {
      await this.#startRuntimeStatus();
    } catch (error) {
      errorOutput.write(`codex-bridge: unable to record Shim runtime status: ${String(error)}\n`);
    }

    const handoff = this.#persistentSession
      ? await claimAppServerHandoff(directory, this.#options.config?.host ?? "local", this.#activeWorkspaceRoot, this.#options.serviceKey)
      : null;
    this.#pendingHandoff = handoff;
    this.#upstreamToken = handoff?.token ?? randomBytes(32).toString("base64url");
    this.#externalToken = randomBytes(32).toString("base64url");
    this.#ownsState = true;
    await writeFile(this.#upstreamTokenPath, this.#upstreamToken, { mode: 0o600 });
    await writeFile(this.#externalTokenPath, this.#externalToken, { mode: 0o600 });
    await chmodIfSupported(this.#upstreamTokenPath, 0o600);
    await chmodIfSupported(this.#externalTokenPath, 0o600);

    this.#upstreamEndpoint = handoff?.endpoint ?? `ws://${LOOPBACK_HOST}:${await reserveLoopbackPort()}`;
    const appServerArgs = withSharedWebSocketTransport(
      this.#options.appServerArgs,
      this.#upstreamEndpoint,
      this.#upstreamTokenPath,
    );
    if (this.#stopping) return 0;
    if (handoff) {
      this.#appServerIdentity = handoff.appServer;
    } else {
    const child = spawnCodex(this.#options.codexExecutable, appServerArgs, {
      cwd: this.#options.appServerCwd ?? this.#options.controlDir,
      env: process.env,
      stdio: "pipe",
    });
    this.#child = child;
    this.#childExited = new Promise<number>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise(signal ? 128 : (code ?? 1)));
      child.once("error", () => resolvePromise(1));
    });
    this.#appServerIdentity = await this.#inspectAppServerIdentity(child);
    child.stderr.pipe(errorOutput, { end: false });
    child.stdout.pipe(errorOutput, { end: false });
    }

    let exitCode: number | null = null;
    let runtimeError: string | null = null;
    try {
      if (this.#stopping) return 0;
      // Publish recovery identity before initialization, not just after a UI handshake.
      const externalPort = await this.#startExternalServer(errorOutput);
      await this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${externalPort}`);
      const upstream = await this.#connectUpstream();
      if (handoff) {
        await handoff.release(true);
        this.#pendingHandoff = null;
        await this.#audit.write({ operation: "app_server.handoff", outcome: "succeeded",
          details: { appServerPid: handoff.appServer.pid } });
      }
      const stdioClient = this.#runStdioClient(upstream, input, output, errorOutput);
      const startup = await Promise.race([
        this.#vscodeInitialized.then(() => ({ initialized: true as const })),
        stdioClient.then((code) => ({ code, initialized: false as const })),
      ]);
      if (!startup.initialized) {
        exitCode = startup.code;
        return exitCode;
      }
      this.#lifecycle = "ready";
      this.#ready = true;
      await this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${externalPort}`);
      await this.#audit.write({
        operation: "external_cli.gateway",
        outcome: "started",
        hostId: this.#options.config?.host ?? "local",
        workspaceRoot: this.#activeWorkspaceRoot,
        details: { endpoint: `ws://${LOOPBACK_HOST}:${externalPort}` },
      });
      exitCode = await stdioClient;
      return exitCode;
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.#close();
      const appServerLastError =
        runtimeError ??
        (exitCode !== null && exitCode !== 0
          ? `Official Codex app-server exited with code ${exitCode}`
          : null);
      try {
        await this.#updateRuntimeStatus({
          running: false,
          shimLastExitCode: exitCode,
          appServerLastError,
        });
      } catch (error) {
        errorOutput.write(
          `codex-bridge: unable to finalize Shim runtime status: ${String(error)}\n`,
        );
      }
    }
  }

  async #startRuntimeStatus(): Promise<void> {
    if (!this.#options.runtimeStatusPath || !this.#options.config) {
      return;
    }
    const scriptEntry = process.argv[1] ?? "";
    const scriptRuntime = scriptEntry.toLowerCase().endsWith(".cjs");
    this.#runtimeStatus = {
      version: 1,
      host: this.#options.config.host,
      workspaceRoot: this.#options.config.workspaceRoot,
      shimExecutable: scriptRuntime ? scriptEntry : process.execPath,
      nodeExecutable: scriptRuntime ? process.execPath : null,
      extensionHostPid: this.#options.extensionHostPid ?? process.ppid,
      shimPid: process.pid,
      shimStartedAtMs: this.#startedAtMs,
      running: true,
      shimLastExitCode: null,
      appServerInitializedAtMs: null,
      appServerLastError: null,
      updatedAtMs: Date.now(),
    };
    await this.#updateRuntimeStatus({});
  }

  async #updateRuntimeStatus(
    patch: Partial<
      Pick<
        ShimRuntimeStatus,
        | "running"
        | "shimLastExitCode"
        | "appServerInitializedAtMs"
        | "appServerLastError"
      >
    >,
  ): Promise<void> {
    if (!this.#runtimeStatus || !this.#options.runtimeStatusPath) {
      return;
    }
    this.#runtimeStatus = {
      ...this.#runtimeStatus,
      ...patch,
      updatedAtMs: Date.now(),
    };
    const snapshot = { ...this.#runtimeStatus };
    this.#runtimeStatusQueue = this.#runtimeStatusQueue
      .catch(() => undefined)
      .then(() => saveShimRuntimeStatus(this.#options.runtimeStatusPath!, snapshot));
    await this.#runtimeStatusQueue;
  }

  async #connectUpstream(): Promise<WebSocket> {
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (this.#stopping) throw new Error("Bridge app-server is stopping");
      try {
        return await new Promise<WebSocket>((resolvePromise, reject) => {
          const socket = new WebSocket(this.#upstreamEndpoint, {
            headers: { Authorization: `Bearer ${this.#upstreamToken}` },
          });
          const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error("Timed out connecting to official Codex app-server"));
          }, 1_000);
          socket.once("open", () => {
            clearTimeout(timer);
            this.#upstreams.add(socket);
            socket.once("close", () => this.#upstreams.delete(socket));
            resolvePromise(socket);
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw new Error(`Could not connect to official Codex app-server: ${String(lastError)}`);
  }

  async #startExternalServer(errorOutput: Writable): Promise<number> {
    const server = new WebSocketServer({
      host: LOOPBACK_HOST,
      port: 0,
      maxPayload: 16 * 1024 * 1024,
      verifyClient: ({ req }, done) => {
        const token = bearerToken(req.headers.authorization);
        done(!req.headers.origin && this.#lifecycle === "ready" && secretMatches(token, this.#externalToken), 401, "Unauthorized");
      },
    });
    this.#externalServer = server;
    server.on("connection", (socket, request) => {
      void this.#serveExternalClient(socket, errorOutput,
        Boolean(this.#options.serviceKey && request.headers["x-codex-bridge-client"] === "vscode"));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("listening", resolvePromise);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("External CLI gateway did not bind a loopback port");
    }
    return address.port;
  }

  async #serveExternalClient(socket: WebSocket, errorOutput: Writable, vscode = false): Promise<void> {
    const clientId = randomUUID();
    const clientIdentity: BridgeClientIdentity = {
      clientId,
      clientSource: vscode ? "vscode" : "external-cli",
    };
    const buffered: string[] = [];
    const pendingClientRequests = new Map<RpcId, PendingClientRequest>();
    const pendingExternalRequests = new Map<RpcId, PendingExternalRequest>();
    let closed = false;
    socket.on("error", () => socket.terminate());
    socket.once("close", () => {
      closed = true;
    });
    const bufferMessage = (data: RawData): void => {
      if (buffered.length >= 256) { socket.close(1009, "Initialization backlog exceeded"); return; }
      buffered.push(rawMessage(data));
    };
    socket.on("message", bufferMessage);
    let upstream: WebSocket | null = null;
    let session: ShimProxy | null = null;
    try {
      upstream = await this.#connectUpstream();
      upstream.once("close", () => {
        this.#serviceRequests.remove(clientId);
        socket.close(1012, "Native connection closed; reconnect to recover state");
      });
      if (closed) {
        upstream.close();
        return;
      }
      session = this.#createSession(true, 1, clientIdentity);
      const writeUpstream = webSocketWriter(upstream);
      const writeExternalTransport = webSocketWriter(socket);
      let initialized = false;
      let replayed = false;
      const writeExternal: RpcMessageWriter = (message) => {
        if (isRpcResponse(message)) {
          const pending = pendingExternalRequests.get(message.id);
          if (pending) {
            pendingExternalRequests.delete(message.id);
            if (pending.details.method === "initialize" && !message.error) initialized = true;
            void this.#queueAudit({
              ...clientIdentity,
              operationId: pending.operationId,
              operation: "external_cli.request",
              outcome: message.error ? "failed" : "succeeded",
              durationMs: Date.now() - pending.startedAtMs,
              hostId: this.#options.config?.host ?? "local",
              workspaceRoot: this.#activeWorkspaceRoot,
              details: pending.details,
            });
          }
        }
        writeExternalTransport(message);
        if (isRpcResponse(message) && initialized && !closed) {
          this.#externalWriters.set(clientId, writeExternal);
          if (this.#options.serviceKey && !replayed) {
            replayed = true;
            this.#serviceRequests.replay(writeExternal);
          }
        }
      };
      this.#externalRelayCounts.set(clientId, 0);
      const downstream = this.#downstreamWriter(clientId, writeExternal);
      const writeClient: RpcMessageWriter = (message) => {
        if (this.#options.serviceKey && isRpcRequest(message)) {
          this.#serviceRequests.publish(clientId, message, writeUpstream, (request) => {
            for (const writer of this.#externalWriters.values()) writer(request);
          });
        } else downstream(message);
      };
      const handleClient = (raw: string): void => {
        try {
          const message = parseRpcLine(raw);
          if (this.#options.serviceKey && this.#serviceRequests.respond(message)) return;
          if (this.#options.serviceKey && initialized && isRpcRequest(message) &&
              ["bridge/service/status", "bridge/service/stop"].includes(message.method)) {
            const busy = !this.#serviceIdleConfirmed || this.#threads.loaded.size > 0 || this.#orphanedClients.size > 0 ||
              this.#externalWriters.size > 1 || pendingExternalRequests.size > 0;
            if (message.method === "bridge/service/stop" && busy) {
              writeExternal({ id: message.id, error: { code: -32000, message: "Service still has clients, loaded threads or unconfirmed work; refusing shutdown" } });
            } else {
              writeExternal({ id: message.id, result: { pid: process.pid, appServerPid: this.#appServerIdentity?.pid,
                clients: this.#externalWriters.size, activeThreads: [...this.#activeThreads.keys()], loadedThreads: [...this.#threads.loaded], canStop: !busy } });
              if (message.method === "bridge/service/stop") setTimeout(() => this.#requestStop(), 25);
            }
            return;
          }
          if (this.#options.serviceKey && "method" in message && message.method === "initialized") {
            this.#refreshSubscriptions?.();
          }
          const externalMcpInitialize = this.#isExternalMcpInitialize(message);
          this.#observeClientMessage(
            message,
            pendingClientRequests,
            clientIdentity,
          );
          let operationId: string | undefined;
          let details: Record<string, unknown> | undefined;
          if ("method" in message) {
            operationId = isRpcRequest(message)
              ? String(message.id)
              : randomUUID();
            details = this.#externalRequestAuditDetails(message);
            if (isRpcRequest(message)) {
              pendingExternalRequests.set(message.id, {
                details,
                operationId,
                startedAtMs: Date.now(),
              });
            }
          }
          const handling = session?.handleClientMessage(message, writeUpstream, writeClient);
          if (!handling) {
            throw new Error("External client session is unavailable");
          }
          if (externalMcpInitialize) {
            clientIdentity.clientSource = "external-mcp";
          }
          if (operationId && details) {
            void this.#queueAudit({
              ...clientIdentity,
              operationId,
              operation: "external_cli.request",
              outcome: isRpcRequest(message) ? "started" : "succeeded",
              hostId: this.#options.config?.host ?? "local",
              workspaceRoot: this.#activeWorkspaceRoot,
              details,
            });
          }
          void handling
            .catch((error) => {
              if (isRpcRequest(message)) {
                const pending = pendingExternalRequests.get(message.id);
                if (pending) {
                  pendingExternalRequests.delete(message.id);
                  void this.#queueAudit({
                    ...clientIdentity,
                    operationId: pending.operationId,
                    operation: "external_cli.request",
                    outcome: "failed",
                    durationMs: Date.now() - pending.startedAtMs,
                    hostId: this.#options.config?.host ?? "local",
                    workspaceRoot: this.#activeWorkspaceRoot,
                    details: {
                      ...pending.details,
                      errorType:
                        error instanceof Error ? error.name : typeof error,
                    },
                  });
                }
              }
              errorOutput.write(
                `codex-bridge: external client request failed: ${String(error)}\n`,
              );
            });
        } catch (error) {
          errorOutput.write(`codex-bridge: invalid external JSON-RPC: ${String(error)}\n`);
          socket.close(1003, "Invalid JSON-RPC");
        }
      };
      upstream.on("message", (data) => {
        try {
          const message = parseRpcLine(rawMessage(data));
          this.#observeServerMessage(message, pendingClientRequests);
          void session
            ?.handleServerMessage(message, writeUpstream, writeClient)
            .catch((error) => {
              errorOutput.write(
                `codex-bridge: external server request failed: ${String(error)}\n`,
              );
            });
        } catch (error) {
          errorOutput.write(`codex-bridge: invalid upstream JSON-RPC: ${String(error)}\n`);
          upstream?.close();
        }
      });
      socket.once("close", () => {
        if (this.#options.serviceKey && upstream && session && !this.#stopping) {
          this.#externalWriters.delete(clientId);
          this.#externalRelayCounts.delete(clientId);
          this.#orphanedClients.set(clientId, { upstream, session, pending: pendingExternalRequests });
          this.#refreshSubscriptions?.();
          void this.#queueAudit({ ...clientIdentity, operation: "service.client_detached", outcome: "succeeded",
            details: { pendingRequests: pendingExternalRequests.size, interruptedTurns: 0 } });
          return;
        }
        const cleanup = this.#handleExternalDisconnect(
          clientIdentity,
          pendingExternalRequests,
          upstream,
          session,
        ).catch((error) => {
          errorOutput.write(
            `codex-bridge: external client cleanup failed: ${String(error)}\n`,
          );
        });
        this.#externalCleanupTasks.add(cleanup);
        void cleanup.finally(() => this.#externalCleanupTasks.delete(cleanup));
      });
      // Both reply and disconnect callbacks must exist before accepting input.
      // A slow audit write must not create a window that loses initialize replies.
      await this.#queueAudit({
        ...clientIdentity,
        operationId: clientId,
        operation: "external_cli.connect",
        outcome: "succeeded",
        hostId: this.#options.config?.host ?? "local",
        workspaceRoot: this.#activeWorkspaceRoot,
      });
      if (closed) return;
      socket.off("message", bufferMessage);
      socket.on("message", (data) => handleClient(rawMessage(data)));
      for (const raw of buffered) handleClient(raw);
    } catch (error) {
      this.#externalWriters.delete(clientId);
      this.#externalRelayCounts.delete(clientId);
      upstream?.terminate();
      session?.closeSession();
      socket.close(1011, "Bridge upstream unavailable");
      errorOutput.write(`codex-bridge: external CLI connection failed: ${String(error)}\n`);
    }
  }

  async #handleExternalDisconnect(
    clientIdentity: BridgeClientIdentity,
    pendingExternalRequests: Map<RpcId, PendingExternalRequest>,
    upstream: WebSocket | null,
    session: ShimProxy | null,
  ): Promise<void> {
    const notificationsRelayedToVsCode =
      this.#externalRelayCounts.get(clientIdentity.clientId) ?? 0;
    for (const pending of pendingExternalRequests.values()) {
      void this.#queueAudit({
        ...clientIdentity,
        operationId: pending.operationId,
        operation: "external_cli.request",
        outcome: "cancelled",
        durationMs: Date.now() - pending.startedAtMs,
        hostId: this.#options.config?.host ?? "local",
        workspaceRoot: this.#activeWorkspaceRoot,
        details: {
          ...pending.details,
          reason: "client-disconnected",
        },
      });
    }
    pendingExternalRequests.clear();
    this.#externalWriters.delete(clientIdentity.clientId);
    this.#externalRelayCounts.delete(clientIdentity.clientId);
    session?.closeSession();
    const turnInterrupts = this.#options.serviceKey || (this.#persistentSession && this.#stopping)
      ? { confirmed: 0, requested: 0, unconfirmed: 0 }
      : await this.#interruptExternalTurns(clientIdentity.clientId, upstream);
    upstream?.close();
    await this.#queueAudit({
      ...clientIdentity,
      operationId: clientIdentity.clientId,
      operation: "external_cli.disconnect",
      outcome: turnInterrupts.unconfirmed === 0 ? "succeeded" : "unknown",
      hostId: this.#options.config?.host ?? "local",
      workspaceRoot: this.#activeWorkspaceRoot,
      details: { notificationsRelayedToVsCode, turnInterrupts },
    });
  }

  async #interruptExternalTurns(
    clientId: string,
    upstream: WebSocket | null,
  ): Promise<ExternalTurnInterruptSummary> {
    const turns = this.#turnClients.takeForClient(clientId);
    if (turns.length === 0) {
      return { confirmed: 0, requested: 0, unconfirmed: 0 };
    }
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      return {
        confirmed: 0,
        requested: turns.length,
        unconfirmed: turns.length,
      };
    }

    const pendingIds = new Set<RpcId>();
    let confirmed = 0;
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolvePromise) => {
      settle = resolvePromise;
    });
    const handleMessage = (data: RawData): void => {
      let message: ReturnType<typeof parseRpcLine>;
      try {
        message = parseRpcLine(rawMessage(data));
      } catch {
        return;
      }
      if (!isRpcResponse(message) || !pendingIds.delete(message.id)) {
        return;
      }
      if (!message.error) {
        confirmed += 1;
      }
      if (pendingIds.size === 0) {
        settle();
      }
    };
    upstream.on("message", handleMessage);
    for (const turn of turns) {
      const id = `external_disconnect_${randomUUID()}`;
      pendingIds.add(id);
      try {
        upstream.send(
          JSON.stringify({
            id,
            method: "turn/interrupt",
            params: turn,
          }),
        );
      } catch {
        pendingIds.delete(id);
      }
    }
    if (pendingIds.size === 0) {
      settle();
    }
    const timeout = setTimeout(settle, EXTERNAL_DISCONNECT_INTERRUPT_TIMEOUT_MS);
    timeout.unref();
    await settled;
    clearTimeout(timeout);
    upstream.off("message", handleMessage);
    return {
      confirmed,
      requested: turns.length,
      unconfirmed: turns.length - confirmed,
    };
  }

  async #runStdioClient(
    upstream: WebSocket,
    input: Readable,
    output: Writable,
    errorOutput: Writable,
  ): Promise<number> {
    const clientIdentity: BridgeClientIdentity = {
      clientId: "stdio",
      clientSource: "vscode",
    };
    const session = this.#createSession(true, 0, clientIdentity);
    const pendingClientRequests = new Map<RpcId, PendingClientRequest>();
    const writeUpstream = webSocketWriter(upstream);
    const writeClient = streamWriter(output, () => {
      if (this.#stopping) return;
      void this.#queueAudit({ operation: "app_server.output_stalled", outcome: "failed",
        details: { bufferedBytes: output.writableLength } });
      this.#requestStop();
    });
    this.#stdioWriter = writeClient;
    const writeDownstream = this.#downstreamWriter("stdio", writeClient);
    const recovery = new ThreadSubscriptionRecovery({
      send: (message) => writeUpstream(message),
      emit: (message) => {
        this.#observeServerMessage(message, pendingClientRequests);
        writeDownstream(message);
      },
      workspaceRoot: () => this.#options.serviceScope === "user" ? undefined : this.#activeWorkspaceRoot,
      selectedThreadId: () => this.#threads.selected,
      onCycle: (cycle) => {
        this.#serviceIdleConfirmed = cycle.errors === 0 && cycle.listedThreads === 0;
        void this.#queueAudit({
          operation: "thread.recovery.cycle",
          outcome: cycle.errors ? "failed" : "succeeded",
          workspaceRoot: this.#activeWorkspaceRoot,
          details: { ...cycle },
        }).catch(() => undefined);
      },
      log: (message) => errorOutput.write(`codex-bridge: ${message}\n`),
    });
    this.#refreshSubscriptions = () => { void recovery.refresh(); };
    let lastPongAt = Date.now();
    upstream.on("pong", () => { lastPongAt = Date.now(); });
    const heartbeat = setInterval(() => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > 25_000) upstream.terminate();
      else upstream.ping();
    }, 10_000);
    heartbeat.unref();
    const lines = createInterface({ input });
    let clientQueue = Promise.resolve();
    lines.on("line", (line) => {
      clientQueue = clientQueue
        .then(async () => {
          const message = parseRpcLine(line);
          this.#observeClientMessage(
            message,
            pendingClientRequests,
            clientIdentity,
          );
          await session.handleClientMessage(message, writeUpstream, writeDownstream);
          if (this.#persistentSession && "method" in message && message.method === "initialized") recovery.start();
        })
        .catch((error) => {
          errorOutput.write(`codex-bridge: invalid client JSON-RPC: ${String(error)}\n`);
        });
    });
    upstream.on("message", (data) => {
      try {
        const message = parseRpcLine(rawMessage(data));
        if (recovery.observe(message)) return;
        this.#observeServerMessage(message, pendingClientRequests);
        void session.handleServerMessage(message, writeUpstream, writeDownstream).catch((error) => {
          errorOutput.write(`codex-bridge: server request handling failed: ${String(error)}\n`);
        });
      } catch (error) {
        errorOutput.write(`codex-bridge: invalid server JSON-RPC: ${String(error)}\n`);
      }
    });

    return await new Promise<number>((resolvePromise, reject) => {
      const finish = (code: number): void => {
        clearInterval(heartbeat);
        recovery.dispose();
        this.#refreshSubscriptions = undefined;
        lines.close();
        session.closeSession();
        this.#stdioWriter = null;
        resolvePromise(code);
      };
      upstream.once("error", reject);
      upstream.once("close", () => this.#requestStop());
      void this.#childExited?.then((code) => finish(this.#stopping ? 0 : code));
      void this.#stopped.then(() => finish(0));
    });
  }

  #createSession(
    observeApprovalPolicy: boolean,
    remoteToolPriority: number,
    clientIdentity: BridgeClientIdentity,
  ): ShimProxy {
    return new ShimProxy({
      appServerArgs: this.#options.appServerArgs,
      auditPath: this.#options.auditPath,
      codexExecutable: this.#options.codexExecutable,
      config: this.#options.config,
      controlDir: this.#options.controlDir,
      approvalPolicies: this.#approvalPolicies,
      clientIdentity,
      remoteToolCalls: this.#remoteToolCalls,
      remoteToolPriority,
      toolRouteInventory: this.#options.toolRouteInventory,
      turnClients: this.#turnClients,
      observeApprovalPolicy,
      rewriteClientMessages: this.#options.config !== null,
      threadListCwd:
        clientIdentity.clientSource === "vscode"
          ? (this.#options.config
              ? this.#options.controlDir
              : this.#options.localWorkspaceRoot)
          : undefined,
      threadListCwdProvider:
        clientIdentity.clientSource === "vscode" &&
        this.#options.localWorkspaceContextPath
          ? async () => {
              const workspaceRoot = await loadLocalWorkspaceContext(
                this.#options.localWorkspaceContextPath!,
              );
              if (workspaceRoot) {
                this.#setActiveWorkspaceRoot(workspaceRoot);
              }
              return workspaceRoot;
            }
          : undefined,
      spawnSsh: this.#options.spawnSsh,
    });
  }

  #downstreamWriter(sourceId: string, origin: RpcMessageWriter): RpcMessageWriter {
    return (message) => {
      if (!isRpcNotification(message)) {
        origin(message);
        return;
      }
      this.#broadcastNotification(sourceId, message);
    };
  }

  #broadcastNotification(sourceId: string, message: RpcMessage): void {
    const now = Date.now();
    const fingerprint = JSON.stringify(message);
    const recent = this.#relayedNotifications.get(fingerprint);
    if (recent && recent.expiresAtMs > now && !recent.sources.has(sourceId)) {
      recent.sources.add(sourceId);
      return;
    }

    this.#relayedNotifications.set(fingerprint, {
      expiresAtMs: now + NOTIFICATION_DEDUP_MS,
      sources: new Set([sourceId]),
    });
    if (this.#relayedNotifications.size > 256) {
      for (const [key, value] of this.#relayedNotifications) {
        if (value.expiresAtMs <= now) {
          this.#relayedNotifications.delete(key);
        }
      }
      while (this.#relayedNotifications.size > 256) {
        const oldest = this.#relayedNotifications.keys().next().value;
        if (oldest === undefined) break;
        this.#relayedNotifications.delete(oldest);
      }
    }

    this.#stdioWriter?.(message);
    if (sourceId !== "stdio" && this.#stdioWriter) {
      this.#externalRelayCounts.set(
        sourceId,
        (this.#externalRelayCounts.get(sourceId) ?? 0) + 1,
      );
    }
    for (const writer of this.#externalWriters.values()) {
      writer(message);
    }
  }

  #observeClientMessage(
    message: ReturnType<typeof parseRpcLine>,
    pendingClientRequests: Map<RpcId, PendingClientRequest>,
    clientIdentity: BridgeClientIdentity,
  ): void {
    if (!isRpcRequest(message)) {
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (
      message.method === "initialize" ||
      message.method === "thread/start" ||
      message.method === "thread/read" ||
      message.method === "thread/resume" ||
      message.method === "thread/fork" ||
      message.method === "thread/unsubscribe" ||
      message.method === "thread/archive" ||
      message.method === "thread/delete" ||
      message.method === "turn/start" ||
      message.method === "turn/steer"
    ) {
      pendingClientRequests.set(message.id, {
        clientIdentity: { ...clientIdentity },
        method: message.method,
        ...(typeof params.threadId === "string"
          ? { threadId: params.threadId }
          : {}),
        ...(typeof params.expectedTurnId === "string"
          ? { turnId: params.expectedTurnId }
          : {}),
      });
    }
  }

  #observeServerMessage(
    message: ReturnType<typeof parseRpcLine>,
    pendingClientRequests: Map<RpcId, PendingClientRequest>,
  ): void {
    if (isRpcResponse(message)) {
      const pending = pendingClientRequests.get(message.id);
      if (pending) {
        pendingClientRequests.delete(message.id);
        if (
          !message.error &&
          pending.method === "initialize" &&
          pending.clientIdentity.clientSource === "vscode"
        ) {
          this.#resolveVsCodeInitialized();
          void this.#updateRuntimeStatus({
            appServerInitializedAtMs: Date.now(),
            appServerLastError: null,
          }).catch(() => undefined);
        }
        const result = isRecord(message.result) ? message.result : {};
        if (!message.error) {
          this.#threads.response(pending.method, pending.threadId, result,
            !this.#options.serviceKey && pending.clientIdentity.clientSource === "vscode");
          if (!this.#options.serviceKey && !this.#options.config && pending.clientIdentity.clientSource === "vscode" &&
              ["thread/start", "thread/resume", "thread/fork"].includes(pending.method) &&
              isRecord(result.thread) && typeof result.thread.cwd === "string" && isAbsolute(result.thread.cwd)) {
            this.#setActiveWorkspaceRoot(result.thread.cwd);
          }
          this.#publishThreadIndex();
          if (["thread/start", "thread/resume", "thread/fork"].includes(pending.method)) this.#refreshSubscriptions?.();
        }
        const turn = result.turn;
        if (
          pending.method === "turn/start" &&
          pending.threadId &&
          isRecord(turn) &&
          typeof turn.id === "string"
        ) {
          if (!message.error) this.#activeThreads.set(pending.threadId, turn.id);
          this.#turnClients.record(
            pending.threadId,
            turn.id,
            pending.clientIdentity,
          );
        }
        if (
          !message.error &&
          pending.method === "turn/steer" &&
          pending.threadId &&
          pending.turnId
        ) {
          this.#turnClients.record(
            pending.threadId,
            pending.turnId,
            pending.clientIdentity,
          );
        }
      }
      return;
    }
    if (!("method" in message) || !isRecord(message.params)) {
      return;
    }
    this.#threads.notification(message.method, message.params);
    const threadId = message.params.threadId;
    if (typeof threadId === "string") {
      if (message.method === "turn/started" && isRecord(message.params.turn) && typeof message.params.turn.id === "string") this.#activeThreads.set(threadId, message.params.turn.id);
      else if (message.method === "turn/completed" && isRecord(message.params.turn) &&
          this.#activeThreads.get(threadId) === message.params.turn.id) this.#activeThreads.delete(threadId);
      else if (["thread/closed", "thread/archived", "thread/deleted"].includes(message.method)) this.#activeThreads.delete(threadId);
      else if (message.method === "thread/status/changed" && isRecord(message.params.status)) {
        if (message.params.status.type === "active" && !this.#activeThreads.has(threadId)) this.#activeThreads.set(threadId, "unknown");
        else if (message.params.status.type === "idle" && this.#activeThreads.get(threadId) === "unknown") this.#activeThreads.delete(threadId);
      }
    }
    if (message.method.startsWith("thread/") || message.method === "turn/started") this.#publishThreadIndex();
    if (
      message.method === "turn/completed" &&
      typeof message.params.threadId === "string" &&
      isRecord(message.params.turn) &&
      typeof message.params.turn.id === "string"
    ) {
      this.#turnClients.complete(
        message.params.threadId,
        message.params.turn.id,
      );
    }
  }

  #isExternalMcpInitialize(
    message: ReturnType<typeof parseRpcLine>,
  ): boolean {
    if (
      !("method" in message) ||
      message.method !== "initialize" ||
      !isRecord(message.params) ||
      !isRecord(message.params.clientInfo)
    ) {
      return false;
    }
    return isVsCodeConversationClientName(message.params.clientInfo.name);
  }

  #externalRequestAuditDetails(
    message: ReturnType<typeof parseRpcLine>,
  ): Record<string, unknown> {
    if (!("method" in message)) {
      return {};
    }
    const details: Record<string, unknown> = { method: message.method };
    const params = isRecord(message.params) ? message.params : {};
    for (const key of ["threadId", "turnId", "expectedTurnId", "callId"] as const) {
      if (typeof params[key] === "string") {
        details[key] = params[key];
      }
    }
    return details;
  }

  #queueAudit(
    event: Omit<AuditEvent, "timestamp"> & { timestamp?: string },
  ): Promise<void> {
    this.#auditQueue = this.#auditQueue
      .catch(() => undefined)
      .then(() => this.#audit.write(event));
    return this.#auditQueue;
  }

  #publishThreadIndex(): void {
    const address = this.#externalServer?.address();
    if (address && typeof address !== "string") {
      void this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${address.port}`).catch(() => undefined);
    }
  }

  #setActiveWorkspaceRoot(workspaceRoot: string): void {
    if (this.#activeWorkspaceRoot === workspaceRoot) {
      return;
    }
    this.#activeWorkspaceRoot = workspaceRoot;
    const address = this.#externalServer?.address();
    if (address && typeof address !== "string") {
      void this.#writeDescriptor(`ws://${LOOPBACK_HOST}:${address.port}`).catch(() => undefined);
    }
  }

  async #writeDescriptor(endpoint: string): Promise<void> {
    if (!this.#appServerIdentity) {
      throw new Error("Official Codex app-server identity is unavailable");
    }
    const descriptor: ExternalCliSessionDescriptor = {
      version: 3,
      codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")),
      ...(this.#options.serviceScope ? { serviceScope: this.#options.serviceScope } : {}),
      ...(this.#options.serviceKey ? { serviceKey: this.#options.serviceKey } : {}),
      appServer: this.#appServerIdentity,
      endpoint,
      executablePath: this.#processExecutablePath,
      ...(this.#selfIdentity?.executableFileId ? { executableFileId: this.#selfIdentity.executableFileId } : {}),
      host: this.#options.config?.host ?? "local",
      pid: process.pid,
      startedAtMs: this.#startedAtMs,
      tokenEnv: EXTERNAL_TOKEN_ENV,
      tokenPath: this.#externalTokenPath,
      workspaceRoot: this.#activeWorkspaceRoot,
      lifecycle: this.#lifecycle,
      upstreamEndpoint: this.#upstreamEndpoint,
      ...(this.#persistentSession ? { retainUntilMs: Date.now() + 30 * 60_000 } : {}),
      loadedThreadIds: [...this.#threads.loaded],
      ...(this.#threads.selected ? { threadId: this.#threads.selected } : {}),
    };
    const temporaryPath = `${this.#sessionPath}.${randomBytes(6).toString("hex")}.tmp`;
    this.#descriptorQueue = this.#descriptorQueue.catch(() => undefined).then(async () => {
      try {
        await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
        await chmodIfSupported(temporaryPath, 0o600);
        await rename(temporaryPath, this.#sessionPath);
      } finally { await rm(temporaryPath, { force: true }); }
    });
    await this.#descriptorQueue;
  }

  async #close(): Promise<void> {
    this.#closeTask ??= this.#closeOnce();
    return await this.#closeTask;
  }

  #requestStop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#lifecycle = "stopping";
    this.#publishThreadIndex();
    if ((this.#child || this.#appServerIdentity) && !this.#stopChildTask) this.#stopChildTask = this.#stopChild();
  }

  async #waitForChild(timeoutMs: number): Promise<boolean> {
    if (!this.#childExited) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#childExited.then(() => true),
        new Promise<boolean>((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async #stopChild(): Promise<boolean> {
    await this.#closeExternalClients();
    for (const socket of this.#upstreams) socket.terminate();
    if (this.#persistentSession && ((!this.#options.serviceKey && this.#ready) || this.#threads.loaded.size > 0 || !this.#child)) {
      this.#detached = true;
      this.#lifecycle = "detached";
      this.#publishThreadIndex();
      this.#child?.stdin.destroy();
      this.#child?.stdout.destroy();
      this.#child?.stderr.destroy();
      this.#child?.unref();
      this.#resolveStopped();
      return true;
    }
    this.#child?.kill("SIGTERM");
    if (await this.#waitForChild(2_000)) { this.#resolveStopped(); return true; }
    // Escalate only the child we spawned, never a PID discovered by name.
    this.#child?.kill("SIGKILL");
    const exited = await this.#waitForChild(1_000);
    this.#resolveStopped();
    return exited;
  }

  async #closeOnce(): Promise<void> {
    this.#requestStop();
    const childStopped = await (this.#stopChildTask ?? Promise.resolve(true));
    await this.#closeExternalClients();
    await Promise.allSettled([...this.#externalCleanupTasks]);
    this.#externalWriters.clear();
    this.#externalRelayCounts.clear();
    for (const [id, client] of this.#orphanedClients) {
      client.session.closeSession();
      client.upstream.terminate();
      this.#serviceRequests.remove(id);
    }
    this.#orphanedClients.clear();
    this.#stdioWriter = null;
    this.#relayedNotifications.clear();
    await new Promise<void>((resolvePromise) => {
      if (!this.#externalServer) {
        resolvePromise();
        return;
      }
      this.#externalServer.close(() => resolvePromise());
    });
    this.#externalServer = null;
    await this.#audit.write({ operation: this.#detached ? "app_server.detached" : "app_server.shutdown", outcome: childStopped ? "succeeded" : "failed",
      details: { childPid: this.#appServerIdentity?.pid ?? null, childExited: childStopped && !this.#detached } });
    if (this.#detached && !this.#pendingHandoff) {
      await this.#descriptorQueue.catch(() => undefined);
      return;
    }
    if (!childStopped) {
      this.#lifecycle = "failed";
      await this.#descriptorQueue.catch(() => undefined);
      throw new Error("Owned app-server did not exit; recovery journal retained");
    }
    this.#child = null;
    this.#appServerIdentity = null;
    await this.#descriptorQueue.catch(() => undefined);
    await this.#auditQueue.catch(() => undefined);
    if (!this.#ownsState) return;
    await Promise.all([
      rm(this.#sessionPath, { force: true }),
      rm(this.#externalTokenPath, { force: true }),
      rm(this.#upstreamTokenPath, { force: true }),
    ]);
  }

  async #inspectAppServerIdentity(
    child: ChildProcessWithoutNullStreams,
  ): Promise<ProcessIdentity> {
    if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error("Official Codex app-server did not report a process ID");
    }
    if (process.platform === "linux") {
      try {
        const identity = (await inspectProcessIdentities([child.pid], "linux")).get(
          child.pid,
        );
        if (identity) {
          return identity;
        }
      } catch {
        // Fall back to the configured executable and spawn time below.
      }
    }
    let executablePath = this.#options.codexExecutable;
    try {
      executablePath = realpathSync.native(executablePath);
    } catch {
      // The spawned command may be resolved through PATH on non-Linux hosts.
    }
    if (!isAbsolute(executablePath)) {
      executablePath = resolve(
        this.#options.appServerCwd ?? this.#options.controlDir,
        executablePath,
      );
    }
    return {
      executablePath,
      pid: child.pid,
      startedAtMs: Date.now(),
    };
  }

  async #closeExternalClients(): Promise<void> {
    await Promise.all(
      [...(this.#externalServer?.clients ?? [])].map(
        (client) =>
          new Promise<void>((resolvePromise) => {
            if (client.readyState === WebSocket.CLOSED) {
              resolvePromise();
              return;
            }
            let timer: NodeJS.Timeout | undefined;
            const finish = (): void => {
              if (timer) {
                clearTimeout(timer);
              }
              resolvePromise();
            };
            client.once("close", finish);
            timer = setTimeout(() => {
              client.terminate();
              finish();
            }, EXTERNAL_CLOSE_GRACE_MS);
            if (client.readyState === WebSocket.OPEN) {
              client.close(EXTERNAL_CLOSE_CODE, EXTERNAL_CLOSE_REASON);
            }
          }),
      ),
    );
  }
}
