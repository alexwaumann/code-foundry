---
name: code-foundry-help
description: "Answer how-to questions about Code Foundry, the app this thread runs in: projects, workspaces, threads, worktrees, settings, keybindings, PRs, actions. Use when the user asks how to do something or how it works, wants a setting changed, states a standing preference about the app or how you work in it (remember it), asks to see something, or before you show something in the app's side panel."
---

# Answering questions about Code Foundry

{{cf.provenance}}

What the app is and which skill covers what: the code-foundry skill. Commands change the real app.

## Where to look

Read these (next to this file) with your Read tool instead of answering from memory:

- `reference/getting-started.md`: the user guide (Help › Getting Started in the app). Find the
  topic here first and use its words for buttons, pages and shortcuts.
- `reference/settings.md`: every setting: key, title (the Settings page's label), what it does,
  allowed values, default, and whether it needs a daemon restart.
- `reference/commands.md`: the commands, also in the palette (⌘K); `code-foundry help <command>`.

None covers it: read the source (below); still unanswered, say so rather than guess.

## Reading the source

For how Code Foundry works inside, or behaviour the references do not cover, read its
source; never answer that from memory. The line under this file's title gives the build
and its source, `https://github.com/<owner>/<repo>/tree/<ref>` (a public repository; with
no `/tree/<ref>`, use `main`). Read files at that ref with your own tools:

- WebFetch `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, or, when
  `gh` is installed, `gh api 'repos/<owner>/<repo>/contents/<path>?ref=<ref>' -H
  'Accept: application/vnd.github.raw'` (for a directory, drop the header: it lists it).
- When the ref 404s, use the `commit` from `code-foundry daemon.version --json` as the
  ref; when that 404s too (a local build), use `main` and say so.
- Start at `docs/ARCHITECTURE.md`, then read the package it names for the topic (for
  example `internal/store/thread/` for threads) and follow the code from there.
- Cite the file paths your answer rests on; notes and comments may be stale, the code is not.
- If the line says `dev build`, say the answer comes from that source, not their build.

## Explain first, then offer

1. Answer in the app's terms: where to click, which shortcut, which page. Name a setting
   by its Settings page label (Settings › Threads › New threads work in), not its key.
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

A workspace is a saved set of projects (a product's repos) with a folder for the instructions and
skills that span them. The Projects page has a card per workspace (projects, instructions file,
skills); Save as workspace in a thread's title menu makes one (`code-foundry workspace new <name>
--projects a,b`). Its folder (`code-foundry workspace list`) holds `CLAUDE.md` and
`.claude/skills/<name>/SKILL.md`: offer to write them (the code-foundry skill's "Scopes"). Adding
or removing a thread's project (card's project menu, `thread project add|remove`) leaves its workspace.

## The welcome tutorial

A first run ("I just installed Code Foundry", "the welcome tutorial", no projects yet): the
tutorial is a page the app writes at every start, at the path the prompt names
(`{{cf.welcomePage}}`). Open it in the side panel only, never inline and never rewritten:
`code-foundry view.panel.page <path> --title Welcome`. Then reply with exactly: "Your welcome
page is open in the panel on the right: four steps, each a sentence you could type here. Start
with the first bubble, or tell me which folder on this Mac, or GitHub repository, is your first
project." Do not summarise or walk through the page in words; it walks the user through
itself. What its buttons do and how to answer its demo: the code-foundry-pages skill's
reference/welcome.md.

## Showing things in the app

When the user asks to see something, open it in your own thread's side panel:
`view.panel.file <path>`, `view.panel.diff <path>`, `view.panel.pr <number>`, `view.panel.mcp`;
`code-foundry daemon.capabilities --group panel` lists every surface. A "show me" is asking: just
open it. Add `--focus` only when they ask to be taken there; it selects this thread in every
window. A page, chart, form or checklist you make (asked "as a page", or one they can fill in) is
an `.html` file in `$CODE_FOUNDRY_PAGES` (not markdown, no server, no browser, never the repository
or home folder): show it inline with `code-foundry view.inline <path>` (`--panel` also opens it
beside the thread); one that reads or changes the app: the code-foundry-pages skill. Have it link
`<link rel="stylesheet" href="/cf/theme.css">` and paint with its `--cf-*` variables
(the code-foundry skill names them; every slot and what it paints: reference/themes.md) or the
type-role classes (`text-title`, `text-body`…), never fixed colours or
`prefers-color-scheme`. To follow a theme switch live, set each var of the
message `{type: "cf:theme", id, scheme, vars}` on `<html>`, then reply
`{type: "cf:theme:ack"}` to its parent to keep your state (else the frame reloads).
`<script src="/cf/bridge.js"></script>` does that for the page and sizes its card.

After you do something worth seeing on your own (a page you wrote, a pull request you
opened), open it in your own panel too unless a saved preference says not to, and say so
in your reply. Do not `ui.notify`: the end of your turn already alerts the user.
`code-foundry ui.presence --json` is only for deciding whether to mention that the
window is in the background. Page verbs (`view.projects`, `view.usage`…) move every
window and are refused from a thread no window shows: run one only when the user asks
for that page, with `--focus`.
