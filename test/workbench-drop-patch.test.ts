import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { inspectWorkbenchDropSource } from "../src/extension/workbench-drop-patch.js";

const SOURCE = [
  'var la=class extends Base{constructor(e){super(e);this.element={dataset:{}};this.id=e.id,this._title=e.title}};',
  'var Close=class extends Action{constructor(e,t,i){super(e,t);this.commandService=i}static{this.ID="workbench.action.closeActiveEditor"}run(){}};Close=decorate([param(2,commandService)],Close);',
  'var Final=class extends Disposable{constructor(){super()}static{this.ID="workbench.contrib.systemWideKeybindings"}sync(){}};Final=decorate([param(0,nativeHost)],Final);register(Final.ID,Final,Lifecycle.AfterRestored);',
  'export{mainValue as main};',
].join("");
const execFileAsync = promisify(execFile);

type DragListener = (event: Record<string, unknown>) => void;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  textContent = "";
  paneBody?: FakeElement;

  constructor(
    readonly rect = { bottom: 900, height: 800, left: 1200, right: 2000, top: 100, width: 800 },
  ) {}

  closest(): FakeElement | null {
    return this.dataset.codexBridgeViewId ? this : null;
  }

  contains(candidate: unknown): boolean {
    return candidate === this || candidate === this.paneBody;
  }

  getBoundingClientRect(): typeof this.rect {
    return this.rect;
  }

  querySelector(selector: string): FakeElement | null {
    return selector === ".pane-body" ? (this.paneBody ?? null) : null;
  }

  setAttribute(): void {}
}

function contributionFixture(connected = true): {
  commandService: { executeCommand: ReturnType<typeof vi.fn> };
  document: {
    body: { appendChild: ReturnType<typeof vi.fn> };
    createElement: () => FakeElement;
    elementFromPoint: () => FakeElement | null;
    listeners: Map<string, DragListener>;
    querySelectorAll: () => FakeElement[];
  };
  instance: { overlay?: FakeElement; readyUntil: number; peer: { postMessage: ReturnType<typeof vi.fn> } };
  peer: { postMessage: ReturnType<typeof vi.fn> };
  pane: FakeElement;
  window: { listeners: Map<string, DragListener> };
} {
  const inspected = inspectWorkbenchDropSource(SOURCE);
  if (inspected.status !== "patchable") {
    throw new Error("fixture Workbench source is not patchable");
  }
  const prefix = "var CodexRemoteBridgeWorkbenchDrop=";
  const start = inspected.patchedSource.indexOf(prefix);
  const end = inspected.patchedSource.indexOf("\n};", start);
  if (start < 0 || end < 0) {
    throw new Error("generated Workbench contribution was not found");
  }
  const expression = inspected.patchedSource.slice(start + prefix.length, end + 2);
  const listeners = new Map<string, DragListener>();
  const windowListeners = new Map<string, DragListener>();
  const pane = new FakeElement();
  pane.dataset.codexBridgeViewId = "chatgpt.sidebarSecondaryView";
  pane.paneBody = new FakeElement(pane.rect);
  let pointElement: FakeElement | null = pane;
  const document = {
    addEventListener: (name: string, listener: DragListener) => listeners.set(name, listener),
    body: { appendChild: vi.fn() },
    createElement: () => new FakeElement(),
    elementFromPoint: () => pointElement,
    listeners,
    querySelectorAll: () => [pane],
  };
  const window = {
    addEventListener: (name: string, listener: DragListener) =>
      windowListeners.set(name, listener),
    listeners: windowListeners,
  };
  const createContribution = new Function(
    "document",
    "window",
    "HTMLElement",
    "Element",
    "Node",
    "console",
    `return (${expression});`,
  ) as (
    documentValue: typeof document,
    windowValue: typeof window,
    htmlElement: typeof FakeElement,
    element: typeof FakeElement,
    node: typeof FakeElement,
    consoleValue: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> },
  ) => new (service: { executeCommand: ReturnType<typeof vi.fn> }) => {
    overlay?: FakeElement;
    readyUntil: number;
    peer: { postMessage: ReturnType<typeof vi.fn> };
  };
  const Contribution = createContribution(
    document,
    window,
    FakeElement,
    FakeElement,
    FakeElement,
    { error: vi.fn(), info: vi.fn() },
  );
  const commandService = { executeCommand: vi.fn() };
  const instance = new Contribution(commandService);
  const peer = { postMessage: vi.fn() };
  instance.peer = peer;
  instance.readyUntil = connected ? Date.now() + 1500 : 0;
  pointElement = pane;
  return { commandService, document, instance, peer, pane, window };
}

