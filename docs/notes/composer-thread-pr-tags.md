# Composer thread and pull request tags

Status: branch `cf/composer-thread-pr-tags`. Two tag kinds next to the skill (`/`) and file
(`@`) tags of `composer-tags-1-daemon.md` … `composer-tags-4-files.md`: other threads under
`@`, pull requests after `#`. Decisions by Alex, 2026-10-18.

## What landed

| Path | What |
|---|---|
| `internal/store/thread/threadrefs.go` | `rewriteThreadRefs` (pure), `Manager.threadRefs` (snapshot + transcript), called in `Create` and `Send` after the file reference rewrite |
| `gui/frontend/src/lib/prompt.ts` | `thread` and `pr` tags: tokens, labels, `threadLabel`, projection; neither is project-scoped (`tagProject` "") |
| `gui/frontend/src/lib/completion.ts` | `#` trigger (`findTrigger`) |
| `gui/frontend/src/lib/tagCandidates.ts` | matching, ranking, caps and rows for threads and pull requests (pure) |
| `gui/frontend/src/components/compose/useRefSources.ts` | `useMentionSource` (threads + files under `@`), `usePrSource`, `usePrPool`, `useProjectSlugs` |
| `gui/frontend/src/components/compose/useTagInfo.ts` | what a thread or pull request chip shows (shared by the composer and the bubble) |
| `components/compose/{TagView,tagContext,tagStyle,useCompletion}.ts(x)`, `thread/UserBubble.tsx`, `lib/userMessage.ts` | chips, node attrs (`slug`, `number`), accents, `quietEmpty`, bubble pieces |
| `gui/frontend/e2e/composer-{threads,prs}.spec.ts` | mock e2e |

## Decisions

* **Thread token** `[name](cf-thread://<cf thread id>)`: the label is the name when the tag
  was inserted, the only label a token carries (skill, file and pull request labels come
  from the URL). The chip shows the thread's current name from the store, else that label.
* **Thread projection, in two steps.** The GUI projects the tag to
  `[Thread "<label>" (id <id>)]`; the daemon (`rewriteThreadRefs`, in `Create` and `Send`)
  completes it with the current name and where to read the conversation:
  `[Thread "<name>" (id <id>); transcript: <ClaudePaths.transcriptPath>]`, or, while Claude
  has not written a transcript (no `ClaudeSessionID` yet, or the file is gone),
  `[Thread "<name>" (id <id>); inspect with: code-foundry thread read <id>]` (`thread read`
  prints the items; `thread get` is the summary). An unknown id keeps the written name and
  says `; not found`, logged once at WARN. Only that exact shape is rewritten, so the
  completed line passes through a second time unchanged. The intermediate line rather than
  the raw `cf-thread://` URL: it reads well by itself (an agent's `thread send` can use it
  too), it carries the name for an unknown id, and it never equals the composer text, so
  `composer-text` is always sent and the bubble draws the chip (`sendThreadDraft` drops
  the composer text when it equals the projected text).
