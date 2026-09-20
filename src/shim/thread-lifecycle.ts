import { isRecord } from "./rpc.js";

// A persisted thread, a loaded thread, and the UI-selected thread are distinct.
export class ThreadLifecycleIndex {
  readonly loaded = new Set<string>();
  selected: string | undefined;

  response(
    method: string,
    threadId: string | undefined,
    result: unknown,
    vscode: boolean,
  ): void {
    if (!isRecord(result)) return;
    const thread = isRecord(result.thread) ? result.thread : undefined;
    const id = typeof thread?.id === "string" ? thread.id : threadId;
    if (!id) return;
    if (
      [
        "thread/start",
        "thread/resume",
        "thread/fork",
        "turn/start",
        "turn/steer",
      ].includes(method)
    ) {
      this.loaded.add(id);
      if (vscode) this.selected = id;
    } else if (["thread/archive", "thread/delete"].includes(method)) {
      this.remove(id);
    } else if (method === "thread/unsubscribe") {
      if (vscode && this.selected === id) this.selected = undefined;
      if (result.status === "notLoaded") this.remove(id);
    }
  }

  notification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    const thread = isRecord(params.thread) ? params.thread : undefined;
    const id =
      typeof params.threadId === "string" ? params.threadId : thread?.id;
    if (typeof id !== "string") return;
    if (
      ["thread/closed", "thread/archived", "thread/deleted"].includes(method)
    ) {
      this.remove(id);
    } else if (method === "thread/status/changed" && isRecord(params.status)) {
      if (params.status.type === "notLoaded") this.remove(id);
      else if (
        ["idle", "active", "systemError"].includes(String(params.status.type))
      )
        this.loaded.add(id);
    } else if (["thread/started", "turn/started"].includes(method)) {
      this.loaded.add(id);
    }
  }

  private remove(id: string): void {
    this.loaded.delete(id);
    if (this.selected === id) this.selected = undefined;
  }
}
