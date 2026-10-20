# Skills 4: Settings → Skills (2026-10-20)

The last of four PRs for the Skills marketplace (`skills-1-registry.md` the store,
`skills-2-lifecycle.md` the lifecycle and `skill.*`, `skills-3-api.md` the service, view
models, store and mock). GUI only: no Go, proto or migration changes, so a running daemon
from main serves it.

## What is here

| Piece | Where |
|---|---|
| The page (`skills` beside `plugins`, "Claude Code plugins and skills from your organisation's marketplace.") | `components/settings/guiPages.ts`, `components/skill/settings/SkillsPage.tsx` |
| Installed: rows, actions, busy, failure | `components/skill/settings/InstalledSection.tsx` |
| Browse: search, chips, count, virtualised hits | `components/skill/settings/BrowseSection.tsx` |
| Registries: rows and the empty state | `components/skill/settings/RegistriesSection.tsx` |
| The confirm dialog (Disable, Uninstall, Remove) | `components/skill/settings/ConfirmSkillDialog.tsx` |
| The daemon confirm answered for a call the page confirmed | `stores/skillConfirm.ts` |
| Words, dates, pills, chips (pure) | `components/skill/settings/model.ts`, shared pieces in `parts.tsx` |
| Section hits in the settings search | `components/settings/model.ts` (`searchGuiPages`), `SearchResults.tsx`, `SettingsPage.tsx` |
| Tests | `model.test.ts`, `SkillsPage.test.tsx`, `settings/model.test.ts`, `e2e/skills.spec.ts`; `e2e/settings.spec.ts` lists Skills in the nav |

## The page

* **Installed** (one row per `InstalledSkillView`, the daemon's order): name, a Plugin or
  Skill pill (outlined), the version (a plugin's as it is; a skill's `YYYYMMDD · 3 weeks
  ago`), "from <marketplace> · by <by>" or "Local", the description, "<v> is available."
  when offered, a plugin's "N skills ›" expanding to the names, the state pill, and the
  buttons `installedActions(row)` gives, in its order: Enable (outline) or Disable,
  "Update to X" (amber outline; "Reinstall" for a missing skill), Run setup (amber
  outline), Uninstall, or Remove alone for a local skill. A busy row spins its action and
  disables every button; a failure is red under the row with a ×. Empty: "Nothing
  installed yet. Install a plugin or skill from Browse below." `pluginsError` (claude
  plugin list failed) is an amber line above the rows.
