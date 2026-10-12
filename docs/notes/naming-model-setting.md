# Naming model setting

Status: done on branch `t3code/naming-model-setting`. `make check` and `make gui-build`
green, the Playwright settings spec passes (WebKit + Chromium). Exercised end to end with
an isolated daemon (below).

## What changed

* New setting `sessions.naming_model` (`settings.KeyNamingModel`, Sessions group, right
  after "Name sessions automatically"): an Enum over the model registry
  (`command.SessionModels`, `model.Labels()`), default `model.NamingDefault` = `"sonnet"`.
  Bound to `Settings.Sessions.NamingModel`. Not `Restart`: it applies live.
* The naming command is built per call by `namingArgs(model, minimal)`. Both variants
  pass `--model <m> --effort low`:

      claude -p --model <m> --effort low --no-session-persistence --safe-mode --tools "" -- <prompt>
      claude -p --model <m> --effort low --no-session-persistence -- <prompt>     (fallback)

* The model reaches `ClaudeNamer` through the context: `session.WithNamingModel(ctx, m)`
  sets it, `session.NamingModel(ctx)` reads it. The daemon's `settingsNamer` (which already
  read `sessions.auto_name` per call) now also reads `sessions.naming_model` per call and
  wraps the ctx. No settings store (tests, `Options.Namer` nil) means no ctx value and the
  default.

## Decisions

* **Sonnet is the default** because Haiku 5.5 is not available on Alex's work laptop yet
  (managed settings allow only Opus 4.8/4.7, Sonnet 5/4.6, Haiku 4.5). Switch
  `model.NamingDefault` to `"haiku"` once it is; the setting's default follows.
* **Effort is fixed at low.** A 3-5 word slug needs no thinking; low keeps the call fast
  whatever the model. It is a constant (`namingEffort`), not a setting.
* **Model per call via ctx, not a `func() string` option on `ClaudeNamer`.** The namer
  already takes its session id from ctx (`withNamingSession`), `settingsNamer` is already
  the one place where settings meet naming, and `ClaudeNamer`'s state (the "use the
  minimal command from now on" flag) has to survive model changes, so it cannot be
  rebuilt per model. `NamingModel` falls back to `model.NamingDefault` for an empty or
  unregistered value, so a hand-edited settings file that the store would reject anyway
  cannot reach claude as `--model gpt-5`.
* `model.NamingDefault` lives in `internal/model` next to `model.Default` so the settings
  schema and the session store share it without importing each other.
* No GUI code: the settings page renders the Enum from the schema with the registry's
  labels and marks the default ("Sonnet (default)").

## Verification

* Unit: `TestNamingArgs` (model substitution, `--effort low` in both variants, default
  model), `TestNamingModel` (unset, empty, unknown -> sonnet), `TestClaudeNamerModel` (two
  calls on one namer, default then haiku), `TestNamingModelField` (default, live, enum,
  placement, rejects "", "gpt-5", "Sonnet"), labels, file round trip, store update,
  `TestSettingsNamer` (setting changed between two calls: sonnet, then haiku), CLI
  `settings get/set sessions.naming_model`, Playwright settings spec.
* `claude --help` (this machine) lists `--effort <level>` (low, medium, high, xhigh, max)
  as a general flag; `-p` accepts it (the live calls below exit 0).
* Live: `CODE_FOUNDRY_HOME=/tmp/cf-naming-live bin/code-foundry daemon --dev`, a fresh
  scratch repo `~/cf-naming-scratch` (see gotchas), `settings set sessions.naming_model
  haiku`, `session new --model haiku --effort medium --prompt "add a hello world readme"`:

      level=INFO msg="naming command finished" store=session session=s-3307d01ba85c cmd="claude -p --model haiku --effort low --no-session-persistence --safe-mode --tools \"\" -- <prompt>" ok=true took=1.569s
      level=INFO msg="session auto-named" store=session session=s-3307d01ba85c name=add-hello-world-readme took=1.57s

  Then `settings reset sessions.naming_model` on the same daemon (no restart) and a second
  session:

      level=INFO msg="naming command finished" store=session session=s-a8a668cf21fa cmd="claude -p --model sonnet --effort low --no-session-persistence --safe-mode --tools \"\" -- <prompt>" ok=true took=2.037s

  Both sessions were closed, the daemon stopped, the scratch repo and its transcripts
  under `~/.claude/projects/-Users-alex-cf-naming-scratch` deleted.
* Screenshot: `naming-model-setting/settings-dark.png`.

## Gotchas

* **The scratch repo cannot live under /tmp.** `repo add` refuses paths outside home
  ("is outside your home directory") and `session.new` needs a registered repo, so the
  live check used a fresh `~/cf-naming-scratch` (the same as earlier notes' `~/cf-*-scratch`).
  Claude also added a trust entry for it to `~/.claude.json`.
* **No Wails screenshot while the screen is locked.** The Mac was locked
  (`CGSSessionScreenIsLocked`); the Wails window existed (CGWindowList) but its WKWebView
  painted nothing and `screencapture -R` only saw the lock screen. The screenshot is the
  same frontend in Playwright WebKit (Vite dev server pointed at the same live daemon via
  `VITE_DAEMON_URL`/`VITE_DAEMON_TOKEN`), i.e. the real schema from the real daemon, not
  the mock.
* The worktree-isolation guard rejects running `"./gui/bin/Code Foundry"` (a path with a
  space); a symlink without a space (`/tmp/cf-naming-gui`) works.
* Running Playwright e2e while another worktree runs it: the default mock port 7799 is
  taken; set `E2E_MOCK_PORT`/`E2E_VITE_PORT`.
