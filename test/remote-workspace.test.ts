import { describe, expect, it } from "vitest";
import { matchesRemoteWorkspaceRoot, remoteExecutionRoot } from "../src/remote-extension/workspace.js";

describe("Remote Executor workspace identity", () => {
  it("accepts the remote host file URI for the exact requested root", () => {
    expect(
      matchesRemoteWorkspaceRoot(
        { scheme: "file", path: "/root/work/train/MimicLite" },
        "/root/work/train/MimicLite",
      ),
    ).toBe(true);
  });

  it("also accepts the UI-side vscode-remote URI representation", () => {
    expect(
      matchesRemoteWorkspaceRoot(
        { scheme: "vscode-remote", path: "/root/work/train/MimicLite/" },
        "/root/work/train/MimicLite",
      ),
    ).toBe(true);
  });

  it("rejects other schemes, relative paths, and parent or child roots", () => {
    expect(
      matchesRemoteWorkspaceRoot(
        { scheme: "untitled", path: "/root/work/train/MimicLite" },
        "/root/work/train/MimicLite",
      ),
    ).toBe(false);
    expect(
      matchesRemoteWorkspaceRoot(
        { scheme: "file", path: "/root/work/train/MimicLite" },
        "root/work/train/MimicLite",
      ),
    ).toBe(false);
    expect(
      matchesRemoteWorkspaceRoot(
        { scheme: "file", path: "/root/work/train" },
        "/root/work/train/MimicLite",
      ),
    ).toBe(false);
    expect(
      matchesRemoteWorkspaceRoot(
        { scheme: "file", path: "/root/work/train/MimicLite/subdir" },
        "/root/work/train/MimicLite",
      ),
    ).toBe(false);
  });

  it("allows only the remote account home as an alternate execution scope", () => {
    expect(remoteExecutionRoot("/home/user/project", undefined, "/home/user")).toBe(
      "/home/user/project",
    );
    expect(remoteExecutionRoot("/home/user/project", "/home/user", "/home/user")).toBe(
      "/home/user",
    );
    expect(() =>
      remoteExecutionRoot("/home/user/project", "/home/other", "/home/user"),
    ).toThrow("does not match");
    expect(() =>
      remoteExecutionRoot("/home/user/project", "/", "/"),
    ).toThrow("does not match");
  });
});
