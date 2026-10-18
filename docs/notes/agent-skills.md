# Agent skills: code-foundry-orchestrate and code-foundry-help (2026-10-18)

PR 1 of two. Every thread used to learn about the app from one system prompt line
pointing at `code-foundry guide` ([agents-5-cli](agents-5-cli.md)). Now the daemon ships
two Claude Code skills to every thread: **code-foundry-orchestrate** (delegate a unit of
work to another thread in a new worktree instead of a subagent; wait, collect, archive,
clean up) and **code-foundry-help** (how-to questions about the app; explain, then offer
the command). Daemon and CLI; no GUI change.

## Layout

```
<home>/claude/                     every claude's first --add-dir (paths.Paths.Claude)
  VERSION                          the daemon's version
  .claude/skills/
    code-foundry-orchestrate/
      SKILL.md                     static; user-invocable: false
      reference/commands.md        rendered: Thread (in full), Action, Workspace, Project
      reference/patterns.md        static: one child + wait, fan out + reports, review loop
    code-foundry-help/
      SKILL.md                     static; user- and model-invocable (no invocation keys)
      reference/getting-started.md docs/GETTING-STARTED.md
      reference/settings.md        rendered: every setting, one entry each
      reference/commands.md        rendered: Project, Settings (in full), Thread, Pull Request, Action
```

## Decisions

Agreed with Alex (the brief):

* **Skills, not a longer prompt.** The system prompt line is now static and names the
  skills: "This thread runs inside code-foundry. Its skills (code-foundry-orchestrate,
  code-foundry-help) say how to delegate work to other threads and how to answer
  questions about the app." A workspace thread's line follows it, as before.
