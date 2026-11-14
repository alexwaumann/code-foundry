import { describe, expect, it } from "vitest";
import { commandIcon, cwdHint, folderName, normalizeDir, programOf, terminalName, type TerminalNameInput } from "./terminalName";

const input = (over: Partial<TerminalNameInput>): TerminalNameInput => ({ manual: "", argv: ["/bin/zsh", "-l"], dir: "/Users/dev/src/code-foundry", foreground: "", ...over });

describe("terminalName", () => {
  it.each([
    ["idle: its shell and folder", input({}), "zsh · code-foundry", "shell", true],
    ["idle in the home directory", input({ dir: "/Users/dev" }), "zsh · ~", "shell", true],
    ["a login shell's argv[0]", input({ argv: ["-fish"], dir: "/tmp" }), "fish · tmp", "shell", true],
    ["what runs, with its icon", input({ foreground: "make dev" }), "make dev", "build", true],
    ["a git command", input({ foreground: "git log --oneline" }), "git log --oneline", "git", true],
    ["a manual name sticks over what runs, with the running icon", input({ manual: "  server ", foreground: "bun run dev" }), "server", "package", false],
    ["a manual name on an idle shell", input({ manual: "scratch" }), "scratch", "shell", false],
    ["an action run is named by its command", input({ argv: ["make", "test"] }), "make test", "build", true],
    ["an argument with a space is quoted", input({ argv: ["/usr/bin/tail", "-f", "a b.log"] }), "tail -f 'a b.log'", "log", true],
    ["nothing known yet", input({ argv: [], dir: "" }), "shell", "shell", true],
  ])("%s", (_name, given, name, icon, auto) => {
    expect(terminalName(given)).toEqual({ name, icon, auto });
  });
});

describe("commandIcon and programOf", () => {
  it.each([
    ["sudo -E make install", "make", "build"],
    ["FOO=1 BAR=2 npm test", "npm", "package"],
    ["/usr/local/bin/nvim notes.md", "nvim", "editor"],
    ["ssh dev@box", "ssh", "remote"],
    ["docker compose up", "docker", "container"],
    ["htop", "htop", "monitor"],
    ["less README.md", "less", "log"],
    ["psql app", "psql", "database"],
    ["python3.12 -m http.server", "python3.12", "python"],
    ["claude", "claude", "agent"],
    ["some-tool --watch", "some-tool", "run"],
    ["bash", "bash", "shell"],
    ["", "", "shell"],
  ])("%s", (line, program, icon) => {
    expect(programOf(line)).toBe(program);
    expect(commandIcon(line)).toBe(icon);
  });

  it("names a folder, home as ~", () => {
    expect(folderName("/Users/dev")).toBe("~");
    expect(folderName("/Users/dev/src/app/")).toBe("app");
    expect(folderName("")).toBe("");
  });
});

describe("cwdHint", () => {
  it.each([
    ["the shell is where its thread is", "/Users/dev/src/app", "/Users/dev/src/app", false],
    ["a trailing slash is the same place", "/Users/dev/src/app/", "/Users/dev/src/app", false],
    ["macOS's /private/tmp is the thread's /tmp", "/private/tmp/x", "/tmp/x", false],
    ["the shell moved", "/tmp", "/Users/dev/src/app", true],
    ["the thread moved to a worktree", "/Users/dev/src/app", "/Users/dev/src/app.worktrees/fix", true],
    ["a subdirectory is somewhere else", "/Users/dev/src/app/gui", "/Users/dev/src/app", true],
    ["no thread (a free shell)", "/tmp", "", false],
    ["no directory yet", "", "/Users/dev/src/app", false],
  ])("%s", (_name, live, thread, shown) => {
    expect(cwdHint(live, thread)).toEqual(shown ? { threadDir: thread } : null);
  });

  it("normalizes only /private's macOS links", () => {
    expect(normalizeDir("/private/var/folders/x")).toBe("/var/folders/x");
    expect(normalizeDir("/private/stuff")).toBe("/private/stuff");
    expect(normalizeDir("/")).toBe("/");
  });
});
