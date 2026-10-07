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

export async function stopSmokeAppServers(root) {
  if (process.platform !== "linux") return;
  const prefix = resolve(root) + sep;
  const candidates = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0");
      if ((!args.includes("app-server") || !args.includes("--ws-token-file")) && !args.includes("--bridge-local-service-worker")) continue;
      const environment = (await readFile(`/proc/${name}/environ`, "utf8")).split("\0");
      if (!environment.some((entry) => entry.startsWith(`CODEX_HOME=${prefix}`)) ||
          !environment.some((entry) => entry.startsWith(`CODEX_BRIDGE_STATE_DIR=${prefix}`))) continue;
      const value = await identity(name);
      if (value) candidates.push({ pid: Number(name), ...value });
    } catch { /* Processes can exit during the scan. */ }
  }
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
    if (await matches()) throw new Error(`Smoke app-server ${candidate.pid} did not exit`);
  }
}
