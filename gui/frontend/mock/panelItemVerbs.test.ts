// @vitest-environment node
import { describe, expect, it } from "vitest";
import { panelItemCommands, type ItemThread } from "./panelItemVerbs";

const thread: ItemThread = { projectId: "r1", worktreePath: "/w/a", githubSlug: "" };
const ctx = { activeThreadId: "t1" } as never;

function run(name: string, args: Record<string, string>): { out: unknown; params: Record<string, string> | undefined } {
  let params: Record<string, string> | undefined;
  const cmds = panelItemCommands(
    (id) => (id === "t1" ? thread : undefined),
    (i) => {
      if (i.intent?.case === "showView") params = i.intent.value.params as Record<string, string>;
      return 1;
    },
  );
  const cmd = cmds.find((c) => c.cmd.name === name);
  if (!cmd) throw new Error(`no ${name}`);
  return { out: cmd.run(ctx, args), params };
}

describe("the panel verbs' --title, like the daemon's", () => {
  const verbs: [string, Record<string, string>][] = [
    ["view.panel.page", { path: "/w/a/p.html" }],
    ["view.panel.diff", { path: "/w/a/x.go" }],
  ];
  for (const [name, args] of verbs) {
    it(`${name} takes 100 characters, cleaned`, () => {
      const { params } = run(name, { ...args, title: ` ${"é".repeat(98)}\n\t x ` });
      expect(params?.title).toBe(`${"é".repeat(98)} x`);
    });
    it(`${name} refuses 101 with the daemon's message`, () => {
      expect(() => run(name, { ...args, title: "x".repeat(101) })).toThrow("101 characters, at most 100");
    });
  }
});
