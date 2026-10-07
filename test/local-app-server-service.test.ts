import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localServiceKey, resolveServiceWorkspace } from "../src/shim/local-app-server-service.js";
import { saveLocalWorkspaceContext } from "../src/core/local-workspace-context.js";

describe("local service execution domain", () => {
  it("uses canonical workspace and config home, not window identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-service-key-"));
    const previous = process.env.CODEX_HOME;
    try {
      await mkdir(join(root, "workspace"));
      await symlink(join(root, "workspace"), join(root, "alias"), "dir");
      process.env.CODEX_HOME = join(root, "home-a");
      const a = await localServiceKey(join(root, "workspace"), ["app-server"]);
      expect(await localServiceKey(join(root, "alias"), ["app-server"])).toBe(a);
      process.env.CODEX_HOME = join(root, "home-b");
      expect(await localServiceKey(join(root, "workspace"), ["app-server"])).not.toBe(a);
      const context = join(root, "context.json");
      await saveLocalWorkspaceContext(context, null);
      expect(await resolveServiceWorkspace(context, root)).toBeUndefined();
      await expect(resolveServiceWorkspace(join(root, "missing"), root, 10)).rejects.toThrow("not ready");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
