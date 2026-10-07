import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { discoverExternalCliSessions } from "../src/shim/external-session-registry.js";
import { recoverLiveLocalService } from "../src/shim/local-service-identity-recovery.js";
import { inspectProcessIdentities, processIdentitiesMatch } from "../src/shim/process-identity.js";
import type { ExternalCliSessionDescriptor } from "../src/shim/shared-app-server.js";
import { localServicesInDomain } from "../src/shim/unified-local-client.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-clock-recovery-"));
  const identity = (await inspectProcessIdentities([process.pid])).get(process.pid)!;
  const environment = (await readFile(`/proc/${process.pid}/environ`, "utf8")).split("\0");
  const home = environment.find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) ?? join(homedir(), ".codex");
  const methods: string[] = [];
  let status: unknown = { pid: process.pid, appServerPid: process.pid };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0,
    verifyClient: ({ req }, done) => done(req.headers.authorization === "Bearer fixture-capability", 401) });
  await once(server, "listening");
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    methods.push(message.method);
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "bridge/service/status") socket.send(JSON.stringify(status === null
      ? { id: message.id, error: { code: -32601, message: "Unsupported method" } }
      : { id: message.id, result: status }));
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  const descriptor: ExternalCliSessionDescriptor = {
    ...identity, startedAtMs: identity.startedAtMs - 60_000,
    appServer: { ...identity, startedAtMs: identity.startedAtMs - 60_000 },
    version: 3, host: "local", codexHome: home, workspaceRoot: homedir(), lifecycle: "ready",
    serviceKey: "a".repeat(64), serviceScope: "user", endpoint: `ws://127.0.0.1:${address.port}`,
    tokenPath: join(directory, `${process.pid}.token`), tokenEnv: "CODEX_BRIDGE_EXTERNAL_SESSION_TOKEN",
  };
  await writeFile(descriptor.tokenPath, "fixture-capability", { mode: 0o600 });
  return { directory, identity, home, descriptor, methods, setStatus: (value: unknown) => { status = value; },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    } };
}

describe.runIf(process.platform === "linux")("live local service clock-drift recovery", () => {
  it("recovers through listener ownership and authentication without loosening the process identity gate", async () => {
    const f = await fixture();
    try {
      expect(processIdentitiesMatch(f.descriptor as typeof f.identity, f.identity)).toBe(false);
      expect(await recoverLiveLocalService(f.descriptor, f.directory, f.home)).toEqual(f.descriptor);
      expect(f.methods).toEqual(["initialize", "initialized", "bridge/service/status"]);
      expect(processIdentitiesMatch(f.descriptor as typeof f.identity, f.identity)).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["lifecycle", "serviceKey", "executable", "nativeExecutable", "declaredHome", "actualHome", "tokenPath"])(
    "rejects an unverified %s before contacting the service", async (kind) => {
      const f = await fixture();
      try {
        const value = structuredClone(f.descriptor);
        if (kind === "lifecycle") value.lifecycle = "stopping";
        if (kind === "serviceKey") delete value.serviceKey;
        if (kind === "executable") value.executableFileId = "0:1";
        if (kind === "nativeExecutable") value.appServer!.executableFileId = "0:1";
        if (kind === "declaredHome") value.codexHome = f.directory;
        if (kind === "actualHome") value.codexHome = f.directory;
        if (kind === "tokenPath") value.tokenPath = join(f.directory, "unrelated.token");
        expect(await recoverLiveLocalService(value, f.directory, kind === "actualHome" ? f.directory : f.home)).toBeNull();
        expect(f.methods).toEqual([]);
      } finally { await f.close(); }
    },
  );

  it.each(["authentication", "pid", "nativePid", "unsupportedStatus", "malformedStatus"])(
    "rejects failed %s verification", async (kind) => {
      const f = await fixture();
      try {
        if (kind === "authentication") await writeFile(f.descriptor.tokenPath, "wrong-capability");
        if (kind === "pid") f.setStatus({ pid: process.pid + 1, appServerPid: process.pid });
        if (kind === "nativePid") f.setStatus({ pid: process.pid, appServerPid: process.pid + 1 });
        if (kind === "unsupportedStatus") f.setStatus(null);
        if (kind === "malformedStatus") f.setStatus({ ready: true });
        expect(await recoverLiveLocalService(f.descriptor, f.directory, f.home)).toBeNull();
      } finally { await f.close(); }
    },
  );

  it("rejects a live matching executable that does not own the listener", async () => {
    const f = await fixture();
    const child = spawn("/bin/sleep", ["30"]);
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      const identity = (await inspectProcessIdentities([child.pid!])).get(child.pid!)!;
      const descriptor = { ...f.descriptor, ...identity, tokenPath: join(f.directory, `${child.pid}.token`) };
      expect(await recoverLiveLocalService(descriptor, f.directory, f.home)).toBeNull();
      expect(f.methods).toEqual([]);
    } finally { child.kill("SIGTERM"); await exited; await f.close(); }
  });

  it("includes the recovered service in unified discovery without rewriting its journal", async () => {
    const f = await fixture();
    try {
      vi.stubEnv("CODEX_BRIDGE_STATE_DIR", join(f.directory, "state"));
      vi.stubEnv("CODEX_HOME", f.home);
      const registry = join(process.env.CODEX_BRIDGE_STATE_DIR!, "external-cli");
      await mkdir(registry, { recursive: true });
      const descriptor = { ...f.descriptor, tokenPath: join(registry, `${process.pid}.token`) };
      await writeFile(descriptor.tokenPath, "fixture-capability", { mode: 0o600 });
      const path = join(registry, `${process.pid}.json`);
      const raw = JSON.stringify(descriptor);
      await writeFile(path, raw);
      expect(await discoverExternalCliSessions()).toEqual([]);
      expect(await localServicesInDomain()).toEqual([descriptor]);
      expect(await readFile(path, "utf8")).toBe(raw);
    } finally { vi.unstubAllEnvs(); await f.close(); }
  });
});
