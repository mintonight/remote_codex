import { realpathSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentProcessStartedAtMs,
  inspectProcessIdentities,
  processExecutablePathsEqual,
  processIdentitiesMatch,
} from "../src/shim/process-identity.js";

describe("process identity inspection", () => {
  it("rejects malformed process lifetimes instead of matching through NaN", () => {
    const valid = { pid: 123, startedAtMs: 1000, executablePath: "/bin/tool", executableFileId: "1:2" };
    expect(processIdentitiesMatch({ ...valid, startedAtMs: Number.NaN }, valid, "linux")).toBe(false);
    expect(processIdentitiesMatch(valid, { ...valid, startedAtMs: Number.POSITIVE_INFINITY }, "linux")).toBe(false);
    expect(processIdentitiesMatch(valid, valid, "linux", Number.NaN)).toBe(false);
    expect(processIdentitiesMatch({ ...valid, pid: 0 }, { ...valid, pid: 0 }, "linux")).toBe(false);
  });
  it.runIf(process.platform === "linux")(
    "retains executable inode identity after a running binary is moved and unlinked",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "codex-deleted-executable-"));
      const executable = join(root, "original-sleep");
      const relocated = join(root, "relocated-sleep");
      await copyFile("/bin/sleep", executable);
      const child = spawn(executable, ["30"]);
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        const before = (await inspectProcessIdentities([child.pid!])).get(
          child.pid!,
        )!;
        expect(before.executablePath).toBe(executable);
        expect(before.executableFileId).toMatch(/^\d+:\d+$/);
        await rename(executable, relocated);
        await rm(relocated);
        const after = (await inspectProcessIdentities([child.pid!])).get(
          child.pid!,
        )!;
        expect(after.executablePath).toBe(relocated + " (deleted)");
        expect(after.executableFileId).toBe(before.executableFileId);
        expect(processIdentitiesMatch(before, after)).toBe(true);
        expect(
          processIdentitiesMatch({ ...before, executableFileId: "0:1" }, after),
        ).toBe(false);
        expect(
          processIdentitiesMatch(
            { ...before, startedAtMs: before.startedAtMs - 10_000 },
            after,
          ),
        ).toBe(false);
        expect(
          processIdentitiesMatch(
            { ...before, executableFileId: undefined },
            after,
          ),
        ).toBe(false);
      } finally {
        child.kill("SIGTERM");
        await exited;
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "reads the current process executable and start time",
    async () => {
      const identities = await inspectProcessIdentities([process.pid]);
      const identity = identities.get(process.pid);

      expect(identity).toBeDefined();
      expect(
        processExecutablePathsEqual(
          identity!.executablePath,
          realpathSync.native(process.execPath),
        ),
      ).toBe(true);
      expect(
        Math.abs(identity!.startedAtMs - currentProcessStartedAtMs()),
      ).toBeLessThan(2_000);
    },
  );

  it("derives a stable start timestamp from wall time and uptime", () => {
    expect(currentProcessStartedAtMs(10_000, 2.5)).toBe(7_500);
  });
});
