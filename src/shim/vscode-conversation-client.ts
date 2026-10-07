import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import WebSocket, { type RawData } from "ws";
import {
  VSCODE_CONVERSATION_CLIENT_TITLE,
  VSCODE_CONVERSATION_CLIENT_VERSION,
  createVsCodeConversationClientName,
} from "./external-client-identity.js";
import { discoverExternalCliSessions } from "./external-session-registry.js";
import { isRecord, isRpcRequest, isRpcResponse, type RpcId } from "./rpc.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
  threadId?: string;
  timeout: NodeJS.Timeout;
}

const INTERRUPTED_TURN_CACHE_LIMIT = 64;
const INTERRUPTED_TURN_ITEM_LIMIT = 32;
const COLD_INITIALIZE_PROBE_TIMEOUT_MS = 1_000;
const INITIALIZE_RETRY_DELAY_MS = 50;

class VsCodeRequestTimeoutError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`VS Code Codex request timed out: ${method}`);
    this.name = "VsCodeRequestTimeoutError";
    this.method = method;
  }
}

function rawMessage(data: RawData): string {
  return typeof data === "string" ? data : data.toString("utf8");
}

function rpcError(value: unknown): Error {
  if (!isRecord(value)) {
    return new Error("VS Code Codex app-server returned an unknown error");
  }
  const message =
    typeof value.message === "string" ? value.message : "VS Code Codex request failed";
  return new Error(message);
}

export class VsCodeConversationClient {
  readonly descriptor: ExternalCliSessionDescriptor;
  readonly #socket: WebSocket;
  readonly #interruptedTurnItems = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  readonly #pending = new Map<RpcId, PendingRequest>();
  #nextId = 1;
  readonly #subscriptions = new Set<string>();
  #closing = false;

