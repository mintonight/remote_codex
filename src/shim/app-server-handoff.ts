import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import {
  inspectProcessIdentities,
  processIdentitiesMatch,
  processExecutablePathsEqual,
  type ProcessIdentity,
} from "./process-identity.js";
import { isRecord } from "./rpc.js";

export interface AppServerHandoff {
  appServer: ProcessIdentity;
  endpoint: string;
  token: string;
  release: (committed: boolean) => Promise<void>;
}

export async function managedUpstream(
  directory: string,
  pid: number,
  value: Record<string, unknown>,
): Promise<{ endpoint: string; token: string }> {
  let endpoint = value.upstreamEndpoint;
  if (typeof endpoint !== "string") {
    if (!isRecord(value.appServer))
      throw new Error("Missing app-server identity");
    const args = (
      await readFile(`/proc/${value.appServer.pid}/cmdline`, "utf8")
    ).split("\0");
    if (
      args[args.indexOf("--ws-token-file") + 1] !==
      join(directory, `${pid}.upstream.token`)
    ) {
      throw new Error("Managed upstream identity cannot be established");
    }
    endpoint = args[args.indexOf("--listen") + 1];
  }
  if (
    typeof endpoint !== "string" ||
    !/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint)
  )
    throw new Error("Invalid managed upstream endpoint");
  const token = await readFile(
    join(directory, `${pid}.upstream.token`),
    "utf8",
  );
  if (!/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error("Invalid managed upstream credential");
  return { endpoint, token };
}

function matches(
  expected: ProcessIdentity,
  actual: ProcessIdentity | undefined,
): boolean {
  return processIdentitiesMatch(expected, actual);
}

async function attestLegacyAppServer(
  directory: string,
  shimPid: number,
  descriptor: Record<string, unknown>,
  expected: ProcessIdentity,
  actual: ProcessIdentity,
): Promise<boolean> {
  try {
    const args = (await readFile(`/proc/${actual.pid}/cmdline`, "utf8")).split(
      "\0",
    );
    const tokenIndex = args.indexOf("--ws-token-file");
    const listenIndex = args.indexOf("--listen");
    if (
      !processExecutablePathsEqual(args[0] ?? "", expected.executablePath) ||
      !args.includes("app-server") ||
      tokenIndex < 0 ||
      listenIndex < 0 ||
      args[tokenIndex + 1] !== join(directory, `${shimPid}.upstream.token`)
    )
      return false;
    const upstream = await managedUpstream(directory, shimPid, descriptor);
    if (args[listenIndex + 1] !== upstream.endpoint) return false;
    const inodes = new Set<string>();
    for (const fd of await readdir(`/proc/${actual.pid}/fd`)) {
      const target = await readlink(`/proc/${actual.pid}/fd/${fd}`).catch(
        () => "",
      );
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) inodes.add(inode);
    }
    const address = `0100007F:${Number(new URL(upstream.endpoint).port).toString(16).toUpperCase().padStart(4, "0")}`;
    const ownsListener = (await readFile(`/proc/${actual.pid}/net/tcp`, "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields[1] === address &&
          fields[3] === "0A" &&
          inodes.has(fields[9] ?? "")
        );
      });
    if (
      !ownsListener ||
      (await probeManagedAppServer(
        upstream.endpoint,
        upstream.token,
        "empty",
      )) === null
    )
      return false;
    return matches(
      actual,
      (await inspectProcessIdentities([actual.pid])).get(actual.pid),
    );
  } catch {
    return false;
  }
}

