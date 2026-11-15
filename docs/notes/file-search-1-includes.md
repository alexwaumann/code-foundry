# File search 1: ignored files to include

Status: PR 1 of 5 for file search, on branch `cf/file-search-1-includes`. Daemon, proto and
mock only. Next: (2) the GUI (a Settings section, a project page section, an "ignored" label
on finder rows), (3) ripgrep shipped with the release, (4) a text search RPC, (5) a Text mode
in the finder.

cmd+P and the composer's `@` list git's view of a checkout (`git ls-files -co
--exclude-standard`), so a git-ignored file was never found: `.env`, `CLAUDE.local.md`,
`.claude/settings.local.json`, a scratch folder. Include patterns bring such files back.

## What landed

| Path | What |
|---|---|
| `internal/fsx/include.go` | pattern validation (`CleanIncludePatterns`, `CheckIncludeSetting`, `SplitIncludeSetting`), the matcher, `IgnoredEntries`, `IncludedIgnored` (the one rule for which ignored files are in) |
| `internal/fsx/suggest.go` | `SuggestIgnored` (the add field's suggestions and count), `MergeIncludes` |
| `internal/fsx/files.go` | `FileEntry.Ignored`, `Source.Include`, `WithIncluded`; the listing runs the ignored listing beside `git ls-files -co`; the cache key holds the patterns |
| `internal/store/settings` | `files.include_ignored` (group and section `files`, General page), `DefaultIncludeIgnored` |
| `internal/db/migrations/0062_project_include_ignored.sql` | `project_include_ignored`: one row per project with patterns, a JSON array, `ON DELETE CASCADE` |
| `internal/store/project/include.go` | `Project.IncludeIgnored`, `SetIncludeIgnored`, `CleanIncludes`; loaded at start, kept by reconcile |
| `internal/api/filesystem*.go`, `project_include.go` | `SearchFiles` sends each source's effective patterns and fills `FileMatch.ignored`; `SuggestIncludeIgnored`; `SetIncludeIgnored` |
| `internal/command/commands_project_include.go` | `project.files.include <project> <patterns|none>` |
| `proto/.../project.proto`, `filesystem.proto` | `Project.include_ignored`, `SetIncludeIgnored`; `FileMatch.ignored`, `SuggestIncludeIgnored`, `IgnoredSuggestion` |
| `gui/frontend/mock/includeIgnored.ts` (+ settings, world, server, filesystem) | the setting, per-project patterns, the command, the ignored flag on matches, the suggestion RPC; `POST /__mock/ignored` |

## For PR 2 (the GUI)

* Setting key `files.include_ignored` (General page, section `files` "Files"). A String
  field: comma-separated patterns. Its schema `default_value` is the defaults:
  `.env*, CLAUDE.local.md, .claude/settings.local.json` (`settings.DefaultIncludeIgnored`).
  "Restore N defaults" = the defaults (split at commas, trimmed) missing from the current
  value, appended; the user's own patterns are untouched.
* Removing a default writes the remaining list, which is a set value, so it stays removed.
  An empty value means "unset", which is the default list again (the settings store's rule
  for every key), so **the empty list is `none`**, like `plugins.registries`. Removing the
  last pattern must write `none`; reading `none` means no patterns. Duplicates in the value
  are accepted and dropped when read.
* The project's own list: `Project.include_ignored` (in every project message and event),
  set with `ProjectService.SetIncludeIgnored{id, patterns}` (the whole list; empty clears)
  or the command `project.files.include` (`patterns` comma-separated or `none`). Invalid
  patterns are InvalidArgument with a readable message (the GUI can show it as is after
  "invalid argument: ").
* `FileMatch.ignored`: the match is a git-ignored file an include pattern brought in. A
  directory is marked when only included ignored files are under it (`build/` when
  `build/reports/a.html` is included).
* `FilesystemService.SuggestIncludeIgnored{project_id, text, limit}`: suggestions
  (`path`, `is_dir` for a collapsed folder, `file_count`/`file_count_capped`, `included`
  when the effective patterns already cover the whole entry, `matches_text` when the typed
  text as a pattern covers it, `path_positions`), `truncated`, and for the typed text
  `text_files`/`text_files_capped` (how many files it includes on its own) or `text_error`
  (why it is not a valid pattern, no "invalid argument" prefix). FailedPrecondition for a
  project without git.

## Rules

* **Patterns** are .gitignore-style: a pattern without a slash (other than a trailing one)
  matches a name at any depth (`.env*`, `CLAUDE.local.md`); one with a slash is anchored at
  the checkout's root and matched segment by segment (`docs/scratch/`,
  `.claude/settings.local.json`); a trailing `/` matches folders only; `*`, `?`, `[...]`
  and `\` work within a segment (Go's `path.Match`), `**` spans segments, a trailing `/**`
  is everything inside. A pattern matching a folder matches everything in it (as in
  .gitignore), so `docs/` includes `docs/scratch/n.md`.
* **Candidates**: `git ls-files -oi --exclude-standard --directory -z`. Git lists an ignored
  file in a folder it looks into on its own line, and a wholly ignored folder collapsed
  (`node_modules/`). A file entry that a pattern matches (itself or through a parent
  folder) is included. A collapsed folder that a pattern matches (by name, by path, or
  through a parent) is walked and all its files are included.
* **Name patterns never reach inside a collapsed folder that did not match itself.** `.env*`
  does not find `node_modules/x/.env`, and neither does `**/.env` (a leading `**` is a name
  pattern in .gitignore).
* **A path into a collapsed folder** (`build/reports/*.html` with `build/` collapsed): the
  rule chosen is "an anchored pattern whose leading segments name the folder's segments one
  by one, with no `**` among them, and that has segments left, goes in". Those patterns
  alone are then tested against what is inside, and the walk skips subfolders they cannot
  reach. So `build/reports/*.html` finds `build/reports/a.html` (not
  `build/reports/deep/c.html`: `*` stops at `/`), `build/**/*.html` finds both,
  `*/reports/*.html` goes into any top-level collapsed folder (the user named one level),
  and `**/*.html` goes into none. Rejected: never reaching in (a user who typed the full
  path gets nothing, with no way to say it) and testing every pattern inside every folder
  (`.env*` would walk node_modules, the case this design exists to avoid).
* **Walks** never follow symlinks (a link is listed as a file, like git does), skip `.git`
  (a nested repository's), skip unreadable folders, and stop at 20,000 included files or
  100,000 entries read per checkout (logged; the rest of the listing is kept).
* **Git's expanded folders**: an untracked folder whose files are all ignored is printed as
  `logs/` *and then* its files. Such a folder is not collapsed: `parseIgnored` drops a
  folder line that the next sorted line starts with, so only folders git did not look into
  are walked. Its files match like any other (`*.log`, or `logs/` through the parent rule).
* **Effective patterns** for a checkout: the setting's, then the project's, without repeats
  (`fsx.MergeIncludes`). The same list for the finder and `@` (one `SearchFiles`); the
  later text search will call `fsx.IncludedIgnored` with it.
* **Projects without git** (the walk) have no ignore notion: patterns do not apply, and a
  walked source's cache key drops them. A git project whose `git ls-files` fails falls
  back to the walk too.
* **Validation** (both levels, `fsx.CleanIncludePatterns`): trimmed; repeats dropped (first
  kept); refused: empty, over 200 bytes, a control character, a comma (the setting's
  separator; refused in projects too so a pattern can move between levels), a leading `!`
  (nothing to re-exclude), `#` (a comment in .gitignore), `/` (absolute; this also means
  .gitignore's root anchor `/foo` is not available: a name pattern matches at any depth),
  `~` or `~/`, a `.`, `..` or empty segment, more than four `**` segments (each multiplies
  the matching work), a malformed glob; more than 100 patterns per list. InvalidArgument
  from the RPC; the setting reports it as an issue and keeps the default.

