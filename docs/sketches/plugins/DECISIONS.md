# Plugin system: build decisions (2026-10-18)

Alex signed off on the design package in this directory on 2026-10-18 with the changes
below. **Where this file disagrees with `BRIEF.md`, `ARCHITECTURE.md`, `PRIMITIVES.md`
or `README.md`, this file wins.** Everything else in those documents stands, including
the README's reconciliation (catalog names win over the mockup's, `section.stale` and
per-line log tone adopted, ANSI deferred).

## Accepted as recommended

1. Contributions are declared in `plugin.json`; `initialize` may narrow, never widen.
2. Wire: newline-delimited JSON-RPC 2.0 over stdio. Proxy-only token model: no daemon
   token by default, an opt-in `api` permission hands over the normal endpoint + token.
   No scoped tokens.
3. The view model travels as JSON end to end (`view_json`), validated generically by the
   daemon, typed in `gui/frontend/src/api/plugin.ts` and in `pluginsdk/ui`.
4. Consent: a newly discovered or installed plugin is disabled until enabled through a
   permission dialog that lists the manifest's permissions; re-consent when permissions
   grow on update.
5. Predicates evaluate on the daemon; each surface gets a `plugin.<name>.show.<surface>`
   command whose availability the GUI already syncs.
6. Thread status is a flags overlay on the thread (attention / error + reason), never the
   stream-owned status. Sidebar sort, line-2 reason and dock alerts get the small edits
   `ARCHITECTURE.md` §C.6 describes.
7. Visual rules: emerald for `ok`; a neutral header icon for every plugin (no identity
   hue); **no filled buttons** (main action amber-outlined, the rest muted); destructive
   buttons go through the host's confirm dialog; **plugin tabs get no hotkey letter**.
8. Plugins and Project Actions both stay. Actions are the no-code tier (§H).

## Changed

### Session environment hook: env, PATH and add-dirs only

Custom MCP configuration does not work on Alex's work laptop (managed settings), so the
`mcpServers` contribution is **dropped** entirely, along with the `--mcp-config` file and
the "test on the work laptop" open question. The hook contributes `env`, `pathPrepend`
and `addDirs` with the rules in §C.7 (reserved keys, limits, name-order conflicts, scope,
2 s startup grace, push not request). It plugs into the same spawn-extras slot the
daemon's own skills `--add-dir` already uses (`docs/notes/agent-skills.md`); extend that
path, do not add a parallel one. Order of `--add-dir`: skills dir, plugin add-dirs,
attachments, workspace members, grants.

### Secrets: host-owned store, plugin-readable

A plugin never invents its own secret storage. The host keeps a Keychain-backed store
(macOS `security`, service `code-foundry-plugin`, account `<plugin>/<key>`) namespaced
per plugin and exposes `secret/get`, `secret/set`, `secret/delete`, `secret/list` (names
only) to the plugin, each scoped to its own namespace. Rules:

* Secret values flow in one direction only, **host → plugin over stdio**. They never
  appear in `view/update`, bus events, logs (keys only), argv, or `ps`.
* The form `secret` input gains an optional `store: "<key>"`. On submit the host writes the
  value into the plugin's namespace and the submit event carries `{key, stored: true}`
  instead of the value; the plugin reads it with `secret/get` when it needs it. Without
  `store`, the submit event carries the value (plugin-ward only), as before.
* The host never renders a secret back. A view may show "set" and when, nothing else.
* `plugin secrets list <plugin>` and `plugin secrets delete <plugin> <key>` CLI verbs for
  the user; disabling keeps secrets, `uninstall --purge` deletes them.
* Hardening (PR 8, `docs/notes/plugins-8-secrets-hardening.md`): secrets, consent and the
  data dir belong to the plugin's install source, not just its name (another source's
  package takes the name only with `--force`, which deletes them); a non-default
  `CODE_FOUNDRY_HOME` uses its own Keychain service; reads need the key recorded in this
  home's database. Isolation between plugins, not a sandbox: a plugin runs as the user.

### New primitives (all v1)

* **`tabs`**: navigation tabs inside a plugin surface, styled like the PR view's tabs
  (not the side-panel tab strip), so one plugin surface has several views. The plugin
  declares `tabs: [{key, label, badge?}]` and `active`; the host sends a `tab` action on
  change and keeps draft state per tab. Body nodes live under the active tab.
