import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopWrapper, installDesktopClient } from "../scripts/install-desktop-client.mjs";

describe.skipIf(process.platform !== "linux")("reversible desktop launcher", () => {
  it("quotes paths and keeps desktop arguments without rewriting official resources", () => {
    const wrapper = desktopWrapper({ shim: "/a b/bridge", desktop: "/a'b/ChatGPT", codex: "/runtime/codex" });
    expect(wrapper).toContain("CODEX_CLI_PATH='/a b/bridge'");
    expect(wrapper).toContain(`exec '/a'"'"'b/ChatGPT' "$@"`);
    expect(wrapper).toContain("CODEX_BRIDGE_DESKTOP_CLIENT=1");
  });
  it("installs a separate entry, refuses user edits, and only removes matching managed files", async () => {
    const home = await mkdtemp(join(tmpdir(), "desktop-bridge-install-"));
    try {
      await mkdir(join(home, "dist")); await writeFile(join(home, "dist/codex-bridge-shim"), "fixture");
      const systemDesktopFile = join(home, "official.desktop");
      const systemEntry = "[Desktop Entry]\nType=Application\nName=Fixture ChatGPT\nExec=/bin/true %U\n";
      await writeFile(systemDesktopFile, systemEntry);
      const options = { home, root: home, desktop: "/bin/true", codex: "/bin/true", systemDesktopFile };
      const result = await installDesktopClient(options);
      if (!("wrapper" in result)) throw new Error("Missing launcher");
      expect(await readFile(result.defaultEntry, "utf8")).toContain(`Exec="${result.wrapper}" %U`);
      expect(await readFile(result.defaultEntry, "utf8")).toContain("DBusActivatable=false");
      const original = await readFile(result.wrapper, "utf8");
      await writeFile(result.wrapper, "user edit");
      await expect(installDesktopClient(options)).rejects.toThrow("unmanaged or modified");
      await expect(installDesktopClient({ ...options, uninstall: true })).rejects.toThrow("unmanaged or modified");
      await writeFile(result.wrapper, original);
      expect(await installDesktopClient({ ...options, uninstall: true })).toEqual({ removed: true });
      await expect(access(result.wrapper)).rejects.toThrow();
      await expect(access(result.defaultEntry)).rejects.toThrow();
      expect(await readFile(systemDesktopFile, "utf8")).toBe(systemEntry);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("preserves an existing user icon and restores its exact original bytes after upgrades", async () => {
    const home = await mkdtemp(join(tmpdir(), "desktop-bridge-restore-"));
    try {
      await mkdir(join(home, "dist")); await writeFile(join(home, "dist/codex-bridge-shim"), "fixture");
      const directory = join(home, ".local/share/applications");
      await mkdir(directory, { recursive: true });
      const target = join(directory, "chatgpt.desktop");
      const original = Buffer.from("[Desktop Entry]\r\nType=Application\r\nName=My ChatGPT\r\nExec=/bin/true %U\r\nMimeType=x-scheme-handler/codex;\r\nDBusActivatable=true\r\n");
      await writeFile(target, original);
      const options = { home, root: home, desktop: "/bin/true", codex: "/bin/true" };
      await installDesktopClient(options);
      expect(await readFile(target, "utf8")).toContain("Name=My ChatGPT");
      expect(await readFile(target, "utf8")).toContain("MimeType=x-scheme-handler/codex;");
      await installDesktopClient(options);
      const managed = await readFile(target);
      await writeFile(target, "user changed the default icon");
      await expect(installDesktopClient({ ...options, uninstall: true })).rejects.toThrow("unmanaged or modified");
      await writeFile(target, managed);
      await installDesktopClient({ ...options, uninstall: true });
      expect(await readFile(target)).toEqual(original);
      const nextOriginal = Buffer.from(original.toString().replace("My ChatGPT", "My Updated ChatGPT"));
      await writeFile(target, nextOriginal);
      await installDesktopClient(options);
      await installDesktopClient({ ...options, uninstall: true });
      expect(await readFile(target)).toEqual(nextOriginal);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
