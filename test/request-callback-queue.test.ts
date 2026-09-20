import { describe, expect, it, vi } from "vitest";
import { RequestCallbackQueue } from "../src/shim/request-callback-queue.js";
import { clientConfigFromArgs, withClientConfig } from "../src/shim/client-config.js";
import type { RpcMessage } from "../src/shim/rpc.js";

describe("callback queues", () => {
  it("routes out-of-order callbacks with unique wire IDs and discards late responses", async () => {
    const queue = new RequestCallbackQueue();
    const sent: RpcMessage[] = [];
    const a = queue.request({ id: 1, method: "read" }, (m) => sent.push(m));
    const b = queue.request({ id: 1, method: "read" }, (m) => sent.push(m));
    const ids = sent.map((m) => "id" in m ? m.id : "");
    expect(ids[0]).not.toBe(ids[1]);
    queue.receive({ id: ids[1]!, result: "b" });
    queue.receive({ id: ids[0]!, result: "a" });
    expect(await a).toEqual({ id: 1, result: "a" });
    expect(await b).toEqual({ id: 1, result: "b" });
    expect(queue.receive({ id: ids[0]!, result: "late" })).toBe(true);
  });

  it("serializes acknowledgements in one lane without blocking direct control requests", async () => {
    const queue = new RequestCallbackQueue();
    const seen: string[] = [];
    let release!: () => void;
    const a = queue.enqueue("thread", async () => { seen.push("start"); await new Promise<void>((r) => { release = r; }); });
    const b = queue.enqueue("thread", async () => { seen.push("queued"); });
    await vi.waitFor(() => expect(seen).toEqual(["start"]));
    const stop = queue.request({ id: 3, method: "turn/interrupt" }, (m) => {
      seen.push("interrupt");
      queue.receive({ id: "id" in m ? m.id : "", result: {} });
    });
    await stop;
    expect(seen).toEqual(["start", "interrupt"]);
    release(); await a; await b;
    expect(seen).toEqual(["start", "interrupt", "queued"]);
  });

  it("reports unknown outcomes on timeout/close without replaying writes", async () => {
    const queue = new RequestCallbackQueue();
    const send = vi.fn();
    const timeout = queue.request({ id: 1, method: "turn/start" }, send, 10);
    expect((await timeout).error?.message).toContain("unknown");
    const closed = queue.request({ id: 2, method: "turn/start" }, send);
    queue.close();
    expect((await closed).error?.message).toContain("detached");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("desktop launch configuration", () => {
  it("preserves structured MCP settings and lets explicit thread config win", () => {
    const config = clientConfigFromArgs(["-c", "features.code_mode_host=true", "app-server", "-c",
      'mcp_servers.codex_app={command="node", args=["server.mjs"], env={CODEX_APP_TOOLS_PIPE_PATH="/tmp/test.sock"}}',
      "--enable", "another_feature", "-c", "model=fixture-model"]);
    expect(config.model).toBe("fixture-model");
    const message = withClientConfig({ id: 1, method: "thread/resume", params: { threadId: "t", config: { features: { code_mode_host: false } } } }, config);
    expect(message).toMatchObject({ params: { config: { features: { code_mode_host: false, another_feature: true }, mcp_servers: { codex_app: { args: ["server.mjs"], env: { CODEX_APP_TOOLS_PIPE_PATH: "/tmp/test.sock" } } } } } });
    expect(() => clientConfigFromArgs(["app-server", "--unknown"])).toThrow("Unsupported");
  });
});
