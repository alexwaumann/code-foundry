# daemon.capabilities and the code-foundry entry skill (2026-10-22)

A thread could learn about Code Foundry only from three skills, each about one job, and
nothing told it what the app as a whole can do: which pages and panel surfaces exist,
what its replies render as, what is installed. Now a thread finds out in two steps, an
index and then one group: a live verb, `daemon.capabilities`, and a short entry skill,
`code-foundry`, that every thread's system prompt names first and that routes to the
other skills. Daemon, CLI and skill text; no GUI or proto change.

## daemon.capabilities

`internal/command/commands_capabilities.go` (category Daemon, NoKeybinding). With no
args it prints an index of one line per group: name, a count, a one-line description
(12 lines on a real daemon). `--group <name>` (an Enum of the group names) prints one
group in detail; `--json` works for both. Groups are a registry (`capGroups`): a group is
an entry with a loader that returns its count, index summary, text and JSON.

| Group | Read from |
|---|---|
| build | `version.Info` (same fields as `daemon.version --json`, plus the dev-build caveat of the provenance line) |
| commands | the registry: count per category, then names and titles as one wrapped paragraph per category |
| pages | the registry: `view.<name>` verbs with one segment after `view.`, except `view.back` and `view.forward` (`notPages`) |
| panel | the registry: `view.panel.*` verbs except the four actions (the existing `ViewPanel*` constants), the description after its first ": " as what the surface shows; plugin surfaces from the plugin store; the `ui.presence` rule |
| rendering | `Renderings`, a hand-kept list (below) |
| skills | `skills.Shipped` (the embedded SKILL.md frontmatter of every skill `Render` ships) and the skill store's installed skills and Claude Code plugins |
| plugins | `PluginService.List`: name, version, state, commands, surfaces |
| settings | the settings schema: fields per group |
| memory | the memory store's entry count and the registry's `memory.*` verbs |
| presence | the same deps and text as `ui.presence`, for the caller's thread |

The index reads every group; one that fails says "(unavailable: …)" on its line and the
rest still list. `--group` on a failing group is an error. A daemon (or test) without the
plugin store (Unimplemented) lists no plugins rather than failing.

## Decisions

* **Pages and surfaces from the registry**, not a list: a new `view.<page>` verb or
  `view.panel.<surface>` verb shows up by itself. What is *not* a page or surface is the
  exception list, and it reuses the ShowView constants that already exist.
* **Rendering is the one hand-kept group** (`commands_capabilities_rendering.go`, with a
  comment naming the frontend files to check): what the window draws lives in the
  frontend. Checked against the GUI for this PR: GFM markdown with a short inline-HTML
  allow list (`lib/inlineHtml.ts`) and `html: false` for replies; Copy on every block,
  Run in terminal only on finished shell blocks in replies; path chips (`:N`, `:N:C`,
  `#L12-L30`) open the File tab; https images inline, local ones as chips, data: URIs not
  rendered; Read of an image inline in the tool detail; PDFs only as attachments and in
  the File tab; HTML rendered interactively in the File tab, reached only through a path
  chip (no CLI verb opens the File tab); edits as diffs; no math or mermaid.
* **Plugin surfaces are listed with their `plugin.<p>.show.<id>` verb** and the note that
  it acts on each window's selection: unlike `view.panel.*`, it has no `--thread`.
* **Skill purposes are the description's first clause** (up to ": " or ". "), so each
  skill's one-line purpose is not a second hand-kept string. The marketplace group lists
  local skills in `~/.claude/skills` too, marked local, since the skill store reports them.
* **commands detail** is one wrapped paragraph per category (77 lines for 180 commands)
  rather than a line per command (211): `code-foundry commands` already has the table.
* `CapabilitiesDeps` takes narrow interfaces (`MemoryReader`, `PluginLister`,
  `SkillSnapshotter`, `SettingsSchemaReader`); `all.Deps` gains only `ShippedSkills`. The
  daemon builds the shipped list once (`internal/daemon/skills.go`), since the files are
  embedded.

## The entry skill

