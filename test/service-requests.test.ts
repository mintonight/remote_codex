import { describe, expect, it } from "vitest";
import { ServiceRequests } from "../src/shim/service-requests.js";
import type { RpcMessage } from "../src/shim/rpc.js";

describe("service request arbitration", () => {
  it("isolates upstream request IDs and accepts only the first client response", () => {
    const hub = new ServiceRequests();
    const publicRequests: unknown[] = [];
    const a: unknown[] = [];
    const b: unknown[] = [];
    hub.publish("a", { id: 1, method: "approve" }, (m) => a.push(m), (m) => publicRequests.push(m));
    hub.publish("b", { id: 1, method: "approve" }, (m) => b.push(m), (m) => publicRequests.push(m));
    const ids = (publicRequests as RpcMessage[]).map((m) => "id" in m ? m.id : null);
    expect(ids[0]).not.toBe(ids[1]);
    expect(hub.respond({ id: ids[0]!, result: "accept" })).toBe(true);
    expect(hub.respond({ id: ids[0]!, result: "reject" })).toBe(true);
    expect(a).toEqual([{ id: 1, result: "accept" }]);
    expect(b).toEqual([]);
    const replay: unknown[] = [];
    hub.replay((m) => replay.push(m));
    expect(replay).toEqual([publicRequests[1]]);
    expect(hub.has("a")).toBe(false);
    expect(hub.has("b")).toBe(true);
    hub.remove("b");
    expect(hub.has("b")).toBe(false);
  });
});
