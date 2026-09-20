import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { findOfficialCodexRuntime } from "./official-codex.mjs";

if (process.platform !== "linux" || !process.argv.includes("--apply")) {
  throw new Error("Usage: npm run drop:repair -- --apply (Linux; system authorization may be required)");
}
if (!process.env.CODEX_BRIDGE_OFFICIAL_EXTENSION_PATH) {
  const { stdout } = await promisify(execFile)("code", ["--locate-extension", "openai.chatgpt"], { timeout: 5_000 });
  if (!stdout.trim()) throw new Error("VS Code did not locate the active Codex extension");
  process.env.CODEX_BRIDGE_OFFICIAL_EXTENSION_PATH = stdout.trim();
}
const runtime = await findOfficialCodexRuntime();
if (!runtime.extensionPath) throw new Error("An installed official extension is required");
const directory = await mkdtemp(join(tmpdir(), "codex-drop-repair-"));
try {
  const runner = join(directory, "repair.cjs");
  await build({ stdin: { contents: `
    import { enableCodexInlineMentionCompatibility, restoreCodexInlineMentionCompatibility } from ${JSON.stringify(resolve("src/extension/codex-inline-mention-compatibility.ts"))};
    import { enableWorkbenchDropCompatibility, workbenchDropTargetNeedsElevation, replaceWorkbenchAssetWithPkexec } from ${JSON.stringify(resolve("src/extension/workbench-drop-compatibility.ts"))};
    import { codexInlineMentionCompatibilityDir, workbenchDropCompatibilityDir } from ${JSON.stringify(resolve("src/core/locations.ts"))};
    const inlineOptions = { extensionPath: ${JSON.stringify(runtime.extensionPath)}, extensionVersion: ${JSON.stringify(runtime.extensionVersion)}, stateDirectory: codexInlineMentionCompatibilityDir() };
    const appRoot = "/usr/share/code/resources/app";
    const ok = result => ["patched", "already-patched"].includes(result.status);
    async function run() {
      const inline = await enableCodexInlineMentionCompatibility(inlineOptions);
      if (!ok(inline)) throw new Error(inline.detail ?? inline.status);
      try {
        const workbench = await enableWorkbenchDropCompatibility({appRoot,stateDirectory:workbenchDropCompatibilityDir(),
          ...(await workbenchDropTargetNeedsElevation(appRoot) ? {replaceTarget:replaceWorkbenchAssetWithPkexec} : {})});
        if (!ok(workbench)) throw new Error(workbench.detail ?? workbench.status);
        console.log(JSON.stringify({inlineMention:inline.status,workbench:workbench.status,manualReloadRequired:true}));
      } catch(error) {
        if(inline.changed) {
          const restored = await restoreCodexInlineMentionCompatibility(inlineOptions);
          if(!["restored","already-restored","nothing-to-restore","stale-cleaned"].includes(restored.status)) throw new Error("Workbench repair failed and inline rollback needs attention");
        }
        throw error;
      }
    }
    run().catch(error=>{console.error(String(error));process.exitCode=1});
  `, resolveDir: process.cwd(), loader: "ts" }, outfile: runner, bundle: true, platform: "node", format: "cjs" });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [runner], { timeout: 300_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(stdout); process.stderr.write(stderr);
} finally { await rm(directory, { recursive: true, force: true }); }
