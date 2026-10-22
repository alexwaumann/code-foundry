---
name: code-foundry
description: "Start here for anything about Code Foundry, the app this thread runs in: what it can do and which of its other skills to read. Use when the user asks what you can do here, about its version, model, effort, usage or cost, worktrees, settings, skills or plugins; asks to see a file, diff, page, HTML or chart; states a preference or asks you to remember one; wants a PR; or before you act in the app."
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
| To see a file, a change, a PR, a page or chart you make | `view.panel.file <path>`, `view.panel.diff <path>`, `view.panel.pr <n>`; write a page or chart as an `.html` file |
| A pull request opened, or the project put on GitHub | `code-foundry pr.create`, `code-foundry project.github.publish` |
| Work in parallel, on several branches or PRs, or anything about other threads | the code-foundry-orchestrate skill |
| To build, debug or publish a plugin | the code-foundry-plugin skill |
| To know what exists here | `code-foundry daemon.capabilities`, then `--group <name>` |
| How something works inside the app | its source at the ref in the line under this title, as the help skill's "Reading the source" says |

Load a skill with your Skill tool (or Read its SKILL.md: `daemon.capabilities --group
skills` gives the paths).

## Showing things

Panel verbs open a surface in your own thread's side panel and move nothing else:
`view.panel.file`, `diff`, `pr`, `usage`, `worktree`, `linked-prs`, `agents`, `threads`,
`mcp`, `workspace`. Add `--focus` only when the user asks to be taken there. Page verbs
(`view.projects`, `view.usage`…) move every window: only when asked. A file path in your
reply is a chip that opens the file; an `.html` file renders there interactively (no
server, no browser). Details: code-foundry-help, "Showing things in the app".

## Discovering what exists

`code-foundry daemon.capabilities` prints one line per group: build, commands, pages,
panel, rendering, skills, plugins, settings, memory, presence. Read the index, then only
the group you need (`--group panel`, `rendering`, `commands`; `--json` for both): it reads
the running app, so it is current where these files may not be.

## Good to know

- A **project** is a folder on the Mac; a **thread** is one conversation with an agent in
  it. "Work in" decides where a new thread edits: In place (the project folder itself,
  the default, setting `threads.default_worktree`) or Fresh copy (a worktree and branch).
- The app replaces /model, /effort, /fast, /mcp, /rename and /clear: the composer's
  Model, Effort and Permissions pickers, the MCP panel, Rename Thread, a new thread.
- `$CODE_FOUNDRY_THREAD` is your thread's id. Thread commands without `--id` act on it;
  pass `--id <thread id>` for another (`code-foundry thread list` prints the ids).
- Commands that ask for confirmation exit 2 and do nothing without `--yes`; add it only
  once the user agreed to that exact action.
- The user's standing preferences about the app are in your system prompt; follow them.
