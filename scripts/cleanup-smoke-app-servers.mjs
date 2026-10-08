import { readFile, readdir, readlink } from "node:fs/promises";
import { resolve, sep } from "node:path";

async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return null;
    return { executable: await readlink(`/proc/${pid}/exe`), started: fields[19] };
  } catch { return null; }
}

async function smokeOwnedProcesses(prefix) {
  const candidates = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environment = (await readFile(`/proc/${name}/environ`, "utf8")).split("\0");
      // A disposable root belongs to exactly one run, so require both before
      // treating a process as smoke-owned.
      if (!environment.some((entry) => entry.startsWith(`CODEX_HOME=${prefix}`)) ||
          !environment.some((entry) => entry.startsWith(`CODEX_BRIDGE_STATE_DIR=${prefix}`))) continue;
      const value = await identity(name);
      if (value) candidates.push({ pid: Number(name), ...value });
    } catch { /* Processes can exit during the scan. */ }
  }
  return candidates;
}

async function stopCandidates(candidates) {
  for (const candidate of candidates) {
    const matches = async () => {
      const current = await identity(candidate.pid);
      return current?.executable === candidate.executable && current.started === candidate.started;
    };
    if (!await matches()) continue;
    try { process.kill(candidate.pid, "SIGTERM"); } catch { continue; }
    for (let i = 0; i < 80 && await matches(); i += 1) await new Promise((r) => setTimeout(r, 25));
    if (await matches()) process.kill(candidate.pid, "SIGKILL");
    for (let i = 0; i < 40 && await matches(); i += 1) await new Promise((r) => setTimeout(r, 25));
    if (await matches()) throw new Error(`Smoke process ${candidate.pid} did not exit`);
  }
}

export async function stopSmokeAppServers(root) {
  if (process.platform !== "linux") return;
  const prefix = resolve(root) + sep;
  // The disposable CODEX_HOME is inherited by every descendant the run starts,
  // not only the app-server: the app-server's curated-plugin startup sync leaves
  // `git fetch` helpers writing into $CODEX_HOME/.tmp after the app-server is
  // gone, and they race the teardown `rm` (ENOTEMPTY). Stop every process that
  // still owns this run's disposable roots, then confirm none respawned.
  for (let attempt = 0; ; attempt += 1) {
    const candidates = await smokeOwnedProcesses(prefix);
    if (candidates.length === 0) return;
    if (attempt >= 3) {
      throw new Error(`Smoke processes keep respawning: ${candidates.map((c) => c.pid).join(", ")}`);
    }
    await stopCandidates(candidates);
  }
}
