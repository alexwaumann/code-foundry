# Provisional thread names

A new thread used to show its id in the sidebar and header until the naming model
answered, which takes a few seconds and sometimes fails (rate limits, a missing model, no
credits). Alex's decision (2026-10-18): the daemon gives the thread a provisional name
from the prompt at creation, and the namer replaces it.

## Decisions

- **Derived in the daemon** (`internal/store/thread/provisional.go`, `provisionalName`).
  Source: the composer's text when the GUI sent one (`composer_prompt`), else the prompt
  as sent (the CLI's, an agent's). Tokens: an attachment chip (`![x](cf-attachment://…)`,
  any `![…](cf-*://…)`) goes; a skill, file or any other `[label](cf-*://…)` token keeps
  its label (`/deploy`, `Composer.tsx`), because the label is what the user saw as a chip
  and "Fix Composer.tsx crash" reads better than "Fix crash". The projected forms the CLI
  may carry are handled too: `[Image: …]` / `[PDF: …]` go, `@cf-file://<p>/<path>` becomes
  the base name (a directory's with "/"), percent-decoded.
- **One line, one sentence, 48 runes.** Control characters become spaces, whitespace
  collapses, a Markdown heading, quote, bullet or numbered-list marker goes, code-fence
  lines and lines without a letter or digit are skipped; the first remaining line is
  cut at its first sentence end (`.`, `!`, `?` before a space, or full-width `。！？`). A
  period after an abbreviation (`e.g.`, `i.e.`, `etc.`, `vs.`) or ending a one-word
  sentence ("Hi.") does not end it; a version ("v1.2.") does. A trailing `.`, `:`, `;`, `,`
  goes; `?` and `!` stay. Longer than 48 runes: cut at the last space that fits 47, trailing
  punctuation trimmed, then "…" (48 including it); a first word longer than that is cut
  mid-word. Nothing left (an image-only prompt): no name, and the id placeholder shows as
  before.
- **Persisted flag.** Migration 0028 adds `threads.name_provisional` (default 0: existing
  names stay real). `Thread.NameProvisional`, `codefoundry.v1.Thread.name_provisional`
  (53), `ThreadView.nameProvisional`. A provisional name has `AutoNamed` false: that flag
  still means "the namer named it".
- **Rules.** `namedForGood` (a name that is not provisional) replaces every
  `Name != ""` check in the naming path: the namer still runs for a provisional name
  (`startNaming`, `applyLateName`, the record's `namingTried` at load and on a fresh
  start). The namer's title sets `AutoNamed` and clears the flag (`applyNamerTitle`);
  a rename clears it and sets `namingTried`, and a namer answer that arrives after a
  rename is dropped (logged "naming answer ignored", not "thread auto-named" as before).
  An explicit name at Create is never provisional.
- **Every path with a first prompt.** Create (composer, CLI `thread new`, agents) names
  after the worktree step, so a namer title that arrived within `SlugTimeout` wins
  outright. A thread created without a prompt gets its provisional name from the first
  user message sent to it (`Send`, `nameFromFirstMessage`): only while it has no user
  message, the namer has not run, and the message is not a wake.
- **Forks** keep `<parent> (fork)` and are never provisional, even when the parent's
  name was: no namer runs for a fork, so the flag would never clear.
- **The branch never uses it.** `waitSlug` still slugs only an explicit name or the
  namer's title; a namer that misses `SlugTimeout` leaves `cf/<id>` and the provisional
  name until its title lands.
- **GUI.** Muted and italic (`text-muted-foreground italic`) on the sidebar row name
  (both the two-line row and the archived/snoozed single line) and the header title,
  `data-provisional` on the row's name. No icon, no tooltip. The unnamed id keeps its
  muted, upright look.
- **CLI.** Text output just shows the name; `--json` (protojson) carries
  `"nameProvisional": true` and leaves it out otherwise.

## Gotchas

- A failed namer leaves the provisional name, muted, until the next fresh start of the
  process (the namer runs again on resume, as it did for an empty name). That is the
  honest state: the naming model has not named it.
- The namer names from the transcript's first user message. When the very first start
  failed before Claude wrote a transcript (seen live: a model the account could not use),
  the next message becomes the transcript's first one and the namer titles that, while
  the provisional name came from the original prompt.
- `CommandButton` does not forward `data-*` props, so the header has no
  `data-provisional`; its test reads the classes.
- protojson randomizes whitespace: tests decode the JSON rather than match bytes.

## Verified

- `make check` green.
- Table tests: `TestProvisionalName` (tokens, projected forms, whitespace, multi-line,
  sentences, abbreviations, markers, long words, unicode, CJK, image-only),
  `TestProvisionalNameRules` (namer replaces, rename before the namer wins, explicit
  name, image-only, failed namer survives a restart with the namer still to run, first
  message to a prompt-less thread), `TestForkOfProvisionalName`,
  `TestThreadNameProvisionalMigrationDefault`, `TestThreadToProtoNameProvisional`, the
  new-worktree table (a failed namer: provisional name, branch `cf/<id>`), sidebar and
  header component tests.
- Daemon + CLI against an isolated home with a scratch project under `$HOME`, Haiku 5.5
  at medium effort (this machine has no 1M-context credits, so a test-only wrapper set
  as `advanced.claude_path` dropped the `[1m]` suffix and could slow the naming call to
  15 s): a long prompt was created as "Please add a short usage section to the README…"
  (provisional in `--json`), kept it across a daemon restart while the namer failed, and
  was replaced by the namer's title once the namer could run; an image-only prompt
  (staged attachment, the composer's token) was created unnamed and then titled by the
  namer; a thread renamed while its namer ran kept "My line counter" after the namer
  answered "Count lines in README.md"; a new-worktree thread with a slow namer got branch
  `cf/<id>` and a provisional name, then the title; a thread created without a prompt got
  its provisional name from its first `thread send`.
- Daemon + GUI (`make gui-build`, isolated copy): provisional names muted and italic in
  the sidebar row, the Working footer row and the header, then upright and plain when the
  title landed, dark and light.
