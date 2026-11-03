import { describe, expect, it } from "vitest";
import { linkOwner, type TaskLink } from "./prTask";

// The mock's copy of the daemon's thread.LinkOwner (prlink_owner_test.go has the full table).
describe("linkOwner", () => {
  const own = (n: number, slug = "o/r"): TaskLink => ({ slug, number: n });
  const via = (n: number, through: string): TaskLink => ({ slug: "o/r", number: n, via: through });
  it.each([
    { name: "its own link", threads: { t: [own(7)] }, want: "t" },
    { name: "no link", threads: { t: [own(8)] }, want: "t" },
    { name: "two hops", threads: { t: [via(7, "c")], c: [via(7, "g")], g: [own(7)] }, want: "g" },
    { name: "a gone hop", threads: { t: [via(7, "c")] }, want: "t" },
    { name: "a cycle", threads: { t: [via(7, "c")], c: [via(7, "t")] }, want: "t" },
    { name: "GitHub's current name, case aside", threads: { t: [via(7, "c")], c: [own(7, "O/New")] }, want: "c" },
  ])("$name", ({ threads, want }) => {
    const byId: Record<string, TaskLink[] | undefined> = threads;
    expect(linkOwner("t", ["o/r", "o/new"], 7, (id) => byId[id])).toBe(want);
  });
});