## Cache

The candidate cache key is `<git>:<dir>` followed by each pattern after a NUL, so a list
built with other patterns is never served; changing the setting or a project's patterns
lists again on the next search, and the old entry ages out with the 5 s TTL. A walked
source keys without patterns. The key keeps its old form when there are none
(`TestFileIndexConcurrentMissesShareOneListing` peeks at it).

## Measurements

M3 Pro, the main code-foundry clone (4,960 tracked and untracked files; ignored: `bin/`,
`gui/.task/`, `gui/bin/`, `gui/frontend/dist/` with 349 files, `gui/frontend/node_modules/`,
`gui/frontend/test-results/`), best of 7:

| What | ms | result |
|---|---|---|
| `git ls-files -co` | 39.6 | 4,960 files |
| `git ls-files -oi --directory` | 30.9 | 6 entries |
| included, the three defaults | 31.3 | 0 files (the listing alone) |
| included, `gui/frontend/dist/` | 18.2 | 349 files |
| included, `node_modules/` | 155.0 | 20,000 files (capped) |
| the whole listing, no patterns | 28.7 | 5,265 entries |
| the whole listing, the defaults | 29.3 | 5,265 entries |
| suggestions, empty text | 37.4 | 6 entries, folders counted |
| suggestions, `node_modules/` | 147.0 | 20,000 files counted (capped) |

The ignored listing runs beside `git ls-files -co`, so the defaults cost nothing visible
on a cached-miss listing. Including `node_modules/` is bounded by the 20,000 cap.
`gui/frontend/node_modules/react/*.js` finds nothing there: bun installs `react` as a
symlink into `.bun/`, and links are never followed.

## Gotchas

* The settings store treats an empty value as unset (it deletes the key), so an empty list
  needs a sentinel; `none` follows `plugins.registries`. A file literally named `none` can
  still be included with `**/none`, which is the same pattern in other words.
