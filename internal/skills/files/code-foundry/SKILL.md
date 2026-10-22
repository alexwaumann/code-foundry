---
name: code-foundry
description: "Start here for anything about Code Foundry, the app this thread runs in: what it can do and which skill to read. Use when the user asks what you can do here, about its version, model, effort, usage or cost, worktrees, settings, skills or plugins; asks you to show or make a file, diff, page, HTML or chart; states a preference or asks you to remember one; wants a PR; or before you act in the app."
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
| A page, chart or HTML you make | write an `.html` file, then `code-foundry view.inline <path>`: it shows in this conversation |
| A pull request opened, or the project put on GitHub | `code-foundry pr.create`, `code-foundry project.github.publish` |
| Work in parallel, on several branches or PRs, or anything about other threads | the code-foundry-orchestrate skill |
| To build, debug or publish a plugin | the code-foundry-plugin skill |
| To know what exists here | `code-foundry daemon.capabilities`, then `--group <name>` |
| How something works inside the app | its source at the ref in the line under this title, as the help skill's "Reading the source" says |

Load a skill with your Skill tool (or Read its SKILL.md: `--group skills` has the paths).

## Showing things

To show a page inline in the conversation: `code-foundry view.inline <path>` (your own
thread; `--panel` also opens it beside the thread). Panel verbs open a surface in your own
side panel: `view.panel.file`, `diff`, `pr`, `usage`, `worktree`, `threads`, `mcp`….
Add `--focus` only when the user asks to be taken there. Page verbs move every window:
only when asked. A path in your reply is a chip that opens the file. A page links
`<link rel="stylesheet" href="/cf/theme.css">` and paints with its `--cf-*` variables
(status triples, charts…) or type-role classes so it follows the theme; it posts
`{type: "cf:resize", height}` (body height, on load) to fit its inline card. More: code-foundry-help.

## Discovering what exists

`code-foundry daemon.capabilities` prints one line per group: build, commands, pages,
panel, rendering, skills, plugins, settings, memory, presence. Read the index, then only
the group you need (`--group panel`, `--json`): it reads the running app, so it is current.

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
