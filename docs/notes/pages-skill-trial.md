# Pages skill after the trial (fix/pages-skill-trial)

Four real threads (Opus 5.5, medium) each built a page from the code-foundry-pages skill and said
what got in their way. This branch takes the findings about what the skill tells Claude and what
`view.inline` warns about. The page self-check and the File tab are other branches.

## What was wrong, and the rule now

- **Classes that do nothing, silently.** `/cf/ui.css` is a fixed set of utilities (the safelist in
  `src/pagelib/theme.ts` plus what the components use), not all of Tailwind. A thread used
  `line-through` (not there) and nothing said so; another hand-wrote a `<style>` because it did not
  know `text-cf-text-muted` exists. Now `view.inline` warns, naming them, about classes a page uses
  that `ui.css` lacks (`WarnUnknownClass`, `commands_view_inline_classes.go`). The set is read from
  the stylesheet the daemon embeds and serves (`pagelib.UIClass`, `internal/pagelib/classes.go`),
  so it cannot drift. SKILL.md's "Paint only with" now says it is a fixed set, gives the cf colour
  classes by pattern and says arbitrary values need `/cf/tailwind.js`.
- **Storage limits misread.** "1 KiB a key" read as a cap on a value: two threads capped notes at
  800 to 900 characters and told the user so. 1 KiB is a key's name (`pagestorage.KeyMax`); values
  are bounded only by the 256 KiB the whole storage may hold. SKILL.md and sources.md say that now.
- **Polling warning on a label ticker.** `pollsCfRun` fired on any `setInterval` in a page that
  called `cf.run` anywhere; a thread removed its "5m ago" ticker to quiet it and its times froze. It
  now warns only when the timer's own callback reaches `cf.run`: inline, or through a function the
  page defines (named, `const f = …`, `useCallback`), two calls deep. A clock, relative times and a
  `cf.fetch` refresh pass. The skill says what is wrong (polling the app for what `cf.on` sends) and
  what is fine.
- **Archive read as limited.** `help thread.archive` and `verbs.md` read as if a page may archive
  only threads it created. Only unarchiving (and messaging, pinning, snoozing an archived thread) is
  (`store/thread/holds.go`); archive works on any thread. The text says so.
- **Boards that disagree with the sidebar.** sources.md's thread-list gives each status's meaning in
  the sidebar's groups (`lib/thread.ts` `threadGroup`): Working = busy, or idle "waiting…";
  Needs you = attention but finished; Done = attention "finished" (unseen; it turns idle "at prompt"
  once seen, `attended.go`); Error = error; Idle = the rest. And a three-column mapping.
- **Help that contradicted its usage line.** Every positional arg was listed as `--path (required)`
  under a usage line showing `<path>`. The generator (`guide/help.go` `helpFlag`) now lists a
  positional as `<path>, --path path`: the CLI takes either.
- **Found more slowly than needed.** SKILL.md opens with what to read first; sources.md opens with
  its contents. `verbs.md` has `thread.open` (a row click is the user asking: `focus` true).
  Storage's lifetime (by path; removing the thread deletes its pages and their storage) and the
  hidden-page patterns (a page behind another tab or in another space is unloaded: draw from
  storage on load; keep the last good fetched result with its time) are in SKILL.md and sources.md.

SKILL.md's body stays inside its 8,700-byte budget: every addition was paid for by cuts nearby.

## The class check, what counts

- Only a page that links `/cf/ui.css` and does not load `/cf/tailwind.js` (a plain or mockup page
  paints itself; the runtime makes any utility).
- Classes read: quoted `class`/`className` values (a `${…}` in a script's template left out), and
  the strings of a `className={…}` expression that are classes: a literal, a ternary or `&&`
  branch, a grouping, `cn`/`clsx`/`cx`/`twMerge` arguments, a template's text and its `${…}`. Not a
  literal compared against (`status === "done"`), an index (`tones["ok"]`) or another call's
  argument. A variable holding classes (`const cls = …`) is not followed.
- The page's own: every `.name` in its text (its `<style>`, a `querySelector(".row")`), and names
  passed to `getElementsByClassName` or `classList.contains`. Arbitrary values (`[…]`) are left to
  the existing arbitrary-value check. At most eight names, then "…".

## Gotchas

- A Go file named `*_js.go` is built only for GOOS=js: the scanner is `commands_view_inline_scan.go`.
- The skill's own pages are tested against the check (`internal/skills/pages_classes_test.go`). It
  found three dead classes in `welcome.html` (`size-7`, `disabled:opacity-60`,
  `group-hover:text-cf-accent`), now `h-7 w-7`, `disabled:opacity-50` and a rule in its `<style>`.
- `welcome.html` still polls `dictation.status` with a `setTimeout` while a model downloads (no
  source carries the progress). The polling warning fires on it as it did before this change; it
  opens with `view.open.page`, which runs no checks.
- Running the built CLI with a scratch `CODE_FOUNDRY_HOME` (even `help`) starts a daemon on it:
  stop it by pid before removing the home.
- Missing from `ui.css` and often reached for (for the page library's owner): `line-through`,
  `font-mono`, `whitespace-pre`, `list-disc`/`list-inside`/`list-none`, `capitalize`/`lowercase`,
  `w-1/2`, `size-full`, `size-2.5`, `size-7`, `place-items-center`, `group-hover:*`, `leading-*`,
  `tracking-*`, `opacity-40`. Each is a pattern in `pageSafelist`.