  private constructor(
    descriptor: ExternalCliSessionDescriptor,
    socket: WebSocket,
  ) {
    this.descriptor = descriptor;
    this.#socket = socket;
    socket.on("message", (data) => this.#handleMessage(data));
    socket.once("close", () => {
      this.#rejectPending(new Error("VS Code Codex app-server connection closed"));
    });
    socket.once("error", (error) => {
      this.#rejectPending(error);
    });
  }

  static async connect(
    descriptor: ExternalCliSessionDescriptor,
    initializeTimeoutMs = 30_000,
  ): Promise<VsCodeConversationClient> {
    const token = await readFile(descriptor.tokenPath, "utf8");
    if (!token || /[\r\n]/.test(token)) {
      throw new Error("VS Code Codex gateway token is invalid");
    }
    const deadline = Date.now() + Math.max(1, initializeTimeoutMs);
    let initializeError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs === 0) {
        break;
      }
      const attemptTimeoutMs =
        attempt === 0
          ? Math.min(
              COLD_INITIALIZE_PROBE_TIMEOUT_MS,
              Math.max(1, Math.floor(remainingMs / 2)),
            )
          : remainingMs;
      try {
        return await VsCodeConversationClient.#connectOnce(
          descriptor,
          token,
          attemptTimeoutMs,
        );
      } catch (error) {
        initializeError = error;
        if (
          attempt > 0 ||
          !(error instanceof VsCodeRequestTimeoutError) ||
          error.method !== "initialize"
        ) {
          throw error;
        }
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, INITIALIZE_RETRY_DELAY_MS),
        );
      }
    }
    throw initializeError ?? new VsCodeRequestTimeoutError("initialize");
  }

  static async #connectOnce(
    descriptor: ExternalCliSessionDescriptor,
    token: string,
    initializeTimeoutMs: number,
  ): Promise<VsCodeConversationClient> {
    const socket = new WebSocket(descriptor.endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: initializeTimeoutMs,
    });
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const client = new VsCodeConversationClient(descriptor, socket);
    try {
      await client.request(
        "initialize",
        {
          clientInfo: {
            name: createVsCodeConversationClientName(),
            title: VSCODE_CONVERSATION_CLIENT_TITLE,
            version: VSCODE_CONVERSATION_CLIENT_VERSION,
          },
          capabilities: { experimentalApi: true },
        },
        initializeTimeoutMs,
      );
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("VS Code Codex app-server is not connected");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<unknown>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new VsCodeRequestTimeoutError(method));
      }, timeoutMs);
      timeout.unref();
      this.#pending.set(id, {
        method,
        reject,
        resolve: resolvePromise,
        ...(isRecord(params) && typeof params.threadId === "string"
          ? { threadId: params.threadId }
          : {}),
        timeout,
      });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return await result;
  }

  notify(method: string, params: unknown): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ method, params }));
    }
  }

  close(): void {
    if (this.#closing) return;
    // Unsubscribe on the same connection. This is not a request to delete history.
    const unsubscribes = [...this.#subscriptions].map((threadId) =>
      this.request("thread/unsubscribe", { threadId }, 250));
    this.#closing = true;
    this.#subscriptions.clear();
    void Promise.allSettled(unsubscribes).finally(() => {
      this.#rejectPending(new Error("VS Code Codex client disposed"));
      this.#socket.close();
      const timer = setTimeout(() => this.#socket.terminate(), 250);
      timer.unref();
      this.#socket.once("close", () => clearTimeout(timer));
    });
  }

  get isOpen(): boolean {
    return !this.#closing && this.#socket.readyState === WebSocket.OPEN;
  }

  #handleMessage(data: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(rawMessage(data)) as unknown;
    } catch {
      this.#socket.close(1003, "Invalid JSON-RPC");
      return;
    }
    if (isRpcResponse(message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(rpcError(message.error));
      } else {
        if (["thread/start", "thread/resume", "thread/fork"].includes(pending.method)) {
          const result = isRecord(message.result) ? message.result : {};
          const thread = isRecord(result.thread) ? result.thread : {};
          const threadId = typeof thread.id === "string" ? thread.id : pending.threadId;
          if (threadId) this.#subscriptions.add(threadId);
        }
        pending.resolve(
          pending.method === "thread/turns/list" && pending.threadId
            ? this.#restoreInterruptedTurnItems(message.result, pending.threadId)
            : message.result,
        );
      }
      return;
    }
    if (isRpcRequest(message)) {
      const decision = message.method.endsWith("/requestApproval")
        ? { decision: "decline" }
        : undefined;
      this.#socket.send(
        JSON.stringify(
          decision
            ? { id: message.id, result: decision }
            : {
                id: message.id,
                error: {
                  code: -32601,
                  message: `External MCP client cannot handle ${message.method}`,
                },
              },
        ),
      );
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #restoreInterruptedTurnItems(value: unknown, threadId: string): unknown {
    if (!isRecord(value) || !Array.isArray(value.data)) {
      return value;
    }

    let changed = false;
    const data = value.data.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        entry.status !== "interrupted" ||
        !Array.isArray(entry.items)
      ) {
        return entry;
      }

      const key = `${threadId}\0${entry.id}`;
      const finalItems = entry.items
        .filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) &&
            typeof item.id === "string" &&
            item.type === "commandExecution" &&
            item.status === "failed",
        )
        .slice(0, INTERRUPTED_TURN_ITEM_LIMIT);
      if (finalItems.length > 0) {
        this.#interruptedTurnItems.delete(key);
        this.#interruptedTurnItems.set(
          key,
          new Map(finalItems.map((item) => [item.id as string, { ...item }])),
        );
        while (this.#interruptedTurnItems.size > INTERRUPTED_TURN_CACHE_LIMIT) {
          const oldest = this.#interruptedTurnItems.keys().next().value;
          if (typeof oldest !== "string") {
            break;
          }
          this.#interruptedTurnItems.delete(oldest);
        }
      }

      const cached = this.#interruptedTurnItems.get(key);
      if (!cached) {
        return entry;
      }
      const presentIds = new Set(
        entry.items
          .filter(isRecord)
          .map((item) => item.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const missing = [...cached.entries()]
        .filter(([id]) => !presentIds.has(id))
        .map(([, item]) => ({ ...item }));
      if (missing.length === 0) {
        return entry;
      }
      changed = true;
      return { ...entry, items: [...entry.items, ...missing] };
    });

    return changed ? { ...value, data } : value;
  }
}

const persistentClients = new Map<number, VsCodeConversationClient>();

