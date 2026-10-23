---
name: code-foundry
description: "Start here for anything about Code Foundry, the app this thread runs in: which skill to read. Use when the user asks what you can do, about its version, model, effort, usage, cost, worktrees, settings, skills or plugins; asks you to show or make a file, diff, page, HTML, chart or theme, or to change the app's colours; states a preference to remember; wants a PR; or before you act in the app."
user-invocable: false
---

# Code Foundry: start here

{{cf.provenance}}

Code Foundry is the macOS app this thread runs in: it runs Claude Code threads
(conversations like this one) on the user's projects and shows them in one window with a
sidebar, pages and a side panel per thread. The `code-foundry` CLI drives it (most
buttons and menu items are commands you can run too) and changes the user's real app.

## The one rule

The user can ask you for anything about or in the app; if you can do it with the CLI,
offer it and do it. A question ("how do I…?") gets the answer and the offer; run a change
once the user says yes (code-foundry-help, "Explain first, then offer"). Skills never run
commands themselves: you run `code-foundry …` with your Bash tool.

Talk about the app as the user sees it: pages, buttons, the side panel, Settings labels.
Never tell the user skill or command names: say what you will do, not which command.

## Which skill or command

| The user wants | Read or run |
|---|---|
| How to do something, a setting or keybinding | the code-foundry-help skill |
| A standing preference ("keep answers short", "always open PRs as drafts") | `code-foundry memory add <text>` (help: "Remembering preferences") |
| What it cost, token usage | `code-foundry usage.show` (`--all` for every thread), not /cost or ~/.claude |
| To see a file, a change or a PR | `view.panel.file <path>`, `view.panel.diff <path>`, `view.panel.pr <n>` |
| A page, chart or HTML you make; a form, checklist or countdown "as a page" or "I can fill in" | an `.html` file in `$CODE_FOUNDRY_PAGES`, then `code-foundry view.inline <path>`: it shows in this conversation (not markdown) |
| The app's colours, in any thread: a theme, "sidebar quieter", "less contrast", the accent | "Making a theme" below |
| A pull request opened, or the project put on GitHub | `code-foundry pr.create`, `code-foundry project.github.publish` |
| Work in parallel, on several branches or PRs, or anything about other threads | the code-foundry-orchestrate skill |
| To build, debug or publish a plugin | the code-foundry-plugin skill |
| To know what exists here | `code-foundry daemon.capabilities`, then `--group <name>` (build, commands, pages, panel, rendering, skills, plugins, settings, memory, presence; `--json`): it reads the running app |
| How something works inside the app | its source at the ref in the line under this title, as the help skill's "Reading the source" says |

Load a skill with your Skill tool (or Read its SKILL.md: `--group skills` has the paths).

## Showing things

To show a page inline in the conversation: `code-foundry view.inline <path>` (your own
thread; `--panel` also opens it beside the thread). Panel verbs open a surface in your own
side panel: `view.panel.file`, `diff`, `pr`, `usage`, `worktree`, `threads`, `mcp`….
Add `--focus` only when the user asks to be taken there. Page verbs move every window:
only when asked. A path in your reply is a chip that opens the file.

Write a page in `$CODE_FOUNDRY_PAGES` (your thread's own folder), never in the repository
or the home folder. It links `<link rel="stylesheet" href="/cf/theme.css">` and paints only
with its `--cf-*` variables: `--cf-canvas`, `--cf-surface`, `--cf-surface-raised`,
`--cf-text`, `--cf-text-muted`, `--cf-accent`, `--cf-border` and the status fills
`--cf-success`, `--cf-warning`, `--cf-error` (their text `-text`, tint `-surface`), or the
type-role classes (`text-title`, `text-body`…); never fixed colours or `prefers-color-scheme`.
It posts `{type: "cf:resize", height}` (body height, on load) to fit its inline card.
`view.inline` warns about what a page misses. More: code-foundry-help.

## Making a theme

Every colour change is `code-foundry theme save --file <path> --apply` (a card with Undo); never
edit the themes folder. Verbs: `theme list|show|save|check|edit|duplicate|delete|restore|set-dark|`
`set-light|set-scheme|ask`. Copy the closest (`theme show <id>`) into `$CODE_FOUNDRY_PAGES` with a
new `id`, `name` and `from` (the theme copied; `pair` only for your own). Change base colours first;
pin `overrides` only where a rule is wrong ({{cf.themesRef}}). Body text keeps 7:1, status text
4.5:1: for less contrast move `surface` and `canvas` toward the text, never the text. Fix every
pair the save's `contrast:` lists before you reply. A theme this thread did not make needs
`--replace`, once the user asked to change it. A light theme while the app is dark changes nothing
on screen: say so, offer `theme set-scheme light`, never switch unasked. Reply in a sentence or two.

## Good to know

- A **project** is a folder on the Mac; a **thread** is one conversation with an agent in
  it. The composer's "Work in" places the user's own threads: In place (the project
  folder) or Fresh copy (a worktree and branch), default `threads.default_worktree`.
  Threads you create with `thread new` are yours to place: in place or `--new-worktree`.
- The app replaces /model, /effort, /fast, /mcp, /rename and /clear: the composer's
  Model, Effort and Permissions pickers, the MCP panel, Rename Thread, a new thread.
- `$CODE_FOUNDRY_THREAD` is your thread's id. Thread commands without `--id` act on it.
- Commands that ask first exit 2 without `--yes`: add it once the user agreed to that act.
- The user's standing preferences about the app are in your system prompt; follow them.
