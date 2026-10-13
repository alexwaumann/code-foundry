# Model registry: 1M ids, no aliases

Decided 2026-10-13 (Alex). Supersedes the alias half of `model-registry.md`.

## What changed

The registry (`internal/model`) now lists only pinned ids with the 1M context suffix:

| Value | Label |
|---|---|
| `claude-opus-5-5[1m]` | Opus 5.5 |
| `claude-opus-4-8[1m]` | Opus 4.8 |
| `claude-opus-4-7[1m]` | Opus 4.7 |
| `claude-sonnet-5-5[1m]` | Sonnet 5.5 |
| `claude-sonnet-5[1m]` | Sonnet 5 |
| `claude-sonnet-4-6[1m]` | Sonnet 4.6 |
| `claude-haiku-5-5[1m]` | Haiku 5.5 |
| `claude-4.5-haiku[1m]` | Haiku 4.5 |

* The Fable / Opus / Sonnet / Haiku alias entries are gone. An alias resolves to the
  account's default for the family, which is not necessarily the 1M variant.
* `model.Default` is Opus 4.8 and `model.NamingDefault` is Sonnet 5. Switch naming to a
  Haiku once Haiku 5.5 is available at work.
* The 5.5 entries are listed before the work laptop's managed settings offer them (expected
  in 2–3 weeks), so they appear without an app update. Until then, picking one fails at
  session start. Alex is telling the test group about this limitation.
* Haiku 4.5 is `claude-4.5-haiku[1m]` because that is the id the work (Bedrock) setup
  accepts. `claude-haiku-4-5` is refused there, which is why Haiku 4.5 had been removed
  before. On a first-party account, Claude Code reports `claude-4.5-haiku[1m]` as
  `unrecognized_model`. The registry targets the work setup.
* Labels carry no "1M" tag, because every entry is 1M.
* `thread.set-model` reports the model's label ("uses Sonnet 5"), not the raw id.
* `FALLBACK_MODEL_CHOICES` (before the settings schema loads) is the default model alone. It
  used to be the four aliases.

## Suffix check (Claude Code 2.1.296, first-party account)

One `claude -p` turn per id at low effort. The window is `modelUsage[*].contextWindow`.

* Opus 5.5, Opus 4.8, Opus 4.7, Sonnet 5.5, Sonnet 5 and Haiku 5.5 are all 1M with or
  without `[1m]`. The suffix is accepted and changes nothing.
* Sonnet 4.6 is 200K without the suffix. With it, the subscription account got a 429 asking
  for usage credits. Alex confirmed that `claude-sonnet-4-6[1m]` works on the work laptop.

## Gotchas

* Saved settings with an old value (`default_model = "opus"`) are reported as issues on the
  settings page, and the new default applies. There is no migration: Alex is the only user.
* Threads started with an old value keep it, so they resume as before. The UI shows the
  raw value ("opus") because the registry no longer lists it.
* zsh globs `[1m]`, so CLI users must quote the value: `--model 'claude-opus-4-8[1m]'`.
  The `--model` help says so.
