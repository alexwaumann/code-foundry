import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ThreadEventSchema } from "@/gen/codefoundry/v1/thread_pb";
import { shareCommands, type SlashCommandView } from "./slashCommands";
import { toThreadEventView } from "./thread";

const usage = { name: "usage", description: "Show session cost", argumentHint: "", aliases: ["cost", "stats"], builtin: true };
const deploy = { name: "deploy", description: "Ship it (project)", argumentHint: "<env>", aliases: [], builtin: false };

describe("slash commands on the Watch", () => {
  it("maps the snapshot's list", () => {
    const v = toThreadEventView(create(ThreadEventSchema, { event: { case: "snapshot", value: { threadId: "s", seq: 4n, commands: [deploy, usage] } } }));
    expect(v?.kind === "snapshot" && v.commands).toEqual([deploy, usage]);
  });

  it("maps a commands event, empty when the process ended", () => {
    const v = toThreadEventView(create(ThreadEventSchema, { event: { case: "commands", value: { threadId: "s", seq: 9n, commands: [usage] } } }));
    expect(v).toEqual({ kind: "commands", sessionId: "s", seq: 9, commands: [usage] });
    const gone = toThreadEventView(create(ThreadEventSchema, { event: { case: "commands", value: { threadId: "s", seq: 10n } } }));
    expect(gone).toEqual({ kind: "commands", sessionId: "s", seq: 10, commands: [] });
  });

  it("an older daemon's snapshot has none", () => {
    const v = toThreadEventView(create(ThreadEventSchema, { event: { case: "snapshot", value: { threadId: "s", seq: 1n } } }));
    expect(v?.kind === "snapshot" && v.commands).toEqual([]);
  });
});

describe("shareCommands", () => {
  const list = (...cs: SlashCommandView[]) => cs.map((c) => ({ ...c, aliases: [...c.aliases] }));
  it.each<[string, SlashCommandView[], boolean]>([
    ["the same list by value", list(deploy, usage), true],
    ["another order", list(usage, deploy), false],
    ["one more", list(deploy, usage, usage), false],
    ["an alias changed", list(deploy, { ...usage, aliases: ["cost"] }), false],
    ["the hint changed", list({ ...deploy, argumentHint: "" }, usage), false],
    ["builtin changed", list({ ...deploy, builtin: true }, usage), false],
  ])("%s", (_name, next, kept) => {
    const prev = list(deploy, usage);
    expect(shareCommands(prev, next) === prev).toBe(kept);
  });
});
