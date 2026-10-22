---
name: code-foundry-help
description: "Answer how-to questions about Code Foundry, the app this thread runs in: projects, threads, worktrees, settings, keybindings, pull requests, actions. Use when the user asks how to do something in it or how it works, wants a setting changed, states a standing preference about the app or how you work in it (remember it), or before you show something in the app's side panel."
---

# Answering questions about Code Foundry

{{cf.provenance}}

What the app is and which skill covers what: the code-foundry skill. Commands you run
(the `code-foundry` CLI, with your Bash tool) change the user's real app.

## Where to look

Read these with your Read tool (they are next to this file) instead of answering from
memory:

- `reference/getting-started.md`: the user guide (Help › Getting Started in the app).
  Find the topic here first and use its words for buttons, pages and shortcuts.
- `reference/settings.md`: every setting, one entry each: key, title, what it does,
  type and allowed values, default, and whether it needs a daemon restart.
- `reference/commands.md`: the commands for projects, settings, threads, pull requests,
  actions and views. Every button and menu item in the app is one of these commands,
  also found in the command palette (⌘K). `code-foundry help <command>` prints every
  flag of one.

If none of these covers the question, read the source (below); if that does not answer
it either, say so rather than guess; the Help menu has a way to report a problem.

## Reading the source

For how Code Foundry works inside, or behaviour the references do not cover, read its
source; never answer that from memory. The line under this file's title gives the build
and its source, `https://github.com/<owner>/<repo>/tree/<ref>` (a public repository; with
no `/tree/<ref>`, use `main`). Read files at that ref with your own tools:

- WebFetch `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, or, when
  `gh` is installed, `gh api 'repos/<owner>/<repo>/contents/<path>?ref=<ref>' -H
  'Accept: application/vnd.github.raw'` (for a directory, drop the header: it lists it).
- Start at `docs/ARCHITECTURE.md`, then read the package it names for the topic (for
  example `internal/store/thread/` for threads) and follow the code from there.
- Cite the file paths your answer rests on. Only the code says how the build works:
  design notes and comments can be out of date, so confirm in the code.
- If the line says `dev build`, say that the answer comes from that source, which may
  not match the build the user is running.

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
  `code-foundry settings get [<key>]` reads the current values (`--json` adds each one's
  title, description, type and default).
- Values: an enum takes one of the values listed in `reference/settings.md` (quote model
  ids in the shell: `'claude-opus-4-8[1m]'`); a bool `true` or `false`; an int within its
  bounds; a keybinding a chord such as `cmd+shift+n`, or `none` to unbind.
- Keyboard shortcuts are settings too: `keybindings.<command>`, for example
  `code-foundry settings set keybindings.thread.new cmd+shift+n`.
- Never edit the settings file (settings.toml, `code-foundry settings path`) by hand:
  always go through `settings set`, which checks the value. Most settings apply at once
  in every window.
- The Settings page (⌘,) shows the same settings; its search box finds one by name.

## Remembering preferences

When the user states a standing preference about the app or about how you behave in it
("don't open the side panel on your own", "always open PRs as drafts", "explain git terms
when you use them"); a one-off request about the task at hand is not one:

1. Check `reference/settings.md` first. When a setting covers it, offer that instead.
2. Otherwise save it in the user's words, one line, without asking:
   `code-foundry memory add "<preference>"`. Every thread in every project gets it.
3. Confirm in one line, and say it applies to threads started from now on (follow it
   in this thread yourself).
4. When it contradicts a saved one, remove the old entry first:
   `code-foundry memory remove <number>` (or text only that entry has).

"What do you remember?" is `code-foundry memory show`. `memory clear --yes` forgets them
all, only when the user asks for exactly that.

## Showing things in the app

After something worth seeing, you may open it in this thread's side panel
(`view.panel.linked-prs` after opening a pull request, `view.panel.worktree` after
changing files); from this thread it changes only its panel, never what the user sees.
First run `code-foundry ui.presence --json`: open it only when `viewed` is true (a window
shows this thread) and no saved preference says not to; otherwise say it in your reply,
or `code-foundry ui.notify --title "<what happened>"` if the user should know now. Never
pass `--focus` (it pulls every window to this thread) unless the user asked for it.
`code-foundry daemon.capabilities --group panel` lists every surface and its verb.
