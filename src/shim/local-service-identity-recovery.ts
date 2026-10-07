import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { parseDescriptor } from "./external-session-registry.js";
import { inspectProcessIdentities, processIdentitiesMatch, type ProcessIdentity } from "./process-identity.js";
import { RequestCallbackQueue } from "./request-callback-queue.js";
import { isRecord, parseRpcLine } from "./rpc.js";
import type { ExternalCliSessionDescriptor } from "./shared-app-server.js";

function executableMatches(expected: { executableFileId?: string }, actual: ProcessIdentity | undefined): boolean {
  return actual !== undefined && /^\d+:\d+$/.test(expected.executableFileId ?? "") &&
    expected.executableFileId === actual.executableFileId;
}

async function ownsListener(pid: number, endpoint: string): Promise<boolean> {
  const port = Number(new URL(endpoint).port).toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set((await readFile("/proc/net/tcp", "utf8")).trim().split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === `0100007F:${port}` && fields[3] === "0A")
    .map((fields) => `socket:[${fields[9]}]`));
  if (!inodes.size) return false;
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    if (inodes.has(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""))) return true;
  }
  return false;
}

async function authenticatedStatus(descriptor: ExternalCliSessionDescriptor): Promise<unknown> {
  const token = await readFile(descriptor.tokenPath, "utf8");
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const requests = new RequestCallbackQueue();
  const socket = new WebSocket(descriptor.endpoint, {
    headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 3_000, maxPayload: 16 * 1024 * 1024,
  });
  socket.on("error", () => requests.close());
  socket.on("close", () => requests.close());
  socket.on("message", (raw) => {
    try { requests.receive(parseRpcLine(raw.toString())); }
    catch { socket.terminate(); }
  });
  const send = (message: unknown): void => { socket.send(JSON.stringify(message)); };
  try {
    await new Promise<void>((done, reject) => {
      socket.once("open", done);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Identity probe disconnected")));
    });
    const initialized = await requests.request({ id: "identity-init", method: "initialize", params: {
      clientInfo: { name: "bridge_local_identity_probe", version: "1" }, capabilities: { experimentalApi: true },
    } }, send, 3_000);
    if (initialized.error) return null;
    send({ method: "initialized" });
    const status = await requests.request({ id: "identity-status", method: "bridge/service/status" }, send, 3_000);
    return status.error ? null : status.result;
  } finally {
    requests.close();
    socket.terminate();
  }
}

// Wall-clock corrections can invalidate old epoch timestamps. This fallback is
// only for attaching to a live, authenticated local service, never for killing
// processes or taking over an orphan. Keep those identity gates unchanged.
export async function recoverLiveLocalService(
  value: unknown,
  directory: string,
  codexHome: string,
): Promise<ExternalCliSessionDescriptor | null> {
  if (process.platform !== "linux") return null;
  try {
    const descriptor = parseDescriptor(value, directory, process.platform);
    const native = descriptor.appServer;
    if (descriptor.host !== "local" || !descriptor.serviceKey || descriptor.lifecycle !== "ready" || !native) return null;
    const home = await realpath(codexHome).catch(() => resolve(codexHome));
    if (descriptor.codexHome && await realpath(descriptor.codexHome).catch(() => resolve(descriptor.codexHome!)) !== home) return null;
    const environment = (await readFile(`/proc/${native.pid}/environ`, "utf8")).split("\0");
    const nativeHome = environment.find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) ?? join(homedir(), ".codex");
    if (await realpath(nativeHome).catch(() => resolve(nativeHome)) !== home) return null;
    const before = await inspectProcessIdentities([descriptor.pid, native.pid]);
    if (!executableMatches(descriptor, before.get(descriptor.pid)) || !executableMatches(native, before.get(native.pid))) return null;
    if (!await ownsListener(descriptor.pid, descriptor.endpoint)) return null;
    const status = await authenticatedStatus(descriptor);
    if (!isRecord(status) || status.pid !== descriptor.pid || status.appServerPid !== native.pid) return null;
    const after = await inspectProcessIdentities([descriptor.pid, native.pid]);
    if (!processIdentitiesMatch(before.get(descriptor.pid)!, after.get(descriptor.pid)) ||
        !processIdentitiesMatch(before.get(native.pid)!, after.get(native.pid)) ||
        !await ownsListener(descriptor.pid, descriptor.endpoint)) return null;
    return descriptor;
  } catch {
    return null;
  }
}
