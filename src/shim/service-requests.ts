import { randomUUID } from "node:crypto";
import { isRpcRequest, isRpcResponse, type RpcMessage } from "./rpc.js";
import type { RpcMessageWriter } from "./proxy.js";

// Native request IDs are scoped to one upstream connection. Public IDs must
// instead be unique across clients, and only the first response is authoritative.
export class ServiceRequests {
  readonly #pending = new Map<string, { source: string; message: RpcMessage; reply: RpcMessageWriter }>();

  publish(source: string, message: RpcMessage, reply: RpcMessageWriter, broadcast: RpcMessageWriter): void {
    if (!isRpcRequest(message)) return;
    const id = `bridge_service_request_${randomUUID()}`;
    const exposed = { ...message, id };
    this.#pending.set(id, { source, message, reply });
    broadcast(exposed);
  }

  respond(message: RpcMessage): boolean {
    if (!isRpcResponse(message) || typeof message.id !== "string" || !message.id.startsWith("bridge_service_request_")) return false;
    const pending = this.#pending.get(message.id);
    if (pending && isRpcRequest(pending.message)) {
      this.#pending.delete(message.id);
      pending.reply({ ...message, id: pending.message.id });
    }
    return true;
  }

  replay(write: RpcMessageWriter): void {
    for (const [id, pending] of this.#pending) write({ ...pending.message, id } as RpcMessage);
  }

  has(source: string): boolean {
    return [...this.#pending.values()].some((pending) => pending.source === source);
  }

  remove(source: string): void {
    for (const [id, pending] of this.#pending) if (pending.source === source) this.#pending.delete(id);
  }
}
