import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import WebSocket from "ws";
import { AuditLog } from "../core/audit-log.js";
import { bridgeExternalCliDir } from "../core/locations.js";
import { inspectProcessIdentities, processIdentitiesMatch, type ProcessIdentity } from "./process-identity.js";
import { managedUpstream } from "./app-server-handoff.js";
import { discoverExternalCliSessions } from "./external-session-registry.js";
import { recoverLiveLocalService } from "./local-service-identity-recovery.js";
import { ensureLocalService, userServiceKey } from "./local-app-server-service.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";
import { RequestCallbackQueue } from "./request-callback-queue.js";
import { clientConfigFromArgs, withClientConfig } from "./client-config.js";
import { ServiceRequests } from "./service-requests.js";
import { scopeThreadListToWorkspace } from "./rewrite.js";
import { isRecord, isRpcRequest, isRpcResponse, parseRpcLine, type RpcMessage, type RpcRequest, type RpcResponse } from "./rpc.js";

export const SHARED_LOCAL_ARGS = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"];

export async function canonicalCodexHome(): Promise<string> {
  const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  return await realpath(home).catch(() => home);
}

export async function localServicesInDomain(): Promise<ExternalCliSessionDescriptor[]> {
  const home = await canonicalCodexHome();
  const result: ExternalCliSessionDescriptor[] = [];
  for (const service of await discoverExternalCliSessions()) {
    if (service.host !== "local" || !service.serviceKey || !service.appServer) continue;
    // Older journals predate codexHome. Verify their actual runtime domain
    // instead of admitting an unknown/different profile based on directory alone.
    let serviceHome = service.codexHome;
    if (!serviceHome) {
      const environment = await readFile(`/proc/${service.appServer.pid}/environ`, "utf8").catch(() => null);
      if (environment === null) continue;
      serviceHome = environment.split("\0").find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) ?? join(homedir(), ".codex");
    }
    if (await realpath(serviceHome).catch(() => resolve(serviceHome!)) === home) result.push(service);
  }
  // Transitional writers may have outlived an older Shim. Attach read-only
  // discovery to their authenticated transport; never kill or re-create them.
  const directory = bridgeExternalCliDir();
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!isRecord(value) || value.host !== "local" || !isRecord(value.appServer) || value.pid !== Number(name.slice(0, -5))) continue;
      const nativePid = value.appServer.pid;
      if (result.some((peer) => peer.appServer?.pid === nativePid)) continue;
      let alive = true;
      try { process.kill(Number(value.pid), 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
        alive = false;
      }
      if (alive) {
        const recovered = await recoverLiveLocalService(value, directory, home);
        if (recovered) result.push(recovered);
        continue;
      }
      const expected = value.appServer as unknown as ProcessIdentity;
      const actual = (await inspectProcessIdentities([expected.pid])).get(expected.pid);
      if (!processIdentitiesMatch(expected, actual)) continue;
      const environment = (await readFile(`/proc/${expected.pid}/environ`, "utf8")).split("\0");
      const root = environment.find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) ?? join(homedir(), ".codex");
      if (await realpath(root).catch(() => resolve(root)) !== home) continue;
      const upstream = await managedUpstream(directory, Number(value.pid), value);
      result.push({ version: 3, pid: expected.pid, startedAtMs: expected.startedAtMs,
        executablePath: actual!.executablePath, appServer: actual!, endpoint: upstream.endpoint,
        tokenPath: join(directory, `${value.pid}.upstream.token`), tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
        host: "local", workspaceRoot: typeof value.workspaceRoot === "string" ? value.workspaceRoot : homedir() });
    } catch { /* Incomplete or unverifiable journals never grant access. */ }
  }
  return result.sort((a, b) => Number(Boolean(b.serviceKey)) - Number(Boolean(a.serviceKey)) ||
    Number(b.serviceScope === "user") - Number(a.serviceScope === "user") || a.startedAtMs - b.startedAtMs || a.pid - b.pid);
}

