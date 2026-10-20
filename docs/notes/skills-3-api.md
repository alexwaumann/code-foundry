# Skills 3: SkillService, the GUI's view models and store, the mock marketplace (2026-10-20)

The third of four PRs for Settings → Skills (`skills-1-registry.md` is the store,
`skills-2-lifecycle.md` the lifecycle and the `skill.*` commands). This one puts the store
on the wire and gives the GUI everything but components: PR 4 writes the page.

## What is here

| Piece | Where |
|---|---|
| `SkillService`: Search, Installed, Registries, Watch | `proto/codefoundry/v1/skill.proto`, `internal/api/skill.go` |
| EventService skill source (`EVENT_SOURCE_SKILL`, `Event.skill`) | `events.proto`, `internal/api/skill.go` (`skillSource`), `EventsDeps.Skill` |
| `Snapshot.InstalledOf(entry)` (the Browse join, shared by the API and `skill.browse`) | `internal/store/skill/installed.go` |
| Plugin update offer from `plugin.json` on both sides; `Entry.ManifestVersion`; `Installed.By` | `installed.go` (`pluginOffer`), `marketplace.go` (`ManifestVersion`) |
| `events` CLI prints an integer case's value (`12 skill epoch 3`) | `cmd/code-foundry/events.go` |
| View models and RPC calls | `gui/frontend/src/api/skill.ts` |
| The store: search, installed, registries, epoch re-reads, busy and failure per row, actions | `gui/frontend/src/stores/skill.ts`; `stores/events.ts` routes the source |
| Mock `ai-marketplace`, SkillService, `skill.*`, `/__mock/skills` | `gui/frontend/mock/skills.ts`, `world.ts`, `server.ts` |

## Decisions

* **The service only reads.** Install, enable, disable, update, uninstall, remove, setup
  and refresh stay the `skill.*` commands (CommandService), as the brief says and as the
  plugin page does: confirms (the restart warning), errors and the palette/CLI are the
  same path. `SearchSkillsRequest.refresh` exists for scripts; the page uses
  `skill.refresh`.
* **The epoch rides both a `Watch` and the EventService.** The codebase's pattern: each
  service has a Watch for the CLI and tests, and EventService multiplexes them for the
  GUI's one stream. The skill source's snapshot is the current epoch; every read
  publishes the next. It is not added to the plugins' `events/subscribe` names (that is
  the pluginsdk's contract).
* **Responses carry the epoch** they were read at, so a client can tell a stale answer.
* **Entry state is the daemon's join**, not the GUI's: `SkillEntry.state`
  (not installed / enabled / disabled), `installed_version`, `update_version`. The join
  (`Snapshot.InstalledOf`: a plugin by name and marketplace, a skill by marketplace and
  path) moved into the store so the command's `browseView` and the API share it.
* **Installed state is an enum** (installed / local / missing) rather than two bools;
  `enabled` and `needs_setup` stay bools.
* **The plugin offer compares plugin.json with plugin.json** (PR 2's gotcha). Claude Code
  installs and reports the version in the plugin's `.claude-plugin/plugin.json`, so an
  index version that differs (1.4.0 vs 1.3.9 in the fixture) offered an update forever.
  Now: when the checkout's `<source>/.claude-plugin/plugin.json` has a version, it is
  compared with the installed `installPath/.claude-plugin/plugin.json` (else the version
  `plugin list` reports); only a checkout without one compares the index version. The
  offer's version is then plugin.json's, i.e. what `claude plugin update` brings, so
  Browse may show the index's 1.4.0 as the entry's version and "Update to 1.5.0" when
  plugin.json says so. `Entry.Version` stays the index's (the brief).
* **`Installed.By`** is new: the marketplace entry's `by`, else the installed
  SKILL.md's frontmatter (a local skill).
* **GUI store** (`stores/skill.ts`, hook `useSkillMarketplaceStore`): not named
  `useSkillsStore`, which is the composer's "/" list (`stores/skills.ts`). It re-reads
  only while a page holds it open (`openSkillMarketplace()`), 100 ms after an epoch (a
  burst reads once), and runs the current query again then. Searches run at once and are
  sequenced: an older answer is dropped and its request aborted; the page debounces
  (150 ms). The search limit is 200 (the list is virtualised; the daemon caps at 500).
* **Every action passes `--kind`**, and a plugin's name as `<name>@<marketplace>`, so a
  shared name or a second marketplace never asks. Except `skill.remove` and
  `skill.setup`, which have no `kind` argument (the registry refuses unknown
  arguments; only skills are local or have setup).
* **Per-row failure** is the command's error text (also toasted, the plugin page's
  `failedProgress` pattern without progress steps: skills have none); a declined confirm
  clears it, the next try replaces it, `dismissSkillFailure` takes it away.
* **Setup's owner**: `canRunSetup(ctx)` is the daemon's rule (thread, worktree or
  project); `NO_SETUP_OWNER` is its words for the disabled button's tooltip.
  `runSkillSetup(item, {reveal: true})` opens the terminal's bottom panel
  (`revealShell`, which leaves Settings); without it the id is returned.

## Mock

