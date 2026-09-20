import { describe, expect, it } from "vitest";
import {
  ThreadSubscriptionRecovery,
  type ThreadRecoveryCycle,
} from "../src/shim/thread-recovery.js";
import { isRecord, type RpcMessage } from "../src/shim/rpc.js";
import { loadedThreadIds } from "../src/shim/vscode-conversation-client.js";

function fixture() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const emitted: RpcMessage[] = [];
  const cycles: ThreadRecoveryCycle[] = [];
  const errors: string[] = [];
  let status: Record<string, unknown> = { type: "active", activeFlags: [] };
  let selected: string | undefined;
  let loaded = ["background"];
  const recovery = new ThreadSubscriptionRecovery({
    workspaceRoot: () => "/work",
    selectedThreadId: () => selected,
    log: (message) => errors.push(message),
    onCycle: (cycle) => cycles.push(cycle),
    emit: (message) => emitted.push(message),
    send: (message) => {
      if (!("method" in message) || !("id" in message)) return;
      const params = isRecord(message.params) ? message.params : {};
      requests.push({ method: message.method, params });
      const result =
        message.method === "thread/loaded/list"
          ? { data: loaded, nextCursor: null }
          : message.method === "thread/unsubscribe"
            ? { status: "unsubscribed" }
            : {
                thread: {
                  id: params.threadId,
                  cwd: "/work",
                  status,
                  turns: [],
                },
              };
      queueMicrotask(() => recovery.observe({ id: message.id!, result }));
    },
  });
  return {
    recovery,
    requests,
    emitted,
    cycles,
    errors,
    setStatus: (value: Record<string, unknown>) => {
      status = value;
    },
    setSelected: (value: string | undefined) => {
      selected = value;
    },
    setLoaded: (value: string[]) => {
      loaded = value;
    },
  };
}