async function persistentClient(
  descriptor: ExternalCliSessionDescriptor,
): Promise<VsCodeConversationClient> {
  const existing = persistentClients.get(descriptor.pid);
  if (
    existing?.isOpen &&
    existing.descriptor.endpoint === descriptor.endpoint &&
    existing.descriptor.startedAtMs === descriptor.startedAtMs &&
    existing.descriptor.appServer?.startedAtMs === descriptor.appServer?.startedAtMs
  ) {
    return existing;
  }
  existing?.close();
  const client = await VsCodeConversationClient.connect(descriptor);
  persistentClients.set(descriptor.pid, client);
  return client;
}

async function withClient<T>(
  descriptor: ExternalCliSessionDescriptor,
  operation: (client: VsCodeConversationClient) => Promise<T>,
): Promise<T> {
  return await operation(await persistentClient(descriptor));
}

function sessionSummary(descriptor: ExternalCliSessionDescriptor): Record<string, unknown> {
  return {
    sessionPid: descriptor.pid,
    host: descriptor.host,
    workspaceRoot: descriptor.workspaceRoot,
    activeThreadId: descriptor.threadId ?? null,
    startedAtMs: descriptor.startedAtMs,
    lifecycle: descriptor.lifecycle ?? "ready",
  };
}

async function activeSessions(): Promise<ExternalCliSessionDescriptor[]> {
  const sessions = await discoverExternalCliSessions();
  for (const [pid, client] of persistentClients) {
    if (!sessions.some((s) => s.pid === pid && s.startedAtMs === client.descriptor.startedAtMs &&
      s.endpoint === client.descriptor.endpoint && s.appServer?.startedAtMs === client.descriptor.appServer?.startedAtMs)) {
      client.close();
      persistentClients.delete(pid);
    }
  }
  return sessions;
}

export async function loadedThreadIds(client: Pick<VsCodeConversationClient, "request">): Promise<string[]> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!isRecord(result) || !Array.isArray(result.data) || result.data.some((id) => typeof id !== "string")) {
      throw new Error("Invalid thread/loaded/list response; thread ownership is unknown");
    }
    for (const id of result.data as string[]) ids.add(id);
    if (result.nextCursor == null) return [...ids];
    if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) {
      throw new Error("Invalid thread/loaded/list pagination");
    }
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error("Thread discovery exceeded the pagination limit");
}

async function sessionByPid(sessionPid: number): Promise<ExternalCliSessionDescriptor> {
  const descriptor = (await activeSessions()).find(
    (candidate) => candidate.pid === sessionPid,
  );
  if (!descriptor) {
    throw new Error(`VS Code Codex Bridge session ${sessionPid} is not active`);
  }
  return descriptor;
}

