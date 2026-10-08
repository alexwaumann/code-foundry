import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ArgType, CommandSchema } from "@/gen/codefoundry/v1/command_pb";
import { RepoEventSchema, RepoSchema } from "@/gen/codefoundry/v1/repo_pb";
import { AttachEventSchema, TerminalEventSchema, TerminalSchema, TerminalState } from "@/gen/codefoundry/v1/terminal_pb";
import { UiIntent_Notify_Level, UiIntentSchema } from "@/gen/codefoundry/v1/ui_pb";
import { toCommandView } from "./command";
import { overrideEndpoint } from "./endpoint";
import { toRepoEventView, toRepoView } from "./repo";
import { toAttachEventView, toTerminalEventView, toTerminalView } from "./terminal";
import { toUiIntentView } from "./ui";

describe("terminal mapping", () => {
  it("maps a Terminal to its view model", () => {
    const t = create(TerminalSchema, {
      id: "t1",
      argv: ["claude", "--resume"],
      cwd: "/src",
      cols: 120,
      rows: 40,
      title: "✳ Work",
      state: TerminalState.EXITED,
      exitCode: 3,
      startedAt: timestampFromMs(1000),
      exitedAt: timestampFromMs(5000),
      altScreen: true,
      labels: { worktree: "/src" },
    });
    expect(toTerminalView(t)).toEqual({
      id: "t1",
      argv: ["claude", "--resume"],
      cwd: "/src",
      cols: 120,
      rows: 40,
      title: "✳ Work",
      state: "exited",
      exitCode: 3,
      startedAtMs: 1000,
      exitedAtMs: 5000,
      altScreen: true,
      labels: { worktree: "/src" },
    });
    expect(toTerminalView(create(TerminalSchema, { id: "x" }))).toMatchObject({ state: "unknown", startedAtMs: null, exitedAtMs: null });
  });

  it.each([
    [{ event: { case: "updated" as const, value: create(TerminalSchema, { id: "a", state: TerminalState.RUNNING }) } }, { kind: "updated", id: "a" }],
    [{ event: { case: "removedId" as const, value: "b" } }, { kind: "removed", id: "b" }],
  ])("maps TerminalEvent %#", (init, want) => {
    const v = toTerminalEventView(create(TerminalEventSchema, init));
    expect(v?.kind).toBe(want.kind);
    expect(v?.kind === "updated" ? v.terminal.id : v?.id).toBe(want.id);
  });

  it("maps every AttachEvent case and drops empty ones", () => {
    const data = new Uint8Array([27, 91, 109]);
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "snapshot", value: { data, cols: 80, rows: 24, altScreen: true } } }))).toEqual({
      kind: "snapshot",
      data,
      cols: 80,
      rows: 24,
      altScreen: true,
    });
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "output", value: { data } } }))).toEqual({ kind: "output", data });
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "resized", value: { cols: 1, rows: 2 } } }))).toEqual({ kind: "resized", cols: 1, rows: 2 });
    expect(toAttachEventView(create(AttachEventSchema, { event: { case: "exited", value: { exitCode: 7 } } }))).toEqual({ kind: "exited", exitCode: 7 });
    expect(toAttachEventView(create(AttachEventSchema, {}))).toBeNull();
  });
});

describe("repo mapping", () => {
  it("defaults a missing git status to clean", () => {
    const r = toRepoView(create(RepoSchema, { id: "r", name: "app", worktrees: [{ repoId: "r", path: "/a", isMain: true }] }));
    expect(r.worktrees[0]?.status).toMatchObject({ dirty: false, ahead: 0, refreshedAtMs: null });
  });

  it.each([
    [{ case: "repoRemovedId" as const, value: "r1" }, { kind: "repoRemoved", id: "r1" }],
    [{ case: "worktreeRemoved" as const, value: { repoId: "r1", path: "/p" } }, { kind: "worktreeRemoved", repoId: "r1", path: "/p" }],
  ])("maps RepoEvent %#", (event, want) => {
    expect(toRepoEventView(create(RepoEventSchema, { event }))).toEqual(want);
  });
});

describe("command mapping", () => {
  it("maps arg types and fills defaults", () => {
    const c = toCommandView(
      create(CommandSchema, {
        name: "worktree.remove",
        args: [
          { name: "force", type: ArgType.BOOL, required: true },
          { name: "path", type: ArgType.PATH },
          { name: "n", type: ArgType.INT },
          { name: "m", type: ArgType.ENUM, enumValues: ["a"] },
          { name: "s", type: ArgType.UNSPECIFIED },
        ],
        keybindings: ["cmd+w"],
        available: true,
      }),
    );
    expect(c.title).toBe("worktree.remove");
    expect(c.category).toBe("General");
    expect(c.args.map((a) => a.type)).toEqual(["bool", "path", "int", "enum", "string"]);
    expect(c.keybindings).toEqual(["cmd+w"]);
  });
});

describe("ui intent mapping", () => {
  it.each([
    [{ case: "focusTerminal" as const, value: { terminalId: "t" } }, { kind: "focusTerminal", terminalId: "t" }],
    [{ case: "focusRepo" as const, value: { repoId: "r", worktreePath: "/w" } }, { kind: "focusRepo", repoId: "r", worktreePath: "/w" }],
    [{ case: "openPalette" as const, value: { query: "new" } }, { kind: "openPalette", query: "new" }],
    [
      { case: "notify" as const, value: { level: UiIntent_Notify_Level.ERROR, title: "x", body: "y" } },
      { kind: "notify", level: "error", title: "x", body: "y" },
    ],
    [{ case: "notify" as const, value: { title: "x" } }, { kind: "notify", level: "info", title: "x", body: "" }],
  ])("maps %#", (intent, want) => {
    expect(toUiIntentView(create(UiIntentSchema, { intent }))).toEqual(want);
  });
});

describe("overrideEndpoint", () => {
  it.each([
    ["query wins", "?daemon=http://q:1&token=qt", { VITE_DAEMON_URL: "http://e:2", VITE_DAEMON_TOKEN: "et" }, { baseUrl: "http://q:1", token: "qt" }],
    ["env", "", { VITE_DAEMON_URL: "http://e:2", VITE_DAEMON_TOKEN: "et" }, { baseUrl: "http://e:2", token: "et" }],
    ["none", "?x=1", {}, null],
  ])("%s", (_name, search, env, want) => {
    expect(overrideEndpoint(search, env)).toEqual(want);
  });
});
