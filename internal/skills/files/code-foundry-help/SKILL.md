---
name: code-foundry-help
description: "Answer how-to questions about Code Foundry, the app this thread runs in: projects, threads, worktrees, settings, keybindings, pull requests, actions, workspaces. Use when the user asks how to do something in Code Foundry or wants a setting changed; explain, then offer to run the command."
---

# Answering questions about Code Foundry

{{cf.provenance}}

Code Foundry is the macOS app this thread runs in. It runs Claude Code threads on the
user's projects (folders on their Mac), each thread in the project's folder or in its own
worktree. A daemon on the Mac does the work; the window shows it; the `code-foundry` CLI,
which you can run with your Bash tool, drives the same daemon. Commands you run change
the user's real app.

## Where to look

Read these with your Read tool (they are next to this file) instead of answering from
memory:

- `reference/getting-started.md`: the user guide (in the app under Help › Getting
  Started). Find the topic here first and use its words for buttons, pages and
  shortcuts.
- `reference/settings.md`: every setting, one entry each: key, title, what it does,
  type and allowed values, default, and whether it needs a daemon restart.
- `reference/commands.md`: the commands for projects, settings, threads, pull requests
  and actions. Every button and menu item in the app is one of these commands, also
  found in the command palette (⌘K).
- `code-foundry help <command>` prints every flag of one command (for a flag you do not
  see in the references); `code-foundry commands` lists them all.
- The current values: `code-foundry settings get` (every setting) or
  `code-foundry settings get <key>`; `--json` adds each setting's title, description,
  type and default.

If none of these covers the question, say so rather than guess; the Help menu has a way
to report a problem.

## Explain first, then offer

1. Answer in the app's terms: where to click, which shortcut, which page.
2. When a command does it, propose the exact command in one sentence and ask, for
   example: "I can run `code-foundry settings set threads.default_model 'claude-sonnet-5[1m]'`
   for you. Want me to?"
3. Run it only after the user says yes. Then report what it printed: the new value, and
   "(applies after a daemon restart)" when the setting needs one.
4. Commands that ask for confirmation (removing, deleting, merging, restarting) exit 2
   and do nothing without `--yes`. Add `--yes` only once the user agreed to that exact
   action, and say what it will do before you run it.

A question is not a request: "how do I change the model?" gets the explanation and the
offer, not a change.

## Settings

- `code-foundry settings set <key> <value>` validates the value against the setting's
  type and writes it; `code-foundry settings reset <key>` returns it to its default;
  `code-foundry settings get [<key>]` reads.
- Values: an enum takes one of the values listed in `reference/settings.md` (quote model
  ids in the shell: `'claude-opus-4-8[1m]'`); a bool `true` or `false`; an int within its
  bounds; a keybinding a chord such as `cmd+shift+n`, or `none` to unbind.
- Keyboard shortcuts are settings too: `keybindings.<command>`, for example
  `code-foundry settings set keybindings.thread.new cmd+shift+n`.
- Never edit the settings file (settings.toml, `code-foundry settings path`) by hand:
  always go through `settings set`, which checks the value. Most settings apply at once
  in every window.
- The Settings page (⌘,) shows the same settings; its search box finds one by name.

## Good to know

- A **project** is a folder on the Mac; a **thread** is one conversation with an agent in
  it. "Work in" decides where a new thread edits: the project folder itself (In place)
  or a fresh copy, a worktree with its own branch (Fresh copy).
- Thread commands without `--id` act on this thread (`$CODE_FOUNDRY_THREAD`). To act on
  another thread, pass `--id <thread id>`; `code-foundry thread list` prints the ids.
- To delegate work to other threads, use the code-foundry-orchestrate skill.
