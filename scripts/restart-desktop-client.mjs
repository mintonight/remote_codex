import { readFile, readlink, readdir, mkdir, writeFile, rename, open } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export async function desktopProcess(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    const executable = await readlink(`/proc/${pid}/exe`);
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    const environment = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
    return { pid, parentPid: Number(fields[1]), startedTicks: fields[19], executable,
      main: basename(executable) === "ChatGPT" && !args.some((arg) => arg.startsWith("--type=")),
      shared: environment.includes("CODEX_BRIDGE_DESKTOP_CLIENT=1"), appServer: args.includes("app-server") };
  } catch { return null; }
}

export function matchesDesktop(actual, expected) {
  return Boolean(actual?.main && actual.pid === expected.pid && actual.startedTicks === expected.startedTicks && actual.executable === expected.executable);
}

export function desktopAttachment(raw, since) {
  for (const line of raw.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      if (event.operation === "client.shared_attached" && event.outcome === "succeeded" &&
          event.details?.clientKind === "desktop" && Date.parse(event.timestamp) >= since &&
          Number.isSafeInteger(event.details.servicePid) && Number.isSafeInteger(event.details.appServerPid)) return event.details;
    } catch { /* The first line of a tail read may be partial. */ }
  }
  return null;
}

async function attachmentSince(receipt, since) {
  const handle = await open(join(dirname(receipt), "..", "audit.jsonl"), "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 512 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return desktopAttachment(buffer.subarray(0, bytesRead).toString("utf8"), since);
  } finally { await handle.close(); }
}

export async function restartDesktopClient(expected, launcher, receipt) {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 1 || basename(expected.executable) !== "ChatGPT" || !/^\d+$/.test(expected.startedTicks)) throw new Error("Invalid desktop identity");
  const record = async (status, details = {}) => {
    await mkdir(dirname(receipt), { recursive: true, mode: 0o700 });
    const temporary = `${receipt}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ timestamp: new Date().toISOString(), status, previousPid: expected.pid, ...details }, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, receipt);
  };
  try {
    const current = await desktopProcess(expected.pid);
    if (current && !matchesDesktop(current, expected)) throw new Error("Desktop identity changed; refusing termination");
    if (current) {
      await record("closing");
      // Signal only the verified desktop parent. Never kill a process group,
      // a native Codex process, VS Code, or training processes by name.
      process.kill(expected.pid, "SIGTERM");
      const deadline = Date.now() + 15_000;
      while (matchesDesktop(await desktopProcess(expected.pid), expected)) {
        if (Date.now() >= deadline) throw new Error("Desktop did not exit gracefully; no SIGKILL escalation performed");
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    const launchedAt = Date.now();
    const child = spawn(launcher, [], { detached: true, stdio: "ignore" });
    let launchError = false;
    child.on("error", () => { launchError = true; });
    child.unref();
    await record("starting", { launcherPid: child.pid });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (launchError) throw new Error("Shared desktop launcher failed");
      const desktop = child.pid ? await desktopProcess(child.pid) : null;
      if (desktop?.main && desktop.shared) {
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          const candidate = await desktopProcess(Number(pid));
          if (candidate?.parentPid === child.pid && candidate.appServer && basename(candidate.executable) === "codex-bridge-shim") {
            const attached = await attachmentSince(receipt, launchedAt);
            if (attached) {
              await record("shared-client-ready", { desktopPid: child.pid, shimPid: candidate.pid,
                servicePid: attached.servicePid, appServerPid: attached.appServerPid });
              return;
            }
          }
        }
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error("Shared desktop process/adapter was not confirmed before timeout");
  } catch (error) {
    await record("failed", { error: error instanceof Error ? error.message : "Restart failed" });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pid, startedTicks, executable, launcher, receipt] = process.argv.slice(2);
  await restartDesktopClient({ pid: Number(pid), startedTicks, executable }, launcher, receipt);
}
