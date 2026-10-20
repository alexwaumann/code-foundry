# Skills 1: marketplace reader, search, installed state (2026-10-20)

The first of four PRs for Settings → Skills (Installed, Browse, Registries): the store
the other three build on. No commands, proto or GUI here: PR 2 adds the lifecycle
(install, enable/disable, update, uninstall, setup) and the `skill.*` commands, PR 3
`SkillService`, PR 4 the page.

## What is here

| Piece | Where |
|---|---|
| Checkout reader: index + `plugin.json` + skills walk, frontmatter, setup scripts | `internal/store/skill/marketplace/marketplace.go`, `frontmatter.go` |
| Per-directory last commit, one `git log` pass cached by HEAD; `Unshallow` | `internal/store/skill/marketplace/git.go` |
| Search (filters, ranking, limit) | `internal/store/skill/marketplace/search.go` |
| Test checkouts: the fixture in `testdata/registry` committed at fixed dates | `internal/store/skill/marketplace/marketplacetest` |
| The `claude` runner (`Claude`, `ExecClaude`) and its two list parsers | `internal/store/skill/claude.go` (fake in `skilltest`) |
| Store: snapshot, `Load`, `Refresh`, `Search`, `Entry`, `Registries`, `Installed` | `internal/store/skill/store.go` |
| Installed plugins and skills, update offers, Needs setup | `internal/store/skill/installed.go` |
| `skill_installs` | migration `0038_skill_installs.sql`, `internal/store/skill/db.go` |
| Daemon glue: construction, start-up read, hourly refresh | `internal/daemon/skill_registry.go`; the tick loop moved out of `plugin_registry.go` into `update_ticks.go` (`onUpdateChecks`), which both registries use |
| `<home>/skills/disabled` | `paths.DisabledSkills()` |

## How it reads

1. **Registries** are `claude plugin marketplace list --json` (`name, source, repo, url,
   ref, installLocation`), in that order. No setting of ours and no clone of ours.
2. **Each checkout** (`installLocation`) is read by `marketplace.Read`:
   * Plugins: every `.claude-plugin/marketplace.json` entry. A string `source` is a
     repo-relative directory; its `.claude-plugin/plugin.json` (optional) gives `by`
     (`author.name`), and the skills are the entry's `skills` list, else `plugin.json`'s
     (string or list), else `<source>/skills`; each listed path is a skill dir or a
     dir of them. An object `source` (a git URL, another repository) is listed with
     what the index says and no path, skills or date.
   * Skills: every directory with a `SKILL.md` under `enterprise/skills/**` and
     `community/skills/**`, not descending into a skill and skipping hidden dirs and
     symlinks. Nothing else in the repository is walked.
   * Tier is the path's first segment when it is `enterprise` or `community`, else
     `""` (a public marketplace's `./plugins/x`). The tier filter never matches `""`.
3. **Dates**: `git -C <dir> rev-parse --show-toplevel --is-shallow-repository HEAD`, then
   (when HEAD or shallowness changed) `git log --no-renames --format=%x01%H%x00%cI
   --name-only HEAD` once; each changed path's commit is credited to every ancestor
   directory, newest committer date winning. Entry `LastUpdated`/`CommitSHA` are their
   directory's; a skill's `Version` is `LastUpdated.UTC()` as `YYYYMMDD`.
4. **Installed**: `claude plugin list --json` (`id name@marketplace, version, scope,
   enabled, installPath, lastUpdated`), joined with the catalog by name for description,
   skills and the update offer; then the top-level dirs with a `SKILL.md` in
   `$CLAUDE_CONFIG_DIR/skills` (else `~/.claude/skills`; enabled) and
   `<home>/skills/disabled` (disabled), skipping `synced` and dot dirs, joined with
   `skill_installs` by name. No row: `Local`. A row without a dir: `Missing`.
5. The new `Snapshot` is stored and `skill.Changed{Epoch}` published, on every read.

## Decisions

* **Claude Code clones marketplaces with `--depth 1`.** Verified: `claude plugin
  marketplace add anthropics/skills` leaves a shallow clone with one commit, so every
  directory would date from HEAD and every installed skill would be offered an update
  whenever HEAD moved. `Refresh` therefore runs `git fetch --quiet --unshallow` once on
  a shallow checkout after Claude Code's own update (network only on Refresh, never on a
  read). Verified that `claude plugin marketplace update` keeps a deepened checkout deep.
  Until the first Refresh the registry has `Shallow` and an issue saying dates are the
  last commit's. This is not "cloning ourselves": it adds history to Claude Code's
  clone and changes no ref or file.
* **Not every checkout is git.** `claude-plugins-official` on this Mac is a downloaded
  tree with no `.git`; a dir inside someone else's work tree (a dotfiles repo holding
  `~/.claude`) is treated the same (`--show-toplevel` must be the checkout). Those
  entries have no dates, skills have no version and offer no updates; the registry
  carries an issue.
* **Tolerant reading.** Only a missing checkout fails a read; a missing or broken
  `marketplace.json`, a nameless or duplicate plugin, a source outside the checkout,
  an unreadable skill are issues on the registry and the rest is read. A failed read
  keeps the last good catalog (and its `ReadAt`) with `Err` set; a failed `marketplace
  list` keeps the last good registries with `Snapshot.Err`; a failed `plugin list` keeps
  the last plugins with `Snapshot.PluginsErr` (skills are still re-read).
