// @vitest-environment node
import { describe, expect, it } from "vitest";
import { refuseSlashCommand } from "./slashCommands";

describe("refuseSlashCommand", () => {
  it.each([
    ["a replaced command", "/model opus", undefined, /model selector/],
    ["an alias of one", "/new idea", undefined, /Start a new thread/],
    ["an alias the thread does not offer", "/name Fix it", () => false, /Rename Thread/],
    ["an alias the thread offers as a command", "/new idea", (n: string) => n === "new", null],
    ["a replaced command the thread offers too", "/clear", (n: string) => n === "clear", /Start a new thread/],
    ["anything else", "/review", undefined, null],
  ] as const)("%s", (_name, text, offers, want) => {
    const send = () => {
      refuseSlashCommand(text, offers);
    };
    if (want) expect(send).toThrow(want);
    else expect(send).not.toThrow();
  });
});
