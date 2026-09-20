const { readFileSync } = require("node:fs");
const { WebSocketServer } = require("ws");
const args = process.argv;
const endpoint = new URL(args[args.indexOf("--listen") + 1]);
const token = readFileSync(args[args.indexOf("--ws-token-file") + 1], "utf8");
const server = new WebSocketServer({ host: endpoint.hostname, port: Number(endpoint.port),
  verifyClient: ({ req }, done) => done(req.headers.authorization === `Bearer ${token}`, 401) });
const threads = new Map();
let number = 0;
const notify = (method, params) => {
  for (const socket of server.clients) if (socket.readyState === 1) socket.send(JSON.stringify({ method, params }));
};
server.on("connection", (socket) => socket.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  const p = m.params || {};
  const reply = (result) => socket.send(JSON.stringify({ id: m.id, result }));
  const thread = threads.get(p.threadId);
  if (m.method === "initialize") return reply({ userAgent: m.params.clientInfo.name });
  if (m.method === "thread/start") {
    const t = { id: `thread-${++number}`, cwd: p.cwd, status: { type: "idle" }, turns: [] };
    threads.set(t.id, t); reply({ thread: t }); return notify("thread/started", { thread: t });
  }
  if (m.method === "thread/loaded/list") return reply({ data: [...threads.keys()], nextCursor: null });
  if (m.method === "thread/read" || m.method === "thread/resume") return reply({ thread });
  if (m.method === "thread/unsubscribe") return reply({ status: "unsubscribed" });
  if (m.method === "thread/archive") {
    threads.delete(p.threadId); reply({}); return notify("thread/archived", { threadId: p.threadId });
  }
  if (m.method === "turn/start") {
    if (thread.status.type === "active") return socket.send(JSON.stringify({ id: m.id, error: { code: -32000, message: "Already active" } }));
    const turn = { id: `turn-${++number}`, status: "inProgress" };
    thread.turns = [turn]; thread.status = { type: "active" };
    reply({ turn }); notify("turn/started", { threadId: thread.id, turn });
    return socket.send(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: turn.id, command: "fixture" } }));
  }
  if (!m.method && m.id === "approval-1") return notify("fixture/approvalAnswered", { decision: m.result });
  if (m.method === "turn/steer") return reply({ turnId: thread.turns[0].id });
  if (m.method === "turn/interrupt") {
    thread.status = { type: "idle" }; thread.turns[0].status = "interrupted";
    reply({}); return notify("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
  }
  if (m.method === "thread/queue/add") { thread.queue = p.input; return reply({ queuedSubmissionId: "queued-1" }); }
  if (m.method === "thread/queue/list") return reply({ data: thread.queue ? [thread.queue] : [], nextCursor: null });
  if (m.id !== undefined) return reply({});
}));
