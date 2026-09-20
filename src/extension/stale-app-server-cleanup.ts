import { randomBytes } from "node:crypto";
import { open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { bridgeExternalCliDir } from "../core/locations.js";
import {
  inspectProcessIdentities,
  processIdentitiesMatch,
  type ProcessIdentity,
  type ProcessIdentityInspector,
} from "../shim/process-identity.js";
import { isRecord } from "../shim/rpc.js";
import { managedUpstream, probeManagedAppServerIdle } from "../shim/app-server-handoff.js";

const PROCESS_START_TOLERANCE_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 2_000;
const TERMINATION_POLL_MS = 50;

interface StaleSessionCandidate {
  appServer: ProcessIdentity | null;
  executablePath: string;
  path: string;
  pid: number;
  raw: string;
  startedAtMs: number;
  version: 2 | 3;
  retainUntilMs?: number;
}

export interface StaleAppServerCleanupSummary {
  failedPids: number[];
  inspectedCount: number;
  removedCount: number;
  staleCount: number;
  terminatedPids: number[];
}

export interface StaleAppServerCleanupOptions {
  directory?: string;
  findLegacyAppServers?: (
    upstreamTokenPath: string,
  ) => Promise<ProcessIdentity[]>;
  hostPlatform?: NodeJS.Platform;
  inspectProcesses?: ProcessIdentityInspector;
  isProcessAlive?: (pid: number) => boolean;
  terminateProcess?: (pid: number, signal: NodeJS.Signals) => void;
  wait?: (delayMs: number) => Promise<void>;
  canRetireAppServer?: (candidatePath: string) => Promise<boolean>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseCandidate(
  raw: string,
  path: string,
  hostPlatform: NodeJS.Platform,
): StaleSessionCandidate | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    (value.version !== 2 && value.version !== 3) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    typeof value.executablePath !== "string" ||
    !pathIsAbsolute(value.executablePath, hostPlatform)
  ) {
    return null;
  }
  let appServer: ProcessIdentity | null = null;
  if (value.version === 3) {
    if (
      !isRecord(value.appServer) ||
      typeof value.appServer.pid !== "number" ||
      !Number.isSafeInteger(value.appServer.pid) ||
      value.appServer.pid <= 0 ||
      typeof value.appServer.startedAtMs !== "number" ||
      !Number.isFinite(value.appServer.startedAtMs) ||
      typeof value.appServer.executablePath !== "string" ||
      !pathIsAbsolute(value.appServer.executablePath, hostPlatform)
    ) {
      return null;
    }
    appServer = {
      executablePath: value.appServer.executablePath,
      pid: value.appServer.pid,
      startedAtMs: value.appServer.startedAtMs,
      ...(typeof value.appServer.executableFileId === "string" ? { executableFileId: value.appServer.executableFileId } : {}),
    };
  }
  return {
    appServer,
    executablePath: value.executablePath,
    path,
    pid: value.pid,
    raw,
    startedAtMs: value.startedAtMs,
    version: value.version,
    ...(typeof value.retainUntilMs === "number" ? { retainUntilMs: value.retainUntilMs } : {}),
  };
}

function pathIsAbsolute(path: string, hostPlatform: NodeJS.Platform): boolean {
  if (hostPlatform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  }
  return isAbsolute(path);
}

function identitiesMatch(
  expected: ProcessIdentity,
  actual: ProcessIdentity | undefined,
  hostPlatform: NodeJS.Platform,
): boolean {
  return processIdentitiesMatch(expected, actual, hostPlatform, PROCESS_START_TOLERANCE_MS);
}

async function readCandidates(
  directory: string,
  hostPlatform: NodeJS.Platform,
): Promise<StaleSessionCandidate[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const candidates: StaleSessionCandidate[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    const path = join(directory, name);
    try {
      const raw = await readFile(path, "utf8");
      const candidate = parseCandidate(raw, path, hostPlatform);
      if (candidate) {
        candidates.push(candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return candidates;
}

async function findLegacyLinuxAppServers(
  upstreamTokenPath: string,
): Promise<ProcessIdentity[]> {
  const names = await readdir("/proc");
  const pids: number[] = [];
  await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        const pid = Number.parseInt(name, 10);
        try {
          const raw = await readFile(`/proc/${name}/cmdline`);
          const args = raw
            .toString("utf8")
            .split("\0")
            .filter((argument) => argument.length > 0);
          const tokenIndex = args.indexOf("--ws-token-file");
          const listenIndex = args.indexOf("--listen");
          if (
            args.includes("app-server") &&
            tokenIndex >= 0 &&
            args[tokenIndex + 1] === upstreamTokenPath &&
            listenIndex >= 0 &&
            /^ws:\/\/127\.0\.0\.1:\d+$/.test(args[listenIndex + 1] ?? "")
          ) {
            pids.push(pid);
          }
        } catch {
          // Processes may exit or deny inspection while /proc is being scanned.
        }
      }),
  );
  return [...(await inspectProcessIdentities(pids, "linux")).values()];
}

async function terminateMatchingProcess(
  expected: ProcessIdentity,
  hostPlatform: NodeJS.Platform,
  inspectProcesses: ProcessIdentityInspector,
  isProcessAlive: (pid: number) => boolean,
  terminateProcess: (pid: number, signal: NodeJS.Signals) => void,
  wait: (delayMs: number) => Promise<void>,
): Promise<{ stopped: boolean; terminated: boolean }> {
  const current = (await inspectProcesses([expected.pid])).get(expected.pid);
  if (!current) {
    return { stopped: !isProcessAlive(expected.pid), terminated: false };
  }
  if (!identitiesMatch(expected, current, hostPlatform)) {
    if (expected.pid === current.pid && Math.abs(expected.startedAtMs - current.startedAtMs) <= PROCESS_START_TOLERANCE_MS) {
      // A moved/deleted legacy image can still own threads. Preserve its journal for attested handoff.
      return { stopped: false, terminated: false };
    }
    return { stopped: true, terminated: false };
  }
  try {
    terminateProcess(expected.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { stopped: true, terminated: false };
    }
    throw error;
  }
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(TERMINATION_POLL_MS);
    const observed = (await inspectProcesses([expected.pid])).get(expected.pid);
    if (!observed && isProcessAlive(expected.pid)) {
      continue;
    }
    if (!identitiesMatch(expected, observed, hostPlatform)) {
      return { stopped: true, terminated: true };
    }
  }
  return { stopped: false, terminated: true };
}

