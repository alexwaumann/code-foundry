# Natural thread names

Thread names read like titles ("Fix the login redirect") instead of kebab-case slugs
("fix-login-redirect"). The slug lives on only in the branch.

## Decisions

* **The namer asks for a title.** `namingPrompt` (`internal/store/session/naming.go`)
  asks for 3 to 6 words naming the coding task, sentence case, no trailing period, no
  quotes, no markdown, with two examples. Effort stays low; the model is still the
  `sessions.naming_model` setting.
* **`cleanTitle` makes the answer one line.** First line with any text; control
  characters and runs of whitespace collapse to one space; repeatedly strips a markdown
  heading / list / quote / numbered marker, a `Title:` or `Name:` label, surrounding
  quotes (straight, curly, guillemets, backticks), `*`/`_` emphasis, a paired `'...'`
  and trailing periods; capped at 60 runes, cut at the last word boundary. An answer
  with no text is the existing "no usable name" error.
* **A bare kebab answer is turned into words.** A single lower-case token with hyphens
  ("fix-login-bug", what a model primed on slugs might still say) becomes
  "Fix login bug". A hyphenated word inside a real title ("Add dark-mode toggle") is
  left alone.
* **Sentence case is the prompt's job.** The cleaner does not recase titles: a forced
  capital breaks titles that start with an identifier (`gofmt`, `iOS`), and the
  models follow the instruction.
* **The branch slugifies the title.** `waitSlug` now keeps the title as the session
  name and `slugify(title)` as the branch slug. A title with nothing slugifiable
  (non-Latin script, say) gives an empty slug, and `pickBranch` falls back to
  `cf/<session id>` exactly as for a failed namer; the session still gets the title.
  A title that arrives after `SlugTimeout` names only the session (the branch is
  already `cf/<id>`), as before.
* **`slugify` is unchanged** (5 words, 60 characters). Six-word titles therefore lose
  their last word in the branch: "Add README usage section for tests" is
  `cf/add-readme-usage-section-for`.
* **Workspace names stay slugs.** A new workspace's default name is still the branch
  without `cf/`; only the thread gets the title.
* **Forks are `<parent> (fork)`** via `forkName`, keeping the parent's `AutoNamed`.
  A fork of a fork stacks: "X (fork) (fork)", like the old "-fork-fork".
* **`session.list` prints `-` for an unnamed thread**, like its other empty cells: with
  spaces in names an empty NAME cell was easy to misread.
* **No migration.** Existing threads keep their slug names (Alex renames by hand).
  Nothing addresses a thread by name, so mixed old and new names are harmless.
* **The mock daemon** names new threads with `promptTitle` (first four words of the
  prompt, first letter capitalized); branches and new-workspace names still use
  `promptSlug`. `e2e/compose.spec.ts` expects "Add a dark mode".

## Audit

Nothing else assumed slug-shaped names: `cleanName` already took any one line up to
200 bytes, the CLI addresses threads by id (`sessionLabel` prints "name (id)"), the GUI
sidebar renders the name as text with the id as placeholder, the composer has no name
field, worktree paths and branches derive from the branch (made once, at creation),
and the workspace prompt line names the workspace, not the thread. Updated: the
session proto comments (`Session.name`, `CreateSessionRequest.new_worktree`), the
`session.new` flag help for `new-worktree` and `repos`, `docs/ARCHITECTURE.md`.

## Verified

`make check` green; Playwright suite against the mock. End to end against an isolated
home (`CODE_FOUNDRY_HOME=/tmp/ntn-home`) with a scratch repo under `$HOME`:

```
$ code-foundry session new --repo <id> --new-worktree --model haiku --effort medium \
    --permission supervised --prompt "Add a usage section to the README that explains how to run the tests"
created thread Add README usage section for tests (s-1c5f10dfbfa4) in .../cf-add-readme-usage-section-for (new worktree from main)
$ code-foundry session fork --id s-1c5f10dfbfa4
forked s-1c5f10dfbfa4 into Add README usage section for tests (fork) (s-f21945da759b)
```

The naming call (sonnet, effort low, the default naming model) took 2.3 s; the branch
was `cf/add-readme-usage-section-for`.
