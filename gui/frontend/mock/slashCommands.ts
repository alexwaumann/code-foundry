/**
 * A running thread's slash commands in the mock daemon (docs/notes/slash-commands-1-daemon.md,
 * docs/notes/slash-commands-2-gui.md): Claude's list as the daemon passes it on (the
 * replaced and terminal-only built-ins already dropped), in Claude's order: the project's
 * skills (`deploy`, `review`, as mock/filesystem.ts scans them; Claude appends
 * " (project)"), the user's `commit`, built-ins and bundled skills, then a plugin's
 * skills. Seeded with the MCP status on running threads (mock/thread.ts load and seed);
 * POST /__mock/thread/commands replaces it and publishes the Watch's `commands` event.
 *
 * Send refuses a message whose first word is a command the app replaces, with the
 * daemon's exact text (internal/store/thread/slashdeny.go).
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { SlashCommandSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { CommandError } from "./errors";

export type SlashCommandInit = MessageInitShape<typeof SlashCommandSchema>;

const builtin = (name: string, description: string, argumentHint = "", aliases: string[] = []): SlashCommandInit => ({ name, description, argumentHint, aliases, builtin: true });

/** The list a running mock thread offers. */
export function slashCommandsFixture(): SlashCommandInit[] {
  return [
    { name: "deploy", description: "Ship the current branch to staging. (project)" },
    { name: "review", description: "Review the diff against the base branch. (project)" },
    { name: "commit", description: "Write a commit message and commit." },
    builtin(
      "code-review",
      "Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simplification/efficiency cleanups where the model's review recipe covers them) at the given effort level.\nWith no level given, it reuses the level you typed last.",
      "[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<pr#>|<branch>|<path>]",
      ["review"],
    ),
    builtin("simplify", "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes.", "[<target>]"),
    builtin("loop", "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo).", "[interval] [prompt]", ["proactive"]),
    builtin("compact", "Free up context by summarizing the conversation so far", "<optional custom summarization instructions>"),
    builtin("context", "Show current context usage"),
    builtin("init", "Initialize a new CLAUDE.md file with codebase documentation"),
    builtin("security-review", "Complete a security review of the pending changes on the current branch"),
    builtin("usage", "Show session cost, plan usage, and what's contributing to your limits", "", ["cost", "stats"]),
    builtin("recap", "Generate a one-line thread recap now"),
    { name: "pdf", description: "Use this skill whenever the user wants to do anything with PDF files.", aliases: ["anthropic-skills:pdf"] },
    { name: "anthropic-skills:deep-research", description: "Use this skill when the user's prompt requires researching a topic across multiple sources." },
  ];
}

/** POST /__mock/thread/commands?set=…: none (the process ended), more (a skill appeared), default. */
export function slashCommandsFor(set: string): SlashCommandInit[] {
  if (set === "none") return [];
  const list = slashCommandsFixture();
  if (set === "more") list.splice(2, 0, { name: "gamma", description: "A skill written while the thread ran. (project)" });
  return list;
}

const REFUSALS: Readonly<Record<string, string>> = {
  model: "Change the model with the composer's model selector (or `thread.set-model`), not /model.",
  effort: "Change the effort with the composer's effort selector (or `thread.set-effort`), not /effort.",
  fast: "Pick the model with the composer's model selector (or `thread.set-model`), not /fast.",
  mcp: "Manage MCP servers in the MCP panel (or `thread.mcp`), not /mcp.",
  rename: "Rename the thread with Rename Thread (or `thread.rename`), not /rename.",
  clear: "Start a new thread instead of clearing this one.",
};
const ALIASES: Readonly<Record<string, string>> = { reset: "clear", new: "clear", name: "rename" };

/** Throws the daemon's refusal (InvalidArgument) for a message that starts with a replaced command. */
export function refuseSlashCommand(text: string): void {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const m = /^\s*\/(\S+)/.exec(first);
  if (!m?.[1]) return;
  const name = ALIASES[m[1]] ?? m[1];
  const refusal = REFUSALS[name];
  if (refusal) throw new CommandError("invalid", refusal);
}