* **Frontmatter** is a small YAML-subset parser (no YAML dependency in the module):
  scalars plain/quoted, `>`/`|` blocks, one nested map (`metadata`), block and flow
  lists, comma strings for keywords; unknown structure is ignored, nothing fails.
  `by` = `owner`, else `metadata.owner`, else `metadata.author`, else `author` (the
  brief's "owner" is read in both places since the seen frontmatter has it under
  `metadata`). Descriptions are collapsed to one line, at most 2,000 bytes.
* **Plugin version and by**: the index's `version`, else `plugin.json`'s; `by` is
  `plugin.json` `author.name`, else the index entry's `author` (object or string).
  Keywords are tags + category (+ either file's `keywords`), de-duplicated.
* **Search**: words split on whitespace, every word must match name, description, a
  keyword or by (case-insensitive substring). Rank: exact name, name prefix, name
  contains the whole text, then the rest; then name, tier (enterprise first), kind,
  path, registry. `Limit` defaults to 50, capped at 500; `Result.Total` is the count
  before the limit, for "N results".
* **`Entry(name, kind)`**: exact, case-sensitive name (Claude Code and the skills dir
  are). Kind `""` with both a plugin and a skill of that name is an `*AmbiguousError`
  (`errors.Is(err, skill.ErrAmbiguous)`, message names `--kind plugin` and `--kind
  skill`); two of the same kind (two registries, or a name in both tiers) resolve to
  the first in registry, then tier, order. Unknown is `ErrNotFound`.
* **Update offers are derived on every read**: plugin when the index version is
  semver-newer (`update.Newer`; Claude Code reports a commit prefix such as
  `dbd4588f9e10` when the index has no version, which never compares, so no offer);
  skill when the registry entry at the record's `path` has a later commit time than
  `commit_at`. The entry is found by path, not name, so a renamed skill still updates.
* **`skill_installs.setup_script` is relative to the skill dir** (what an installed copy
  runs; `Entry.SetupScriptInSkill()` converts from the entry's repo-relative
  `SetupScript`). `NeedsSetup` is a script that never exited 0 or whose sha256 on disk
  differs from `setup_sha256`. The columns are the brief's; nothing writes them until
  PR 2 (`saveRecord`/`deleteRecord` are in `db.go` for it).
* **Every read publishes** a new epoch (hourly plus each lifecycle op in PR 2); an open
  page re-running a 50-row search on each is cheap, and diffing snapshots was not.
* **Cadence**: the start-up `Load` runs in the background (two local `claude` calls and
  the git reads; no network). `Refresh` rides `onUpdateChecks`, the plugin registry's
  loop: after each updater check, or for a dev build 30 s after start and then hourly.
  `refreshMu` keeps a slow Refresh from blocking reads; `Load` is serialized on `mu`.
* **`claude` executable**: `advanced.claude_path`, else `claude` from PATH (the thread
  store's rule), read on every call so the setting applies live. Each call is bounded
  at 3 minutes (Claude Code's own git operations time out at 120 s) and gets
  `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`.

## Gotchas

* `marketplace.json` `plugins[].source` is an object for most of the official
  marketplace (262 of 315 there: `git-subdir`, `url`, `github`): never assume a string.
* `anthropics/skills` lists five plugins all with `source: "./"` and explicit `skills`
  paths; walking `<source>/skills` would have given each plugin every skill. The entry's
  list wins for that reason. Such a plugin's date is the whole checkout's.
* `git log --name-only` prints nothing for merge commits; a merged branch's own commits
  carry the paths with their own committer dates, so a skill merged late may date
  before the merge. Consistent for update offers (both sides read the same way).
* `core.quotePath=false` is needed or non-ASCII paths come back quoted and never match.
* The Go daemon e2e tests (`internal/daemon/*_e2e_test.go`, `cmd/code-foundry`,
  `internal/client`) start a real daemon, whose start-up read runs the configured
  `claude plugin marketplace list` and `claude plugin list` (read-only; on CI there is
  no claude and the read logs the failure). The store's own tests only use the fake.

## For PRs 2–4

```go
func New(opts skill.Options) (*skill.Store, error)
func (s *Store) Load(ctx context.Context) error           // re-read, no network; PR 2 calls it after each op
func (s *Store) Refresh(ctx context.Context) error        // claude plugin marketplace update + re-read
func (s *Store) Snapshot() *skill.Snapshot               // Epoch, Registries, Installed, Err, PluginsErr
func (s *Store) Registries() []skill.Registry
func (s *Store) Installed() []skill.Installed
func (s *Store) Search(q marketplace.Query) marketplace.Result
func (s *Store) Entry(name string, kind marketplace.Kind) (marketplace.Entry, error)
// events: bus.Subscribe[skill.Event]; skill.Changed{Epoch}
```

Browse's Install / Installed / Update state joins a `marketplace.Entry` with
`Installed`: a plugin by `PluginID(name, registry)` == `Installed.ID()`, a skill by
`Installed.Registry == e.Registry && Installed.Path == e.Path`.

## Verification

* `go test ./internal/store/skill/...` (fixture checkout with three dated commits;
  shallow clone + unshallow; not-git; failures; installed join; refresh).
* `make check` green.
* End to end: a dev daemon with `CODE_FOUNDRY_HOME` and `CLAUDE_CONFIG_DIR` pointing at
  scratch dirs, the latter holding `anthropics/skills` added with `claude plugin
  marketplace add` (a shallow clone), `document-skills` installed and one local skill
  in its `skills/`: the start-up read logged `marketplaces read registries=1 plugins=5
  skills=0 installed=2 epoch=1`; with `CODE_FOUNDRY_UPDATE_DELAY=5s` the refresh ran
  `claude plugin marketplace update`, logged `marketplace history fetched`, and read
  again (`epoch=2`); the checkout went from shallow (1 commit) to full (60 commits).
