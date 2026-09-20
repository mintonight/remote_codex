import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  inspectProcessIdentities,
  type ProcessIdentity,
} from "../src/shim/process-identity.js";
import { saveLocalWorkspaceContext } from "../src/core/local-workspace-context.js";

const executable = process.env.CODEX_BRIDGE_TEST_CODEX_EXECUTABLE;

describe.skipIf(!executable || process.platform !== "linux")(
  "official binary session handoff",
  () => {
    it("retains two persisted threads through a real Shim restart without a second writer", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "codex-official-handoff-"),
      );
      const home = join(directory, "codex-home");
      await mkdir(home);
      await mkdir(join(directory, "launcher-home"));
      await saveLocalWorkspaceContext(
        join(directory, "window-context.json"),
        directory,
      );
      const runner = join(directory, "runner.cjs");
      await build({
        stdin: {
          contents: `
        import { SharedAppServer } from ${JSON.stringify(resolve("src/shim/shared-app-server.ts"))};
        const root = process.env.RECOVERY_TEST_ROOT;
        new SharedAppServer({ appServerArgs: ["app-server"], appServerCwd: root + "/launcher-home",
          auditPath: root + "/audit.jsonl", codexExecutable: process.env.CODEX_BRIDGE_TEST_CODEX_EXECUTABLE,
          config: null, controlDir: root, localWorkspaceContextPath: root + "/window-context.json", persistentSession: true
        }).run().then(code => { process.exitCode = code; }, error => { console.error(String(error)); process.exitCode = 1; });
      `,
          resolveDir: process.cwd(),
          loader: "ts",
        },
        outfile: runner,
        bundle: true,
        platform: "node",
        format: "cjs",
      });
      const shims: ChildProcessWithoutNullStreams[] = [];
      let identity: ProcessIdentity | undefined;
      const launch = () => {
        const child = spawn(process.execPath, [runner], {
          env: {
            ...process.env,
            CODEX_HOME: home,
            CODEX_BRIDGE_STATE_DIR: directory,
            RECOVERY_TEST_ROOT: directory,
            CODEX_BRIDGE_TEST_CODEX_EXECUTABLE: executable!,
          },
          stdio: "pipe",
        });
        shims.push(child);
        const messages: Array<Record<string, unknown>> = [];
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += String(chunk);
          for (;;) {
            const end = buffer.indexOf("\n");
            if (end < 0) break;
            messages.push(
              JSON.parse(buffer.slice(0, end)) as Record<string, unknown>,
            );
            buffer = buffer.slice(end + 1);
          }
        });
        child.stderr.resume();
        const exited = new Promise<number | null>((resolvePromise) =>
          child.once("exit", (code) => resolvePromise(code)),
        );
        const send = (message: unknown) =>
          child.stdin.write(JSON.stringify(message) + "\n");
        const response = async (id: number) => {
          for (let attempts = 0; attempts < 600; attempts += 1) {
            const message = messages.find((message) => message.id === id);
            if (message) {
              expect(message.error).toBeUndefined();
              return message.result as Record<string, unknown>;
            }
            if (child.exitCode !== null)
              throw new Error(`Probe Shim exited: ${child.exitCode}`);
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 25),
            );
          }
          throw new Error(`Official probe request ${id} timed out`);
        };
        return { child, messages, send, response, exited };
      };
      const initialize = async (client: ReturnType<typeof launch>) => {
        client.send({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "bridge_lifecycle_test", version: "1" },
            capabilities: { experimentalApi: true },
          },
        });
        await client.response(1);
        client.send({ method: "initialized", params: {} });
      };
      try {
        const first = launch();
        await initialize(first);
        first.send({
          id: 2,
          method: "thread/start",
          params: { cwd: directory },
        });
        const a = (await first.response(2)).thread as { id: string };
        first.send({
          id: 3,
          method: "thread/start",
          params: { cwd: directory },
        });
        const b = (await first.response(3)).thread as { id: string };
        expect(a.id).not.toBe(b.id);
        for (const [id, thread] of [
          [6, a],
          [7, b],
        ] as const) {
          first.send({
            id,
            method: "thread/inject_items",
            params: {
              threadId: thread.id,
              items: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "Offline lifecycle fixture; no turn requested.",
                    },
                  ],
                },
              ],
            },
          });
          await first.response(id);
        }
        first.send({ id: 4, method: "thread/loaded/list", params: {} });
        expect((await first.response(4)).data).toEqual(
          expect.arrayContaining([a.id, b.id]),
        );
        const descriptorPath = join(
          directory,
          "external-cli",
          `${first.child.pid}.json`,
        );
        const before = JSON.parse(await readFile(descriptorPath, "utf8")) as {
          appServer: ProcessIdentity;
        };
        identity = before.appServer;
        first.child.stdin.end();
        expect(await first.exited).toBe(0);
        expect(
          (await inspectProcessIdentities([identity.pid])).get(identity.pid),
        ).toBeDefined();
        const second = launch();
        await initialize(second);
        second.send({ id: 4, method: "thread/loaded/list", params: {} });
        expect((await second.response(4)).data).toEqual(
          expect.arrayContaining([a.id, b.id]),
        );
        second.send({
          id: 5,
          method: "thread/resume",
          params: { threadId: a.id },
        });
        expect((await second.response(5)).thread).toMatchObject({ id: a.id });
        const after = JSON.parse(
          await readFile(
            join(directory, "external-cli", `${second.child.pid}.json`),
            "utf8",
          ),
        ) as { appServer: ProcessIdentity };
        expect(after.appServer).toEqual(identity);
        second.child.stdin.end();
        expect(await second.exited).toBe(0);
      } finally {
        for (const child of shims) {
          child.stdin.destroy();
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        if (identity) {
          const current = (await inspectProcessIdentities([identity.pid])).get(
            identity.pid,
          );
          if (
            current?.startedAtMs === identity.startedAtMs &&
            current.executablePath === identity.executablePath
          )
            process.kill(identity.pid, "SIGTERM");
          for (
            let attempt = 0;
            attempt < 100 &&
            (await inspectProcessIdentities([identity.pid])).has(identity.pid);
            attempt += 1
          )
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 25),
            );
          const remaining = (
            await inspectProcessIdentities([identity.pid])
          ).get(identity.pid);
          if (
            remaining?.startedAtMs === identity.startedAtMs &&
            remaining.executablePath === identity.executablePath
          )
            process.kill(identity.pid, "SIGKILL");
        }
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