* **Browse**: the search field (150 ms after the last key), chips Enterprise / Community
  and Plugin / Skill, Refresh (`refreshSkillMarketplaces`, "Refreshing…" with a spinning
  icon), "N results" (", showing the first 200" when `total` is larger), the search's
  failure in red and the refresh's (`refreshError`) in amber, then the hits in a
  `VirtualStack` (the PR panel's variable-height list on the page's own scroll box;
  virtualised over 40 hits; expanding a plugin's skills is measured in place). A hit:
  name, tier pill, kind pill, version or date and age, "by X", description, keywords
  (muted, "sql · warehouse"), "N skills ›" on plugins, and Install (amber outline),
  "Update to X" or "✓ Installed" / "✓ Installed, disabled". Nothing found: "Nothing
  matches “x”."; nothing at all: "Nothing to browse yet: see Registries below."
* **Registries**: one row per marketplace (name, `repo` else url else checkout dir,
  "2 plugins · 11 skills · read 5 min ago", "by <owner>"), a shallow clone's note, the
  read or refresh error and the issues in amber; the list's own failure above. None:
  "No marketplace is configured. Add your organisation's with `claude plugin marketplace
  add <owner/repo>` (for example ai-marketplace) and Refresh." (`expectedMarketplace`).

## Decisions

* **State pill order**: Missing, then Disabled, then Needs setup, then Enabled. A
  disabled skill whose script never ran says Disabled (its Run setup button still says
  the rest); a local skill has no pill (its source line says Local). Missing rows also
  say "Its directory is gone. Reinstall puts it back; Uninstall forgets it."
* **Chips**: two groups of two toggles; none or both on in a group is "any" (the API
  takes one tier and one kind). A chip searches at once with the text typed so far and
  cancels a debounce in flight, so a wait never undoes it (the first version's timer
  carried the chips from when typing started; caught in the screenshots, now an e2e step).
* **Confirms**: the page asks with its own dialog (the plugin page's uninstall dialog
  style: icon, title, text, destructive outline for Uninstall and Remove, neutral outline
  for Disable). Every text ends with the brief's restart warning; Remove's says it deletes
  `<dir>`, "a skill you wrote", which no marketplace can put back. Confirming runs the
  command with its `name` argument marked preconfirmed; presenters registered for
  `skill.disable`, `skill.uninstall` and `skill.remove` answer yes for that call only
  (the palette still gets the generic confirm with the daemon's words).
* **Run setup without an owner**: disabled, wrapped in a `Tip` reading "Select a thread
  or project first: setup runs in its bottom panel." (`NO_SETUP_OWNER` capitalised). The
  owner is re-checked when the selection changes. With one it runs
  `runSkillSetup(row, {reveal: true})`, which leaves Settings for the terminal.
* **Settings search**: GUI pages were not searchable (the search reads schema fields;
  Plugins is found by its `plugins.registries` field). A GUI-only page now lists its
  sections in its `SettingPageView.sections`, and `searchGuiPages` matches every word
  against page title, section title and description. Hits are link rows after the field
  rows ("Skills › Browse"), counted in the nav; a hit opens the page and scrolls to the
  section, following it while the page's reads grow the content above it (up to 1.5 s or
  until the user scrolls). Plugins keeps its schema page and is not given section hits.
* **Icon**: lucide `Sparkles` for the nav (no other page uses it).
* **No Refresh on Registries**: one Refresh, in Browse's toolbar (the empty state's "and
  Refresh" refers to it); two buttons for one command read as two actions.
* Relative ages are day-grained ("today", "5 days ago", "3 weeks ago", "4 months ago"),
  re-read once a minute; marketplace reads are minute-grained ("read 5 min ago").

## Verification

* `pnpm vitest run src/components/skill src/components/settings src/design` (model
  tables: ages, versions, pills incl. disabled over needs setup, chips, confirm words;
  rows' actions per state, busy and failure, plugin expansion, empty state; Browse
  actions, chips, debounce; the page's confirm answering the daemon's presenter; the
  GUI-page search). `make check` green.
* `make gui-e2e` with the new `e2e/skills.spec.ts` (installed states and an update,
  search + chips incl. a chip during the debounce, install and an injected install
  failure, disable confirm + cancel + no second dialog, Remove's words, setup disabled
  tooltip, setup with a thread, registries populated and `registries=none`, the settings
  search opening the page at Registries).
* End to end against a real dev daemon (`CODE_FOUNDRY_HOME=/tmp/cf-s4/home`,
  `CLAUDE_CONFIG_DIR=/tmp/cf-s4/cfg`, no session `CLAUDE*` variables) with a scratch
  directory marketplace `ai-marketplace` (the store's test fixture plus eight skills,
  committed on different dates; deleted afterwards): `skill install` of four skills and
  `enterprise-data`, `skill disable sql-helper`, a local `my-notes`, a newer commit for
  incident-postmortem and `skill refresh` (offer 20261016 → 20261019). The worktree's
  frontend (vite) in Playwright WebKit against it: Install dbt-model from Browse (✓
  Installed, Installed row Enabled), Disable from Installed through the page's dialog
  (no generic confirm; the daemon logged `skill disabled` into `<home>/skills/disabled`),
  Uninstall (row gone, `skill uninstalled`). Registries empty after `claude plugin
  marketplace remove ai-marketplace` + `skill refresh`, back after re-adding it.

## Screenshots

The frontend in WebKit against that daemon (as plugins 5 and 7: a Wails copy shares the
installed app's WebKit storage), dark and light: the page, Installed, Browse ("sql" with
Enterprise, enterprise-data's skills open), Registries populated and empty. On the
`cf/skills-4-shots` branch and in the PR body. Run setup shows disabled in them: the
scratch daemon has no thread or project (the tooltip state is in the e2e).

## Gotchas

* A directory marketplace has no `repo`: its row shows the checkout path where a GitHub
  one shows owner/repo.
* The fixture's skills with setup scripts (pr-review, sql-helper) install as Needs setup;
  only a thread or project in the context lets Run setup run.
* `toBeInViewport` on a section right after the page opens raced the page's reads (the
  section scrolled into view, then Installed and Browse grew above it): hence the
  follow-until-settled scroll.
