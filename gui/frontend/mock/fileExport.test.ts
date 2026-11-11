// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CallOrigin } from "../src/gen/codefoundry/v1/command_pb";
import { fileExportCommands, type ExportDisk } from "./fileExport";

const files = new Map<string, string>([["/w/a/rows.csv", "old"], ["/w/a/out/keep.txt", "x"]]);
const disk: ExportDisk = {
  textOf: (abs) => files.get(abs) ?? null,
  write: (abs, text) => files.set(abs, text),
  hasFolder: (abs) => [...files.keys()].some((p) => p.startsWith(`${abs}/`)),
};
const [cmd] = fileExportCommands((id) => ({ t1: "/w/a", t2: "" })[id], () => disk);
if (!cmd) throw new Error("no file.export");
const cli = { activeThreadId: "t1" } as never;
const page = { activeThreadId: "t1", origin: CallOrigin.PAGE } as never;

describe("the mock's file.export, like the daemon's", () => {
  it.each([
    ["", "needs a file name"],
    ["/tmp/x", "not relative"],
    ["~/x", "not relative"],
    ["../x", "leads outside"],
    [".git/config", "starting with a dot"],
    ["missing/x.csv", "does not exist"],
    ["out", "is a directory"],
  ])("refuses %j", (path, why) => {
    expect(() => cmd.run(cli, { path, text: "a" })).toThrow(why);
  });

  it("refuses contents given twice, none, or past 256 KiB, and a thread with no checkout", () => {
    expect(() => cmd.run(cli, { path: "x", text: "a", base64: "YQ==" })).toThrow("once");
    expect(() => cmd.run(cli, { path: "x" })).toThrow("needs the contents");
    expect(() => cmd.run(cli, { path: "x", text: "x".repeat(256 * 1024 + 1) })).toThrow("262145 bytes, at most 262144 (256 KiB)");
    expect(() => cmd.run(cli, { path: "x", text: "a", thread: "t2" })).toThrow("no checkout yet");
  });

  it("asks a page first, and anyone before replacing a file", () => {
    expect(cmd.cmd.confirmIf(cli, { path: "new.csv", text: "a" })).toBe(false);
    expect(cmd.cmd.confirmIf(page, { path: "new.csv", text: "a" })).toBe(true);
    expect(cmd.cmd.confirm(page, { path: "new.csv", text: "a" })).toBe('Run this?\nfile.export --path "new.csv" --text <1 byte> --thread "t1"\nSaves 1 byte to /w/a/new.csv');
    expect(cmd.cmd.confirmLabel(page, { path: "new.csv", text: "a" })).toBe("Allow");
    expect(cmd.cmd.confirmIf(cli, { path: "rows.csv", text: "a" })).toBe(true);
    expect(cmd.cmd.confirm(cli, { path: "rows.csv", text: "a" })).toMatch(/^Replace \/w\/a\/rows\.csv\?/);
    expect(cmd.cmd.confirmLabel(cli, { path: "rows.csv", text: "a" })).toBe("Replace");
  });

  it("writes and answers the path", async () => {
    const res = await cmd.run(cli, { path: "out/new.csv", base64: "YSxi" });
    expect(JSON.parse(res.resultJson)).toEqual({ path: "/w/a/out/new.csv", size: 3 });
    expect(files.get("/w/a/out/new.csv")).toBe("a,b");
  });
});
