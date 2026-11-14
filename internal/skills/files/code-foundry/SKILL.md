---
name: code-foundry
description: "Start here for anything about Code Foundry, the app this thread runs in. Use when asked what you can do, what's running, their work, this worktree's changes or PRs, version, model, effort, usage, cost, settings, plugins; to see or make a file, diff, page, HTML, chart or theme, a mockup or a recolour; a preference to remember; a skill, PR, reminder, a secret or a file you cannot read; or before acting in the app."
user-invocable: false
---

# Code Foundry: start here

{{cf.provenance}}

Code Foundry is the macOS app this thread runs in: it runs Claude Code threads (conversations
like this one) on the user's projects in one window with a sidebar and panes of tabs: a thread,
and its diff, files and pull requests beside it. The `code-foundry` CLI drives it (most buttons are commands too) and changes the real app.

## The one rule

If the CLI can do it, offer it and do it. A question ("how do I…?") gets the answer and the offer;
run a change once the user says yes (code-foundry-help). Talk about the app as the user sees it:
pages, tabs, buttons, Settings labels; never skill or command names.

## Which skill or command

| The user wants | Read (your Skill tool, or the SKILL.md `--group skills` lists; `reference/` is next to this file) or run |
|---|---|
| How to do something, a setting or keybinding | the code-foundry-help skill |
| A standing preference ("always open PRs as drafts") | `code-foundry memory add <text>`; for a set of projects, one repo, or a skill for them: `reference/scopes.md` |
| What it cost, token usage | `code-foundry usage.show` (`--all` for every thread) |
| A thread's model, effort or permission mode | `thread get --json` reads them; `thread.set-model '<id>'` (ids: its `--help`), `thread.set-effort <level>`, `thread.set-mode <mode>` change them. The app replaces /model, /effort, /fast, /mcp, /rename and /clear: the composer's pickers, the MCP panel, Rename Thread, a new thread |
| What changed in this thread | The branch's commits since its base (`baseRef` in `thread get --json`, else origin's default branch) plus uncommitted work, not uncommitted work alone |
| This thread's checkouts, subagents, child threads, MCP servers, linked PRs | `thread checkouts`; `thread agents`; `thread list --created-by $CODE_FOUNDRY_THREAD`; `thread mcp` (your session's start list goes stale); `thread get --json`'s `linkedPullRequests`, `thread pr link <url>` adds one |
| To see a file, a change, a PR or a set of images | `view.open.file <path>`, `view.open.diff [<path>…]` (`--base`, `--head`: any two sides; `--title`, `--note`, `--hide`: its `--help`), `view.open.pr <n>`, `view.open.mcp`, `view.open.gallery --title <t> --images -` (JSON; its `--help`): a tab beside you, never the user's focus; `--focus` only when asked to be taken there |
| A secret value, or a change to a file you cannot read (`.env`, `~/.aws/credentials`) | Never ask for it in chat or read the file: `view.open.file <path> --edit --line N --note "<what goes where>"` (a missing file is made on save), then end your turn. Told it is saved, continue without reading its values |
| A page, chart, form, board, dashboard, mockup, checklist or tool you make; a to-do to tick off; anything "as a page" or "I can fill in" | the code-foundry-pages skill first: an `.html` file in `$CODE_FOUNDRY_PAGES` (never the repository) with `/cf/theme.css`, and `/cf/bridge.js`, which sizes its card; shown with `code-foundry view.inline <path>`, not markdown |
| What's running or going on, their work | This app's threads, actions and terminals, never the Mac's processes: `code-foundry thread list`, `action runs`, `terminal list`; a board of it: the code-foundry-pages skill |
| The app's colours: a theme, "sidebar quieter", "less contrast", the accent | `reference/making-a-theme.md`, before you change anything |
| To be told or reminded later, or something on a schedule ("tell me when #4 passes", "every hour…") | `code-foundry thread subscribe` (`--pr owner/name#4 --until checks_passed`, `--every 1h`, `--at 2h`, `--thread <id> --until attention`, `--note`): the app wakes you, even stopped; never Claude Code's cron or a background `--watch`, which die when the app stops this idle thread |
| A pull request opened, or the project put on GitHub | `code-foundry pr.create`, `code-foundry project.github.publish` |
| Something said or done in an earlier thread | `code-foundry thread search <words>` (`--include children` for threads other threads made), then `thread read --id <thread> --since <#N-3>` |
| Work in parallel, on several branches or PRs, or anything about other threads | the code-foundry-orchestrate skill |
| To build, debug or publish a plugin | the code-foundry-plugin skill |
| To find a verb, or know what exists here | `reference/commands.md` lists every verb; `code-foundry daemon.capabilities`, then `--group <name>` (build, commands, pages, panel, rendering, skills, plugins, settings, memory, presence; `--json`) reads the running app |
| A first run ("I just installed", "welcome tutorial", no projects yet) | the code-foundry-pages skill's reference/welcome.md |
| How something works inside the app | the code-foundry-help skill's `reference/reading-the-source.md` |

## Good to know

- A **project** is a folder on the Mac; a **thread** is one conversation with an agent in it. The
  composer's "Work in" places the user's own threads: Project folder or Fresh copy (a worktree and
  branch), default `threads.default_worktree`. Yours from `thread new`: the project folder or
  `--new-worktree`.
- `$CODE_FOUNDRY_THREAD` is your thread's id. Thread commands without `--id` act on it.
- Commands that ask first exit 2 without `--yes`: add it once the user agreed to that act.
