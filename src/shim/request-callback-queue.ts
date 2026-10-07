import { randomUUID } from "node:crypto";
import { isRpcResponse, type RpcId, type RpcMessage, type RpcResponse } from "./rpc.js";

export class RequestCallbackQueue {
  readonly #callbacks = new Map<string, { id: RpcId; resolve: (response: RpcResponse) => void; timer: NodeJS.Timeout }>();
  readonly #lanes = new Map<string, Promise<unknown>>();

  request(message: { id: RpcId; method: string; params?: unknown }, send: (message: RpcMessage) => void, timeoutMs = 120_000): Promise<RpcResponse> {
    if (this.#callbacks.size >= 1024) return Promise.resolve({ id: message.id, error: { code: -32001, message: "Client callback queue is full" } });
    const id = `bridge_callback_${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#callbacks.delete(id);
        resolve({ id: message.id, error: { code: -32002, message: "Response timed out; execution outcome is unknown. Do not automatically resubmit." } });
      }, timeoutMs);
      this.#callbacks.set(id, { id: message.id, resolve, timer });
      try { send({ ...message, id }); }
      catch { this.receive({ id, error: { code: -32002, message: "Transport lost; execution outcome is unknown" } }); }
    });
  }

  receive(message: RpcMessage): boolean {
    if (!isRpcResponse(message) || typeof message.id !== "string" || !message.id.startsWith("bridge_callback_")) return false;
    const pending = this.#callbacks.get(message.id);
    if (pending) {
      this.#callbacks.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ ...message, id: pending.id });
    }
    return true;
  }

  // Wait for request acknowledgement, never for a turn to finish. Control
  // requests bypass these lanes so interrupt/steer cannot sit behind a job.
  enqueue<T>(lane: string, operation: () => Promise<T>): Promise<T> {
    if (this.#lanes.size >= 1024 && !this.#lanes.has(lane)) return Promise.reject(new Error("Too many request lanes"));
    const result = (this.#lanes.get(lane) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.#lanes.set(lane, result);
    void result.finally(() => { if (this.#lanes.get(lane) === result) this.#lanes.delete(lane); }).catch(() => undefined);
    return result;
  }

  close(): void {
    for (const [id] of this.#callbacks) this.receive({ id, error: { code: -32002, message: "Client detached; execution outcome is unknown" } });
  }
}
