import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { McpCheckTrigger, McpServerStatus, ThreadEventSchema, ThreadMcpStatusSchema } from "@/gen/codefoundry/v1/thread_pb";
import { toMcpStatusView } from "./mcp";
import { toThreadEventView } from "./thread";

describe("toMcpStatusView", () => {
  it("maps every status, the trigger, the time and the tools", () => {
    const v = toMcpStatusView(
      create(ThreadMcpStatusSchema, {
        checkedAt: timestampFromMs(5000),
        trigger: McpCheckTrigger.TURN_START,
        servers: [
          {
            name: "github",
            status: McpServerStatus.CONNECTED,
            serverName: "gh",
            version: "1.2.0",
            scope: "user",
            source: "user",
            transport: "stdio",
            tools: [
              { name: "get", description: "Get it", readOnly: true, openWorld: true },
              { name: "push", destructive: true },
            ],
          },
          { name: "linear", status: McpServerStatus.NEEDS_AUTH, transport: "http" },
          { name: "pw", status: McpServerStatus.FAILED, error: "spawn npx ENOENT" },
          { name: "fs", status: McpServerStatus.PENDING },
          { name: "sentry", status: McpServerStatus.DISABLED },
          { name: "odd", status: McpServerStatus.UNSPECIFIED },
        ],
      }),
    );
    expect(v).toMatchObject({ checkedAtMs: 5000, trigger: "turn", server: "" });
    expect(v?.servers.map((s) => s.status)).toEqual(["connected", "needs-auth", "failed", "pending", "disabled", "unknown"]);
    expect(v?.servers[0]).toEqual({
      name: "github",
      status: "connected",
      serverName: "gh",
      version: "1.2.0",
      error: "",
      scope: "user",
      source: "user",
      transport: "stdio",
      tools: [
        { name: "get", description: "Get it", readOnly: true, destructive: false, openWorld: true },
        { name: "push", description: "", readOnly: false, destructive: true, openWorld: false },
      ],
    });
    expect(v?.servers[2]?.error).toBe("spawn npx ENOENT");
  });

  it("maps a newer daemon's status to unknown", () => {
    const st = create(ThreadMcpStatusSchema, { servers: [{ name: "newer" }] });
    (st.servers[0] as { status: number }).status = 42;
    expect(toMcpStatusView(st)?.servers[0]?.status).toBe("unknown");
  });

  it("maps the triggers and a missing time; unset is null", () => {
    const t = (trigger: McpCheckTrigger) => toMcpStatusView(create(ThreadMcpStatusSchema, { trigger, server: "x" }));
    expect(t(McpCheckTrigger.REFRESH)).toEqual({ checkedAtMs: null, trigger: "refresh", server: "x", servers: [] });
    expect(t(McpCheckTrigger.RECONNECT)?.trigger).toBe("reconnect");
    expect(t(McpCheckTrigger.UNSPECIFIED)?.trigger).toBe("unknown");
    expect(toMcpStatusView(undefined)).toBeNull();
  });

  it("rides the thread events: the snapshot's mcp and the mcp event (null when dropped)", () => {
    const snap = toThreadEventView(create(ThreadEventSchema, { event: { case: "snapshot", value: { threadId: "s", seq: 3n, mcp: { servers: [{ name: "a", status: McpServerStatus.CONNECTED }] } } } }));
    expect(snap).toMatchObject({ kind: "snapshot", seq: 3, mcp: { servers: [{ name: "a", status: "connected" }] } });
    const none = toThreadEventView(create(ThreadEventSchema, { event: { case: "snapshot", value: { threadId: "s", seq: 3n } } }));
    expect(none).toMatchObject({ kind: "snapshot", mcp: null });
    const ev = toThreadEventView(create(ThreadEventSchema, { event: { case: "mcp", value: { threadId: "s", seq: 4n, status: { trigger: McpCheckTrigger.RECONNECT, server: "a" } } } }));
    expect(ev).toEqual({ kind: "mcp", threadId: "s", seq: 4, status: { checkedAtMs: null, trigger: "reconnect", server: "a", servers: [] } });
    const gone = toThreadEventView(create(ThreadEventSchema, { event: { case: "mcp", value: { threadId: "s", seq: 5n } } }));
    expect(gone).toEqual({ kind: "mcp", threadId: "s", seq: 5, status: null });
  });
});