`internal/skills/files/code-foundry/SKILL.md`, `user-invocable: false`, 57 lines (cap 70),
description 374 characters. It says what the app is, the one rule ("the user can ask you
for anything about or in the app; if you can do it with the CLI, offer it and do it",
with a question still getting the offer first), that skills never run commands (the model
does, with its Bash tool), a routing table (help, orchestrate, plugin,
`daemon.capabilities` then `--group`, and the source at the provenance line's ref via
help's "Reading the source"), when to read which group, and the general rules that moved
out of help. It carries `{{cf.provenance}}`; `TestRender` checks its phrases and that it
names every capabilities group.

`ThreadPrompt` now starts "Its skill code-foundry says what the app can do and which of
its other skills to read (code-foundry-help to answer questions about the app,
code-foundry-orchestrate to delegate work to other threads, code-foundry-plugin to build
plugins)." The orchestration sentence is unchanged.

## The help skill

From 119 to 104 lines (cap lowered from 120 to 105), description from 387 to 374
characters with "or before you show something in the app's side panel" added. Moved to
the entry skill: what the app is (five lines, now one pointer), `code-foundry commands`,
and the whole "Good to know" section (project and thread, Work in, the `--id` default,
the orchestrate pointer). The settings `--json` detail moved into the Settings section.
"(explain, then offer the command)" left the description; the "Explain first, then
offer" section is unchanged. "Showing things in the app" points at `daemon.capabilities
--group panel`. The rule about `--yes` is in both skills (help's step 4 and the entry's
good-to-know).

## Gotchas

* Claude records the system prompt per conversation, so threads that exist already keep
  the old line until a compaction; the entry skill reaches them anyway through the skills
  dir, which every spawn passes.
* The skills group's marketplace part comes from the skill store's snapshot, which is
  empty until its first read after start.
* Stopping an isolated daemon by `pkill -f <path>/bin/code-foundry` misses one started
  through `PATH`; use the pid from `daemon status --json`.

## End to end (2026-10-22, isolated home)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-cap code-foundry daemon --dev` with the branch's
`bin` first on `PATH` and no `CLAUDE*`/`CODE_FOUNDRY_*` variables.

```
$ code-foundry daemon.capabilities
Code Foundry dev (commit 6f6b201485ae): what this app can do, by group.
build            dev, source https://github.com/alexwaumann/code-foundry/tree/6f6b2014…
commands    180  commands in 15 categories; every button, menu item and CLI verb is one
pages         6  main-pane pages and the verb that shows each
panel         7  side panel surfaces and the verb that opens each in a thread
rendering     9  what the thread view renders: markdown, code, paths, images, PDFs, HTML
skills        4  skills every thread gets, 1 more installed for Claude Code
plugins       0  installed plugins with their commands and surfaces
settings    153  settings in 11 groups; values with code-foundry settings get --json
memory        0  remembered standing preferences (memory.* verbs)
presence         none (no app window is open)
Details: code-foundry daemon.capabilities --group <name> (--json for either).
```

Every `--group` and `--json` was run; `<home>/claude/.claude/skills/code-foundry/SKILL.md`
was written with the provenance line under its title. A thread (no project,
`claude-haiku-5-5[1m]`, medium) asked "what can you do in this app?":

```
#3 tool Skill [done] {"skill":"code-foundry"}
#5 tool Bash [done] {"command":"code-foundry daemon.capabilities"}
#7 tool Bash [done] {"command":"code-foundry daemon.capabilities --group pages; …--group panel; …--group rendering"}
#9 claude: Code Foundry runs Claude Code threads on your projects in one window. … Pages you can open … Side panel
   for a thread … I haven't changed anything. Opening a page or panel moves what you see in the app, and no app
   window is open right now, so I'd only do that when you ask.
#10 turn end: success, 9.7s, claude-haiku-5-5
```

The spawn's `--append-system-prompt` had the new line. No WARN or ERROR lines in the
daemon log. The thread and its transcript were removed, the daemon stopped and the home
deleted.

## Daemon restart

Needed: a new command, and the skills and the system prompt line are written at start.