* **`thread`**: a plugin-owned Claude thread rendered inline with the existing rendered
  thread view and composer. The plugin creates it with `thread/create` (permission
  `threads`): `cwd`, `addDirs`, `env`, `model`, `effort`, `title`, optional `projectId`
  for scope. Plugin threads are **hidden from the sidebar** and from `thread list` by
  default (listed under the plugin and with `thread list --plugin`); the thread row
  records `owner = plugin:<name>`. They obey the same auto-start / auto-stop, cost
  accounting and usage rules as any thread. Disabling or uninstalling the plugin
  archives its threads. The plugin can send into its own thread (`thread/send`) and, via
  `host/invoke` of `thread.send` with the surface's context, into the user's main-pane
  thread. The "only the visible thread holds a WatchThread stream" rule becomes "one
  per visible thread view".
* **`terminal`**: a plugin-owned daemon terminal (permission `terminals`;
  `terminal/create` with argv, cwd, env; `terminal/close`), rendered with the existing
  xterm attach, with an "Open in bottom panel" action; owner label `plugin:<name>` in the
  bottom panel (the owner-label design already exists). The one-Attach rule becomes "one
  per visible terminal view". A pty login prompt is also the recommended way to collect a
  secret that the plugin itself never needs to see.
* **`fieldset`** inside `form`: label + hint + error for a group of inputs (the checkbox
  group gap, DESIGN.md awkward spot 7).
* **Host-filled option sources** for `select`: `options_source: projects | threads`
  (PRIMITIVES.md open question 7). The host fills and keeps them current.
* **`duration`** inline span beside the `time` span (elapsed / relative / countdown), so
  finished and running stage durations do not drift in style.

Still deferred: table, image, charts, ANSI colours, segmented control, the iframe tier.

### Example plugins: GitHub Actions run tracker and test watcher

Jenkins and the enterprise auth wizard are **not** built: neither backend exists outside
Alex's work. Their documents stay in this directory as the reference for what coworkers
will build (the Jenkins tracker is the first real third-party plugin expected). The
shipped examples are:

1. **`gh-actions`** — GitHub Actions run tracker. Per-PR surface (scope `pr`, available
   when the selected thread's PR has check runs from GitHub Actions): header with PR and
   run link, jobs as stage chips with status and duration, failed step log tail (via
   `gh run view --log-failed` / the REST jobs API through `gh api`), Rerun failed / Rerun
   all / Cancel actions (commands, confirm on cancel), Open on GitHub, "Send failure to
   Claude" (host-invoked `thread.send` with the excerpt). Raises an `attention` flag with
   the failed job name; clears it when seen. Uses `tabs` for Runs / Jobs / Log.
2. **`test-watcher`** — subscribes to the thread's git/file events, runs the project's
   test command (configurable per project, default guessed from `go.mod` /
   `package.json` / `Makefile`), shows pass/fail with a log of failures (log append),
   raises an `error` flag on failure, offers "Send failures to Claude" and "Run now". Uses
   a `terminal` node for the live run and a host-stored secret-free settings form.

In-repo: `plugins/examples/hello` (Go, exercises every protocol method minimally) and a
~30-line `python3` plugin under `internal/store/plugin/testdata/` proving the protocol is
language agnostic. The two shipped examples live in their **own repositories**
(`alexwaumann/code-foundry-plugin-gh-actions`, `alexwaumann/code-foundry-plugin-test-watcher`)
with release workflows, because they double as the real-world example of the registry.

### SDK as a nested module

`pluginsdk/` is its own Go module (`github.com/alexwaumann/code-foundry/pluginsdk`,
stdlib only, `replace`d in the main `go.mod`), so plugin repositories import it without
pulling the daemon's dependency graph. Packages: `pluginsdk` (Serve, Host, manifest
types, jsonrpc), `pluginsdk/ui` (typed view-model builders for every v1 node),
`pluginsdk/plugintest` (fake host for unit tests). Tag `pluginsdk/v0.1.0` after the stack
merges; until then plugin repos pin a commit.

### Registry (the "plugin market")

A registry is a git repository (or any URL) serving `index.json`: for each plugin, name,
display name, description, permissions summary, latest version, per-platform download
URL (`darwin/arm64`, `darwin/amd64`) and sha256, and the source repo. Settings gain
`plugins.registries` (list; default `https://github.com/alexwaumann/code-foundry-plugins`).
`gh` auth covers private registries, so a workplace can point at an internal repo with
no new auth. A GitHub Action in the registry repo validates PRs that add or bump a plugin
(manifest present in the release tarball, hash matches, permissions listed).

