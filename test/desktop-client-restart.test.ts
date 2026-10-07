import { describe, expect, it } from "vitest";
import { desktopAttachment, matchesDesktop, restartDesktopClient } from "../scripts/restart-desktop-client.mjs";

describe("desktop restart identity", () => {
  const expected = { pid: 123, startedTicks: "456", executable: "/usr/lib/chatgpt/ChatGPT" };
  it("requires main-process identity and rejects PID reuse or image replacement", () => {
    expect(matchesDesktop({ ...expected, main: true }, expected)).toBe(true);
    expect(matchesDesktop({ ...expected, main: false }, expected)).toBe(false);
    expect(matchesDesktop({ ...expected, main: true, startedTicks: "999" }, expected)).toBe(false);
    expect(matchesDesktop({ ...expected, main: true, executable: "/usr/share/code/code" }, expected)).toBe(false);
    expect(matchesDesktop(null, expected)).toBe(false);
  });
  it("rejects an unrelated executable or dangerous PID before any action", async () => {
    await expect(restartDesktopClient({ ...expected, pid: 1 }, "/unused", "/unused")).rejects.toThrow("Invalid desktop identity");
    await expect(restartDesktopClient({ ...expected, executable: "/bin/sleep" }, "/unused", "/unused")).rejects.toThrow("Invalid desktop identity");
  });
  it("requires a fresh successful desktop attachment rather than a historical VS Code event", () => {
    const event = { timestamp: "2026-09-11T05:00:00Z", operation: "client.shared_attached", outcome: "succeeded", details: { clientKind: "desktop", servicePid: 1, appServerPid: 2 } };
    const since = Date.parse(event.timestamp);
    expect(desktopAttachment(JSON.stringify(event), since)).toMatchObject(event.details);
    expect(desktopAttachment(JSON.stringify(event), since + 1)).toBeNull();
    expect(desktopAttachment(JSON.stringify({ ...event, details: { ...event.details, clientKind: "vscode" } }), since)).toBeNull();
    expect(desktopAttachment("truncated\n" + JSON.stringify(event), since)).toMatchObject(event.details);
  });
});
