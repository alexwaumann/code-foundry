# Search 1: the utility model, and free chords

PR 1 of the thread-search series. The naming model setting becomes the app's model for
its own small jobs (later PRs run Agent search on it), and git fetch/pull/push give up
their default chords so cmd+f and cmd+shift+f can go to search. Needs a daemon restart
(Go change): the old daemon still serves `threads.naming_model`.

## Decisions

* **Key `models.utility`, in a new `models` group.** Groups are the file's tables, so
  the file now has a `[models]` table ("The models Code Foundry uses for its own
  jobs."), right after `[threads]`. Pages and sections are display-only, so the field
  stays where it was on the settings page: General › Text generation, right after "Name
  threads automatically". The section text stays "Models for small jobs like naming a
  thread." (already general).
* **Title "Utility model"**, description "The model Code Foundry uses for its own small
  jobs. Always runs at low effort." No `DependsOn: threads.auto_name`: it is not dimmed
  with automatic naming off (Regenerate name and branch naming use it then too, and
  search will).
* **Default unchanged**: `model.UtilityDefault` (was `model.NamingDefault`) =
  `claude-sonnet-4-6[1m]`.
* **Go names**: `settings.KeyUtilityModel`, `settings.Settings.Models.Utility` (a new
  `Models` struct; `Threads.NamingModel` is gone), `model.UtilityDefault`,
  `thread.WithUtilityModel` / `thread.UtilityModel` (the ctx value the daemon's
  `settingsNamer` sets per call). "the naming model" in comments, the proto docs
  (regenerated) and the branch naming descriptions reads "the utility model"; so does
  Regenerate name's "the utility model gave no title" error.
* **Migration in `settings.decode`**: a `movedKeys` map (old key -> new key) next to
  `retiredKeys`. `threads.naming_model` reads as `models.utility`; when a file sets both,
  the new key wins and the old one is dropped. Nothing is reported for the old key, and
  the next save writes only `[models] utility = ...`. An invalid old value moves too and
  is reported (and kept under "# Ignored:") under the new key. Every reader goes through
  `decode` (the store, `settings.Read` for daemon-less CLI verbs, `ThemeSlots`), so they
  all see the move. Table test: `TestDecodeMovedKeys` (decode, resolve, render).
* **Managed settings need nothing.** `docs/notes/naming-managed-settings.md` is about
  Claude Code's managed settings refusing flags of the naming call, not about a
  managed copy of our settings; Code Foundry has no managed settings file to map.
* **Chords**: `git.fetch` (cmd+shift+f), `git.pull` (cmd+shift+u) and `git.push`
  (cmd+shift+k) have no default keybinding. They stay in the palette and the CLI, and a
  user can still bind them in Settings › Keybindings. No new bindings here.
  `TestGitOpsKeybindings` now pins "no chord" for the three and cmd+shift+o for
  `worktree.open.editor`.

## Gotchas

* The mock's gitops specs need `keybindings: []`, not a missing field: the mock's
  settings schema reads `c.keybindings[0]` and the mock daemon fails to start without it.
* The gitops e2e test pressed cmd+shift+k. It now presses cmd+shift+o
  (`worktree.open.editor`), which keeps what it checked: a global chord runs a worktree
  command in the selected thread's worktree.
* The settings page unit test used the naming model as its cross-section `dependsOn`
  example; no real field has one now (alert volume sits right under its toggle), so the
  fixture has a made-up `threads.name_style` to keep the behaviour covered.
* An existing user's file with a hand-edited `naming_model` keeps reading correctly with
  this daemon, but a daemon from before this change would ignore `[models] utility` once
  the new daemon has rewritten the file. GUI and daemon always ship together, so that only
  matters for someone rolling back.

## Verified end to end

Branch binary, `CODE_FOUNDRY_HOME=/tmp/cf-s1h`, a scratch repo under `~` (deleted after).

1. Seeded an old-format `settings.toml` (`[threads] naming_model = "claude-sonnet-5-5[1m]"`)
   and started the daemon. `settings get models.utility` printed `claude-sonnet-5-5[1m]`;
   `settings get threads.naming_model` was an unknown setting. The file was untouched
   until a save; `settings set threads.default_effort medium` rewrote it with
   `[models] utility = "claude-sonnet-5-5[1m]"` and no `naming_model`.
2. `settings get --json`: the three git chords' values and defaults are empty;
   `worktree.open.editor` keeps cmd+shift+o.
3. A Sonnet 5.5 (medium) thread: the daemon log's `naming command finished` ran
   `claude -p --model claude-sonnet-5-5[1m] --effort low ...` (the migrated value), and the
   thread was named "Add dark mode toggle to settings".
4. `threads.auto_name = false`, then `thread.regenerate-name`: renamed with the utility
   model (same command line in the log).
5. The settings page (`daemon --dev` + vite + Playwright WebKit): General › Text
   generation shows "Utility model" with its new description, not dimmed while "Name
   threads automatically" is off.