* `plugin install <name>[@version]` (from a registry), `plugin install <path>` (dev,
  symlink), `plugin install <owner>/<repo>` (direct from a release): download, verify
  hash, atomic rename into `~/.code-foundry/plugins/<name>`; the consent dialog shows
  permissions before anything runs. `plugin update [<name>]`, `plugin uninstall [--purge]`.
* The existing daily update check also compares installed plugin versions and offers
  per-plugin updates; never silent.
* Trust in v1 = registry owner + hash + consent. No signing yet.
* Settings → Plugins page: **Installed** (enable / disable / restart / update / logs /
  uninstall, consent dialog) and **Browse** (the merged index from every registry).

### A plugin-creation skill, and the plugins are built with it

`code-foundry-plugin` is a third daemon-written skill (`internal/skills`, same `--add-dir`
as the other two): how to scaffold a plugin against `pluginsdk`, the manifest, the
protocol, every primitive with an example, the secrets / threads / terminals / env-hook
APIs, `plugin dev` for local iteration, `plugin surface` / `plugin act` for debugging
without the GUI, the registry publishing flow, and the design rules a plugin UI must
follow. Reference files beside `SKILL.md`; no `` !`command` `` (blocked by managed
settings). **The two example plugin repositories must be built by agents using this
skill**, and the gaps they hit are fed back into the skill in the same series. Agents
write most plugins; the SDK and the skill matter more than the examples.

## Build order (stacked PRs, not merged until Alex has seen the whole stack)

Branches `cf/plugins-N-<slug>`, each PR based on the previous one. Every PR: `make
check` green, `docs/notes/plugins-N-<slug>.md`, committed as it goes, pushed, `make
attest` on the final tree, PR body with screenshots for anything visible. **Do not merge.**

| PR | Branch | Contents |
|---|---|---|
| 1 | `cf/plugins-1-core` | This directory's docs; `pluginsdk` nested module (types for every v1 node, jsonrpc, Serve, Host, plugintest); `internal/store/plugin` (discovery, migration, actor lifecycle, backoff, logs, ping, consent state); secrets store; `Registry.ReplacePrefix` + dynamic commands + `host/invoke` allowlist; `PluginService` (list / enable / disable / restart / logs / secrets); EventService `plugin` source; `plugin.*` CLI verbs; `plugins/examples/hello`; python testdata plugin; `make plugins` |
| 2 | `cf/plugins-2-surfaces` | Surface instances, view validation (every v1 node incl. tabs, fieldset, option sources, duration; thread/terminal nodes validated but inert), coalescing, `WatchSurface` / `Act`, `surface/*`, `view/*`, `context/set`; predicate compiler + evaluator; facts incl. async PR checks; `plugin.<n>.show.<s>` commands; `pr.checks` read command; `UiIntent.InvokeCommand`; `plugin surface` / `plugin act` debug verbs; hello gains a surface |
| 3 | `cf/plugins-3-events-flags-env` | `events/subscribe` + feed; thread flags (store, proto, clearing); GUI sidebar / line-2 / dock edits; session env hook (env, pathPrepend, addDirs) through the spawn-extras slot |
| 4 | `cf/plugins-4-skill` | The `code-foundry-plugin` skill + reference files, rendered from the registry where possible; `docs/ARCHITECTURE.md` plugin section |
| 5 | `cf/plugins-5-gui` | `api/plugin.ts`, stores, generic surface kind + registry fall-through, renderer for every v1 node (tabs included), consent dialog, Settings → Plugins (Installed), mock-daemon fixtures, Playwright shots dark + light at 400 and 280 px |
| 6 | `cf/plugins-6-thread-terminal` | Plugin-owned threads and terminals end to end: `thread/create`, `thread/send`, `terminal/create`, hidden threads + owner, archive on disable, `thread` and `terminal` renderers with the relaxed one-stream rules |
| 7 | `cf/plugins-7-registry` | `plugins.registries` setting, index format + validation, install / update / uninstall / dev, update-check integration, Settings → Plugins → Browse |

Outside the repo, in parallel from PR 4 onward: the registry repo
(`alexwaumann/code-foundry-plugins`, index + validating workflow), the two plugin repos
(built with the skill, release workflows, tagged releases), and PRs into the registry
adding them. The series ends with both plugins installed from the registry into a real
daemon + GUI run and screenshots of them working.