* Two sentinels read "invalid argument" (`fsx` and `project`): `project.CleanIncludes`
  swaps the sentinel and keeps the message so `projectError` maps it.
* `SetIncludeIgnored` takes the project store's rename lock (one metadata write at a time)
  and reconcile keeps the current patterns the way it keeps a rename (`keptIncludesLocked`
  next to `renamedLocked`).
* The insert uses `SELECT id ... FROM projects WHERE id = ?` so an unregistered project
  never gets a row the cascade would have missed.
* `project.files.include` is PageState, like `settings.set`.
* The mock gives every git project a few ignored entries (`IGNORED`: `.env`, `.env.local`,
  `src/.env.test`, collapsed `dist`, `docs/scratch`, `node_modules`), so the GUI has something
  to show. A project whose files a spec sets (`POST /__mock/files`) starts with none:
  `composer-files` counts the `@src` rows exactly, and `src/.env.test` made 22 of 21.
  `POST /__mock/ignored` sets a project's entries.
* While testing end to end, a cleanup `pkill -f "bin/code-foundry daemon --dev"` ran once
  (an unknown `daemon stop` verb fell through to it); it matches any worktree's dev daemon.
  Stop a scratch daemon by its pid instead.

## Tests

* Go: `TestCleanIncludePatterns`, `TestIncludeSetting`, `TestIncludePatternMatch`,
  `TestIncludePatternNames`, `TestParseIgnored`, `TestIncludedIgnored` (a real repo: the
  defaults stay out of `node_modules`, folders by name, path and parent, paths into a
  collapsed folder with and without `**`, a leading `**`, git's expanded folder, links,
  nested `.git`), `TestIncludedIgnoredBounds`, `TestWithIncluded`,
  `TestSearchIncludesIgnored`, `TestFileIndexCacheKeysPatterns`, `TestSuggestIgnored`,
  `TestSuggestQuery`, `TestMergeIncludes` (fsx); `TestIncludeIgnoredField` (settings);
  `TestCleanIncludes`, `TestSetIncludeIgnored` (store: stored, published, kept by
  reconcile, reloaded, cleared, cascaded on unregister); `TestSearchFilesIncludesIgnored`,
  `TestSuggestIncludeIgnored`, `TestSetIncludeIgnored` (api); `TestProjectFilesInclude`
  (command).
* Vitest: `mock/includeIgnored.test.ts` pins what PR 2 builds against.
* Playwright: the full suite against the mock (moved ports: other worktrees' mocks held the
  default ones, which made a first run fail with ECONNREFUSED halfway): 574 passed, one
  failed, `code-select.spec.ts:49` ("line not laid out", a File tab layout race under load,
  code this PR does not touch), which passed when run again on its own.

## Verified

* `make check` green (the first run failed `TestLayoutWayBack`; fixed as above).
* A scratch daemon (`CODE_FOUNDRY_HOME` in a temp dir, `make build`), a scratch git repo
  under home with `.env`, `.env.local`, `src/.env`, `CLAUDE.local.md`,
  `.claude/settings.local.json`, ignored folders `node_modules/`, `build/`, `docs/scratch/`
  and `logs/x.log`, registered with `project add`, Connect JSON over the socket with curl:
  * Defaults: `env` found `.env`, `src/.env`, `.env.local` marked ignored, not
    `node_modules/dotenv/.env.example`; `local` found `CLAUDE.local.md` and
    `.claude/settings.local.json`.
  * `SetIncludeIgnored` with `" docs/scratch/ ", "build/reports/*.html", "docs/scratch/"`
    stored two patterns; `plan` then found `docs/scratch/plan.md`, `html` found
    `build/reports/a.html` (not `deep/b.html`); `../x` and `!x` InvalidArgument with their
    messages; `Get` returned the patterns.
  * `settings set files.include_ignored "CLAUDE.local.md, .claude/settings.local.json"`:
    `env` found nothing (the removed default stayed removed); `none`: nothing; `/etc/hosts`
    refused; `settings reset` brought the defaults back.
  * `SuggestIncludeIgnored`: empty text listed the entries with folder counts and
    `included`; `node_modules/` gave the folder, 2 files, `matches_text`; `build/**/*.html`
    gave `build` and 2 files; `~/x` a `text_error`; limit -1 InvalidArgument.
  * `project files include app "dist/, .env*, dist/"`, `none`, `../x` refused; the row was
    in `project_include_ignored`, and `project unregister` removed it; registering again
    started with no patterns.
  * Cleanup: the daemon stopped, the scratch repo and home deleted.

## The way back from the shell

`internal/db/wayback/0061_layout.sql` takes a database back for a build from before the
window shell, which refuses any migration it does not know. With 0062 after 0061, dropping
only 0061 was no longer enough (`TestLayoutWayBack` caught it), so the way back now also
drops `project_include_ignored` and 0062's record: a rollback loses each project's own
patterns (the setting's stay in settings.toml), and the next update makes the table again.
