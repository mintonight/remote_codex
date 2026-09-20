import { randomUUID } from "node:crypto";
import { isRecord, isRpcResponse, type RpcMessage } from "./rpc.js";

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ThreadStatus {
  type: "active" | "idle" | "notLoaded" | "systemError";
  activeFlags?: string[];
}

export interface ThreadRecoveryCycle {
  listedThreads: number;
  matchingThreads: number;
  resumedThreads: number;
  publishedStatuses: number;
  unsubscribedThreads: number;
  errors: number;
  durationMs: number;
}

function threadStatus(value: unknown): ThreadStatus | undefined {
  if (
    !isRecord(value) ||
    !["active", "idle", "notLoaded", "systemError"].includes(String(value.type))
  )
    return;
  if (
    value.activeFlags !== undefined &&
    (!Array.isArray(value.activeFlags) ||
      value.activeFlags.length > 32 ||
      value.activeFlags.some(
        (flag) => typeof flag !== "string" || flag.length > 128,
      ))
  )
    return;
  return {
    type: value.type as ThreadStatus["type"],
    ...(value.activeFlags === undefined
      ? {}
      : { activeFlags: [...(value.activeFlags as string[])].sort() }),
  };
}

export class ThreadSubscriptionRecovery {
  readonly #pending = new Map<string, Pending>();
  readonly #subscribed = new Set<string>();
  readonly #publishedStatus = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;
  #disposed = false;

  constructor(
    readonly options: {
      send: (message: RpcMessage) => void;
      emit: (message: RpcMessage) => void;
      workspaceRoot: () => string | undefined;
      selectedThreadId?: () => string | undefined;
      onCycle?: (cycle: ThreadRecoveryCycle) => void;
      log: (message: string) => void;
      intervalMs?: number;
      timeoutMs?: number;
    },
  ) {}

  start(): void {
    if (this.#timer || this.#disposed) return;
    void this.refresh();
    this.#timer = setInterval(
      () => void this.refresh(),
      this.options.intervalMs ?? 30_000,
    );
    this.#timer.unref();
  }

  observe(message: RpcMessage): boolean {
    if (isRpcResponse(message) && typeof message.id === "string") {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            new Error(
              "Official thread recovery request failed: " + pending.method,
            ),
          );
        else pending.resolve(message.result);
        return true;
      }
      if (message.id.startsWith("bridge_recovery_")) return true;
    }
    if (
      "method" in message &&
      isRecord(message.params) &&
      typeof message.params.threadId === "string"
    ) {
      const id = message.params.threadId;
      if (
        ["thread/closed", "thread/archived", "thread/deleted"].includes(
          message.method,
        )
      ) {
        this.#subscribed.delete(id);
        this.#publishedStatus.delete(id);
      } else if (
        message.method === "thread/status/changed" &&
        this.#publishedStatus.has(id)
      ) {
        const status = threadStatus(message.params.status);
        if (status) this.#publishedStatus.set(id, JSON.stringify(status));
      }
    }
    return false;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    if (this.#disposed) throw new Error("Thread recovery disposed");
    const id = "bridge_recovery_" + randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Thread recovery timed out: " + method));
      }, this.options.timeoutMs ?? 5_000);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.options.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #publishStatus(threadId: string, status: ThreadStatus): boolean {
    const encoded = JSON.stringify(status);
    if (this.#publishedStatus.get(threadId) === encoded) return false;
    this.options.emit({
      method: "thread/status/changed",
      params: { threadId, status },
    });
    this.#publishedStatus.set(threadId, encoded);
    return true;
  }

  async refresh(): Promise<void> {
    if (this.#refreshing || this.#disposed) return;
    this.#refreshing = true;
    const startedAt = Date.now();
    const cycle: ThreadRecoveryCycle = {
      listedThreads: 0,
      matchingThreads: 0,
      resumedThreads: 0,
      publishedStatuses: 0,
      unsubscribedThreads: 0,
      errors: 0,
      durationMs: 0,
    };
    const failed = (error: unknown): void => {
      if (!this.#disposed) {
        cycle.errors += 1;
        this.options.log(
          error instanceof Error ? error.message : "Thread recovery failed",
        );
      }
    };
    try {
      const loaded = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const result = await this.#request("thread/loaded/list", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (
          !isRecord(result) ||
          !Array.isArray(result.data) ||
          result.data.some((id) => typeof id !== "string")
        )
          throw new Error("Malformed loaded-thread index");
        for (const id of result.data as string[]) loaded.add(id);
        if (result.nextCursor == null) break;
        if (
          typeof result.nextCursor !== "string" ||
          !result.nextCursor ||
          cursors.has(result.nextCursor) ||
          page === 99
        )
          throw new Error("Malformed loaded-thread pagination");
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      cycle.listedThreads = loaded.size;
      for (const id of this.#subscribed)
        if (!loaded.has(id)) {
          this.#subscribed.delete(id);
          this.options.emit({
            method: "thread/closed",
            params: { threadId: id },
          });
        }
      for (const id of this.#publishedStatus.keys())
        if (!loaded.has(id)) this.#publishedStatus.delete(id);
      for (const threadId of loaded) {
        try {
          const metadata = await this.#request("thread/read", {
            threadId,
            includeTurns: false,
          });
          if (
            !isRecord(metadata) ||
            !isRecord(metadata.thread) ||
            metadata.thread.id !== threadId ||
            (this.options.workspaceRoot() !== undefined && metadata.thread.cwd !== this.options.workspaceRoot())
          )
            continue;
          let status = threadStatus(metadata.thread.status);
          if (!status) throw new Error("Malformed thread runtime status");
          cycle.matchingThreads += 1;
          if (
            status.type === "active" &&
            !this.#subscribed.has(threadId) &&
            this.options.selectedThreadId?.() !== threadId
          ) {
            // Restore subscriptions without hydrating/replaying history into the UI.
            const resumed = await this.#request("thread/resume", {
              threadId,
              excludeTurns: true,
            });
            if (
              !isRecord(resumed) ||
              !isRecord(resumed.thread) ||
              resumed.thread.id !== threadId
            )
              throw new Error("Malformed resumed thread");
            this.#subscribed.add(threadId);
            cycle.resumedThreads += 1;
            status = threadStatus(resumed.thread.status) ?? status;
          }
          if (this.#publishStatus(threadId, status))
            cycle.publishedStatuses += 1;
          if (
            status.type === "idle" &&
            this.#subscribed.has(threadId) &&
            this.options.selectedThreadId?.() !== threadId
          ) {
            await this.#request("thread/unsubscribe", { threadId });
            this.#subscribed.delete(threadId);
            cycle.unsubscribedThreads += 1;
          }
        } catch (error) {
          failed(error);
        }
      }
    } catch (error) {
      failed(error);
    } finally {
      this.#refreshing = false;
      if (!this.#disposed) {
        cycle.durationMs = Date.now() - startedAt;
        try {
          this.options.onCycle?.(cycle);
        } catch {
          /* Diagnostics must not affect subscriptions. */
        }
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Thread recovery disposed"));
    }
    this.#pending.clear();
    this.#subscribed.clear();
    this.#publishedStatus.clear();
  }
}
