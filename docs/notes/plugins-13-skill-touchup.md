# Plugins 13: skill touch-up from the showcase and plugin-fix rounds (2026-10-18)

The `code-foundry-plugin` skill (`docs/notes/plugins-4-skill.md`) after two more rounds of
author feedback: the showcase plugin's `SKILL-FEEDBACK.md` (24 items; the plugin is
`alexwaumann/code-foundry-plugin-showcase`) and the eight items from fixing gh-actions and
test-watcher. Written on `73685d8b`; restacked (2026-10-18) onto `cf/plugins-11-gui-gaps`
(after #200 and #201 on the rebased `cf/plugins-7-registry`); the diff is
the skill files, `plugins/examples/minimal`, pluginsdk doc comments, one embed line and
the skill test's file list.

## Written for behaviour that lands in other PRs

The first commit carries, unchanged, the skill-text hunks of three sibling branches, so
this branch's edits are written against the new behaviour and a restack merges those
hunks as identical changes (or drops the commit as already applied). The restack
dropped it as already applied, so the branch has nine commits; it was:

* `cf/plugins-7-registry` `940d3a71`: no registry configured by default (publishing.md).
* #200 (`cf/plugins-8-secrets`): per-home Keychain service, secrets bound to the install
  source, `--force` deleting secrets, data and consent, env values never shown.
* #201 (`cf/plugins-10-host-gaps`): `Surface.Close(reason)` (idle after 10 minutes,
  `context_gone`, `unavailable`), command errors as `InvalidArgument` /
  `FailedPrecondition`, `plugin surface --settle`, `plugin act` printing the view and
  pressing command buttons, `secret/changed`, command-args limits, `terminal/read` and
  `terminal/exited`, typed `SetContext*`, `With…` field helpers.

On this base alone the skill therefore describes SDK calls that are not here yet
(`ReadTerminal`, `OnTerminalExit`, `Surface.Close(reason)`, `SetContextBool`, …); the
example still compiles against this base's SDK (its `Close()` is untouched: #201 changes
that line). Text of my own that depends on those PRs: `plugin list` showing a waiting
surface as `unknown` (manifest.md), `plugin dev --force` and `uninstall --purge` for
re-consent (testing.md, publishing.md), direct installs offered updates and
`plugin install` accepting `SHA256SUMS` or `checksums.txt` (publishing.md), the example's
"closes it 10 minutes after" comment, `plugin env` showing names only (host-api.md).

From the renderer pass (PR in progress, nothing pushed when this was written), written as
the new behaviour:

* at most two `thread` / `terminal` nodes per view, each attached only while on screen
  (primitives.md, SKILL.md design rules, `ui.Thread` doc);
* a `multiple` select with `style: dropdown` is a menu of checkboxes;
* drafts survive a refused submit. I read "refused" as: Act returned an error, or the
  view after it has a field `error` or the form's `error`; drafts drop only on a submit
  taken cleanly. If the renderer lands a narrower rule (only Act errors), primitives.md's
  "Drafts" paragraph needs one sentence changed;
* the header sub-line wraps to two lines, then is cut.

## Feedback, item by item

Showcase `SKILL-FEEDBACK.md`:

| # | Item | Where |
|---|---|---|
| 1 | SDK pin resolved | no change needed |
| 2 | past 8 tabs | primitives.md: collapsible sections in a tab, or a second surface |
| 3 | `sublineIcon` undocumented | primitives.md header JSON, Go and prose; `ui.Header` doc |
| 4 | section `actions` / `tone` | primitives.md example and prose (buttons at the end of the title row; tone colours the title and a card's border) |
| 5 | `--add-dir` skill layout | host-api.md: `<dir>/.claude/skills/<skill>/SKILL.md`, a Go example writing one under the data dir |
| 6 | model / effort values | host-api.md: the values `code-foundry help thread.new` lists |
| 7, 24 | archived plugin thread | primitives.md, host-api.md, `ui.Thread` doc: still renders, no cue; drop its node |
| 8 | drafts cannot be read | primitives.md "Drafts": use a `change` event |
| 9 | form vs submit `busy` | primitives.md; `ui.Form.Busy` doc |
| 10 | `act.Context` on a page with no thread | primitives.md "Acts": empty `ThreadID` |
| 11 | no README in the example | `example/README.md` template |
| 12 | zsh word splitting | declined: the skill spells commands out |
| 13 | `checksums.txt` vs `SHA256SUMS` | publishing.md; #201 fixes the help text (cli.md is rendered from it) |
| 14 | repository created first | publishing.md points back to step 1 |
| 15 | version in two places | example `version` constant + `TestManifest` check; SKILL.md step 9, testing.md, publishing.md |
| 16 | thread / terminal streams | the renderer pass's limit (above) |
| 17 | sub-line truncation | primitives.md, SKILL.md, `ui.Header` doc (two lines after the renderer pass) |
| 18 | section titles truncate | primitives.md |
| 19 | drafts dropped on any accepted submit | the renderer pass's rule (above) |
| 20 | `multiple` select always a list | the renderer pass (above); `ui.Select.Style` doc |
| 21 | `change` on commit | primitives.md; `ui.Field.Change` doc |
| 22 | where toasts show | host-api.md "Toasts"; `Toast` / `ToastIn` doc |
| 23 | row button placement | primitives.md "list" |

Plugin-fix round:

| | Item | Where |
|---|---|---|
| a, b | `terminal read/write` verbs; no output or exit event | #201's `terminal/read` and `terminal/exited` text (carried); no script(1) workaround anywhere |
| c | consent survives uninstall | testing.md "Consent again", publishing.md (`--purge`) |
| d | `SHA256SUMS` accepted | publishing.md (help text: #201) |
| e | a PR URL in a prompt makes no link | testing.md: a shallow clone on the head branch, `project add`, `thread new` |
| f | 15-minute polls on an isolated daemon | testing.md: `pr refresh <owner/repo> <number>` |
| g | uninstall on a dev link should say so | host text, not here (the command's description already says only the link goes; the printed message is the host's) |
| h | "Copy to .github/workflows/" comments | removed; the workflows were already in place, SKILL.md and publishing.md say the copy is the repository |

**Showcase pointer**: one paragraph in SKILL.md after the loop: the living gallery of every
component, `code-foundry plugin install showcase` once `plugins.registries` is configured.

## The example

* `README.md` template (what it adds, install from a registry or `owner/repo`, permissions
  and why, development, license) with "Minimal"/"minimal" so step 1's rename covers it.
  Embedded by `plugins/embed.go` and listed in the skill test (byte-for-byte check).
* `const version` in `main.go`, shown as the header's trailing text and in Init's log
  line; `TestManifest` fails when `plugin.json` differs.
* Workflow header comments no longer say to copy them.

## Sizes

SKILL.md is at the 120-line cap (tightened to fit: the loop's steps 1, 4, 5, 9 and the
design rules reflowed, two references on one line). Rendered sizes against the 32 KB cap:
primitives.md 29.4 KB (the largest; #201's two extra limits rows add about 200 bytes),
host-api.md 22 KB, manifest.md 16 KB, testing.md 11 KB, publishing.md 8 KB. No `!`
commands.

## Gotchas

* `pr refresh` fetches a known pull request's detail; linking a branch to its pull request
  is the poll's (a new branch watch polls within a second, later changes wait for the
  cadence). That is why testing.md's recipe works on an isolated daemon: the thread's
  first `pr.checks` read asks for the branch and the retry finds it.
* gofmt realigns a struct's field block when a comment line is inserted inside it; the SDK
  doc additions are trailing comments to keep the diff to the lines that changed.
