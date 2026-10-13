import { describe, expect, it } from "vitest";
import type { McpServerView, McpStatusView } from "@/api/mcp";
import { canReconnect, checkedAgo, checkedLine, connectedSummary, metaParts, needsAttention, sameServer, shareMcp, toolCount, toolHints, transportLabel } from "./mcp";

const NOW = 1_800_000_000_000;

function server(name: string, o: Partial<McpServerView> = {}): McpServerView {
  return { name, status: "connected", serverName: "", version: "", error: "", scope: "user", source: "user", transport: "stdio", tools: [], ...o };
}

function status(servers: McpServerView[], o: Partial<McpStatusView> = {}): McpStatusView {
  return { checkedAtMs: NOW, trigger: "turn", server: "", servers, ...o };
}

describe("checkedAgo", () => {
  it.each<[string, number | null, string]>([
    ["unknown", null, ""],
    ["now", NOW, "just now"],
    ["4.9 s", NOW - 4900, "just now"],
    ["5 s", NOW - 5000, "5s ago"],
    ["12 s", NOW - 12_000, "12s ago"],
    ["59 s", NOW - 59_999, "59s ago"],
    ["1 min", NOW - 60_000, "1 min ago"],
    ["59 min", NOW - 59 * 60_000 - 59_000, "59 min ago"],
    ["2 h", NOW - 2 * 3_600_000 - 5, "2 h ago"],
    ["3 d", NOW - 3 * 86_400_000, "3 d ago"],
    ["a clock ahead", NOW + 3000, "just now"],
  ])("%s", (_name, ms, want) => {
    expect(checkedAgo(ms, NOW)).toBe(want);
  });
});

describe("checkedLine", () => {
  it.each<[string, Partial<McpStatusView>, string]>([
    ["a turn's start", { checkedAtMs: NOW - 12_000, trigger: "turn" }, "Checked 12s ago, at the start of the last turn"],
    ["a refresh", { checkedAtMs: NOW - 2000, trigger: "refresh" }, "Checked just now"],
    ["a reconnect", { checkedAtMs: NOW - 180_000, trigger: "reconnect", server: "github" }, "Checked 3 min ago, after reconnecting github"],
    ["a reconnect without a name", { trigger: "reconnect", server: "" }, "Checked just now"],
    ["no time", { checkedAtMs: null, trigger: "turn" }, "Checked, at the start of the last turn"],
    ["unknown trigger", { checkedAtMs: NOW - 7000, trigger: "unknown" }, "Checked 7s ago"],
  ])("%s", (_name, o, want) => {
    expect(checkedLine(status([], o), NOW)).toBe(want);
  });
});

describe("card helpers", () => {
  it("meta line: scope · transport · tools (tools only when connected; claude.ai's proxy named)", () => {
    expect(metaParts(server("a", { tools: [{ name: "t", description: "", readOnly: true, destructive: false, openWorld: false }] }))).toEqual(["user", "stdio", "1 tool"]);
    expect(metaParts(server("a", { status: "connected" }))).toEqual(["user", "stdio", "0 tools"]);
    expect(metaParts(server("a", { status: "failed", scope: "project" }))).toEqual(["project", "stdio"]);
    expect(metaParts(server("a", { status: "needs-auth", scope: "claudeai", transport: "claudeai-proxy" }))).toEqual(["claudeai", "claude.ai"]);
    expect(metaParts(server("a", { status: "pending", scope: "", transport: "" }))).toEqual([]);
    expect(transportLabel("http")).toBe("http");
    expect(toolCount(24)).toBe("24 tools");
  });

  it.each<[McpServerView["status"], boolean, boolean]>([
    ["connected", true, false],
    ["failed", true, true],
    ["needs-auth", true, true],
    ["pending", false, false],
    ["disabled", false, false],
    ["unknown", true, false],
  ])("%s: reconnect %s, attention %s", (st, reconnect, attention) => {
    expect(canReconnect(st)).toBe(reconnect);
    expect(needsAttention(st)).toBe(attention);
  });

  it("counts the connected", () => {
    expect(connectedSummary([server("a"), server("b", { status: "failed" }), server("c")])).toBe("2 of 3 connected");
    expect(connectedSummary([])).toBe("0 of 0 connected");
  });

  it.each<[string, { readOnly: boolean; destructive: boolean; openWorld: boolean }, string[]]>([
    ["read-only", { readOnly: true, destructive: false, openWorld: false }, ["read-only"]],
    ["writes (no hints)", { readOnly: false, destructive: false, openWorld: false }, ["writes"]],
    ["destructive, open-world", { readOnly: false, destructive: true, openWorld: true }, ["writes", "destructive", "open-world"]],
    ["read-only, open-world", { readOnly: true, destructive: false, openWorld: true }, ["read-only", "open-world"]],
  ])("tool hints: %s", (_name, t, want) => {
    expect(toolHints(t)).toEqual(want);
  });
});

describe("shareMcp", () => {
  it("keeps unchanged servers by identity and the whole status when nothing changed", () => {
    const a = server("a", { tools: [{ name: "t", description: "d", readOnly: true, destructive: false, openWorld: false }] });
    const b = server("b", { status: "failed", error: "x" });
    const prev = status([a, b]);
    expect(shareMcp(prev, status([{ ...a, tools: [...a.tools] }, { ...b }]))).toBe(prev);

    const later = shareMcp(prev, status([{ ...a }, { ...b, status: "connected", error: "" }], { checkedAtMs: NOW + 1000, trigger: "reconnect", server: "b" }));
    expect(later).not.toBe(prev);
    expect(later?.servers[0]).toBe(a);
    expect(later?.servers[1]).toMatchObject({ status: "connected" });

    // Only the time changed: a new status with the same server list.
    const ticked = shareMcp(prev, status([{ ...a }, { ...b }], { checkedAtMs: NOW + 5000 }));
    expect(ticked?.checkedAtMs).toBe(NOW + 5000);
    expect(ticked?.servers).toBe(prev.servers);

    expect(shareMcp(null, prev)).toBe(prev);
    expect(shareMcp(prev, null)).toBeNull();
  });

  it("compares every field and the tools by value", () => {
    const a = server("a");
    expect(sameServer(a, { ...a })).toBe(true);
    expect(sameServer(a, { ...a, version: "2" })).toBe(false);
    expect(sameServer(a, { ...a, tools: [{ name: "t", description: "", readOnly: false, destructive: false, openWorld: false }] })).toBe(false);
  });
});
