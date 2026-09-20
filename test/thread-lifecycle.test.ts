import { describe, expect, it } from "vitest";
import { ThreadLifecycleIndex } from "../src/shim/thread-lifecycle.js";

describe("official thread lifecycle index", () => {
  it("does not turn stored history or external activity into the UI selection", () => {
    const index = new ThreadLifecycleIndex();
    index.response(
      "thread/read",
      "history",
      { thread: { id: "history" } },
      true,
    );
    expect(index.selected).toBeUndefined();
    expect(index.loaded.size).toBe(0);
    index.response("thread/resume", "ui", { thread: { id: "ui" } }, true);
    index.response(
      "thread/start",
      undefined,
      { thread: { id: "external" } },
      false,
    );
    index.notification("thread/started", { thread: { id: "background" } });
    expect(index.selected).toBe("ui");
    expect([...index.loaded]).toEqual(["ui", "external", "background"]);
  });

  it("distinguishes unsubscribe from unload and clears a closed selection", () => {
    const index = new ThreadLifecycleIndex();
    index.response("thread/resume", "ui", {}, true);
    index.response(
      "thread/unsubscribe",
      "ui",
      { status: "unsubscribed" },
      true,
    );
    expect(index.selected).toBeUndefined();
    expect(index.loaded.has("ui")).toBe(true);
    index.response("thread/resume", "ui", {}, true);
    index.notification("thread/status/changed", {
      threadId: "ui",
      status: { type: "notLoaded" },
    });
    expect(index.selected).toBeUndefined();
    expect(index.loaded.size).toBe(0);
    index.notification("thread/closed", { threadId: "ui" });
    expect(index.loaded.size).toBe(0);
  });

  it.each(["thread/archived", "thread/deleted", "thread/closed"])(
    "retires %s without retaining a stale handle",
    (method) => {
      const index = new ThreadLifecycleIndex();
      index.response("thread/resume", "ui", {}, true);
      index.notification(method, { threadId: "ui" });
      expect(index.selected).toBeUndefined();
      expect(index.loaded.size).toBe(0);
    },
  );
});