class ServicePeer {
  readonly callbacks = new RequestCallbackQueue();
  readonly ready: Promise<RpcResponse>;
  readonly socket: WebSocket;
  #initialized = false;
  readonly #early: RpcMessage[] = [];

  constructor(readonly descriptor: ExternalCliSessionDescriptor, token: string, initialize: RpcRequest,
    readonly emit: (peer: ServicePeer, message: RpcMessage) => void) {
    this.socket = new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 5_000, maxPayload: 16 * 1024 * 1024 });
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 25_000) this.close();
      else if (this.socket.readyState === WebSocket.OPEN) this.socket.ping();
    }, 10_000);
    heartbeat.unref();
    this.socket.on("pong", () => { lastPong = Date.now(); });
    this.socket.once("close", () => clearInterval(heartbeat));
    this.ready = new Promise((done, reject) => {
      this.socket.once("error", reject);
      this.socket.once("close", () => reject(new Error("Service closed during initialization")));
      this.socket.once("open", () => {
        void this.callbacks.request(initialize, (message) => this.send(message), 10_000).then((response) => {
          if (response.error) { reject(new Error(response.error.message)); return; }
          this.#initialized = true;
          this.send({ method: "initialized" });
          done(response);
          for (const event of this.#early.splice(0)) this.emit(this, event);
        });
      });
    });
    this.socket.on("message", (data) => {
      try {
        const message = parseRpcLine(data.toString());
        if (!this.callbacks.receive(message)) {
          if (this.#initialized) this.emit(this, message);
          else if (this.#early.length < 256) this.#early.push(message);
          else this.close();
        }
      } catch { this.close(); }
    });
    this.socket.on("close", () => this.callbacks.close());
    this.socket.on("error", () => this.callbacks.close());
  }

  send(message: RpcMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 16 * 1024 * 1024) throw new Error("Service connection unavailable or stalled");
    this.socket.send(JSON.stringify(message));
  }

  async request(message: RpcRequest, timeoutMs?: number): Promise<RpcResponse> {
    await this.ready;
    return await this.callbacks.request(message, (value) => this.send(value), timeoutMs);
  }

  async loaded(): Promise<string[]> {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await this.request({ id: "loaded", method: "thread/loaded/list", params: { limit: 100, ...(cursor ? { cursor } : {}) } }, 5_000);
      const result = response.result;
      if (response.error || !isRecord(result) || !Array.isArray(result.data) || !result.data.every((id) => typeof id === "string")) throw new Error("Cannot establish the live thread index");
      for (const id of result.data) ids.add(id as string);
      if (result.nextCursor == null) return [...ids];
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Invalid loaded-thread cursor");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new Error("Loaded-thread index exceeds the discovery bound");
  }

  close(): void { this.socket.terminate(); this.callbacks.close(); }
}

export interface UnifiedLocalClientOptions {
  appServerArgs: string[];
  codexExecutable: string;
  auditPath: string;
  workspaceRoot?: string;
  clientKind: "vscode" | "desktop";
  input?: Readable;
  output?: Writable;
  discover?: () => Promise<ExternalCliSessionDescriptor[]>;
  bootstrap?: () => Promise<ExternalCliSessionDescriptor>;
}

