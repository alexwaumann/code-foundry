import { act, cleanup, render, screen, within } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillView } from "@/api/filesystem";
import type { SlashCommandView } from "@/api/slashCommands";
import { skillSourcesKey } from "@/lib/completion";
import { useSkillsStore } from "@/stores/skills";
import { CompletionCard } from "./CompletionCard";
import type { EditorTrigger, PromptEditorHandle } from "./PromptEditor";
import { useCompletion, useSlashSource } from "./useCompletion";

/**
 * A thread composer's "/" card (useSlashSource over CompletionCard,
 * docs/notes/slash-commands-2-gui.md) with the mock's running s-r1 list (mock/slashCommands.ts)
 * and its disk scan (mock/filesystem.ts: the project's deploy and review, the user's commit).
 * The grouping rule itself: src/lib/completion.test.ts.
 */

const CF = "/Users/dev/src/code-foundry";
const SOURCES = [{ projectId: "repo-cf", path: CF }];
const KEY = skillSourcesKey(SOURCES);

const builtin = (name: string, description: string, argumentHint = "", aliases: string[] = []): SlashCommandView => ({ name, description, argumentHint, aliases, builtin: true });
const skill = (name: string, description: string, aliases: string[] = []): SlashCommandView => ({ name, description, argumentHint: "", aliases, builtin: false });

function running(more = false): SlashCommandView[] {
  const list = [
    skill("deploy", "Ship the current branch to staging. (project)"),
    skill("review", "Review the diff against the base branch. (project)"),
    skill("commit", "Write a commit message and commit."),
    builtin(
      "code-review",
      "Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model's review recipe covers them) at the given effort level.\nWith no level given, it reuses the level you typed last.",
      "[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<pr#>|<branch>|<path>]",
      ["review"],
    ),
    builtin("compact", "Free up context by summarizing the conversation so far", "<optional custom summarization instructions>"),
    builtin("context", "Show current context usage"),
    skill("pdf", "Use this skill whenever the user wants to do anything with PDF files.", ["anthropic-skills:pdf"]),
  ];
  if (more) list.splice(2, 0, skill("gamma", "A skill written while the thread ran. (project)"));
  return list;
}

const SCANNED: SkillView[] = [
  { name: "deploy", description: "Ship the current branch to staging.", scope: "project", projectId: "repo-cf", path: `${CF}/.claude/skills/deploy/SKILL.md` },
  { name: "review", description: "Review the diff against the base branch.", scope: "project", projectId: "repo-cf", path: `${CF}/.claude/skills/review/SKILL.md` },
  { name: "commit", description: "Write a commit message and commit.", scope: "user", projectId: "", path: "/Users/dev/.claude/skills/commit/SKILL.md" },
];

const SLASH: EditorTrigger = { char: "/", query: "", from: 0, to: 1 };

function Card({ commands }: { commands: readonly SlashCommandView[] }) {
  const editorRef = useRef({ insertTag: () => undefined, insertText: () => undefined } as unknown as PromptEditorHandle) as RefObject<PromptEditorHandle | null>;
  const source = useSlashSource(SLASH, commands, KEY, ["repo-cf"]);
  const completion = useCompletion(SLASH, () => undefined, source, editorRef);
  return <CompletionCard completion={completion} above />;
}

const headings = () => screen.queryAllByTestId("completion-group").map((h) => h.textContent);
const labels = () => screen.getAllByTestId("completion-label").map((l) => l.textContent);
const item = (label: string) => {
  const el = screen.getAllByTestId("completion-item").find((i) => within(i).getByTestId("completion-label").textContent === label);
  if (!el) throw new Error(`no ${label}`);
  return el;
};

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  useSkillsStore.setState({ byKey: { [KEY]: { status: "ready", skills: SCANNED, outdated: false } } });
});

afterEach(() => {
  cleanup();
  useSkillsStore.setState({ byKey: {} });
});

describe("the running thread's / card", () => {
  it("groups its commands: the project's skills first (no heading for one project), User, Skills, Claude Code last", () => {
    render(<Card commands={running()} />);
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Slash commands");
    expect(headings()).toEqual(["User", "Skills", "Claude Code"]);
    expect(labels()[0]).toBe("/deploy");
    expect(within(item("/compact")).getByTestId("completion-hint").textContent).toBe("<optional custom summarization instructions>");
    // A paragraph-long description shows its first line only.
    expect(item("/code-review").textContent).toContain("at the given effort level.");
    expect(item("/code-review").textContent).not.toContain("reuses the level");
  });

  it("follows the list: none (the process ended) falls back to the disk scan; a skill Claude saw appear goes under Skills", () => {
    const view = render(<Card commands={running()} />);
    expect(headings()).toEqual(["User", "Skills", "Claude Code"]);
    act(() => {
      view.rerender(<Card commands={[]} />);
    });
    expect(headings()).toEqual(["User"]);
    expect(labels()).toEqual(["/deploy", "/review", "/commit"]);
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Skills");
    act(() => {
      view.rerender(<Card commands={running(true)} />);
    });
    expect(headings()).toEqual(["User", "Skills", "Claude Code"]);
    const skills = screen.getAllByRole("group").find((g) => within(g).queryByTestId("completion-group")?.textContent === "Skills");
    expect(skills?.textContent).toContain("/gamma");
  });
});