export async function claimAppServerHandoff(
  directory: string,
  host: string,
  workspaceRoot: string,
  serviceKey?: string,
): Promise<AppServerHandoff | null> {
  if (process.platform !== "linux") return null;
  const names = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const candidates: Array<{
    path: string;
    raw: string;
    value: Record<string, unknown>;
    appServer: ProcessIdentity;
  }> = [];
  const liveOwners = new Set<number>();
  const unverifiable = new Set<number>();
  for (const name of names.filter((name) => /^\d+\.json$/.test(name))) {
    let recognizedAppServerPid: number | undefined;
    try {
      const path = join(directory, name);
      const raw = await readFile(path, "utf8");
      const value: unknown = JSON.parse(raw);
      if (
        !isRecord(value) ||
        value.host !== host ||
        value.workspaceRoot !== workspaceRoot ||
        (serviceKey !== undefined && value.serviceKey !== undefined && value.serviceKey !== serviceKey) ||
        !Number.isSafeInteger(value.pid) ||
        value.pid !== Number(name.slice(0, -5)) ||
        !isRecord(value.appServer)
      )
        continue;
      if (
        Number.isSafeInteger(value.appServer.pid) &&
        Number(value.appServer.pid) > 0
      )
        recognizedAppServerPid = Number(value.appServer.pid);
      const pid = value.pid as number;
      const owner = (await inspectProcessIdentities([pid])).get(pid);
      const expectedOwner = {
        pid,
        startedAtMs: Number(value.startedAtMs),
        executablePath:
          typeof value.executablePath === "string" ? value.executablePath : "",
      };
      if (owner && matches(expectedOwner, owner)) {
        liveOwners.add(Number(value.appServer.pid));
        continue;
      }
      if (!owner) {
        try {
          process.kill(pid, 0);
          liveOwners.add(Number(value.appServer.pid));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
        }
      }
      const appServer = value.appServer as unknown as ProcessIdentity;
      if (serviceKey && value.serviceKey === undefined) {
        const environment = (await readFile(`/proc/${appServer.pid}/environ`, "utf8")).split("\0");
        const home = environment.find((entry) => entry.startsWith("CODEX_HOME="))?.slice("CODEX_HOME=".length);
        if (resolve(home ?? join(homedir(), ".codex")) !== resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))) continue;
      }
      const actual = (await inspectProcessIdentities([appServer.pid])).get(
        appServer.pid,
      );
      if (matches(appServer, actual))
        candidates.push({ path, raw, value, appServer: actual! });
      else if (
        actual &&
        appServer.executableFileId === undefined &&
        actual.pid === appServer.pid &&
        Math.abs(actual.startedAtMs - appServer.startedAtMs) <= 2_000
      ) {
        if (
          await attestLegacyAppServer(directory, pid, value, appServer, actual)
        )
          candidates.push({ path, raw, value, appServer: actual });
        else unverifiable.add(appServer.pid);
      } else if (!actual) {
        try {
          process.kill(appServer.pid, 0);
          unverifiable.add(appServer.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM")
            unverifiable.add(appServer.pid);
        }
      }
    } catch {
      /* An incomplete journal is not ownership evidence. */
      if (recognizedAppServerPid !== undefined)
        unverifiable.add(recognizedAppServerPid);
    }
  }
  if ([...unverifiable].some((pid) => !liveOwners.has(pid)))
    throw new Error(
      "Retained app-server identity is unverifiable; refusing to select an empty competitor",
    );
  let eligible = candidates.filter(
    (candidate) => !liveOwners.has(candidate.appServer.pid),
  );
  if (new Set(eligible.map((candidate) => candidate.appServer.pid)).size > 1) {
    const nonempty = new Set<number>();
    for (const pid of new Set(
      eligible.map((candidate) => candidate.appServer.pid),
    )) {
      const candidate = eligible.find(
        (candidate) => candidate.appServer.pid === pid,
      )!;
      const upstream = await managedUpstream(
        directory,
        candidate.value.pid as number,
        candidate.value,
      );
      const empty = await probeManagedAppServer(
        upstream.endpoint,
        upstream.token,
        "empty",
      );
      if (empty === null)
        throw new Error("Cannot verify detached app-server thread ownership");
      if (!empty) nonempty.add(pid);
    }
    if (nonempty.size > 1)
      throw new Error(
        "Multiple detached app-servers hold threads for this workspace; automatic takeover is ambiguous",
      );
    const selected =
      nonempty.size === 1
        ? [...nonempty][0]!
        : [...eligible].sort(
            (a, b) => Number(b.value.startedAtMs) - Number(a.value.startedAtMs),
          )[0]!.appServer.pid;
    eligible = eligible.filter(
      (candidate) => candidate.appServer.pid === selected,
    );
  }
  const candidate = eligible.sort(
    (a, b) => Number(b.value.startedAtMs) - Number(a.value.startedAtMs),
  )[0];
  if (!candidate) return null;
  const claimPath = join(
    directory,
    `app-server-${candidate.appServer.pid}.claim`,
  );
  try {
    const raw = await readFile(claimPath, "utf8");
    const owner: unknown = JSON.parse(raw);
    if (
      isRecord(owner) &&
      Number.isSafeInteger(owner.pid) &&
      Number(owner.pid) > 0
    ) {
      let dead = false;
      try {
        process.kill(Number(owner.pid), 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (dead) {
        const retired = `${claimPath}.${randomUUID()}.stale`;
        await rename(claimPath, retired);
        const quarantined = await readFile(retired, "utf8");
        if (quarantined !== raw)
          await writeFile(claimPath, quarantined, { flag: "wx", mode: 0o600 });
        await rm(retired, { force: true });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Handoff claim cannot be safely recovered");
  }
  const handle = await open(claimPath, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error("Another Bridge is reclaiming the detached app-server");
      throw error;
    },
  );
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await handle.close();
    await rm(claimPath, { force: true });
  };
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, claimId: randomUUID() }),
    );
    if ((await readFile(candidate.path, "utf8")) !== candidate.raw)
      throw new Error("App-server journal changed during takeover");
    if (
      !matches(
        candidate.appServer,
        (await inspectProcessIdentities([candidate.appServer.pid])).get(
          candidate.appServer.pid,
        ),
      )
    ) {
      throw new Error("App-server process identity changed during takeover");
    }
    const upstream = await managedUpstream(
      directory,
      candidate.value.pid as number,
      candidate.value,
    );
    // Keep the old journal until a new owner has persisted its identity.
    return {
      appServer: candidate.appServer,
      ...upstream,
      release: async (committed) => {
        try {
          for (const previous of eligible) {
            if (
              committed &&
              (await readFile(previous.path, "utf8").catch(() => "")) ===
                previous.raw
            ) {
              await rm(previous.path, { force: true });
              await rm(join(directory, `${previous.value.pid}.token`), {
                force: true,
              });
              await rm(
                join(directory, `${previous.value.pid}.upstream.token`),
                { force: true },
              );
            }
          }
        } finally {
          await release();
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function probeManagedAppServerIdle(
  endpoint: string,
  token: string,
): Promise<boolean> {
  return (await probeManagedAppServer(endpoint, token, "idle")) === true;
}

async function probeManagedAppServer(
  endpoint: string,
  token: string,
  mode: "idle" | "empty",
): Promise<boolean | null> {
  const socket = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 1_000,
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let id = 0;
  socket.on("error", () => undefined);
  socket.on("message", (raw) => {
    try {
      const value: unknown = JSON.parse(raw.toString());
      if (isRecord(value) && typeof value.id === "number")
        pending.get(value.id)?.(value);
    } catch {
      /* Fail through the bounded request timeout. */
    }
  });
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Idle probe timed out"));
      }, 1_000);
      pending.set(requestId, (message) => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (message.error) reject(new Error("Idle probe failed"));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await request("initialize", {
      clientInfo: { name: "bridge_lifecycle_probe", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    const loaded = await request("thread/loaded/list", { limit: 100 });
    if (
      !isRecord(loaded) ||
      !Array.isArray(loaded.data) ||
      loaded.data.some((id) => typeof id !== "string")
    )
      return null;
    if (mode === "empty")
      return loaded.data.length === 0 && loaded.nextCursor == null;
    if (loaded.nextCursor != null) return false;
    for (const threadId of loaded.data) {
      if (typeof threadId !== "string") return false;
      const result = await request("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (
        !isRecord(result) ||
        !isRecord(result.thread) ||
        !isRecord(result.thread.status) ||
        !["idle", "notLoaded"].includes(String(result.thread.status.type))
      )
        return false;
    }
    return true;
  } catch {
    return null;
  } finally {
    socket.terminate();
  }
}