* **No `` !`command` `` in any skill.** Managed enterprise settings (Alex's work laptop)
  forbid dynamic shell in skills, so whatever is dynamic is rendered by the daemon at
  start. `TestRender` fails on a `` !` `` in any skill file.
* **`--add-dir`, not hooks, `--plugin-dir` or `--settings`.** Claude Code loads the
  `.claude/skills` of an `--add-dir` directory (documented). Managed settings forbid all
  hooks; a plugin dir or a settings file would be a second mechanism for the same thing.
  No CLAUDE.md is shipped, so `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is not
  needed (still set for workspace threads only, as before).
* **Add-dir order**, fixed, every spawn (create, start on send, fork, effort restart; all
  go through `claudeCommand`): the skills dir, the attachments dir, workspace members,
  then granted dirs.
* **Rewritten at every start**, staged and renamed: the new `.claude` is written in full
  beside the old one, the old is renamed aside, the new renamed in, the old removed.
  Everything else in `<home>/claude` (an older layout, an interrupted install's
  leftovers) is removed: the directory is wholly the daemon's. Between the two renames
  there is briefly no `.claude`; it happens before the servers listen, so no thread
  spawns then.
* **One renderer.** `internal/guide` (moved out of `cmd/code-foundry/guide.go`) renders
  the CLI guide, the command references (`WriteCategories`) and the settings reference
  (`WriteSettings`) from `[]*v1.Command` and the settings schema protos. `code-foundry
  guide` prints byte-for-byte what it did (checked against the old output before the
  move); its test and the 29,000-byte budget moved with it.
* **The getting started guide** is embedded by a new `docs` package (`docs/embed.go`,
  `docs.GettingStarted`), since `go:embed` cannot reach a parent directory. The file
  stays where it is, so the GUI's `?raw` import is untouched; a test checks the shipped
  copy is the repo file.
* **`settings get --json`** entries add `title`, `description` and `type` (the
  SettingType's lower-case name) to `key`, `value`, `default`; `settings set` and
  `settings reset` answer the same shape. Text output unchanged.
* Descriptions: orchestrate 316 characters, help 288 (under 400; every description costs
  tokens on every turn of every thread). Bodies: 102 and 73 lines.

Decided while building (flagged for review):

* **Arg defaults from settings are left out of the rendered references.** The live
  registry gives `thread.new --model`/`--effort` (and the `pr.*` thread starters) the
  user's current defaults; a file written at start would go stale with the next settings
  change. `dropSettingDefaults` clears exactly the args `registryOverrides` sets; the arg
  description still says "(default: settings threads.default_model)". The CLI guide
  (rendered per call) keeps them.
* **Keybinding settings get one short line each** (`keybindings.<command>`, the
  command's title, its default chord) in settings.md; the command's description is in
  the commands references. Every other setting gets its title, description, type with
  enum values and labels or int bounds and unit, default, and "Applies after a daemon
  restart" when it does. settings.md is 14 KB, 195 lines.
* **The orchestrate skill passes project ids**: `thread new --project <name>` fails for a
  plain project thread ("thread not found: project cf-scratch-skills";
  `resolveWorktree` looks the id up only), although the guide says it takes a name
  (agent-cli-feedback-1). Not fixed here (it is in the thread store's create path); the
  skill says to pass the id from `project list`. Worth a follow-up.
* **"needs attention (finished)" explained** in the orchestrate skill: the e2e
  orchestrator was unsure whether that meant success.
* The rendered references start with a "Generated by the code-foundry daemon (<version>)"
  line and a short "How to read it" (positional args, `[--id]`, `--yes`, `--json`).
* SKILL.md descriptions are double-quoted in the frontmatter (help's contains ": ").
* Files are 0600 and directories 0700, like the rest of the home.
* A failed render or install logs an ERROR and the daemon starts anyway; the thread store
  creates `<home>/claude` itself at start (like the attachments dir), so claude never
  refuses a missing `--add-dir`.
* `docs/ARCHITECTURE.md`: the layout, the Skills bullet in the thread store section, the
  guide and help-overlay mentions.

## Gotchas

* **The system prompt is recorded per conversation.** Claude records it on a
  conversation's first request and reuses it on resume, so threads that exist already
  keep the old line (pointing at `code-foundry guide`) until a compaction. Their next
  spawn passes the skills dir all the same (`--add-dir` is per spawn); whether Claude
  lists the skills to such a resumed conversation was not tested.
* The orchestrate skill has `user-invocable: false`, so `thread commands` (Claude's
  initialize reply) lists `/code-foundry-help` and not the orchestrate skill, while the
  model sees and invokes both.
* `api.Command.List` is called in-process to render (no RPC); the settings store's
  keybinding fields exist only after `applySettings` (`SetCommands`), so the install runs
  after it.
* The agent read the reference files with its Read tool without a permission prompt
  (auto mode): the `--add-dir` makes the directory one of the session's working
  directories.

## End to end (2026-10-18, isolated home, scratch repo under ~)

`make build`; the daemon `CODE_FOUNDRY_HOME=/tmp/cf-sk bin/code-foundry daemon --dev`
with the branch's `bin` first on `PATH` and no `CLAUDE*`/`CODE_FOUNDRY_*` variables;
`~/cf-scratch-skills` (a README, one commit) registered as `c3837abc79b0`.
`code-foundry` below is a wrapper for the branch binary with that home.

```
daemon.out: level=INFO msg="skills installed" component=skills dir=/tmp/cf-sk/claude files=7
$ find /tmp/cf-sk/claude -type f
/tmp/cf-sk/claude/VERSION                                   (dev)
/tmp/cf-sk/claude/.claude/skills/code-foundry-help/SKILL.md
/tmp/cf-sk/claude/.claude/skills/code-foundry-help/reference/settings.md
/tmp/cf-sk/claude/.claude/skills/code-foundry-help/reference/commands.md
/tmp/cf-sk/claude/.claude/skills/code-foundry-help/reference/getting-started.md
/tmp/cf-sk/claude/.claude/skills/code-foundry-orchestrate/SKILL.md
/tmp/cf-sk/claude/.claude/skills/code-foundry-orchestrate/reference/commands.md
/tmp/cf-sk/claude/.claude/skills/code-foundry-orchestrate/reference/patterns.md

$ code-foundry thread new --project c3837abc79b0 --model 'claude-haiku-5-5[1m]' --effort medium --name "skills e2e" --created-by= \
    --prompt "what skills do you have from code-foundry and when would you use a thread instead of a subagent?"
created thread skills e2e (s-e8c777870156) in /Users/alex/cf-scratch-skills
# daemon.out, the spawn:
… --add-dir /tmp/cf-sk/claude --add-dir /tmp/cf-sk/attachments --append-system-prompt This thread runs inside code-foundry. Its skills (code-foundry-orchestrate, code-foundry-help) say how to delegate work to other threads and how to answer questions about the app.
$ code-foundry thread read e8c777870156 --full
#1 you: what skills do you have from code-foundry and when would you use a thread instead of a subagent?
#2 thinking
#3 tool Skill [done] {"skill":"code-foundry-orchestrate","args":"Explain when to delegate to a Code Foundry thread instead of a subagent."}
#4 tool Skill [done] {"skill":"code-foundry-help"}
#6 claude: I have two Code Foundry skills:

- **code-foundry-orchestrate** delegates work to other threads. It covers creating a thread in its own worktree, waiting for it, collecting its report, archiving it, and cleaning up worktrees after merge. It also points to command and pattern references.
- **code-foundry-help** answers how-to questions about the app: projects, threads, settings, keybindings, and pull requests. It explains first, then offers to run a command, and only changes settings after you say yes.

**Thread or subagent:**

- **Use a thread** when the work ends in a pull request or prototype, needs its own branch, or when I'm orchestrating rather than implementing. Threads get their own worktree, so they never edit this checkout. You can watch and steer them in the sidebar, and they keep running after my turn ends.
- **Use a subagent** (the Agent tool) only for read-only research in this checkout, such as searching, reading, and summarizing. Never use one for work that edits files.

I haven't started any threads or changed any settings in this session.
#7 turn end: success, 6.1s, 51865 in / 852 out tokens, $0.0040, $0.0040 so far, claude-haiku-5-5

$ code-foundry thread commands --id e8c777870156 | grep code-foundry
/code-foundry-help   -   Answer how-to questions about Code Foundry, the app this thread runs in: projects, threads, worktree…
```

A help question (explained and offered; nothing changed):

```
$ code-foundry thread send --id e8c777870156 "How do I make new threads use Opus 4.8 by default?" --wait --for 4m
#10 tool Read [done] {"file_path":"/tmp/cf-sk/claude/.claude/skills/code-foundry-help/reference/settings.md"}
#12 claude: Set the `threads.default_model` setting to Opus 4.8:
    code-foundry settings set threads.default_model 'claude-opus-4-8[1m]'
    The quotes matter because of the brackets. The setting applies to new threads right away and doesn't need a daemon restart. …
    You can also make the change in the Settings page (⌘,) under Threads, in the Default model field. Otherwise I can run the command for you.
$ code-foundry settings get threads.default_model
claude-sonnet-5[1m]
```

An orchestration (after a daemon restart, which rewrote the skills; a thread asked to
delegate "add hello.txt and commit it, no push, no PR"):

```
#3 tool Skill [done] {"skill":"code-foundry-orchestrate", …}
#5 tool Bash [done] {"command":"code-foundry project worktree cleanup c3837abc79b0 --yes"}
    → No worktrees to clean up
#6 tool Bash [done] {"command":"code-foundry thread new --project c3837abc79b0 --new-worktree --name \"Add hello.txt\" --brief \"…\" --request-id add-hello-txt --model 'claude-haiku-5-5[1m]' --effort medium --prompt \"… Then run: code-foundry thread report done …\""}
    → created thread Add hello.txt (s-8ee0c3dd9efb) in /private/tmp/cf-sk/worktrees/_local/cf-scratch-skills/cf-add-hello-txt (new worktree from main)
#7 tool Bash [done] {"command":"code-foundry thread wait s-8ee0c3dd9efb --for 30m"}
    → thread s-8ee0c3dd9efb Add hello.txt: needs attention (finished)
#9 tool Bash [done] {"command":"code-foundry thread read s-8ee0c3dd9efb; echo \"---REPORTS---\"; code-foundry thread reports --created-by $CODE_FOUNDRY_THREAD"}
    → … s-8ee0c3dd9efb  done  Add hello.txt  Added hello.txt (contents: hi) and committed as db0c46a 'Add hello.txt' on cf/add-hello-txt; working tree clean, not pushed
#11 tool Bash [done] {"command":"code-foundry thread archive --ids s-8ee0c3dd9efb --yes"}
    → archived 1 thread: s-8ee0c3dd9efb
#13 turn end: success, 20.4s, 166240 in / 1695 out tokens, $0.0052, $0.0052 so far, claude-haiku-5-5
```

The orchestrator's answer added "The wait returned 'needs attention (finished)' even
though the report was `done`", hence the line about that status in the skill.

The daemon logs had no ERROR or WARN lines. Then the daemon was stopped (SIGTERM) and
`~/cf-scratch-skills`, `/tmp/cf-sk` and the scratch threads' transcripts deleted.

## Daemon restart

Needed: the skills are written at start, and the spawn argv and prompt line changed.
