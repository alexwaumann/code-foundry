# Guide and skill budgets (2026-11-06)

The audit found the caps measured the wrong thing: the guide's soft cap took 13 values since
2026-10-17, the entry skill's line cap went from 70 to 86, and 79 test lines used `Contains`, many
pinning sentences, so a rewrite cost more in tests than in text. This PR changes tests only, so
it needs no `make guide-eval`: nothing a model reads moved. Later PRs (one command index, trimmed
skills, a restructured guide) lean on it.

## Verbs and flags resolve

`TestSkillFilesResolve` (`internal/skills/verbs_test.go`) reads every file under
`internal/skills/files`, and the guide's hand-written sections, and resolves what they write
against the live registry. A renamed verb or flag now fails the build. **It found nothing stale**,
so no skill text changed.

- **What counts as code**: inline spans (wraps folded), plain and `sh` fences, heredocs and quoted
  prompts inside them, `h.Invoke` and `cf.run` with a literal verb. Prose, and `go`, `json`, `html`
  and `tsx` fences, are not read for commands: that is where the audit's false positives (SDK
  types, field names) lived. Flags in prose are still checked, against every flag of any command.
- **Verbs**: `code-foundry <words>`, and a span starting with a domain word or a dotted name
  (`thread new --notify`, `view.panel.file --edit`). The CLI's longest prefix, but `.show` only with
  no words left over, or any typo after `project` passes as project.show's argument.
- **Flags**: a flag beside a verb must be that verb's, and `--yes` needs a confirmation. A loose
  flag must be some command's.
- **Dotted names** are reliable once the other meanings are subtracted, from live lists: plugin
  capabilities (`plugintest.HostCapabilities`), host facts, setting keys. camelCase names and
  file names are skipped.
- **Local verbs** (`events`, `guide`, `help`, …) are not in the registry. The test reads
  `cmd/code-foundry`'s subcommand table and flag sets from source, so they stay live too; their
  flags are one pool, not per verb.
- **The exceptions** are named in the test: `--no-verify`, `--until-seen`, `--card`, `--flag`,
  CSS variables, `git` as a span's first word, three made-up plugins, and `project.snapshot`.

`TestResolveChecker` holds the planted mistakes (19) and the false positives (15) as a
table. Also planted by hand in real files, then reverted: `memory ad` in the entry skill, `--waitt`
in `wakes.md`, `--new-worktre` in the orchestrate skill. Each failed the test.

Not read: `ThreadPrompt`, which has no backticks. `prompt_test.go` still pins it.

## Budgets

One table, `internal/skills/budget_test.go`, replaces the line caps, the description caps, the
guide's line cap, the soft cap and the 16 KiB pages limit. Bytes are a proxy: Opus 5.5 gets 2.3 to
2.9 bytes per token, so a budget stops growth and does not price it.

| What | Size | Budget | Why this number |
|---|---|---|---|
| `ThreadPrompt` | 1,638 | 1,641 | Every request pays. The existing cap, moved here unchanged |
| Descriptions | 257 to 531 | Size to the next 20 | Every request pays, so almost no room |
| Bodies | 5,235 to 13,252 | About 5%, to the next 100 | Paid on load: a routing row or two fits, a section does not |
| Guide, topics | 27,623 at most | 29,000 | Bash sets output over 30,000 characters aside. A limit, not a target |
| References | 32,041 at most | 32 KiB | Read whole; the plugin skill's old limit, now for all |

Per skill, description and body:

| Skill | Description | Body |
|---|---|---|
| `code-foundry` | 415 / 420 | 7,863 / 8,300 |
| `code-foundry-help` | 393 / 400 | 7,514 / 7,900 |
| `code-foundry-orchestrate` | 531 / 540 | 9,177 / 9,700 |
| `code-foundry-pages` | 399 / 400 | 10,093 / 10,600 |
| `code-foundry-plugin` | 406 / 420 | 5,235 / 5,500 |
| `code-foundry-ember` | 257 / 260 | 13,252 / 13,900 |

Over budget, cut. A number goes down when a trim lands; raising one needs a reason in its row and
a guide eval run. Sizes are of the rendered text from the tests' fixed sources.

`host-commands.md` is the reference closest to its limit, 727 bytes under, and it grows with the
registry. Split it when it gets there. Ember's `rules.md` keeps its own 6 KiB cap in
`internal/store/ember`.

## Wording pins

| | Before | After |
|---|---|---|
| `Contains` lines in `skills_test`, `pages_test`, `plugin_test` | 79 | 41 |
| `Contains` lines in `internal/skills` and `internal/guide` | 97 | 59 |
| Strings in `[]string` literals of those three and `guide_test` (paths too) | 470 | 281 |

Of the 281, 185 are the markers in `rules_test.go`, mostly a verb, flag or number. The 41 left
check rendering against live lists, not prose: categories, commands, facts, `bridge.ErrorCodes`,
`bridge.Sources`, pagelib's paths and exports.

**Kept**, in `rules_test.go`: 37 rows, each naming the note that holds its failure, and the test
fails if that note is gone. They match case-insensitive regexps over the text with wraps and
Markdown folded, so a rewrite that keeps the rule passes.

- `control-7-skill-routing`: prompts that loaded no skill, no skill or command names to the user,
  a "show me" in the own panel.
- `bridge-fix-wording`, `bridge-fix-c-daemon`: "what's running" meant `ps`; wakes, never cron or
  `--watch`; `onError`; rows that stay put; two data shapes; once per file.
- `bridge-3-skill`, `bridge-fix-storage`, `file-edit-3-agent`: pages of `--yes` lines to copy, a key
  in `localStorage`, a key pasted by hand; `localStorage` does not last.
- `page-library-fixes-a`, `page-library-fixes-b`: unthemed pages in the repo, hand-posted
  `cf:resize`, overlays and arbitrary classes in a card.
- `theme-fuzz-daemon`: contrast floors 7:1 and 4.5:1, `--replace`, the scheme, the verbs.
- `orch-removed-panels-check`: what changed means the branch; PR and MCP reads.
- `workspaces-v2-5-skills`, `control-8-memory-scope`, `control-6-memory-fixes`: which store, and
  when a change arrives.
- `orch-skill-v4`: pairwise `merge-tree`, the diff against the claim, no `--wait` from a wake,
  `report_stale`, a lead's progress report. The `SKILL.md` row is new: nothing pinned those.
- `ember-fixes-1-skill-cli`, `ember-fixes-2-skill`, `ember-research-tasks`, `ember-rules-reply`: the
  task loop, prompts on stdin and never in double quotes, the worker checklist, research tasks,
  the last text. `control-2-skill-provenance`: the dev build caveat.

**Replaced by structure**: the 20-row orchestrate pointer table is now "every `reference/x.md` and
`§N` a file names exists", for the pages skill too. The rendered commands lists check every command
of a category instead of a sample. `bridge.js`'s header lines are read from the script.

**Dropped**: section headings, sentences of how-to prose, strings that must stay gone (the rule
they guarded is now positive, or the resolver catches the verb), the limits table's rows and
numbers (`TestViewLimitsNameEveryLimit` covers it, and a changed limit no longer fails a test),
`cf.fetch`'s limits, example snippets, and a model id in `settings.md`.

## Gotchas

- `internal/skills` tests now import `internal/store/thread` for `ThreadPrompt`.
- A span with a stray backtick pairs with the next one, so spans do not cross a blank line.
- The pages skill names the help skill's `reference/settings.md`, so a reference may be preceded by
  its owner (`code-foundry-help skill's`).
