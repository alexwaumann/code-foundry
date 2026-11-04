import { describe, expect, it } from "vitest";
import { SearchStatus } from "../src/gen/codefoundry/v1/search_pb";
import { MockSearches, type ActivityInit } from "./agentSearch";

const world = () =>
  new MockSearches({
    thread: (id) => (id === "s-3" ? { name: "Fix resize race", archived: false } : undefined),
    items: () => [{ id: "s-3-i4", ordinal: 40n, payload: { case: "assistantText", value: { text: "Fixed: the actor applies a resize only after the pending writes drain. The race test passes." } } }],
    promote: () => "s-new-1",
    publishActivity: (a) => {
      published.push(a);
    },
  });
const published: ActivityInit[] = [];

async function collect(it: AsyncGenerator<{ version?: bigint; event?: { case?: string } }>, n = 100): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of it) {
    out.push(`${ev.event?.case ?? ""}@${String(ev.version)}`);
    if (out.length >= n) break;
  }
  return out;
}

describe("MockSearches", () => {
  it("activity: a run's start and end alone, the unseen one before seen, none after; a restart fails what runs", async () => {
    published.length = 0;
    const s = world();
    s.control(new URLSearchParams("stepMs=5"));
    const e = s.startAgent("why the race?");
    const id = e.id ?? "";
    await collect(s.watch(id, new AbortController().signal));
    expect(published).toEqual([
      { running: 1, runningId: id, unseenId: "", unseenStatus: SearchStatus.UNSPECIFIED, unseenHits: 0 },
      { running: 0, runningId: "", unseenId: id, unseenStatus: SearchStatus.DONE, unseenHits: 1 },
    ]);
    s.markSeen(id);
    expect(s.activity()).toMatchObject({ running: 0, unseenId: "" });

    s.control(new URLSearchParams("stepMs=1000"));
    const lost = s.startAgent("lost").id ?? "";
    expect(s.activity()).toMatchObject({ running: 1, runningId: lost });
    s.restarted();
    expect(s.activity()).toMatchObject({ running: 0, runningId: "", unseenId: lost, unseenStatus: SearchStatus.FAILED });
    s.forget(lost);
    expect(s.activity()).toMatchObject({ running: 0, unseenId: "" });
  });

  it("Watch: one snapshot, then steps, the hit, the answer and the status with growing versions, then the end", async () => {
    const s = world();
    s.control(new URLSearchParams("stepMs=10"));
    const e = s.startAgent("why the race?");
    const got = await collect(s.watch(e.id ?? "", new AbortController().signal));
    expect(got).toEqual(["snapshot@1", "step@2", "step@3", "step@4", "step@5", "step@6", "step@7", "hit@8", "answer@9", "status@10"]);
    // Finished: the snapshot alone.
    expect(await collect(s.watch(e.id ?? "", new AbortController().signal))).toEqual(["snapshot@10"]);
    expect(s.list()[0]).toMatchObject({ unseen: true, hits: [{ n: 1, itemId: "s-3-i4" }] });
  });

  it("a forgotten entry ends its Watch NOT_FOUND; Find entries replace their query", async () => {
    const s = world();
    s.control(new URLSearchParams("stepMs=1000"));
    const e = s.startAgent("q");
    const w = collect(s.watch(e.id ?? "", new AbortController().signal));
    await new Promise((r) => setTimeout(r, 5));
    s.forget(e.id ?? "");
    await expect(w).rejects.toThrow(/no search/);
    s.recordFind("fingerprint", 3);
    s.recordFind("fingerprint", 14);
    expect(s.list().map((x) => [x.query, x.findHits])).toEqual([["fingerprint", 14]]);
  });

  it("long=1: a markdown answer citing only the hits it found, and more candidates; reset turns it off", async () => {
    const s = world();
    s.control(new URLSearchParams("stepMs=10&long=1"));
    const e = s.startAgent("why the race?");
    await collect(s.watch(e.id ?? "", new AbortController().signal));
    const got = s.list()[0];
    // Two of the candidates are s-3's; the test world's one message has the first alone, the second is the prompt it lacks.
    expect(got?.hits?.map((h) => h.n)).toEqual([1]);
    expect(got?.answer).toContain("## Still open");
    expect(got?.answer).toContain("[1]");
    expect(got?.answer).not.toContain("[2]");
    s.reset();
    expect(s.control(new URLSearchParams())).toMatchObject({ long: false });
  });

  it("seed: an agent entry with hits reads its first hit's thread, so its summary counts the read", () => {
    const s = world();
    s.seed();
    const resize = s.list().find((x) => x.query === "why did the terminal resize race?");
    expect(resize).toMatchObject({ searches: 2, threadsRead: 1 });
    expect(resize?.steps?.at(-1)).toMatchObject({ threadId: "s-3", threadName: "Fix resize race", done: true });
  });
});