export async function listVsCodeConversations(limit = 20): Promise<unknown> {
  const sessions = await activeSessions();
  const results = await Promise.all(
    sessions.map(async (descriptor) => {
      try {
        const threads = await withClient(descriptor, (client) =>
          client.request("thread/list", {
            limit,
            sortDirection: "desc",
            sortKey: "updated_at",
            sourceKinds: ["vscode"],
          }),
        );
        const loaded = await withClient(descriptor, loadedThreadIds);
        return { ...sessionSummary(descriptor), threads, loadedThreadIds: loaded };
      } catch (error) {
        return {
          ...sessionSummary(descriptor),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return { sessions: results };
}

export async function startVsCodeConversation(options: {
  permissionMode: "on-request" | "full-access";
  sessionPid: number;
  text: string;
}): Promise<unknown> {
  const descriptor = await sessionByPid(options.sessionPid);
  const client = await persistentClient(descriptor);
  const started = await client.request("thread/start", {
    ...(options.permissionMode === "full-access"
      ? {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        }
      : {}),
  });
  if (
    !isRecord(started) ||
    !isRecord(started.thread) ||
    typeof started.thread.id !== "string"
  ) {
    throw new Error("VS Code Codex app-server did not return a new thread");
  }
  const threadId = started.thread.id;
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: options.text, text_elements: [] }],
    clientUserMessageId: randomUUID(),
    responsesapiClientMetadata: {
      codex_bridge_origin: "external-cli-mcp",
    },
  });
  return {
    ...sessionSummary(descriptor),
    threadId,
    thread: started.thread,
    turn,
  };
}

async function findConversation(
  threadId: string,
  sessionPid?: number,
): Promise<{
  client: VsCodeConversationClient;
  descriptor: ExternalCliSessionDescriptor;
}> {
  const sessions = (await activeSessions()).filter(
    (descriptor) => sessionPid === undefined || descriptor.pid === sessionPid,
  );
  if (sessionPid === undefined && sessions.length > 0) {
    const owners: ExternalCliSessionDescriptor[] = [];
    for (const descriptor of sessions) {
      const client = await persistentClient(descriptor);
      if ((await loadedThreadIds(client)).includes(threadId)) owners.push(descriptor);
    }
    if (owners.length > 1 || (owners.length === 0 && sessions.length > 1)) {
      throw new Error("Thread ownership is ambiguous; specify sessionPid instead of selecting by history");
    }
    if (owners.length === 1) {
      const descriptor = owners[0]!;
      return { client: await persistentClient(descriptor), descriptor };
    }
  }
  let lastError: unknown;
  for (const descriptor of sessions) {
    try {
      const client = await persistentClient(descriptor);
      await client.request("thread/read", { threadId, includeTurns: false });
      return { client, descriptor };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `VS Code Codex thread ${threadId} is not available in an active Bridge session${
      lastError ? `: ${String(lastError)}` : ""
    }`,
  );
}

export async function readVsCodeConversation(
  threadId: string,
  limit = 20,
  sessionPid?: number,
): Promise<unknown> {
  const { client, descriptor } = await findConversation(threadId, sessionPid);
  const turns = await client.request("thread/turns/list", {
    threadId,
    limit,
    itemsView: "full",
    sortDirection: "desc",
  });
  return { ...sessionSummary(descriptor), threadId, turns };
}

function activeTurnId(turns: unknown): string | undefined {
  if (!isRecord(turns) || !Array.isArray(turns.data)) {
    return undefined;
  }
  const active = turns.data.find(
    (turn) =>
      isRecord(turn) &&
      typeof turn.id === "string" &&
      (turn.status === "inProgress" || turn.status === "in_progress"),
  );
  return isRecord(active) && typeof active.id === "string" ? active.id : undefined;
}

export async function interveneVsCodeConversation(options: {
  expectedTurnId?: string;
  mode: "auto" | "steer" | "new-turn";
  sessionPid?: number;
  text: string;
  threadId: string;
}): Promise<unknown> {
  const { client, descriptor } = await findConversation(
    options.threadId,
    options.sessionPid,
  );
  // thread/read can inspect a notLoaded thread without making it available to turn mutations.
  await client.request("thread/resume", {
    threadId: options.threadId,
    excludeTurns: true,
  });
  let turnId = options.expectedTurnId;
  if (options.mode !== "new-turn" && !turnId) {
    const turns = await client.request("thread/turns/list", {
      threadId: options.threadId,
      limit: 10,
      itemsView: "summary",
      sortDirection: "desc",
    });
    turnId = activeTurnId(turns);
  }
  const input = [{ type: "text", text: options.text, text_elements: [] }];
  const metadata = { codex_bridge_origin: "external-cli-mcp" };
  let result: unknown;
  let action: "steer" | "new-turn";
  if (options.mode === "steer" || (options.mode === "auto" && turnId)) {
    if (!turnId) {
      throw new Error("No active VS Code Codex turn is available to steer");
    }
    action = "steer";
    result = await client.request("turn/steer", {
      threadId: options.threadId,
      expectedTurnId: turnId,
      input,
      clientUserMessageId: randomUUID(),
      responsesapiClientMetadata: metadata,
    });
  } else {
    action = "new-turn";
    result = await client.request("turn/start", {
      threadId: options.threadId,
      input,
      clientUserMessageId: randomUUID(),
      responsesapiClientMetadata: metadata,
    });
  }
  return {
    ...sessionSummary(descriptor),
    threadId: options.threadId,
    action,
    result,
  };
}

export async function interruptVsCodeConversation(options: {
  sessionPid?: number;
  threadId: string;
  turnId: string;
}): Promise<unknown> {
  const { client, descriptor } = await findConversation(
    options.threadId,
    options.sessionPid,
  );
  const result = await client.request("turn/interrupt", {
    threadId: options.threadId,
    turnId: options.turnId,
  });
  return { ...sessionSummary(descriptor), ...options, result };
}

export function closeVsCodeConversationClients(): void {
  for (const client of persistentClients.values()) {
    client.close();
  }
  persistentClients.clear();
}
