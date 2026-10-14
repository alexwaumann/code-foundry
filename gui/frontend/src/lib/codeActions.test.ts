import { describe, expect, it } from "vitest";
import { isStreamingBlock, runnableCommand } from "./codeActions";

describe("runnableCommand", () => {
  const cases: [string, string, string, string | null][] = [
    ["bash runs as written", "bash", "go test ./...\n", "go test ./..."],
    ["sh, shell and zsh too, any case", "ZSH", "ls -la", "ls -la"],
    ["shell", "shell", "make", "make"],
    ["sh", "sh", "echo hi", "echo hi"],
    ["multi-line stays multi-line", "bash", "cd sub\nmake test\n\n", "cd sub\nmake test"],
    ["comments and continuations stay", "bash", "# build\ngo build \\\n  ./cmd/x", "# build\ngo build \\\n  ./cmd/x"],
    ["CRLF becomes LF", "bash", "a\r\nb\r\n", "a\nb"],
    ["a transcript fenced as bash loses its prompts", "bash", "$ npm install\n$ npm test", "npm install\nnpm test"],
    ["a mixed bash block keeps a literal $ line", "bash", "$ npm install\necho done", "$ npm install\necho done"],
    ["empty block: nothing", "bash", "\n  \n", null],
    ["console: the $ lines, output dropped", "console", "$ go version\ngo version go1.26 darwin/arm64\n$ which go\n/usr/local/go/bin/go", "go version\nwhich go"],
    ["console: a continuation goes with its command", "console", "$ docker run \\\n  --rm alpine\nhello\n$ ls", "docker run \\\n  --rm alpine\nls"],
    ["console without a prompt is ambiguous: nothing", "console", "go version go1.26 darwin/arm64", null],
    ["console with only a bare prompt: nothing", "console", "$ \noutput", null],
    ["other languages: nothing", "python", "print(1)", null],
    ["no language: nothing", "", "ls", null],
    ["shellsession is not offered", "shellsession", "$ ls", null],
  ];
  it.each(cases)("%s", (_name, lang, code, want) => {
    expect(runnableCommand(lang, code)).toBe(want);
  });
});

describe("isStreamingBlock", () => {
  const block = "ls -la\n";
  const cases: [string, string, boolean, boolean][] = [
    ["a finished reply: never", "Run:\n\n```bash\nls -la\n```\n\nDone.", false, false],
    ["streaming, the block is last and open", "Run:\n\n```bash\nls -la", true, true],
    ["streaming, closed but nothing after it yet", "Run:\n\n```bash\nls -la\n```\n", true, true],
    ["streaming, text after the block", "Run:\n\n```bash\nls -la\n```\n\nThen", true, false],
  ];
  it.each(cases)("%s", (_name, text, streaming, want) => {
    expect(isStreamingBlock(text, block, streaming)).toBe(want);
  });
});
