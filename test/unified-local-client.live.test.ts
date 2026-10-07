import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { inspectProcessIdentities } from "../src/shim/process-identity.js";

const executable = process.env.CODEX_BRIDGE_TEST_CODEX_EXECUTABLE;

describe.skipIf(!executable || process.platform !== "linux")("official cross-client callback routing", () => {
  it("shares two existing writers across projects and controls a real shell turn after desktop detach", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-unified-live-"));
    for (const name of ["home", "project-a", "project-b"]) await mkdir(join(root, name));
    const runner = join(root, "runner.cjs");
    const mcp = join(root, "mcp.cjs");
    await build({ stdin: { contents: `
      const readline = require("node:readline");
      readline.createInterface({input:process.stdin}).on("line", line => {
        const m = JSON.parse(line); if(m.id === undefined) return;
        const result = m.method === "initialize" ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}} : m.method === "tools/list" ? {tools:[]} : {};
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
      });
    `, loader: "js" }, outfile: mcp, platform: "node" });
    await build({ stdin: { contents: `
      import { SharedAppServer } from ${JSON.stringify(resolve("src/shim/shared-app-server.ts"))};
      import { runUnifiedLocalClient } from ${JSON.stringify(resolve("src/shim/unified-local-client.ts"))};
      const root = process.env.TEST_ROOT, role = process.env.TEST_ROLE;
      const executable = process.env.CODEX_BRIDGE_TEST_CODEX_EXECUTABLE;
      const workspace = root + "/project-" + (role.endsWith("b") ? "b" : "a");
      const desktopConfig = "mcp_servers.codex_app=" + '{command=' + JSON.stringify(process.execPath) + ',args=[' + JSON.stringify(root + "/mcp.cjs") + '],required=true}';
      const task = role.startsWith("server") ? new SharedAppServer({appServerArgs:["app-server"], codexExecutable:executable,
        auditPath:root+"/audit.jsonl", config:null, controlDir:workspace, appServerCwd:workspace,
        localWorkspaceRoot:workspace, persistentSession:true, serviceKey:(role.endsWith("b")?"b":"a").repeat(64)}).run()
        : runUnifiedLocalClient({appServerArgs:role === "desktop" ? ["app-server","-c",desktopConfig] : ["app-server"],
          codexExecutable:executable,auditPath:root+"/audit.jsonl",clientKind:role === "desktop" ? "desktop":"vscode",
          ...(role === "vscode" ? {workspaceRoot:workspace} : {})});
      task.then(code=>process.exitCode=code,error=>{console.error(error);process.exitCode=1});
    `, resolveDir: process.cwd(), loader: "ts" }, outfile: runner, bundle: true, format: "cjs", platform: "node" });
    const children: ChildProcessWithoutNullStreams[] = [];
    const launch = (role: string) => {
      const child = spawn(process.execPath, [runner], { env: { ...process.env, TEST_ROOT: root, TEST_ROLE: role,
        CODEX_HOME: join(root, "home"), CODEX_BRIDGE_STATE_DIR: root }, stdio: "pipe" });
      children.push(child);
      let buffer = "", stderr = ""; const messages: any[] = [];
      child.stderr.on("data", (data) => { stderr += String(data); });
      child.stdout.on("data", (data) => { buffer += String(data); let end: number; while ((end = buffer.indexOf("\n")) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
      const exited = new Promise((done) => child.once("exit", done));
      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
      const wait = async (test: (m: any) => boolean) => {
        for (let i = 0; i < 600; i++) { const m = messages.find(test); if (m) return m;
          if (child.exitCode !== null) throw new Error(`Client exited: ${stderr}`);
          await new Promise((done) => setTimeout(done, 25)); }
        throw new Error(`Response timeout (${role}): ${stderr}`);
      };
      const response = async (id: number) => { const m = await wait((m) => m.id === id); expect(m.error).toBeUndefined(); return m.result; };
      send({ id: 1, method: "initialize", params: { clientInfo: { name: `bridge_${role}`, version: "1" }, capabilities: { experimentalApi: true } } });
      return { child, send, response, wait, exited };
    };
    try {
      const a = launch("server-a");
      await a.response(1);
      const b = launch("server-b");
      await b.response(1);
      a.send({ method: "initialized" }); b.send({ method: "initialized" });
      a.send({ id: 2, method: "thread/start", params: { cwd: join(root, "project-a") } });
      b.send({ id: 2, method: "thread/start", params: { cwd: join(root, "project-b") } });
      const ta = (await a.response(2)).thread, tb = (await b.response(2)).thread;
      for (const [client, thread] of [[a, ta], [b, tb]] as const) {
        client.send({ id: 3, method: "thread/inject_items", params: { threadId: thread.id,
          items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Offline cross-client fixture." }] }] } });
        await client.response(3);
      }
      const desktop = launch("desktop"), vscode = launch("vscode");
      await desktop.response(1); await vscode.response(1);
      for (const [id, thread] of [[2, ta], [3, tb]] as const) {
        desktop.send({ id, method: "thread/resume", params: { threadId: thread.id, excludeTurns: true } });
        expect((await desktop.response(id)).thread.id).toBe(thread.id);
      }
      desktop.send({ id: 4, method: "thread/loaded/list", params: {} });
      expect((await desktop.response(4)).data).toEqual(expect.arrayContaining([ta.id, tb.id]));
      desktop.send({ id: 5, method: "thread/start", params: { cwd: join(root, "project-b") } });
      const tc = (await desktop.response(5)).thread;
      desktop.send({ id: 8, method: "mcpServerStatus/list", params: { threadId: tc.id } });
      expect((await desktop.response(8)).data.some((server: { name: string }) => server.name === "codex_app")).toBe(true);
      desktop.send({ id: 6, method: "thread/shellCommand", params: { threadId: tc.id, command: "sleep 20", timeoutMs: 25_000 } });
      await desktop.response(6);
      const started = await desktop.wait((m) => m.method === "turn/started" && m.params.threadId === tc.id);
      desktop.child.stdin.end(); expect(await desktop.exited).toBe(0);
      vscode.send({ id: 2, method: "thread/resume", params: { threadId: tc.id, excludeTurns: true } });
      expect((await vscode.response(2)).thread.status.type).toBe("active");
      vscode.send({ id: 3, method: "turn/interrupt", params: { threadId: tc.id, turnId: started.params.turn.id } });
      await vscode.response(3);
      await vscode.wait((m) => m.method === "turn/completed" && m.params.threadId === tc.id);
      const records = (await readdir(join(root, "external-cli"))).filter((name) => /^\d+\.json$/.test(name));
      expect(records).toHaveLength(2); // No third competing native backend.
    } finally {
      for (const child of children) { child.stdin.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
      for (const name of await readdir(join(root, "external-cli")).catch(() => [] as string[])) {
        if (!/^\d+\.json$/.test(name)) continue;
        const record = JSON.parse(await readFile(join(root, "external-cli", name), "utf8"));
        const expected = record.appServer;
        if (!expected) continue;
        const actual = (await inspectProcessIdentities([expected.pid])).get(expected.pid);
        if (actual && Math.abs(actual.startedAtMs - expected.startedAtMs) < 2_000) try { process.kill(actual.pid, "SIGTERM"); } catch { /* Exited. */ }
      }
      await new Promise((done) => setTimeout(done, 500));
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