`ai-marketplace` (`cof-primary/ai-marketplace`, owner AI Platform): three enterprise
plugins (enterprise-data 1.4.0 with 4 skills, installed 1.3.2 so it offers an update;
secure-coding 2.1.0 with 3, installed and enabled; release-train 0.9.3 with 5, not
installed) and 39 skills (22 enterprise, 17 community; fixed dates, YYYYMMDD versions,
six with setup scripts). Installed: pr-review (enabled), sql-helper (disabled),
jira-sync (needs setup), incident-postmortem (update 20260904 → 20261016) and the local
skill my-notes. Search is the daemon's algorithm (`searchEntries`). Each command takes
one to three 250 ms steps and publishes an epoch; refusals use the daemon's words;
unknown arguments are refused like the registry. `skill.setup` opens a `kind=setup`
terminal in the context's thread, worktree or project that prints three lines and exits
0 after about a second, which marks the skill set up. `skill.disable` / `uninstall` /
`remove` confirm with the daemon's text. Controls: `POST /__mock/skills?fail=<command>
&error=<message>` (until cleared with an empty error), `registries=none|default`,
`listError=…`, `pluginsError=…`, `epoch=1`; `GET /__mock/skills` for calls and state.

## Gotchas

* `enable` is a zsh builtin: tooling that vets shell commands may refuse
  `code-foundry skill enable …`; `code-foundry skill.enable …` is the same verb.
* The fake claude's plugin install path has no `plugin.json`, so tests of the offer
  write one into a temp install path (`TestPluginUpdateOffer`).
* The mock's `isPanel` now counts `kind=setup` (the daemon's `termlabel.IsPanel` does),
  so `terminal.close` and thread removal take setup terminals.

## For PR 4

API (`@/api/skill`): `SkillEntryView` (key, kind, tier, name, description, by, version,
declaredVersion, lastUpdatedMs, registry, path, keywords, skills, setupScript, state
`not-installed|enabled|disabled`, installedVersion, updateVersion), `InstalledSkillView`
(key, kind, name, id, registry, path, tier, description, by, version, lastUpdatedMs,
enabled, state `installed|local|missing`, dir, scope, skills, setupScript, needsSetup,
update `{version, lastUpdatedMs, commitSha} | null`), `SkillRegistryView` (name, repo,
source, url, ref, dir, owner, plugins, skills, shallow, readAtMs, refreshedAtMs, error,
issues), `SkillRegistriesView` (registries, error, expectedMarketplace, epoch),
`SkillSearchView` (entries, total, refreshError, epoch), `skillItemKey`,
`SkillChangeView` / `skillChanges(resultJson)`.

Store (`@/stores/skill`): `openSkillMarketplace(): () => void` (mount/unmount),
`searchSkills(text, tier?, kind?)`, `reloadSkills()`, `installSkill`, `enableSkill`,
`disableSkill`, `updateSkill`, `uninstallSkill`, `removeLocalSkill`,
`runSkillSetup(item, {reveal?})`, `refreshSkillMarketplaces()`,
`dismissSkillFailure(key)`; pure `browseAction(entry)` (install | update | installed),
`installedActions(row)` (the row's buttons in order), `canRunSetup(ctx?)`,
`NO_SETUP_OWNER`, `SKILL_SEARCH_LIMIT`; selectors `useSkillQuery`, `useSkillSearch`,
`useSkillSearching`, `useSkillSearchError`, `useInstalledSkills`,
`useInstalledSkillsError`, `useSkillRegistries`, `useSkillRegistriesError`,
`useSkillRefreshing`, `useSkillBusy(key)`, `useSkillFailure(key)`. An action's `item`
is anything with `{kind, name, registry}` (an entry or an installed row).

## Verification

* `go test ./internal/api/ -run TestSkill` (Search filters, ranking, limit, entry state
  and offers, refresh and a failed one; Installed rows, by, needs setup, local; Registries
  incl. a failed list and none; Watch epochs; the event mapping) and
  `./internal/store/skill/...` (`TestPluginUpdateOffer`: agreeing plugin.json versions
  with a newer index offer nothing; an older installed plugin.json, no installed
  plugin.json, installed newer, a commit prefix, a checkout without plugin.json).
* `pnpm vitest run src/api/skill.test.ts src/stores/skill.test.ts` (mappers, keys,
  change parsing, the event; stale searches dropped and aborted, failures, open/close
  and epochs, busy, every action's argv, setup reveal, refresh once at a time, row
  actions).
* `make check` green; `make gui-e2e` green (the mock's new commands and source).
* End to end on a dev daemon with `CODE_FOUNDRY_HOME=/tmp/cf-s3/home` and
  `CLAUDE_CONFIG_DIR=/tmp/cf-s3/cfg` holding a directory marketplace `ai-marketplace`
  (the test fixture, committed; deleted afterwards). SkillService over the loopback
  listener (Connect JSON): `Search {"query":"sql"}` answered sql-helper (name hit) then
  enterprise-data (keyword), epoch 1. `skill install enterprise-data --kind plugin`
  installed 1.3.9 (plugin.json; the index says 1.4.0); `Installed` showed no update and
  `skill update --check` said "every plugin and skill is up to date" (before this PR:
  "Update to 1.4.0" for ever). After committing plugin.json 1.5.0 and `skill refresh`,
  `--check` listed `enterprise-data plugin 1.3.9 1.5.0`; `skill update enterprise-data`
  went 1.3.9 → 1.5.0 and the offer was gone (Browse: version 1.4.0, installed 1.5.0, no
  update). `code-foundry events --source skill` printed `- skill epoch 3`, then
  `1 skill epoch 4` and `2 skill epoch 5` for a disable and an enable.
* The mock driven over HTTP: Search/Installed/Registries as above; install, the disable
  confirm, `skill.remove --kind` refused, update, an injected install failure, setup
  without and with a thread (terminal `kind=setup`, setup done after its exit 0),
  refresh, `registries=none`.
