# Settings a page, a plugin or a thread may not change (2026-11-07)

A page's settings changes now need confirmation, and some settings can only be changed by
the user. A page's script is not trusted the way the user is: it can run scripts and has
network access.

## What changed

- **`UiContext.origin`** (`CallOrigin`; `Context.Origin`): page or plugin, unset for the
  GUI's own controls and a CLI. A page has the context of the CLI inside its thread
  (`activeView` empty, `activeThreadId` set), so the daemon could not tell them apart, and
  a plugin chooses its own context, view included. The GUI's bridge host sets `page`
  (`pageContext`); the page cannot reach the API or the context, only `cf.run`'s verb and
  args. The plugin host, `plugin.act` and the GUI's `runCommandElement` set `plugin`.
- **`Context.FromUser`**: unset origin, and a view (the app) or no thread (a CLI outside a
  thread).
- **`Field.UserOnly`** (`SettingField.user_only`): `settingChange` refuses anyone but
  `FromUser`, confirmed or not, with "<key> can only be changed by the user; they can
  change it in Settings". A registry field, read from the schema; no key list in the
  command. The Settings page shows nothing for it; `settings get --json` and
  `reference/settings.md` do.
- **A page asks** for every other setting. `settingChange` returns a `ConfirmError` from
  Run, so `invokeConfirmed` shows the usual dialog with "Asked by". The message has the key
  and the new value (`%q`, so a value cannot draw lines of its own in the dialog); a reset
  has the default.

## Decisions

- **Not `Command.Confirm`.** It would list `requires_confirmation`, which gives the verb
  `--yes` in the CLI and in the agents' command index, for a rule agents never meet. A
  `ConfirmError` from Run, as a second stage does, keeps both as they were. A thread's CLI
  changes an ordinary setting exactly as before.
- **The rule is in the daemon, not the host,** so `plugin.act` from a page is covered, the
  text is the daemon's, and the rule is tested in Go.
- **Marked user-only**: `advanced.claude_path` and `advanced.gh_path` (programs the daemon
  runs; gh also with the user's token), `gitops.editor_command` (a command line run on Open
  in Editor, live), `plugins.registries` (where plugins come from) and `update.channel` (which builds get
  installed).
- **Not marked**, and a page still has to ask: `appearance.backdrop_file` (a name in the
  backdrops folder, `checkBackdropFile`), `projects.branch_instructions` (words for the
  utility model; the output is only a branch name), `ember.enabled` (spends tokens, runs
  nothing the user did not install), `dictation.anywhere` (nothing is heard unless the user
  holds the key).
- **The Settings page is unaffected**: it calls `SettingsService.Update` directly
  (`stores/settings.ts`), and no GUI control runs `settings.set`.
- **A person in a thread's bottom terminal is refused** like the agent: its environment has
  `$CODE_FOUNDRY_THREAD`. The refusal points at Settings, which works.
- **The welcome page's dictation switch asks now.** It is a page, and the rule has no
  exception for pages we ship. A no leaves the switch off without an alert.
- `noRegistryMessage` and the plugin skill's publishing reference told a thread to run
  `settings set plugins.registries`. Both now say Settings → Plugins → Registries.

## The limit

This stops a page and an agent that simply tries; it is not a sandbox, since an agent runs
as the user.

## Compatibility

- The daemon must restart for any of this to apply. A new GUI on an old daemon changes
  nothing until then.
- Old GUI, new daemon: a page has no origin and is treated like a thread's CLI.
- No on-disk change.