describe("lightweight thread subscription recovery", () => {
  it("discovers every page and resumes background threads without requesting or emitting history", async () => {
    const sent: RpcMessage[] = [];
    const emitted: RpcMessage[] = [];
    const recovery = new ThreadSubscriptionRecovery({
      workspaceRoot: () => "/work",
      log: (message) => {
        throw new Error(message);
      },
      emit: (message) => emitted.push(message),
      send: (message) => {
        sent.push(message);
        if (!("method" in message) || !("id" in message)) return;
        const params = isRecord(message.params) ? message.params : {};
        const result =
          message.method === "thread/loaded/list"
            ? params.cursor
              ? { data: ["background", "foreign"], nextCursor: null }
              : { data: ["foreground"], nextCursor: "next" }
            : {
                thread: {
                  id: params.threadId,
                  cwd: params.threadId === "foreign" ? "/other" : "/work",
                  status: { type: "active" },
                  turns: [{ privateFixture: "must not be replayed" }],
                },
              };
        queueMicrotask(() => recovery.observe({ id: message.id!, result }));
      },
    });
    try {
      await recovery.refresh();
      expect(
        sent
          .filter((m) => "method" in m && m.method === "thread/resume")
          .map((m) => "params" in m && m.params),
      ).toEqual([
        { threadId: "foreground", excludeTurns: true },
        { threadId: "background", excludeTurns: true },
      ]);
      expect(emitted).toHaveLength(2);
      expect(
        emitted.every(
          (m) => "method" in m && m.method === "thread/status/changed",
        ),
      ).toBe(true);
      expect(JSON.stringify(emitted)).not.toContain("privateFixture");
    } finally {
      recovery.dispose();
    }
  });

  it("keeps 500 unchanged active polling cycles free of history replay and duplicate UI events", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 500; i += 1) await f.recovery.refresh();
      expect(f.requests.filter((r) => r.method === "thread/read")).toHaveLength(
        500,
      );
      expect(
        f.requests
          .filter((r) => r.method === "thread/read")
          .every((r) => r.params.includeTurns === false),
      ).toBe(true);
      expect(f.requests.filter((r) => r.method === "thread/resume")).toEqual([
        {
          method: "thread/resume",
          params: { threadId: "background", excludeTurns: true },
        },
      ]);
      expect(f.emitted).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(f.emitted))).toBeLessThan(256);
      expect(
        f.requests.some((r) =>
          ["turn/start", "turn/steer", "turn/interrupt"].includes(r.method),
        ),
      ).toBe(false);
      expect(f.cycles.at(-1)).toMatchObject({
        resumedThreads: 0,
        publishedStatuses: 0,
        errors: 0,
      });
      expect(f.errors).toEqual([]);
    } finally {
      f.recovery.dispose();
    }
  });

  it("publishes changed approval flags and a final idle status, then retires only its background subscription", async () => {
    const f = fixture();
    try {
      await f.recovery.refresh();
      f.setStatus({ type: "active", activeFlags: ["waitingOnApproval"] });
      await f.recovery.refresh();
      f.setStatus({ type: "idle" });
      await f.recovery.refresh();
      await f.recovery.refresh();
      expect(f.emitted).toHaveLength(3);
      expect(f.emitted.at(-1)).toMatchObject({
        method: "thread/status/changed",
        params: { status: { type: "idle" } },
      });
      expect(
        f.requests.filter((r) => r.method === "thread/unsubscribe"),
      ).toHaveLength(1);
      expect(f.requests.every((r) => r.params.includeTurns !== true)).toBe(
        true,
      );
    } finally {
      f.recovery.dispose();
    }
  });

  it("does not duplicate the foreground subscription or unsubscribe it after a foreground switch", async () => {
    const f = fixture();
    try {
      f.setSelected("background");
      await f.recovery.refresh();
      expect(f.requests.some((r) => r.method === "thread/resume")).toBe(false);
      f.setSelected(undefined);
      await f.recovery.refresh();
      f.setSelected("background");
      f.setStatus({ type: "idle" });
      await f.recovery.refresh();
      expect(f.requests.some((r) => r.method === "thread/unsubscribe")).toBe(
        false,
      );
    } finally {
      f.recovery.dispose();
    }
  });

  it("does not repeat a status already delivered by the native event stream", async () => {
    const f = fixture();
    try {
      await f.recovery.refresh();
      f.setStatus({ type: "active", activeFlags: ["waitingOnUserInput"] });
      expect(
        f.recovery.observe({
          method: "thread/status/changed",
          params: {
            threadId: "background",
            status: { type: "active", activeFlags: ["waitingOnUserInput"] },
          },
        }),
      ).toBe(false);
      await f.recovery.refresh();
      expect(f.emitted).toHaveLength(1);
    } finally {
      f.recovery.dispose();
    }
  });

  it("forgets retired entries and rediscovers a subsequently loaded thread", async () => {
    const f = fixture();
    try {
      await f.recovery.refresh();
      f.setLoaded([]);
      await f.recovery.refresh();
      expect(f.emitted.at(-1)).toMatchObject({ method: "thread/closed" });
      f.setLoaded(["background"]);
      await f.recovery.refresh();
      expect(
        f.requests.filter((r) => r.method === "thread/resume"),
      ).toHaveLength(2);
      expect(f.emitted).toHaveLength(3);
    } finally {
      f.recovery.dispose();
    }
  });

  it("rejects oversized runtime status payloads instead of forwarding arbitrary data", async () => {
    const f = fixture();
    try {
      f.setStatus({ type: "active", activeFlags: ["x".repeat(129)] });
      await f.recovery.refresh();
      expect(f.emitted).toEqual([]);
      expect(f.cycles[0]?.errors).toBe(1);
    } finally {
      f.recovery.dispose();
    }
  });

  it("bounds unavailable capabilities and disposes pending recovery requests", async () => {
    const errors: string[] = [];
    const recovery = new ThreadSubscriptionRecovery({
      workspaceRoot: () => "/work",
      send: () => undefined,
      emit: () => undefined,
      log: (message) => errors.push(message),
      timeoutMs: 10,
    });
    await recovery.refresh();
    expect(errors[0]).toContain("timed out");
    const refreshing = recovery.refresh();
    recovery.dispose();
    await refreshing;
    expect(errors).toHaveLength(1);
  });

  it("rejects a cyclic loaded-thread cursor instead of truncating discovery", async () => {
    await expect(
      loadedThreadIds({
        request: async () => ({ data: ["thread"], nextCursor: "repeat" }),
      }),
    ).rejects.toThrow("pagination");
  });
});
