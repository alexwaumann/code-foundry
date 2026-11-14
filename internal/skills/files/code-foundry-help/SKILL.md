---
name: code-foundry-help
description: "Answer how-to questions about Code Foundry, the app this thread runs in: projects, workspaces, threads, worktrees, settings, keybindings, PRs, actions. Use when the user asks how to do something or how it works, wants a setting changed, states a standing preference about the app or how you work in it (remember it), asks to see something, or before you show something in a tab beside you."
---

# Answering questions about Code Foundry

{{cf.provenance}}

## Where to look

- `reference/getting-started.md`: the user guide (Help › Getting Started in the app). Find the
  topic here first and use its words for buttons, pages and shortcuts.
- `reference/settings.md`: every setting: key, title (the Settings page's label), what it does,
  allowed values, default, and whether it needs a daemon restart.
- {{cf.commandsRef}}: every command, also in the palette (⌘K); `code-foundry help <command>`.
- Reading the source, for how it works inside or what these miss:
  `reference/reading-the-source.md`, starting at `docs/ARCHITECTURE.md`; on a `dev build`, say the
  answer comes from that source. Still unanswered, say so rather than guess.

## Explain first, then offer

1. Answer in the app's terms: where to click, which shortcut, which page. Name a setting
   by its Settings page label (Settings › General › New threads work in), not its key.
2. Offer the action in the user's words, as a question: "Want me to make Fresh copy the
   default?" Show the command only if they ask for it.
3. Run it only after the user says yes. Then say what changed (and if it needs a daemon restart).

## Settings

- `code-foundry settings set <key> <value>` validates and writes a value; `settings reset <key>`
  restores the default; `settings get [<key>] --json` reads values with each one's title,
  description, type and default.
- Values: an enum takes one of the values in `reference/settings.md` (quote model ids in the
  shell: `'claude-opus-4-8[1m]'`); a bool `true` or `false`; an int within its bounds; a
  keybinding a chord such as `cmd+shift+n`, or `none` to unbind (`keybindings.thread.new`).
- Never edit settings or theme files by hand: `settings set`; colours, `theme save` (the code-foundry skill).
- A user-only setting (`reference/settings.md`) is refused from a thread: tell the user to change it in Settings.

## Remembering preferences

The app memory holds how you behave in every project ("keep your answers short", "always
open PRs as drafts"). Not a one-off request, nor a fact about the user, a project or its
code ("this repo uses pnpm"): facts go in your own memory files. What holds across a
workspace's projects goes in its `CLAUDE.md` (Workspaces, below). When the user states one:

1. Check `reference/settings.md` first. When a setting covers it, offer that instead.
2. Otherwise save it in the user's words, one line, without asking, and follow it too:
   `code-foundry memory add "<preference>"`, not your own memory files.
3. Confirm in one line, as the command does: "Remembered: …". New threads follow it;
   threads already open get it on their next message after a restart.
4. When it contradicts a saved one, remove the old entry first: `code-foundry memory remove <number or its text>`.

"What do you remember?" is `code-foundry memory show` plus your own memory files, each
labelled; "forget X" acts on whichever holds X; `memory clear --yes` only when asked for.

## Workspaces

A workspace is a saved set of projects with a folder for what spans them. The Projects page has a
page per workspace; Save as workspace in a thread's title menu makes one (`code-foundry workspace new
<name> --projects a,b`). Its folder (`code-foundry workspace list`) holds `CLAUDE.md` and
`.claude/skills/<name>/SKILL.md`: offer to write them (the code-foundry skill's `reference/scopes.md`).
Adding or removing a thread's project (`thread project add|remove`) leaves its workspace.

## The welcome tutorial

A first run ("I just installed Code Foundry", "the welcome tutorial", no projects yet): the
tutorial is a page the app writes at every start, at the path the prompt names
(`{{cf.welcomePage}}`). Open it as a tab beside you only, never inline and never rewritten:
`code-foundry view.open.page <path> --title Welcome`. Then reply with exactly: "Your welcome
page is open in a tab beside this conversation: four steps, each a sentence you could type here. Start
with the first bubble, or tell me which folder on this Mac, or GitHub repository, is your first
project." Do not walk through the page in words. What its buttons do and how to answer its demo:
the code-foundry-pages skill's reference/welcome.md.

## Showing things in the app

- A "show me" is asking: open it as a tab beside you (`view.open.file <path>`,
  `view.open.diff [<path>…]`, `view.open.pr <number>`, `view.open.mcp`; every surface, a
  plugin's too: `code-foundry daemon.capabilities --group panel`); `--focus` only when they ask
  to be taken there. A secret goes in by `view.open.file --edit`.
- A page you make: the code-foundry-pages skill (`view.inline`, with `/cf/theme.css`, and
  `/cf/bridge.js`, which sizes its card).
- Something worth seeing you did on your own (a page, a PR): open it beside you too unless a
  preference says not to, and say so. Do not `ui.notify`: your turn's end alerts the user;
  `ui.presence --json` only to mention a window in the background. Page verbs (`view.projects`…)
  move every window and are refused from a thread no window shows: only when asked, with `--focus`.