async function removeSessionFilesIfUnchanged(
  candidate: StaleSessionCandidate,
  directory: string,
): Promise<boolean> {
  const quarantinePath = `${candidate.path}.${randomBytes(6).toString("hex")}.stale`;
  try {
    await rename(candidate.path, quarantinePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const quarantined = await readFile(quarantinePath, "utf8");
    if (quarantined !== candidate.raw) {
      try {
        await writeFile(candidate.path, quarantined, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      await rm(quarantinePath, { force: true });
      return false;
    }
    await Promise.all([
      rm(quarantinePath, { force: true }),
      rm(join(directory, `${candidate.pid}.token`), { force: true }),
      rm(join(directory, `${candidate.pid}.upstream.token`), { force: true }),
    ]);
    return true;
  } catch (error) {
    await rename(quarantinePath, candidate.path).catch(() => undefined);
    throw error;
  }
}

export async function cleanupStaleOfficialAppServers(
  options: StaleAppServerCleanupOptions = {},
): Promise<StaleAppServerCleanupSummary> {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const summary: StaleAppServerCleanupSummary = {
    failedPids: [],
    inspectedCount: 0,
    removedCount: 0,
    staleCount: 0,
    terminatedPids: [],
  };
  if (hostPlatform !== "linux") {
    return summary;
  }
  const directory = options.directory ?? bridgeExternalCliDir();
  const inspectProcesses = options.inspectProcesses ?? inspectProcessIdentities;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const terminateProcess =
    options.terminateProcess ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });
  const wait =
    options.wait ??
    (async (delayMs: number) =>
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs)));
  const findLegacyAppServers =
    options.findLegacyAppServers ?? findLegacyLinuxAppServers;
  const candidates = await readCandidates(directory, hostPlatform);
  summary.inspectedCount = candidates.length;
  if (candidates.length === 0) {
    return summary;
  }
  const shimIdentities = await inspectProcesses(candidates.map(({ pid }) => pid));
  for (const candidate of candidates) {
    const expectedShim: ProcessIdentity = {
      executablePath: candidate.executablePath,
      pid: candidate.pid,
      startedAtMs: candidate.startedAtMs,
    };
    const shimIdentity = shimIdentities.get(candidate.pid);
    if (identitiesMatch(expectedShim, shimIdentity, hostPlatform)) {
      continue;
    }
    if (!shimIdentity && isProcessAlive(candidate.pid)) {
      continue;
    }
    if (candidate.retainUntilMs && candidate.retainUntilMs > Date.now()) continue;
    // A pending handoff or a running/unknown thread is not abandoned work.
    const claimPath = candidate.appServer ? join(directory, `app-server-${candidate.appServer.pid}.claim`) : `${candidate.path}.claim`;
    const claim = await open(claimPath, "wx", 0o600).catch(() => null);
    if (!claim) continue;
    try {
    await claim.writeFile(JSON.stringify({ pid: process.pid }));
    if (await readFile(candidate.path, "utf8").catch(() => "") !== candidate.raw) continue;
    if (candidate.appServer) {
      const owners = (await readCandidates(directory, hostPlatform)).filter((other) =>
        other.pid !== candidate.pid && other.appServer?.pid === candidate.appServer?.pid);
      const identities = await inspectProcesses(owners.map((owner) => owner.pid));
      if (owners.some((owner) => identitiesMatch({ pid: owner.pid, executablePath: owner.executablePath,
        startedAtMs: owner.startedAtMs }, identities.get(owner.pid), hostPlatform) || isProcessAlive(owner.pid))) continue;
    }
    const canRetire = options.canRetireAppServer ?? (async () => {
      try {
        if (candidate.appServer && !isProcessAlive(candidate.appServer.pid)) return true;
        const value = JSON.parse(candidate.raw) as Record<string, unknown>;
        const upstream = await managedUpstream(directory, candidate.pid, value);
        return await probeManagedAppServerIdle(upstream.endpoint, upstream.token);
      } catch { return false; }
    });
    if (!(await canRetire(candidate.path))) continue;
    summary.staleCount += 1;
    let appServers = candidate.appServer ? [candidate.appServer] : [];
    if (candidate.version === 2) {
      appServers = await findLegacyAppServers(
        resolve(directory, `${candidate.pid}.upstream.token`),
      );
    }
    let stopped = true;
    for (const appServer of appServers) {
      try {
        const termination = await terminateMatchingProcess(
          appServer,
          hostPlatform,
          inspectProcesses,
          isProcessAlive,
          terminateProcess,
          wait,
        );
        if (termination.terminated) {
          summary.terminatedPids.push(appServer.pid);
        }
        if (!termination.stopped) {
          stopped = false;
          summary.failedPids.push(appServer.pid);
        }
      } catch {
        stopped = false;
        summary.failedPids.push(appServer.pid);
      }
    }
    if (stopped && (await removeSessionFilesIfUnchanged(candidate, directory))) {
      summary.removedCount += 1;
    }
    } finally { await claim.close(); await rm(claimPath, { force: true }); }
  }
  return summary;
}
