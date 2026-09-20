import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

const hash = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function desktopWrapper({ shim, desktop, codex }) {
  for (const value of [shim, desktop, codex]) if (/[\r\n\0]/.test(value)) throw new Error("Invalid executable path");
  return `#!/bin/sh
set -eu
if [ -n "\${CODEX_APP_SERVER_WS_URL-}" ]; then
  printf '%s\\n' 'An explicit desktop WebSocket endpoint is set; refusing to silently replace it.' >&2
  exit 1
fi
export CODEX_CLI_PATH=${quote(shim)}
export CODEX_BRIDGE_DESKTOP_CLIENT=1
export CODEX_BRIDGE_DESKTOP_CODEX_EXECUTABLE=${quote(codex)}
exec ${quote(desktop)} "$@"
`;
}

export async function installDesktopClient({ root = resolve("."), home = homedir(), desktop = "/usr/bin/chatgpt", codex = "/usr/lib/chatgpt/resources/codex", systemDesktopFile = "/usr/share/applications/chatgpt.desktop", uninstall = false } = {}) {
  if (process.platform !== "linux") throw new Error("Desktop integration currently requires Linux");
  const directory = join(home, ".local/state/codex-remote-bridge/desktop-client");
  const manifestPath = join(directory, "installation.json");
  const wrapper = join(home, ".local/bin/chatgpt-codex-bridge");
  const entry = join(home, ".local/share/applications/chatgpt-codex-bridge.desktop");
  const defaultEntry = join(home, ".local/share/applications/chatgpt.desktop");
  let previous;
  try { previous = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const path of [wrapper, entry, ...(previous?.defaultEntry ? [defaultEntry] : [])]) {
    const data = await readFile(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const expected = previous?.files?.[path];
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (data && !allowed.includes(hash(data))) throw new Error(`Refusing to overwrite an unmanaged or modified file: ${path}`);
  }
  if (uninstall) {
    if (previous) {
      if (previous.defaultEntry) {
        const snapshot = previous.defaultEntry;
        if (snapshot.existed) {
          const original = await readFile(join(directory, snapshot.backup ?? "default-entry.original"));
          if (hash(original) !== snapshot.sha256) throw new Error("Original desktop entry backup integrity mismatch");
          const temporary = `${defaultEntry}.${process.pid}.tmp`;
          await writeFile(temporary, original, { mode: snapshot.mode });
          await rename(temporary, defaultEntry);
        } else await rm(defaultEntry, { force: true });
      }
      for (const path of [wrapper, entry]) await rm(path, { force: true });
      await rm(manifestPath, { force: true });
    }
    return { removed: Boolean(previous) };
  }
  await access(desktop, constants.X_OK); await access(codex, constants.X_OK);
  const source = join(root, "dist/codex-bridge-shim");
  const digest = hash(await readFile(source));
  const shim = join(directory, digest, "codex-bridge-shim");
  await mkdir(dirname(shim), { recursive: true, mode: 0o700 });
  const existing = await lstat(shim).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (existing) {
    if (!existing.isFile() || hash(await readFile(shim)) !== digest) throw new Error("Managed desktop Shim integrity mismatch");
  } else await copyFile(source, shim, constants.COPYFILE_EXCL);
  await chmod(shim, 0o700);
  const contents = desktopWrapper({ shim, desktop, codex });
  const desktopEntry = `[Desktop Entry]\nType=Application\nName=ChatGPT (Shared Codex)\nComment=Shared Codex execution with VS Code\nExec="${wrapper.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" %U\nIcon=chatgpt\nTerminal=false\nCategories=Development;Utility;\n`;
  const state = await lstat(defaultEntry).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (state && !state.isFile()) throw new Error("Refusing to replace a non-regular default desktop entry");
  let snapshot = previous?.defaultEntry;
  if (!snapshot) {
    if (state) {
      const original = await readFile(defaultEntry);
      snapshot = { existed: true, sha256: hash(original), mode: state.mode & 0o777, backup: `default-entry-${hash(original)}.original` };
      const backup = join(directory, snapshot.backup);
      await writeFile(backup, original, { flag: "wx", mode: 0o600 }).catch(async (error) => {
        if (error.code !== "EEXIST" || hash(await readFile(backup)) !== snapshot.sha256) throw error;
      });
    } else snapshot = { existed: false };
  }
  const original = await readFile(snapshot.existed ? join(directory, snapshot.backup ?? "default-entry.original") : systemDesktopFile);
  if (snapshot.existed && hash(original) !== snapshot.sha256) throw new Error("Original desktop entry backup integrity mismatch");
  const stagedEntry = join(directory, `default-entry.${process.pid}.desktop`);
  let defaultContents;
  try {
    await writeFile(stagedEntry, original, { mode: 0o600 });
    const command = `"${wrapper.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" %U`;
    await execute("desktop-file-edit", ["--set-key=Exec", `--set-value=${command}`,
      "--set-key=TryExec", `--set-value=${wrapper}`, "--set-key=DBusActivatable", "--set-value=false", stagedEntry]);
    defaultContents = await readFile(stagedEntry);
  } finally { await rm(stagedEntry, { force: true }); }
  const files = { [wrapper]: hash(contents), [entry]: hash(desktopEntry), [defaultEntry]: hash(defaultContents) };
  // A crash between replacing the two entry files must remain recoverable.
  const pending = Object.fromEntries(Object.entries(files).map(([path, digest]) => [path,
    [digest, ...[previous?.files?.[path]].flat().filter((value) => typeof value === "string")]]));
  if (!previous?.defaultEntry && snapshot.existed) pending[defaultEntry].push(snapshot.sha256);
  const manifestTemporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(manifestTemporary, JSON.stringify({ shim, sha256: digest, files: pending, defaultEntry: snapshot }), { mode: 0o600 });
  await rename(manifestTemporary, manifestPath);
  for (const [path, data, mode] of [[wrapper, contents, 0o700], [entry, desktopEntry, 0o600], [defaultEntry, defaultContents, 0o600]]) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, data, { mode }); await rename(temporary, path);
  }
  await writeFile(manifestTemporary, JSON.stringify({ shim, sha256: digest, files, defaultEntry: snapshot }, null, 2) + "\n", { mode: 0o600 });
  await rename(manifestTemporary, manifestPath);
  return { wrapper, entry, defaultEntry, shim, requiresManualDesktopRestart: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await installDesktopClient({ uninstall: process.argv.includes("--uninstall") }), null, 2));
}
