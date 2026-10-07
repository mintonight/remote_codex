import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { inspectProcessIdentities } from "../src/shim/process-identity.js";

describe.skipIf(process.platform !== "linux")("independent local service", () => {
  const scenarios = process.env.CODEX_BRIDGE_TEST_CODEX_EXECUTABLE ? ["fixture", "official"] : ["fixture"];
  it.each(scenarios)("shares one writer through simultaneous startup, client loss and reload (%s)", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "codex-service-test-"));
    const home = join(root, "home");
    await mkdir(home);
    const runner = join(root, "runner.cjs");
    const fake = join(root, "fake.cjs");
    await build({ entryPoints: [resolve("test/fixtures/local-service-app-server.cjs")], outfile: fake, platform: "node", bundle: true });
    await build({ stdin: { contents: `
      import { ensureLocalService, localServiceKey, relayServiceStdio, runLocalServiceWorker, SERVICE_WORKER_ARGUMENT } from ${JSON.stringify(resolve("src/shim/local-app-server-service.ts"))};
      async function run() {
        if (process.argv.includes(SERVICE_WORKER_ARGUMENT)) return await runLocalServiceWorker();
        const root = process.env.SERVICE_TEST_ROOT;
        const official = process.env.SERVICE_TEST_OFFICIAL;
        const args = official ? ["app-server"] : [root + "/fake.cjs", "app-server"];
        const descriptor = await ensureLocalService({ appServerArgs: args, codexExecutable: official || process.execPath,
          workspaceRoot: root, auditPath: root + "/audit.jsonl", serviceKey: await localServiceKey(root, args) });
        return await relayServiceStdio(descriptor);
      }
      run().then(code => process.exitCode = code, error => { console.error(error); process.exitCode = 1; });
    `, resolveDir: process.cwd(), loader: "ts" }, outfile: runner, bundle: true, platform: "node", format: "cjs" });
    const clients: ChildProcessWithoutNullStreams[] = [];
    const launch = (name: string) => {
      const child = spawn(process.execPath, [runner], { env: { ...process.env, CODEX_HOME: home,
        CODEX_BRIDGE_STATE_DIR: root, SERVICE_TEST_ROOT: root,
        SERVICE_TEST_OFFICIAL: scenario === "official" ? process.env.CODEX_BRIDGE_TEST_CODEX_EXECUTABLE : "" }, stdio: "pipe" });
      clients.push(child);
      const messages: any[] = [];
      let buffer = "";
      let errors = "";
      child.stderr.on("data", (data) => { errors += String(data); });
      child.stdout.on("data", (data) => {
        buffer += String(data);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        }
      });
      const exit = new Promise((done) => child.once("exit", done));
      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
      const wait = async (predicate: (m: any) => boolean): Promise<any> => {
        for (let i = 0; i < 1000; i++) {
          const m = messages.find(predicate);
          if (m) return m;
          if (child.exitCode !== null) throw new Error(`Client exited: ${errors}`);
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error(`Timed out: ${errors}`);
      };
      const response = async (id: number) => { const m = await wait((m) => m.id === id); expect(m.error).toBeUndefined(); return m.result; };
      send({ id: 1, method: "initialize", params: { clientInfo: { name, version: "1" }, capabilities: { experimentalApi: true } } });
      return { child, send, wait, response, exit };
    };
    const descriptors = async () => {
      const dir = join(root, "external-cli");
      const names = (await readdir(dir)).filter((n) => /^\d+\.json$/.test(n));
      return await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8"))));
    };
    try {
      const a = launch("client-a");
      const b = launch("client-b");
      const initA = await a.response(1);
      const initB = await b.response(1);
      if (scenario === "fixture") {
        expect(initA.userAgent).toBe("client-a");
        expect(initB.userAgent).toBe("client-b");
      }
      // Deliberately omit initialized: some official UI builds do so.
      const before = await descriptors();
      expect(before).toHaveLength(1);
      expect(before[0].pid).not.toBe(a.child.pid);
      a.send({ id: 2, method: "thread/start", params: { cwd: root } });
      const thread = (await a.response(2)).thread;
      b.send({ id: 2, method: "thread/start", params: { cwd: root } });
      const background = (await b.response(2)).thread;
      if (scenario === "official") {
        for (const [id, t] of [[10, thread], [11, background]] as const) {
          a.send({ id, method: "thread/inject_items", params: { threadId: t.id,
            items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Offline service lifecycle fixture." }] }] } });
          await a.response(id);
        }
        a.child.kill("SIGKILL");
        await a.exit;
        const c = launch("client-c");
        await c.response(1);
        c.send({ id: 2, method: "thread/loaded/list", params: {} });
        expect((await c.response(2)).data).toEqual(expect.arrayContaining([thread.id, background.id]));
        const attached = await descriptors();
        expect(attached[0].pid).toBe(before[0].pid);
        expect(attached[0].appServer).toEqual(before[0].appServer);
        // A worker crash releases flock, but leaves the native writer adoptable.
        process.kill(attached[0].pid, "SIGKILL");
        await c.exit;
        const d = launch("client-d");
        await d.response(1);
        d.send({ id: 2, method: "thread/loaded/list", params: {} });
        expect((await d.response(2)).data).toEqual(expect.arrayContaining([thread.id, background.id]));
        const recovered = await descriptors();
        expect(recovered).toHaveLength(1);
        expect(recovered[0].pid).not.toBe(before[0].pid);
        expect(recovered[0].appServer).toEqual(before[0].appServer);
        return;
      }
      a.send({ id: 3, method: "turn/start", params: { threadId: thread.id, input: [] } });
      const turn = (await a.response(3)).turn;
      b.send({ id: 30, method: "turn/start", params: { threadId: thread.id, input: [] } });
      expect((await b.wait((m) => m.id === 30)).error.message).toBe("Already active");
      b.send({ id: 31, method: "bridge/service/stop", params: {} });
      expect((await b.wait((m) => m.id === 31)).error.message).toContain("refusing shutdown");
      const approval = await b.wait((m) => m.method === "item/commandExecution/requestApproval");
      a.child.kill("SIGKILL");
      await a.exit;
      b.send({ id: 3, method: "turn/steer", params: { threadId: thread.id, expectedTurnId: turn.id, input: [] } });
      expect((await b.response(3)).turnId).toBe(turn.id);
      b.send({ id: 4, method: "thread/queue/add", params: { threadId: thread.id, clientUserMessageId: "next", input: [{ type: "text", text: "next" }] } });
      expect((await b.response(4)).queuedSubmissionId).toBe("queued-1");
      const c = launch("client-c");
      await c.response(1);
      const recovered = await c.wait((m) => m.method === "item/commandExecution/requestApproval");
      expect(recovered.id).toBe(approval.id);
      c.send({ id: recovered.id, result: { decision: "accept" } });
      await b.wait((m) => m.method === "fixture/approvalAnswered");
      c.send({ id: 2, method: "thread/loaded/list", params: {} });
      expect((await c.response(2)).data).toEqual(expect.arrayContaining([thread.id, background.id]));
      c.send({ id: 3, method: "turn/interrupt", params: { threadId: thread.id, turnId: turn.id } });
      await c.response(3);
      await b.wait((m) => m.method === "turn/completed");
      const after = await descriptors();
      expect(after[0].pid).toBe(before[0].pid);
      expect(after[0].appServer).toEqual(before[0].appServer);
      const audit = await readFile(join(root, "audit.jsonl"), "utf8");
      expect(audit).toContain("thread.recovery.cycle");
      expect(audit).toContain('"interruptedTurns":0');
      for (const [id, t] of [[10, thread], [11, background]] as const) {
        c.send({ id, method: "thread/archive", params: { threadId: t.id } });
        await c.response(id);
      }
      b.child.stdin.end();
      await b.exit;
      c.send({ method: "initialized" });
      let stopped = false;
      for (let id = 100; id < 140; id++) {
        c.send({ id, method: "bridge/service/status", params: {} });
        if ((await c.response(id)).canStop) {
          c.send({ id: 200, method: "bridge/service/stop", params: {} });
          await c.response(200);
          stopped = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(stopped).toBe(true);
      await c.exit;
      for (let i = 0; i < 100 && (await descriptors()).length; i++) await new Promise((done) => setTimeout(done, 25));
      expect(await descriptors()).toEqual([]);
    } finally {
      for (const child of clients) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const records = await descriptors().catch(() => []);
      for (const record of records) {
        for (const identity of [record, record.appServer]) {
          if (!identity) continue;
          const actual = (await inspectProcessIdentities([identity.pid])).get(identity.pid);
          if (actual && Math.abs(actual.startedAtMs - identity.startedAtMs) < 2_000) {
            try { process.kill(identity.pid, "SIGKILL"); } catch { /* Already exited. */ }
          }
        }
      }
      await new Promise((done) => setTimeout(done, 200));
      await rm(root, { force: true, recursive: true });
    }
  }, 45_000);
});