describe("managed Workbench Codex drop patch", () => {
  it("adds a Codex ViewPane identity and one managed contribution", () => {
    const inspected = inspectWorkbenchDropSource(SOURCE);
    expect(inspected.status).toBe("patchable");
    if (inspected.status !== "patchable") {
      return;
    }
    expect(inspected.patchedSource).toContain(
      "this.element.dataset.codexBridgeViewId=this.id",
    );
    expect(inspected.patchedSource).toContain(
      'executeCommand("codexRemoteBridge.acceptWorkbenchDrop",e)',
    );
    expect(inspected.patchedSource).toContain(
      'window.addEventListener("message",t=>this.onWebviewMessage(t),!0)',
    );
    expect(inspected.patchedSource).toContain(
      't.channel!=="codex-remote-bridge-webview-drop-v1"',
    );
    expect(inspected.patchedSource).toContain("pointer-events:auto");
    expect(inspected.patchedSource).toContain(
      'document.addEventListener("dragleave",t=>this.onDragLeave(t),!0)',
    );
    expect(inspected.patchedSource).toContain(
      "onDragOver(e){let t=this.paneFromEvent(e);",
    );
    expect(inspected.patchedSource).toContain(
      "candidate(e){return!!e&&(this.supported(e)||this.types(e).length===0)}",
    );
    expect(inspected.patchedSource).toContain(
      'this.refreshPeer();if(!this.ready()){this.hide();return}',
    );
    expect(inspected.patchedSource).toContain(
      'if(!t||!this.candidate(e.dataTransfer))return;this.show(t);this.accept(e)}',
    );
    expect(inspected.patchedSource).toContain(
      "i===this.overlay&&this.activePane",
    );
    expect(inspected.patchedSource).toContain("document.elementFromPoint?.(o,a)");
    expect(inspected.patchedSource).not.toContain(
      "e.dataTransfer.dropEffect=\"copy\");this.hideSoon()",
    );
    expect(inspected.patchedSource).toContain(
      "onDrop(e){let t=this.paneFromEvent(e),i=t?this.payload(e):void 0;",
    );
    expect(inspected.patchedSource).toContain(
      'if(!this.ready()||!t||!i){this.hide();return}this.accept(e)',
    );
    expect(inspected.patchedSource).toContain(
      "register(CodexRemoteBridgeWorkbenchDrop.ID,CodexRemoteBridgeWorkbenchDrop,Lifecycle.AfterRestored)",
    );
    expect(inspectWorkbenchDropSource(inspected.patchedSource)).toEqual({
      status: "compatible",
    });
  });

  it("fails closed when a required Workbench capability anchor changes", () => {
    expect(inspectWorkbenchDropSource(SOURCE.replace("commandService", "commands"))).toEqual({
      status: "unsupported",
      detail: "expected one command service anchor, found 0",
    });
  });

  it("accepts the first empty-type dragenter so a short external drop can complete", () => {
    const fixture = contributionFixture();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const transfer = { dropEffect: "none", files: [], getData: () => "", types: [] };

    fixture.document.listeners.get("dragenter")?.({
      clientX: 1500,
      clientY: 300,
      composedPath: () => [fixture.pane],
      dataTransfer: transfer,
      preventDefault,
      stopPropagation,
      target: fixture.pane,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(transfer.dropEffect).toBe("copy");
    expect(fixture.instance.overlay?.style.display).toBe("flex");

    const runtime = globalThis as typeof globalThis & {
      vscode?: { webUtils: { getPathForFile: () => string } };
    };
    const previousVscode = runtime.vscode;
    runtime.vscode = {
      webUtils: { getPathForFile: () => "/home/test/Documents/manual.pdf" },
    };
    try {
      const dropPreventDefault = vi.fn();
      fixture.document.listeners.get("drop")?.({
        clientX: 0,
        clientY: 0,
        composedPath: () => [fixture.instance.overlay],
        dataTransfer: { files: [{}], getData: () => "", types: ["Files"] },
        preventDefault: dropPreventDefault,
        stopImmediatePropagation: vi.fn(),
        stopPropagation: vi.fn(),
        target: fixture.instance.overlay,
      });

      expect(dropPreventDefault).toHaveBeenCalledOnce();
      expect(fixture.commandService.executeCommand).toHaveBeenCalledWith(
        "codexRemoteBridge.acceptWorkbenchDrop",
        expect.objectContaining({ nativeFilePaths: ["/home/test/Documents/manual.pdf"] }),
      );
    } finally {
      if (previousVscode) {
        runtime.vscode = previousVscode;
      } else {
        delete runtime.vscode;
      }
    }
  });

  it("resolves the pane by hit testing after a cross-display entry", () => {
    const fixture = contributionFixture();
    const preventDefault = vi.fn();

    fixture.document.listeners.get("dragenter")?.({
      clientX: 1500,
      clientY: 300,
      composedPath: () => [],
      dataTransfer: { files: [], getData: () => "", types: [] },
      preventDefault,
      stopPropagation: vi.fn(),
      target: null,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(fixture.instance.overlay?.style.display).toBe("flex");
  });

  it("does not consume a provisional drop unless it contains a real resource", () => {
    const fixture = contributionFixture();
    const preventDefault = vi.fn();

    fixture.document.listeners.get("drop")?.({
      clientX: 1500,
      clientY: 300,
      composedPath: () => [fixture.pane],
      dataTransfer: { files: [], getData: () => "", types: [] },
      preventDefault,
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
      target: fixture.pane,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.commandService.executeCommand).not.toHaveBeenCalled();
  });

  it("activates from the Codex Webview ingress signal and accepts its fallback drop", () => {
    const fixture = contributionFixture();
    const listener = fixture.window.listeners.get("message");

    listener?.({
      source: fixture.peer,
      data: {
        channel: "codex-remote-bridge-webview-drop-v1",
        phase: "dragenter",
      },
    });
    expect(fixture.instance.overlay?.style.display).toBe("flex");

    listener?.({
      source: fixture.peer,
      data: {
        channel: "codex-remote-bridge-webview-drop-v1",
        payload: {
          schemaVersion: 1,
          uriList: "file:///home/test/Documents/manual.pdf",
          nativeFilePaths: [],
        },
        phase: "drop",
      },
    });

    expect(fixture.commandService.executeCommand).toHaveBeenCalledWith(
      "codexRemoteBridge.acceptWorkbenchDrop",
      expect.objectContaining({ uriList: "file:///home/test/Documents/manual.pdf" }),
    );
  });

  it("does not consume drops until both the Webview and extension handler are ready", async () => {
    const fixture = contributionFixture(false);
    const drop = { target: fixture.pane, dataTransfer: { files: [], types: ["text/uri-list"], getData: () => "file:///work/file.txt" }, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    fixture.document.listeners.get("drop")?.(drop);
    expect(drop.preventDefault).not.toHaveBeenCalled();
    fixture.commandService.executeCommand.mockRejectedValueOnce(new Error("No handler"));
    const probe = { source: fixture.peer, data: { channel: "codex-remote-bridge-webview-drop-v1", phase: "probe", nonce: "fixture" } };
    fixture.window.listeners.get("message")?.(probe);
    await new Promise((done) => setTimeout(done, 0));
    expect(fixture.peer.postMessage).not.toHaveBeenCalled();
    fixture.commandService.executeCommand.mockResolvedValue(true);
    fixture.window.listeners.get("message")?.(probe);
    await new Promise((done) => setTimeout(done, 0));
    expect(fixture.peer.postMessage).toHaveBeenCalledWith({ channel: "codex-remote-bridge-webview-drop-v1", phase: "ready", nonce: "fixture" }, "*");
    fixture.document.listeners.get("drop")?.(drop);
    expect(drop.preventDefault).toHaveBeenCalledOnce();
    fixture.instance.readyUntil = 0;
    drop.preventDefault.mockClear();
    fixture.document.listeners.get("drop")?.(drop);
    expect(drop.preventDefault).not.toHaveBeenCalled();
  });

  const installedWorkbench =
    "/usr/share/code/resources/app/out/vs/workbench/workbench.desktop.main.js";
  it.skipIf(!existsSync(installedWorkbench))(
    "recognizes the installed VS Code Workbench without a version gate",
    async () => {
      const source = await readFile(installedWorkbench, "utf8");
      const inspected = inspectWorkbenchDropSource(source);
      expect(inspected.status).toMatch(/patchable|compatible/);
      if (inspected.status !== "patchable") {
        return;
      }
      const root = await mkdtemp(join(tmpdir(), "codex-workbench-parse-"));
      const modulePath = join(root, "workbench.mjs");
      try {
        await writeFile(modulePath, inspected.patchedSource, "utf8");
        await expect(execFileAsync(process.execPath, ["--check", modulePath])).resolves.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