export async function runUnifiedLocalClient(options: UnifiedLocalClientOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const audit = new AuditLog(options.auditPath);
  const overrides = clientConfigFromArgs(options.appServerArgs);
  const requests = new RequestCallbackQueue();
  const approvals = new ServiceRequests();
  const peers = new Map<string, Promise<ServicePeer>>();
  const owners = new Map<string, ServicePeer>();
  const pendingIds = new Set<string | number>();
  let primary: ServicePeer | undefined;
  let initialize: RpcRequest | undefined;
  let initialization: Promise<void> = Promise.resolve();
  let closed = false;
  let frontendReady = false;
  const early: RpcMessage[] = [];
  let settle: (code: number) => void = () => undefined;
  const ended = new Promise<number>((done) => { settle = done; });
  const write = (message: RpcMessage): void => {
    if (closed) return;
    if (!frontendReady && !(isRpcResponse(message) && message.id === initialize?.id)) {
      if (early.length >= 256) { finish(1); return; }
      early.push(message); return;
    }
    if (output.destroyed || output.writableLength > 16 * 1024 * 1024) { finish(1); return; }
    output.write(JSON.stringify(message) + "\n");
  };
  const connect = async (descriptor: ExternalCliSessionDescriptor): Promise<ServicePeer> => {
    const key = `${descriptor.pid}:${descriptor.startedAtMs}:${descriptor.endpoint}`;
    let pending = peers.get(key);
    if (!pending) {
      if (peers.size >= 32) throw new Error("Too many managed execution services");
      pending = (async () => {
        if (!initialize || closed) throw new Error("Client is not initialized");
        const token = await readFile(descriptor.tokenPath, "utf8");
        if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid gateway credential");
        const peer = new ServicePeer(descriptor, token, initialize, (source, message) => {
          if (isRpcRequest(message)) {
            approvals.publish(key, message, (reply) => source.send(reply as RpcMessage), (request) => write(request as RpcMessage));
          } else if (!isRpcResponse(message)) {
            const params = isRecord(message.params) ? message.params : {};
            const thread = isRecord(params.thread) ? params.thread : {};
            const id = typeof params.threadId === "string" ? params.threadId : thread.id;
            if (typeof id !== "string" && primary && source !== primary) return;
            if (typeof id === "string" && ["thread/started", "turn/started"].includes(message.method)) owners.set(id, source);
            if (typeof id === "string" && ["thread/closed", "thread/archived", "thread/deleted"].includes(message.method)) owners.delete(id);
            write(message);
          }
        });
        peer.socket.once("close", () => {
          peers.delete(key);
          approvals.remove(key);
          for (const [id, owner] of owners) if (owner === peer) owners.delete(id);
        });
        if (closed) { peer.close(); throw new Error("Client detached"); }
        try { await peer.ready; } catch (error) { peer.close(); throw error; }
        return peer;
      })();
      peers.set(key, pending);
      void pending.catch(() => peers.delete(key));
    }
    return await pending;
  };
  const discover = options.discover ?? localServicesInDomain;
  const refreshOwners = async (): Promise<string[]> => {
    const found = new Map<string, ServicePeer>();
    const snapshots = await Promise.all((await discover()).map(async (descriptor) => {
      const peer = await connect(descriptor);
      return { descriptor, peer, ids: await peer.loaded() };
    }));
    for (const { descriptor, peer, ids } of snapshots) {
      for (const id of ids) {
        if (found.has(id) && found.get(id)!.descriptor.appServer?.pid !== descriptor.appServer?.pid) throw new Error("Ambiguous live thread ownership; refusing competing writes");
        found.set(id, peer);
      }
    }
    owners.clear();
    for (const [id, peer] of found) owners.set(id, peer);
    return [...found.keys()];
  };
  const route = async (message: RpcRequest): Promise<RpcResponse> => {
    if (closed) throw new Error("Client detached");
    if (!primary || primary.socket.readyState !== WebSocket.OPEN) {
      const available = await discover();
      if (!available[0]) throw new Error("Shared execution service is unavailable; no competing backend was started");
      primary = await connect(available[0]);
    }
    if (message.method === "thread/loaded/list") {
      const ids = (await refreshOwners()).sort();
      const params = isRecord(message.params) ? message.params : {};
      if (params.cursor != null && (typeof params.cursor !== "string" || !params.cursor.startsWith("bridge_loaded:"))) throw new Error("Invalid shared thread cursor");
      const after = typeof params.cursor === "string" ? params.cursor.slice(14) : "";
      const remaining = ids.filter((id) => id > after);
      const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 100;
      const data = remaining.slice(0, limit);
      return { id: message.id, result: { data, nextCursor: remaining.length > data.length ? `bridge_loaded:${data.at(-1)}` : null } };
    }
    const params = isRecord(message.params) ? message.params : {};
    const id = typeof params.threadId === "string" ? params.threadId : undefined;
    if (id && !owners.has(id)) await refreshOwners();
    const peer = id ? owners.get(id) ?? primary : primary;
    let outgoing = withClientConfig(scopeThreadListToWorkspace(message, options.workspaceRoot), overrides) as RpcRequest;
    if (message.method === "thread/start" && options.workspaceRoot && params.cwd == null) {
      outgoing = { ...outgoing, params: { ...(isRecord(outgoing.params) ? outgoing.params : {}), cwd: options.workspaceRoot } };
    }
    const result = await peer.request(outgoing);
    const value = isRecord(result.result) ? result.result : {};
    if (!result.error && isRecord(value.thread) && typeof value.thread.id === "string" && ["thread/start", "thread/resume", "thread/fork"].includes(message.method)) owners.set(value.thread.id, peer);
    void audit.write({ operation: "client.callback_route", outcome: result.error ? "failed" : "succeeded",
      details: { clientKind: options.clientKind, method: message.method, servicePid: peer.descriptor.pid, appServerPid: peer.descriptor.appServer?.pid, ...(id ? { threadId: id } : {}) } }).catch(() => undefined);
    return result;
  };
  const handle = async (message: RpcMessage): Promise<void> => {
    if (approvals.respond(message)) return;
    if (!isRpcRequest(message)) {
      if (!isRpcResponse(message) && message.method !== "initialized") {
        try { await initialization; if (!closed) primary?.send(message); } catch { finish(1); }
      }
      return; // Each peer performs its own initialized handshake.
    }
    if (pendingIds.has(message.id) || pendingIds.size >= 1024) { finish(1); return; }
    pendingIds.add(message.id);
    try {
      if (message.method === "initialize") {
        if (initialize) throw new Error("Client already initialized");
        initialize = message;
        initialization = (async () => {
          const known = await discover();
          const descriptor = known[0] ?? await (options.bootstrap?.() ?? ensureLocalService({
            appServerArgs: SHARED_LOCAL_ARGS, codexExecutable: options.codexExecutable,
            workspaceRoot: homedir(), auditPath: options.auditPath, serviceScope: "user",
            serviceKey: await userServiceKey(),
          }));
          primary = await connect(descriptor);
          write(await primary.ready);
          frontendReady = true;
          for (const event of early.splice(0)) write(event);
          await audit.write({ operation: "client.shared_attached", outcome: "succeeded", details: {
            clientKind: options.clientKind, servicePid: descriptor.pid, appServerPid: descriptor.appServer?.pid,
          } });
        })();
        await initialization;
      } else {
        await initialization;
        const params = isRecord(message.params) ? message.params : {};
        const lane = typeof params.threadId === "string" ? params.threadId : "create";
        const control = ["turn/interrupt", "turn/steer"].includes(message.method);
        const ordered = /^(turn\/start|thread\/(start|resume|fork|queue\/))/.test(message.method);
        write(await (ordered && !control ? requests.enqueue(lane, () => route(message)) : route(message)));
      }
    } catch (error) {
      write({ id: message.id, error: { code: -32002, message: error instanceof Error ? error.message : "Shared request routing failed" } });
    } finally { pendingIds.delete(message.id); }
  };
  const lines = createInterface({ input });
  function finish(code: number): void {
    if (closed) return;
    closed = true;
    lines.close();
    requests.close();
    for (const peer of peers.values()) void peer.then((value) => value.close()).catch(() => undefined);
    settle(code);
  }
  const detach = (): void => finish(0);
  const fail = (): void => finish(1);
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) return fail();
    try { void handle(parseRpcLine(line)); } catch { fail(); }
  });
  input.once("end", detach);
  input.once("close", detach);
  input.once("error", fail);
  output.once("error", fail);
  process.once("SIGTERM", detach);
  process.once("SIGINT", detach);
  if (input.destroyed || input.readableEnded) finish(0);
  try { return await ended; }
  finally {
    input.off("end", detach); input.off("close", detach); input.off("error", fail); output.off("error", fail);
    process.off("SIGTERM", detach); process.off("SIGINT", detach);
  }
}