* **Only the composer's own tags are completed** (review fix). A message with composer
  text has only the lines whose id one of its `cf-thread://` tags names rewritten; the
  same shape typed or pasted as text (a test fixture, a message copied from `thread
  read`) reaches Claude exactly as written instead of gaining a transcript or `; not
  found`. A message without composer text (the CLI, an agent's `thread send`) has every
  such line completed, as before.
* **Thread candidates**: from the thread list the GUI holds (no RPC). Active only: not
  archived, not snoozed, never the thread being written in. Matching by name: exact 5,
  prefix 4, word prefix 3, substring 2 (no subsequence: thread names are prose, scattered
  letters matched too much). Then the most recently active. At most 3. An empty `@` lists
  the three most recent. Rows: the name, then `project · status` in the sidebar's words
  without a time ("Working", "Needs input · Bash", "Idle").
* **The `@` card**: a "Threads" group above the files; once threads are listed the files
  get a "Files" heading (several projects keep their project headings). Thread rows answer
  the same query the file search answered, so both groups move together while the debounced
  search catches up. Empty text "No threads or files match". Composers without a project
  (and a daemon without SearchFiles) now get `@` for threads alone ("No threads match");
  `#` stays off there (no repository).
* **Pull request token** `[#123](cf-pr://<owner>/<repo>/123)`, slug lower case (the gh
  store's normalisation); projection `owner/repo#123`, which gh and Claude both read. A
  letter, digit or underscore right against the chip gets a space on that side
  (`see`+chip would have projected `seeowner/repo#123`, chip+`s` `owner/repo#123s`).
* **Pull request candidates**: the draft's projects' GitHub slugs (primary, Also in, or
  workspace members). The pool is what the GUI already reads: the viewer's dashboards
  (`GetDashboard`, "tracked": authored, review requested, reviewed, merged in the last 7
  days) plus any branch list already cached for a thread or worktree on screen. Nothing new
  is polled. The dashboard is watched only while a `#` trigger is live or a PR chip is
  shown. Matching: digits match the number (exact 6, prefix 5), text the title (prefix 4,
  word prefix 3, substring 2); then open first, then most recently updated; at most 5.
  With several repositories the row's hint is the slug.
* **No false positives**: `#` needs a character after it that is not `#` and must follow
  whitespace or a line start, so `#` alone, `# Heading`, `## Steps`, `##` and `C#13` never
  trigger. The `#` source is `quietEmpty`: a query nothing matches shows no card at all
  (not "No pull requests match"), so `fix #999` + Enter sends as typed. Until the pool has
  loaded the source is unavailable (no card, Enter sends). Only a pick makes a tag.
* **Accents.** Pull request: its state's colour as the PR rows show it (`prStateLook`:
  open emerald, merged violet, closed red, draft or unknown muted), `PR_ACCENT`. Thread:
  "sky", but `--info` (the theme's sky, the same token the Agents strip uses) is already
  the file accent, so the thread tag mixes it with `--success`
  (`color-mix(in oklab, var(--info) 60%, var(--success))`, a cyan sky) to tell the two
  apart; it follows every theme.
* **Tooltips.** Thread: its project, its status muted below ("Finished 5 min ago",
  "Archived", "Snoozed"; "Thread not found" for a removed one). Pull request: its title,
  `owner/repo#N` muted below (just `owner/repo#N` when the PR is not in the pool).
* **The sent bubble** draws both chips from the stored composer text (the existing
  mechanism: nothing is parsed out of the projected text), so it is exact and needs no
  "does this thread's project have that repo" guess. A message without composer text (the
  CLI) stays plain text, like every other tag.
* **Member changes**: neither kind is project-scoped (a thread id and `owner/repo#N` name
  the same thing from any checkout), so the project switch and Also in removal keep them,
  like images and user skills. Removing, caret, undo and paste are the tag node's.

## Gotchas

* `lib/palette.test.ts` treats `"#123"` (a quoted 3-, 4-, 6- or 8-digit hex) in any source
  line, comments included, as a colour literal: comments say `#N`.
* In the thread e2e the turn ends right after the send and the timeline folds and keeps to
  the bottom, so a single hover over the bubble's chip can land before it settles; the
  specs hover until the tooltip shows.
* The existing files spec typed `@thr`, which now also lists the mock's "Write thread docs":
  that spec archives it in `beforeEach`; the outdated-SearchFiles case now expects the
  threads-only card.

## Live check (scratch daemon, 2026-10-18)

`make build gui-build`; `CODE_FOUNDRY_HOME=/tmp/cf-tags-home bin/code-foundry daemon --dev`,
the GUI as an isolated copy on it; a shallow clone of this repository at
`~/cf-tags-scratch/code-foundry` registered as a project (so the gh store polls
`alexwaumann/code-foundry`); `threads.default_model` Haiku 5.5, effort medium. Two
threads from the CLI: "Pick a codename" (Haiku 5.5, replied `CODENAME-AMBER-7731`) and
"Draft release notes" (no prompt, so no transcript).

* New-thread composer: `@pick` listed "Pick a codename · code-foundry · Finished" under
  Threads above the matching files; `#18` listed the real #187, #188, #189, #186, #185
  with their titles. Chips and tooltips as designed (merged PRs in violet).
* Sent: `Quote the reply in [Pick a codename] and give the title of [#187] using gh. Two
  lines only.` Claude's first user message in its transcript:
  `… [Thread "Pick a codename" (id s-bf8cb948c8ab); transcript: /Users/alex/.claude/projects/-Users-alex-cf-tags-scratch-code-foundry/e7b9a8ca-….jsonl]
  and give the title of alexwaumann/code-foundry#187 using gh …`. It Read that jsonl and
  ran `gh pr view 187 --repo alexwaumann/code-foundry`; answer: `CODENAME-AMBER-7731` /
  `feat(thread): provisional thread names from the first prompt`. The bubble drew both chips.
* Follow-up in that thread's composer (it left itself out of the Threads group) tagging
  "Draft release notes": Claude got `[Thread "Draft release notes" (id s-6ff1ef00dde8);
  inspect with: code-foundry thread read s-6ff1ef00dde8]`. (It could not run the CLI in
  this scratch setup: no `code-foundry` on its PATH.)
* Daemon log: one WARN, auto-naming failing on the account's 1M-context credit limit
  (unrelated). Light and dark screenshots in the PR.

## Verified

* `make check` green: gofmt, vet, staticcheck, `go test -race ./...`, typecheck, lint,
  vitest. Go: `TestRewriteThreadRefs` (table: transcript, no transcript, current name
  cleaned, blank name, unknown id, two lines, shapes left alone, idempotent),
  `TestSendRewritesThreadRefs`, `TestCreateRewritesThreadRefs`,
  `TestComposerMessagesRewriteOnlyTaggedThreads` (composer text: only tagged ids). Vitest: tokens,
  projection, malformed tokens and member changes (`lib/prompt.test.ts`), the `#` trigger
  table (`lib/completion.test.ts`), candidates (`lib/tagCandidates.test.ts`: archived,
  snoozed and the current thread left out, caps, ranking, the pool), bubble pieces
  (`lib/userMessage.test.ts`), node attrs, the quiet card (`useCompletion.test.tsx`).
* `make gui-e2e`: 913 passed, 1 failed (`thread.spec.ts` "scrolled up when the turn ends",
  light, WebKit), which passes alone 3/3; composer-threads and composer-prs pass 2× in both
  browsers.
