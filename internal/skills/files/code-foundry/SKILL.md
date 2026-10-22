---
name: code-foundry
description: "Start here for anything about Code Foundry, the app this thread runs in: what it can do, what the user can ask you to do in it, and which of its other skills to read. Use when the user asks what you can do here or about the app, its pages, side panel, threads, settings, skills or plugins, before you act in the app, or when you are unsure which code-foundry skill applies."
user-invocable: false
---

# Code Foundry: start here

{{cf.provenance}}

Code Foundry is the macOS app this thread runs in: it runs Claude Code threads
(conversations like this one) on the user's projects, each in the project's folder or in
its own git worktree, and shows them in one window with a sidebar, pages and a side panel
per thread. A daemon on the Mac does the work and the `code-foundry` CLI drives it: every
button and menu item in the app is a command you can run too. Commands you run change the
user's real app.

## The one rule

The user can ask you for anything about or in the app; if you can do it with the CLI,
offer it and do it. A question ("how do I…?") gets the answer and the offer; run a change
once the user says yes (code-foundry-help, "Explain first, then offer"). Skills never run
commands themselves: you run `code-foundry …` with your Bash tool.

## Which skill

| The user wants | Read or run |
|---|---|
| How to do something, a setting or keybinding, a standing preference, or something shown in the app (a page, the side panel) | the code-foundry-help skill |
| Work in parallel, on several branches or PRs, or anything about other threads | the code-foundry-orchestrate skill |
| To build, debug or publish a plugin | the code-foundry-plugin skill |
| To know what exists here | `code-foundry daemon.capabilities`, then `--group <name>` |
| How something works inside the app | its source at the ref in the line under this title, as the help skill's "Reading the source" says |

Load a skill with your Skill tool (or Read its SKILL.md: `daemon.capabilities --group
skills` gives the paths).

## Discovering what exists

`code-foundry daemon.capabilities` prints one line per group: build, commands, pages,
panel, rendering, skills, plugins, settings, memory, presence. Read the index, then only
the group you need: `--group panel` before you open something in the side panel,
`--group rendering` before you rely on how a reply shows (a path becomes a chip that
opens the file), `--group commands` for every verb. `--json` works for both. It reads the
running app, so it is current where these files (written at the app's start) may not be.
`code-foundry help <command>` prints one command's flags.

## Good to know

- A **project** is a folder on the Mac; a **thread** is one conversation with an agent in
  it. "Work in" decides where a new thread edits: the project folder itself (In place)
  or a worktree with its own branch (Fresh copy).
- `$CODE_FOUNDRY_THREAD` is your thread's id. Thread commands without `--id` act on it;
  pass `--id <thread id>` for another (`code-foundry thread list` prints the ids).
- Commands that ask for confirmation exit 2 and do nothing without `--yes`; add it only
  once the user agreed to that exact action.
- The user's standing preferences about the app are in your system prompt; follow them.
